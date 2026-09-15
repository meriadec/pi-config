import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { OperationId } from "../domain/index.ts";
import type {
  DurableOperation,
  OperationHandle,
  StartOperationRequest,
} from "../infrastructure/rpc/index.ts";
import type { WorkClientRuntime } from "./effect-runtime.ts";

export const DEFAULT_CLIENT_WAIT_MS = 10 * 60_000;

export class OperationWaitEnded extends Error {
  readonly operationId: OperationId;
  readonly reason: "cancelled" | "timeout";

  constructor(operationId: OperationId, reason: "cancelled" | "timeout") {
    super(
      reason === "cancelled"
        ? `The client stopped waiting for operation ${operationId}. The daemon operation was not cancelled.`
        : `The client wait for operation ${operationId} timed out. The daemon operation can continue.`,
    );
    this.name = "OperationWaitEnded";
    this.operationId = operationId;
    this.reason = reason;
  }
}

export interface OperationAdapterOptions {
  readonly client: WorkClientRuntime;
  readonly request: StartOperationRequest;
  readonly signal?: AbortSignal;
  readonly timeoutMs?: number;
  readonly context?: Pick<ExtensionContext, "hasUI" | "ui">;
  readonly confirmationText?: (handle: OperationHandle) => string;
  readonly onStarted?: (handle: OperationHandle) => void;
  readonly onUpdate?: (operation: DurableOperation) => void;
}

export type OperationAdapterResult = DurableOperation & { readonly confirmationText?: string };

/**
 * Thin Promise bridge around one scoped client runtime. Abort and timeout stop only this wait.
 * A durable operation is never cancelled as a side effect of client disposal.
 */
export async function startAndWaitForOperation(
  options: OperationAdapterOptions,
): Promise<OperationAdapterResult> {
  const timeoutMs = options.timeoutMs ?? DEFAULT_CLIENT_WAIT_MS;
  let operationId: OperationId | undefined;
  let stopWatch: (() => void) | undefined;
  try {
    throwIfAborted(options.signal);
    const handle = await abortable(options.client.startOperation(options.request), options.signal);
    operationId = handle.id;
    options.onStarted?.(handle);

    if (handle.state === "awaiting-confirmation") {
      const confirmation = handle.confirmation;
      if (confirmation === undefined)
        throw new Error("The daemon omitted an operation confirmation.");
      const confirmationText = handle.confirmationText ?? options.confirmationText?.(handle);
      if (confirmationText === undefined)
        throw new Error("The daemon omitted the direct confirmation text.");
      if (options.context?.hasUI !== true) {
        const operation = await options.client.getOperation(handle.id);
        return { ...operation, confirmationText };
      }
      const approved = await options.context.ui.confirm(
        "Confirm work Topic provisioning",
        confirmationText,
        options.signal === undefined ? undefined : { signal: options.signal },
      );
      throwIfAborted(options.signal);
      if (!approved) return await options.client.rejectOperation(handle.id);
      await options.client.confirmOperation(handle.id, confirmation);
    }

    stopWatch = options.client.watchOperation(handle.id, (operation) =>
      options.onUpdate?.(operation),
    );
    return await waitForOperationDeadline(
      options.client.awaitOperation(handle.id),
      handle.id,
      timeoutMs,
      options.signal,
    );
  } catch (error) {
    if (error instanceof OperationWaitEnded) throw error;
    if (options.signal?.aborted && operationId !== undefined) {
      throw new OperationWaitEnded(operationId, "cancelled");
    }
    throw error;
  } finally {
    stopWatch?.();
    await options.client.dispose();
  }
}

/** Bounds a client wait without changing the lifetime or state of its Durable Operation. */
export async function waitForOperationDeadline<T>(
  promise: Promise<T>,
  operationId: OperationId,
  timeoutMs: number,
  signal?: AbortSignal,
): Promise<T> {
  if (signal?.aborted) throw new OperationWaitEnded(operationId, "cancelled");
  let timer: ReturnType<typeof setTimeout> | undefined;
  let removeAbort = (): void => undefined;
  const ended = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(new OperationWaitEnded(operationId, "timeout")), timeoutMs);
    if (signal !== undefined) {
      const abort = () => reject(new OperationWaitEnded(operationId, "cancelled"));
      signal.addEventListener("abort", abort, { once: true });
      removeAbort = () => signal.removeEventListener("abort", abort);
    }
  });
  try {
    return await Promise.race([promise, ended]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
    removeAbort();
  }
}

async function abortable<T>(promise: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (signal === undefined) return promise;
  throwIfAborted(signal);
  let remove = (): void => undefined;
  const cancelled = new Promise<never>((_resolve, reject) => {
    const abort = () => reject(new DOMException("The client wait was cancelled.", "AbortError"));
    signal.addEventListener("abort", abort, { once: true });
    remove = () => signal.removeEventListener("abort", abort);
  });
  try {
    return await Promise.race([promise, cancelled]);
  } finally {
    remove();
  }
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw new DOMException("The client wait was cancelled.", "AbortError");
}
