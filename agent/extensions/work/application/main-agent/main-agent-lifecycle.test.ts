import { describe, expect, test } from "bun:test";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";
import * as Schema from "effect/Schema";
import * as TestClock from "effect/testing/TestClock";
import {
  PrivateLocalCapability,
  decodeAbsolutePath,
  decodeBranch,
  decodeRepository,
  decodeTopicId,
  type DurableTopic,
  type PrivateLocalCapability as Capability,
  type TopicId,
} from "../../domain/index.ts";
import type { MainAgentLaunch } from "../../infrastructure/desktop/index.ts";
import type {
  OperationRepositoryService,
  RevisionedTopic,
  TopicRepositoryService,
} from "../../infrastructure/storage/index.ts";
import { makeWorkState } from "../state/index.ts";
import { makeMainAgentLifecycle } from "./main-agent-lifecycle.ts";

const ID = decodeTopicId("10000000-0000-4000-8000-000000000001");
const OTHER_ID = decodeTopicId("10000000-0000-4000-8000-000000000002");
const SOCKET = decodeAbsolutePath("/tmp/pi-workd.sock");
const FILE = decodeAbsolutePath("/tmp/session.jsonl");
const ADOPTED_FILE = decodeAbsolutePath("/tmp/adopted.jsonl");
const START = "1970-01-01T00:00:00.000Z";

function topic(id: TopicId, sessionId = `session-${id}`): DurableTopic {
  return {
    id,
    name: `Topic ${id}`,
    branch: decodeBranch(`topic-${id}`),
    repository: decodeRepository("owner/repo"),
    setup: {
      state: "ready",
      repositoryAvailable: true,
      worktreeCreated: true,
      setupCommandsRun: true,
      completedCommandCount: 0,
    },
    worktreePath: decodeAbsolutePath(`/tmp/${id}`),
    mainAgent: { sessionId, sessionFile: null },
    partition: 0,
    integrationTarget: { kind: "integration-branch" },
    createdAt: START,
    updatedAt: START,
  };
}

class MemoryTopics {
  readonly rows = new Map<TopicId, RevisionedTopic>();

  constructor(topics: ReadonlyArray<DurableTopic>) {
    for (const value of topics) this.rows.set(value.id, { topic: value, revision: 0 });
  }

  service(): TopicRepositoryService {
    const service = {
      list: Effect.sync(() => [...this.rows.values()]),
      get: (id) => Effect.sync(() => this.rows.get(id)!),
      updateMainAgent: (id, identity, expectedRevision) =>
        Effect.sync(() => {
          const current = this.rows.get(id)!;
          if (current.revision !== expectedRevision) throw new Error("revision conflict");
          const updated = {
            topic: { ...current.topic, mainAgent: identity },
            revision: current.revision + 1,
          };
          this.rows.set(id, updated);
          return updated;
        }),
    } satisfies Pick<TopicRepositoryService, "list" | "get" | "updateMainAgent">;
    return service as unknown as TopicRepositoryService;
  }
}

interface StoredCapability {
  readonly kind: "registration" | "affiliation";
  readonly topicId: TopicId;
  readonly expiresAt?: string;
  consumed: boolean;
}

class MemoryCapabilities {
  readonly values = new Map<string, StoredCapability>();

  service(): OperationRepositoryService {
    const key = (capability: Capability) => Redacted.value(capability);
    const service = {
      storeCapability: (input) =>
        Effect.sync(() => {
          this.values.set(key(input.capability), {
            kind: input.kind,
            topicId: input.topicId,
            ...(input.expiresAt === undefined ? {} : { expiresAt: input.expiresAt }),
            consumed: false,
          });
        }),
      verifyCapability: (storedCapability, kind, topicId, now) =>
        Effect.sync(() => {
          const value = this.values.get(key(storedCapability));
          return (
            value !== undefined &&
            value.kind === kind &&
            value.topicId === topicId &&
            !value.consumed &&
            (value.expiresAt === undefined || value.expiresAt > now)
          );
        }),
      consumeRegistration: (registration, topicId, now) =>
        Effect.sync(() => {
          const value = this.values.get(key(registration));
          if (
            value === undefined ||
            value.kind !== "registration" ||
            value.topicId !== topicId ||
            value.consumed ||
            (value.expiresAt !== undefined && value.expiresAt <= now)
          ) {
            return false;
          }
          value.consumed = true;
          return true;
        }),
      revokeTopicCapabilities: (topicId) =>
        Effect.sync(() => {
          for (const [token, value] of this.values) {
            if (value.topicId === topicId) this.values.delete(token);
          }
        }),
    } satisfies Pick<
      OperationRepositoryService,
      "storeCapability" | "verifyCapability" | "consumeRegistration" | "revokeTopicCapabilities"
    >;
    return service as unknown as OperationRepositoryService;
  }
}

class MemoryDesktop {
  readonly launches: MainAgentLaunch[] = [];
  readonly events: string[] = [];
  openResult: "launched" | "focused" = "launched";
  closeResult: "closed" | "unavailable" = "closed";

  readonly openMainAgent = (launch: MainAgentLaunch) =>
    Effect.sync(() => {
      this.events.push(`open:${launch.topicId}`);
      this.launches.push(launch);
      return this.openResult === "focused"
        ? { kind: "focused" as const, workspace: 1, message: "Focused." }
        : { kind: "launched" as const, workspace: 1, message: "Opened." };
    });

  readonly closeMainAgent = (topicId: TopicId) =>
    Effect.sync(() => {
      this.events.push(`close:${topicId}`);
      return this.closeResult === "unavailable"
        ? { kind: "unavailable" as const, message: "Close unavailable." }
        : { kind: "closed" as const, message: "Closed." };
    });
}

const capability = (value: string) => Schema.decodeUnknownSync(PrivateLocalCapability)(value);

function make(
  topics: MemoryTopics,
  capabilities: MemoryCapabilities,
  desktop: MemoryDesktop,
  makeCapability?: () => Capability,
) {
  return Effect.gen(function* () {
    const rows = [...topics.rows.values()];
    const state = yield* makeWorkState({
      daemon: { id: "daemon", startedAt: START },
      durable: {
        topics: rows.map((row) => ({ topic: row.topic, rowRevision: row.revision })),
        repositoryStates: [],
        operations: [],
      },
    });
    const lifecycle = yield* makeMainAgentLifecycle({
      topics: topics.service(),
      capabilities: capabilities.service(),
      state,
      desktop,
      socketPath: SOCKET,
      heartbeatTimeoutMs: 15_000,
      registrationTtlMs: 30_000,
      makeSessionId: () => "reset-session",
      ...(makeCapability === undefined ? {} : { makeCapability }),
    });
    return { lifecycle, state };
  });
}

describe("Main Agent lifecycle", () => {
  test("hydrates durable identities as stopped and publishes them through Work state", async () => {
    const topics = new MemoryTopics([topic(ID)]);
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const { lifecycle, state } = yield* make(
            topics,
            new MemoryCapabilities(),
            new MemoryDesktop(),
          );
          expect(yield* lifecycle.snapshot).toEqual([
            { topicId: ID, sessionId: `session-${ID}`, activity: "stopped", connected: false },
          ]);
          const snapshot = yield* state.snapshot;
          expect(snapshot.observed.topics[0]?.value?.mainAgentActivity).toBe("stopped");
        }),
      ),
    );
  });

  test("registers once, adopts in-window sessions, rejects cross-Topic use, and survives restart", async () => {
    const topics = new MemoryTopics([topic(ID), topic(OTHER_ID)]);
    const capabilities = new MemoryCapabilities();
    const desktop = new MemoryDesktop();
    const generated = [capability("registration"), capability("affiliation")];
    let index = 0;

    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const { lifecycle } = yield* make(
            topics,
            capabilities,
            desktop,
            () => generated[index++]!,
          );
          yield* lifecycle.open(ID);
          const launch = desktop.launches[0]!;
          const lease = yield* lifecycle.register({
            connectionId: "connection-1",
            topicId: ID,
            sessionId: launch.sessionId,
            sessionFile: FILE,
            registration: launch.registrationToken,
          });
          expect(lease.activity).toBe("idle");
          const duplicate = yield* Effect.flip(
            lifecycle.register({
              connectionId: "connection-2",
              topicId: ID,
              sessionId: launch.sessionId,
              sessionFile: FILE,
              registration: launch.registrationToken,
            }),
          );
          expect(duplicate.reason).toBe("already-connected");
        }),
      ),
    );

    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const { lifecycle } = yield* make(topics, capabilities, desktop);
          const affiliation = generated[1]!;
          const crossTopic = yield* Effect.flip(
            lifecycle.adopt({
              connectionId: "foreign",
              topicId: OTHER_ID,
              sessionId: "foreign-adoption",
              sessionFile: ADOPTED_FILE,
              affiliation,
            }),
          );
          expect(crossTopic.reason).toBe("invalid-identity");
          const reattached = yield* lifecycle.adopt({
            connectionId: "same-window-after-restart",
            topicId: ID,
            sessionId: `session-${ID}`,
            sessionFile: FILE,
            affiliation,
          });
          expect(reattached).toMatchObject({ sessionId: `session-${ID}`, connected: true });
          const adopted = yield* lifecycle.adopt({
            connectionId: "connection-after-restart",
            topicId: ID,
            sessionId: "adopted-session",
            sessionFile: ADOPTED_FILE,
            affiliation,
          });
          expect(adopted).toMatchObject({ sessionId: "adopted-session", connected: true });
          expect(topics.rows.get(ID)?.topic.mainAgent).toEqual({
            sessionId: "adopted-session",
            sessionFile: ADOPTED_FILE,
          });
        }),
      ),
    );
  });

  test("expires registration and heartbeats at their deadlines without polling", async () => {
    const topics = new MemoryTopics([topic(ID)]);
    const capabilities = new MemoryCapabilities();
    const desktop = new MemoryDesktop();
    const generated = [capability("expiring-registration"), capability("window")];
    let index = 0;

    const program = Effect.scoped(
      Effect.gen(function* () {
        const { lifecycle } = yield* make(topics, capabilities, desktop, () => generated[index++]!);
        yield* lifecycle.open(ID);
        yield* TestClock.adjust("30 seconds");
        const expired = yield* Effect.flip(
          lifecycle.register({
            connectionId: "late",
            topicId: ID,
            sessionId: `session-${ID}`,
            sessionFile: FILE,
            registration: generated[0]!,
          }),
        );
        expect(expired.reason).toBe("invalid-registration");

        const attached = yield* lifecycle.adopt({
          connectionId: "window",
          topicId: ID,
          sessionId: "new-session",
          sessionFile: ADOPTED_FILE,
          affiliation: generated[1]!,
        });
        expect(attached.connected).toBeTrue();
        yield* TestClock.adjust("14 seconds");
        yield* lifecycle.heartbeat("window");
        yield* TestClock.adjust("14 seconds");
        expect((yield* lifecycle.snapshot)[0]?.connected).toBeTrue();
        yield* TestClock.adjust("1 second");
        expect((yield* lifecycle.snapshot)[0]).toMatchObject({
          activity: "failed",
          connected: false,
        });
      }),
    ).pipe(Effect.provide(TestClock.layer()));
    await Effect.runPromise(program as Effect.Effect<void>);
  });

  test("keeps an affiliated live lease when Open Main Agent focuses its existing window", async () => {
    const topics = new MemoryTopics([topic(ID)]);
    const capabilities = new MemoryCapabilities();
    const desktop = new MemoryDesktop();
    const generated = [
      capability("registration-1"),
      capability("affiliation-1"),
      capability("registration-2"),
      capability("affiliation-2"),
    ];
    let index = 0;
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const { lifecycle } = yield* make(
            topics,
            capabilities,
            desktop,
            () => generated[index++]!,
          );
          yield* lifecycle.open(ID);
          const first = desktop.launches[0]!;
          yield* lifecycle.register({
            connectionId: "existing-window",
            topicId: ID,
            sessionId: first.sessionId,
            sessionFile: FILE,
            registration: first.registrationToken,
          });
          desktop.openResult = "focused";
          expect(yield* lifecycle.open(ID)).toMatchObject({ kind: "focused" });
          expect((yield* lifecycle.snapshot)[0]).toMatchObject({
            activity: "idle",
            connected: true,
          });
          const adopted = yield* lifecycle.adopt({
            connectionId: "existing-window-after-new-session",
            topicId: ID,
            sessionId: "adopted-after-focus",
            sessionFile: ADOPTED_FILE,
            affiliation: first.affiliationToken,
          });
          expect(adopted).toMatchObject({ connected: true, sessionId: "adopted-after-focus" });
        }),
      ),
    );
  });

  test("preserves the prior session file, rotates capabilities, and isolates a capability-free Delegation Job", async () => {
    const previous = {
      ...topic(ID),
      mainAgent: { sessionId: `session-${ID}`, sessionFile: FILE },
    };
    const topics = new MemoryTopics([previous]);
    const capabilities = new MemoryCapabilities();
    const desktop = new MemoryDesktop();
    const old = [capability("old-registration"), capability("old-affiliation")];
    const fresh = [capability("new-registration"), capability("new-affiliation")];
    const generated = [...old, ...fresh];
    let index = 0;

    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const { lifecycle } = yield* make(
            topics,
            capabilities,
            desktop,
            () => generated[index++]!,
          );
          yield* lifecycle.open(ID);
          yield* lifecycle.reset(ID);
          expect(desktop.events).toEqual([`open:${ID}`, `close:${ID}`, `open:${ID}`]);
          expect(topics.rows.get(ID)?.topic.mainAgent).toEqual({
            sessionId: "reset-session",
            sessionFile: null,
          });
          expect(previous.mainAgent.sessionFile).toBe(FILE);
          const stale = yield* Effect.flip(
            lifecycle.adopt({
              connectionId: "old-window",
              topicId: ID,
              sessionId: "stale-adoption",
              sessionFile: ADOPTED_FILE,
              affiliation: old[1]!,
            }),
          );
          expect(stale.reason).toBe("invalid-identity");

          // A Delegation Job receives no PI_WORK capabilities, so it cannot alter the identity.
          const delegation = yield* Effect.flip(
            lifecycle.register({
              connectionId: "delegation-job",
              topicId: ID,
              sessionId: "delegation-session",
              sessionFile: ADOPTED_FILE,
              registration: capability("absent-from-child-environment"),
            }),
          );
          expect(delegation.reason).toBe("invalid-identity");
          expect(topics.rows.get(ID)?.topic.mainAgent.sessionId).toBe("reset-session");
        }),
      ),
    );
  });

  test("does not rotate identity or capabilities when reset cannot close the old window", async () => {
    const original = { ...topic(ID), mainAgent: { sessionId: "old-session", sessionFile: FILE } };
    const topics = new MemoryTopics([original]);
    const capabilities = new MemoryCapabilities();
    const desktop = new MemoryDesktop();
    const generated = [capability("old-registration"), capability("old-affiliation")];
    let index = 0;
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const { lifecycle } = yield* make(
            topics,
            capabilities,
            desktop,
            () => generated[index++]!,
          );
          yield* lifecycle.open(ID);
          const capabilityCount = capabilities.values.size;
          desktop.closeResult = "unavailable";
          expect(yield* lifecycle.reset(ID)).toMatchObject({ kind: "unavailable" });
          expect(topics.rows.get(ID)?.topic.mainAgent).toEqual(original.mainAgent);
          expect(capabilities.values.size).toBe(capabilityCount);
          expect(desktop.launches).toHaveLength(1);
        }),
      ),
    );
  });
});
