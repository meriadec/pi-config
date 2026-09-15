import { describe, expect, test } from "bun:test";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import {
  decodeBranch,
  decodeRepository,
  decodeTopicId,
  type DurableTopic,
  type ObservedTopicState,
} from "../../domain/index.ts";
import {
  WorkSnapshot,
  advanceWorkStreamCursor,
  makeWorkState,
  type ObservationFreshness,
  type WorkStreamItem,
} from "./index.ts";

const DAEMON = { id: "daemon-test", startedAt: "2026-06-01T00:00:00.000Z" } as const;
const ALPHA = decodeTopicId("10000000-0000-4000-8000-000000000001");
const BETA = decodeTopicId("10000000-0000-4000-8000-000000000002");

function topic(id = ALPHA, name = "Alpha"): DurableTopic {
  return {
    id,
    name,
    branch: decodeBranch(name.toLowerCase()),
    repository: decodeRepository("owner/repo"),
    setup: {
      state: "ready",
      repositoryAvailable: true,
      worktreeCreated: true,
      setupCommandsRun: true,
      completedCommandCount: 0,
    },
    worktreePath: null,
    mainAgent: { sessionId: "session", sessionFile: null },
    partition: 0,
    createdAt: "2026-06-01T00:00:00.000Z",
    updatedAt: "2026-06-01T00:00:00.000Z",
  };
}

const fresh = (observedAt: string): ObservationFreshness => ({ _tag: "Fresh", observedAt });

function observation(integrationStatus: ObservedTopicState["integrationStatus"]) {
  return {
    topicId: ALPHA,
    freshness: fresh("2026-06-01T00:01:00.000Z"),
    value: {
      topicId: ALPHA,
      integrationStatus,
      gitOperationState: "none" as const,
      worktreePresent: true,
      worktreeClean: true,
      orphan: false,
      mainAgentActivity: "idle" as const,
    },
  };
}

async function collect(subscription: { stream: Stream.Stream<WorkStreamItem> }, count: number) {
  return [...(await Effect.runPromise(Stream.runCollect(Stream.take(subscription.stream, count))))];
}

describe("Work state projection", () => {
  test("publishes committed row batches atomically and returns immutable snapshots", async () => {
    const state = await Effect.runPromise(makeWorkState({ daemon: DAEMON }));
    const subscription = await Effect.runPromise(state.subscribe(8));

    await Effect.runPromise(
      state.publish({
        _tag: "DurableCommitted",
        topics: {
          upsert: [
            { topic: topic(ALPHA, "Alpha"), rowRevision: 0 },
            { topic: topic(BETA, "Beta"), rowRevision: 0 },
          ],
        },
      }),
    );

    const items = await collect(subscription, 2);
    expect(items[0]?._tag).toBe("Snapshot");
    expect(items[1]).toMatchObject({ _tag: "Change", revision: 1 });
    const snapshot = await Effect.runPromise(state.snapshot);
    expect(snapshot.durable.topics.map((item) => item.topic.name)).toEqual(["Alpha", "Beta"]);
    expect(Object.isFrozen(snapshot)).toBe(true);
    expect(Object.isFrozen(snapshot.durable.topics)).toBe(true);
    expect(Schema.decodeUnknownSync(WorkSnapshot)(snapshot)).toEqual(snapshot);
    await Effect.runPromise(subscription.close);
  });

  test("serializes concurrent committed updates in publication order", async () => {
    const state = await Effect.runPromise(makeWorkState({ daemon: DAEMON }));
    const subscription = await Effect.runPromise(state.subscribe(40));

    const published = await Promise.all(
      Array.from({ length: 20 }, (_, index) =>
        Effect.runPromise(
          state.publish({
            _tag: "DurableCommitted",
            topics: { upsert: [{ topic: topic(ALPHA, `topic-${index}`), rowRevision: index }] },
          }),
        ),
      ),
    );
    const items = await collect(subscription, 21);
    const revisions = items.slice(1).map((item) => (item._tag === "Change" ? item.revision : -1));

    expect(published.map((item) => (item._tag === "Change" ? item.revision : -1))).toEqual(
      Array.from({ length: 20 }, (_, index) => index + 1),
    );
    expect(revisions).toEqual(Array.from({ length: 20 }, (_, index) => index + 1));
    expect((await Effect.runPromise(state.snapshot)).durable.topics[0]?.rowRevision).toBe(19);
    await Effect.runPromise(subscription.close);
  });

  test("projects freshness and observed changes without changing durable rows", async () => {
    const state = await Effect.runPromise(
      makeWorkState({
        daemon: DAEMON,
        durable: {
          topics: [{ topic: topic(), rowRevision: 4 }],
          repositoryStates: [],
          operations: [],
        },
      }),
    );

    await Effect.runPromise(
      state.publish({ _tag: "ObservedChanged", topics: { upsert: [observation("behind")] } }),
    );
    await Effect.runPromise(
      state.publish({
        _tag: "ObservedChanged",
        topics: {
          upsert: [
            {
              ...observation("behind"),
              freshness: {
                _tag: "Failed",
                failedAt: "2026-06-01T00:02:00.000Z",
                message: "git failed",
              },
            },
          ],
        },
      }),
    );

    const snapshot = await Effect.runPromise(state.snapshot);
    expect(snapshot.revision).toBe(2);
    expect(snapshot.durable.topics[0]?.rowRevision).toBe(4);
    expect(snapshot.observed.topics[0]).toMatchObject({
      freshness: { _tag: "Failed" },
      value: { integrationStatus: "behind" },
    });
  });

  test("does not block writers and closes an overflowing subscriber with resync", async () => {
    const state = await Effect.runPromise(makeWorkState({ daemon: DAEMON }));
    const subscription = await Effect.runPromise(state.subscribe(2));

    for (let index = 0; index < 100; index += 1) {
      await Effect.runPromise(
        state.publish({
          _tag: "ObservedChanged",
          topics: { upsert: [observation(index % 2 === 0 ? "current" : "behind")] },
        }),
      );
    }

    const items = [...(await Effect.runPromise(Stream.runCollect(subscription.stream)))];
    expect(items.map((item) => item._tag)).toEqual(["Snapshot", "Change", "ResyncRequired"]);
    expect(items[2]).toMatchObject({
      _tag: "ResyncRequired",
      expectedRevision: 2,
      actualRevision: 2,
    });
    expect(await Effect.runPromise(state.subscriberCount)).toBe(0);
  });

  test("marks revision gaps and explicit overflow as requiring resubscription", () => {
    const snapshot: WorkStreamItem = {
      _tag: "Snapshot",
      snapshot: {
        daemon: DAEMON,
        revision: 7,
        durable: { topics: [], repositoryStates: [], operations: [] },
        observed: { topics: [], pullRequests: [], diagnostics: [], activeActions: [] },
      },
    };
    const current = advanceWorkStreamCursor({ _tag: "AwaitingSnapshot" }, snapshot);
    expect(
      advanceWorkStreamCursor(current, {
        _tag: "Change",
        daemonId: DAEMON.id,
        revision: 9,
        change: { _tag: "ObservedChanged" },
      }),
    ).toEqual({ _tag: "Resubscribe" });
    expect(
      advanceWorkStreamCursor(current, {
        _tag: "ResyncRequired",
        daemonId: DAEMON.id,
        expectedRevision: 8,
        actualRevision: 9,
      }),
    ).toEqual({ _tag: "Resubscribe" });
  });

  test("releases subscriber queues when clients close", async () => {
    const state = await Effect.runPromise(makeWorkState({ daemon: DAEMON }));
    const first = await Effect.runPromise(state.subscribe());
    const second = await Effect.runPromise(state.subscribe());
    expect(await Effect.runPromise(state.subscriberCount)).toBe(2);

    await Effect.runPromise(first.close);
    await Effect.runPromise(second.close);
    await Effect.runPromise(first.close);
    expect(await Effect.runPromise(state.subscriberCount)).toBe(0);
  });
});
