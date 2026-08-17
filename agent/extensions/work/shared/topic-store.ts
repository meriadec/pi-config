import { readdir, readFile, rmdir, unlink } from "node:fs/promises";
import { createJsonAtomic, writeJsonAtomic } from "./atomic-json.ts";
import {
  WorkDataError,
  boundMessage,
  generateTopicId,
  isTopicId,
  parseRepository,
  parseTopicManifest,
} from "./domain.ts";
import type { NewTopic, TopicManifest } from "./domain.ts";
import type { WorkPaths } from "./paths.ts";

export interface TopicDiagnostic {
  topicId: string;
  code: string;
  message: string;
}

export interface TopicHydration {
  topics: TopicManifest[];
  diagnostics: TopicDiagnostic[];
}

export interface TopicStoreOptions {
  generateId?: () => string;
  now?: () => Date;
}

export interface TopicStore {
  list(): Promise<TopicHydration>;
  load(id: string): Promise<TopicManifest>;
  create(topic: NewTopic): Promise<TopicManifest>;
  delete(id: string): Promise<TopicManifest>;
  update(
    id: string,
    change: (topic: TopicManifest) => TopicManifest | Promise<TopicManifest>,
  ): Promise<TopicManifest>;
}

const MAX_DIAGNOSTICS = 100;

export function createTopicStore(paths: WorkPaths, options: TopicStoreOptions = {}): TopicStore {
  const idGenerator = options.generateId ?? generateTopicId;
  const now = options.now ?? (() => new Date());
  const queues = new Map<string, Promise<void>>();

  const serialize = async <T>(key: string, operation: () => Promise<T>): Promise<T> => {
    const previous = queues.get(key) ?? Promise.resolve();
    let release = (): void => undefined;
    const next = new Promise<void>((resolve) => {
      release = resolve;
    });
    queues.set(key, next);
    await previous;
    try {
      return await operation();
    } finally {
      release();
      if (queues.get(key) === next) queues.delete(key);
    }
  };

  const load = async (id: string): Promise<TopicManifest> => {
    assertTopicId(id);
    let text: string;
    try {
      text = await readFile(paths.topicManifest(id), "utf8");
    } catch (error) {
      if (isCode(error, "ENOENT"))
        throw new WorkDataError("topic-not-found", "Topic does not exist.");
      throw dataError("Cannot read topic manifest.", error);
    }
    try {
      return parseTopicManifest(JSON.parse(text), id);
    } catch (error) {
      if (error instanceof WorkDataError) throw error;
      throw dataError("Topic manifest is not valid JSON.", error);
    }
  };

  const list = async (): Promise<TopicHydration> => {
    let entries;
    try {
      entries = await readdir(paths.topics, { withFileTypes: true });
    } catch (error) {
      if (isCode(error, "ENOENT")) return { topics: [], diagnostics: [] };
      throw dataError("Cannot list topics.", error);
    }
    const topics: TopicManifest[] = [];
    const diagnostics: TopicDiagnostic[] = [];
    for (const entry of entries.toSorted((left, right) => left.name.localeCompare(right.name))) {
      if (!entry.isDirectory()) continue;
      try {
        topics.push(await load(entry.name));
      } catch (error) {
        if (diagnostics.length < MAX_DIAGNOSTICS) diagnostics.push(diagnostic(entry.name, error));
      }
    }
    topics.sort(
      (left, right) =>
        left.createdAt.localeCompare(right.createdAt) || left.id.localeCompare(right.id),
    );
    return { topics, diagnostics };
  };

  return {
    list,
    load,
    async create(input) {
      return serialize("$uniqueness", async () => {
        parseRepository(input.repository);
        if (input.name.length === 0 || input.branch.length === 0) {
          throw new WorkDataError("invalid-topic", "Topic name and branch must not be empty.");
        }
        const existing = await list();
        assertUnique(existing.topics, input.repository, input.branch);
        const id = idGenerator();
        assertTopicId(id);
        const timestamp = now().toISOString();
        const topic = parseTopicManifest(
          {
            version: 1,
            id,
            name: input.name,
            branch: input.branch,
            repository: input.repository,
            setup: {
              state: "provisioning",
              repositoryAvailable: false,
              worktreeCreated: false,
              setupCommandsRun: false,
            },
            worktreePath: null,
            focused: true,
            mainAgent: { sessionId: id, sessionFile: null },
            createdAt: timestamp,
            updatedAt: timestamp,
          },
          id,
        );
        try {
          await createJsonAtomic(paths.topicManifest(id), topic);
        } catch (error) {
          if (isCode(error, "EEXIST"))
            throw new WorkDataError("duplicate-topic-id", "Generated topic id already exists.");
          throw dataError("Cannot create topic.", error);
        }
        return topic;
      });
    },
    async delete(id) {
      assertTopicId(id);
      return serialize(id, async () => {
        const topic = await load(id);
        try {
          await unlink(paths.topicManifest(id));
        } catch (error) {
          if (isCode(error, "ENOENT")) {
            throw new WorkDataError("topic-not-found", "Topic does not exist.");
          }
          throw dataError("Cannot delete topic manifest.", error);
        }
        await rmdir(paths.topicDirectory(id)).catch(() => undefined);
        return topic;
      });
    },
    async update(id, change) {
      assertTopicId(id);
      return serialize(id, async () => {
        const current = await load(id);
        const candidate = await change(structuredClone(current));
        if (candidate.id !== current.id || candidate.createdAt !== current.createdAt) {
          throw new WorkDataError(
            "invalid-topic-update",
            "Topic id and creation time cannot change.",
          );
        }
        return serialize("$uniqueness", async () => {
          const hydrated = await list();
          assertUnique(hydrated.topics, candidate.repository, candidate.branch, id);
          const requestedTime = now().getTime();
          const nextTime = Math.max(requestedTime, Date.parse(current.updatedAt) + 1);
          const updated = parseTopicManifest(
            { ...candidate, updatedAt: new Date(nextTime).toISOString() },
            id,
          );
          try {
            await writeJsonAtomic(paths.topicManifest(id), updated);
          } catch (error) {
            throw dataError("Cannot update topic.", error);
          }
          return updated;
        });
      });
    },
  };
}

function assertUnique(
  topics: TopicManifest[],
  repository: string,
  branch: string,
  exceptId?: string,
): void {
  if (
    topics.some(
      (topic) =>
        topic.id !== exceptId && topic.repository === repository && topic.branch === branch,
    )
  ) {
    throw new WorkDataError(
      "duplicate-topic",
      "A topic with this repository and branch already exists.",
    );
  }
}

function assertTopicId(id: string): void {
  if (!isTopicId(id)) throw new WorkDataError("invalid-topic-id", "Topic id is invalid.");
}

function diagnostic(topicId: string, error: unknown): TopicDiagnostic {
  if (error instanceof WorkDataError)
    return { topicId, code: error.code, message: boundMessage(error.message) };
  return { topicId, code: "invalid-topic", message: "Topic manifest cannot be loaded." };
}

function dataError(message: string, cause: unknown): WorkDataError {
  const detail = cause instanceof Error ? cause.message : String(cause);
  return new WorkDataError("storage-error", boundMessage(`${message} ${detail}`));
}

function isCode(error: unknown, code: string): boolean {
  return error !== null && typeof error === "object" && "code" in error && error.code === code;
}
