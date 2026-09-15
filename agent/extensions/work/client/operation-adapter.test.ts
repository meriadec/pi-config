import { describe, expect, test } from "bun:test";
import { ClientId, OperationId, TopicId } from "../domain/index.ts";
import type { DurableOperation, StartOperationRequest } from "../infrastructure/rpc/index.ts";
import type { WorkClientRuntime } from "./effect-runtime.ts";
import { OperationWaitEnded, startAndWaitForOperation } from "./operation-adapter.ts";

const operationId = OperationId.make("10000000-0000-4000-8000-000000000001");
const topicId = TopicId.make("20000000-0000-4000-8000-000000000001");
const request: StartOperationRequest = {
  fingerprint: "topic-create",
  input: { version: 1, kind: "topic.provision", value: {} },
};

function operation(state: DurableOperation["state"]): DurableOperation {
  return {
    id: operationId,
    clientId: ClientId.make("30000000-0000-4000-8000-000000000001"),
    requestId: "40000000-0000-4000-8000-000000000001" as never,
    topicId,
    state,
    phase: "setup",
    input: request.input,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:01.000Z",
    revision: 1,
  };
}

function fake(overrides: Partial<WorkClientRuntime> = {}) {
  let disposed = 0;
  let cancellationRequests = 0;
  const runtime = {
    clientId: ClientId.make("30000000-0000-4000-8000-000000000001"),
    startOperation: async () => ({ id: operationId, state: "running" as const }),
    awaitOperation: async () => operation("succeeded"),
    getOperation: async () => operation("running"),
    watchOperation: () => () => undefined,
    requestOperationCancellation: async () => {
      cancellationRequests += 1;
      return { confirmation: "secret" };
    },
    dispose: async () => {
      disposed += 1;
    },
    ...overrides,
  } as unknown as WorkClientRuntime;
  return { runtime, disposed: () => disposed, cancellationRequests: () => cancellationRequests };
}

describe("Operation Handle Promise adapter", () => {
  test("starts, watches, returns the semantic terminal operation, and closes its runtime", async () => {
    const item = fake();
    expect((await startAndWaitForOperation({ client: item.runtime, request })).state).toBe(
      "succeeded",
    );
    expect(item.disposed()).toBe(1);
  });

  test("client cancellation stops waiting without requesting daemon cancellation", async () => {
    const controller = new AbortController();
    const item = fake({ awaitOperation: () => new Promise(() => undefined) });
    const waiting = startAndWaitForOperation({
      client: item.runtime,
      request,
      signal: controller.signal,
    });
    await Promise.resolve();
    controller.abort();
    await expect(waiting).rejects.toBeInstanceOf(OperationWaitEnded);
    expect(item.cancellationRequests()).toBe(0);
    expect(item.disposed()).toBe(1);
  });

  test("returns awaiting-confirmation headlessly without consuming the capability", async () => {
    let confirmed = false;
    const item = fake({
      startOperation: async () => ({
        id: operationId,
        state: "awaiting-confirmation",
        confirmation: "secret",
      }),
      confirmOperation: async () => {
        confirmed = true;
        return operation("running");
      },
    });
    const result = await startAndWaitForOperation({
      client: item.runtime,
      request,
      context: { hasUI: false, ui: {} as never },
    });
    expect(result.state).toBe("running");
    expect(confirmed).toBeFalse();
  });
});
