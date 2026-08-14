import { boundMessage } from "../shared/domain.ts";
import type { ActionId, NewTopic, PullRequestRef, TopicManifest } from "../shared/domain.ts";
import type { TopicDiagnostic } from "../shared/topic-store.ts";
import type { MainAgentEvent, MainAgentLease } from "./main-agent.ts";
import type { TopicOperation, TopicServiceEvent } from "./topic-service.ts";

export const WORK_PROTOCOL_VERSION = 8 as const;
export const MAX_FRAME_BYTES = 64 * 1024;
export const MAX_PARSE_ERRORS = 3;

export type RequestAction =
  | "ping"
  | "snapshot"
  | "subscribe"
  | "refresh"
  | "topic.create"
  | "topic.retry"
  | "topic.rename"
  | "topic.delete"
  | "workspace.access"
  | "terminal.open"
  | "agent.open"
  | "agent.reset"
  | "pull-request.open"
  | "agent.register"
  | "agent.heartbeat"
  | "agent.thinking"
  | "agent.waiting"
  | "agent.stopped"
  | "action.confirm"
  | "action.reject";

interface RequestBase {
  version: typeof WORK_PROTOCOL_VERSION;
  kind: "request";
  id: string;
  clientId: string;
}

export type WorkRequest =
  | (RequestBase & { action: "ping" | "snapshot" | "subscribe" | "refresh" })
  | (RequestBase & { action: "topic.create"; input: NewTopic })
  | (RequestBase & { action: "topic.rename"; topicId: string; name: string })
  | (RequestBase & {
      action:
        | "topic.retry"
        | "topic.delete"
        | "workspace.access"
        | "terminal.open"
        | "agent.open"
        | "agent.reset"
        | "pull-request.open";
      topicId: string;
    })
  | (RequestBase & {
      action: "agent.register";
      topicId: string;
      sessionId: string;
      sessionFile: string;
      token: string;
      affiliationToken?: string;
    })
  | (RequestBase & {
      action: "agent.heartbeat" | "agent.thinking" | "agent.waiting" | "agent.stopped";
    })
  | (RequestBase & { action: "action.confirm" | "action.reject"; token: string });

export interface PingResult {
  protocolVersion: typeof WORK_PROTOCOL_VERSION;
  pid: number;
}

export interface DaemonSnapshot {
  /** Monotonic for one daemon process. A new process starts a new daemon.startedAt identity. */
  revision: number;
  topics: readonly TopicManifest[];
  diagnostics: readonly TopicDiagnostic[];
  operations: readonly TopicOperation[];
  mainAgents: readonly MainAgentLease[];
  baseCheckouts?: Readonly<Record<string, string>>;
  deniedActions?: Readonly<Record<string, readonly ActionId[]>>;
  pullRequests?: Readonly<Record<string, PullRequestRef>>;
  daemon: {
    protocolVersion: typeof WORK_PROTOCOL_VERSION;
    pid: number;
    startedAt: string;
  };
}

export type WorkEvent =
  | TopicServiceEvent
  | MainAgentEvent
  | { type: "snapshot-changed" }
  | { type: "daemon-stopping" };

export type WorkSuccess = {
  version: typeof WORK_PROTOCOL_VERSION;
  kind: "response";
  id: string;
  ok: true;
  result: unknown;
};

export type WorkFailure = {
  version: typeof WORK_PROTOCOL_VERSION;
  kind: "response";
  id: string | null;
  ok: false;
  error: { code: string; message: string };
};

export type WorkResponse = WorkSuccess | WorkFailure;

export interface WorkEventMessage {
  version: typeof WORK_PROTOCOL_VERSION;
  kind: "event";
  /** Revision after this event was applied by this daemon process. */
  revision: number;
  event: WorkEvent;
}

export type ServerMessage = WorkResponse | WorkEventMessage;

export interface SubscriptionSnapshot {
  subscribed: true;
  snapshot: DaemonSnapshot;
}

export type DecodedFrame =
  | { ok: true; text: string }
  | { ok: false; code: "frame-too-large"; message: string };

/** Incrementally separates bounded newline-delimited UTF-8 frames. */
export class NdjsonDecoder {
  private pending = Buffer.alloc(0);
  private discardingOversizedFrame = false;

  feed(chunk: Uint8Array): DecodedFrame[] {
    const frames: DecodedFrame[] = [];
    let input = Buffer.from(chunk);

    if (this.discardingOversizedFrame) {
      const newline = input.indexOf(10);
      if (newline < 0) return frames;
      this.discardingOversizedFrame = false;
      input = input.subarray(newline + 1);
    }

    this.pending = Buffer.concat([this.pending, input]);
    while (true) {
      const newline = this.pending.indexOf(10);
      if (newline < 0) {
        if (this.pending.byteLength > MAX_FRAME_BYTES) {
          this.pending = Buffer.alloc(0);
          this.discardingOversizedFrame = true;
          frames.push({
            ok: false,
            code: "frame-too-large",
            message: `Protocol frame exceeds ${MAX_FRAME_BYTES} bytes.`,
          });
        }
        break;
      }

      const frame = this.pending.subarray(0, newline);
      this.pending = this.pending.subarray(newline + 1);
      if (frame.byteLength > MAX_FRAME_BYTES) {
        frames.push({
          ok: false,
          code: "frame-too-large",
          message: `Protocol frame exceeds ${MAX_FRAME_BYTES} bytes.`,
        });
      } else if (frame.byteLength > 0) {
        frames.push({ ok: true, text: frame.toString("utf8").replace(/\r$/, "") });
      }
    }
    return frames;
  }
}

export function parseRequest(text: string): WorkRequest {
  let input: unknown;
  try {
    input = JSON.parse(text);
  } catch {
    throw new ProtocolError("invalid-json", "Protocol frame is not valid JSON.");
  }
  if (input === null || typeof input !== "object" || Array.isArray(input)) {
    throw new ProtocolError("invalid-message", "Protocol message must be an object.");
  }
  const value = input as Record<string, unknown>;
  if (value["version"] !== WORK_PROTOCOL_VERSION) {
    throw new ProtocolError(
      "unsupported-version",
      "Unsupported protocol version.",
      requestId(value),
    );
  }
  if (value["kind"] !== "request") {
    throw new ProtocolError("unknown-kind", "Unknown protocol message kind.", requestId(value));
  }
  const id = shortString(value["id"], "invalid-id", "Request id must be a short non-empty string.");
  const clientId =
    value["clientId"] === undefined
      ? "legacy"
      : shortString(
          value["clientId"],
          "invalid-client-id",
          "Client id must be a short non-empty string.",
        );
  const base = { version: WORK_PROTOCOL_VERSION, kind: "request" as const, id, clientId };
  switch (value["action"]) {
    case "ping":
    case "snapshot":
    case "subscribe":
    case "refresh":
      return { ...base, action: value["action"] };
    case "topic.create": {
      const topic = record(value["input"], id);
      return {
        ...base,
        action: "topic.create",
        input: {
          name: shortString(topic["name"], "invalid-arguments", "Topic name is required.", id),
          branch: shortString(
            topic["branch"],
            "invalid-arguments",
            "Topic branch is required.",
            id,
          ),
          repository: shortString(
            topic["repository"],
            "invalid-arguments",
            "Topic repository is required.",
            id,
          ),
        },
      };
    }
    case "topic.rename":
      return {
        ...base,
        action: "topic.rename",
        topicId: shortString(value["topicId"], "invalid-arguments", "Topic id is required.", id),
        name: shortString(value["name"], "invalid-arguments", "Topic name is required.", id),
      };
    case "topic.retry":
    case "topic.delete":
    case "workspace.access":
    case "terminal.open":
    case "agent.open":
    case "agent.reset":
    case "pull-request.open":
      return {
        ...base,
        action: value["action"],
        topicId: shortString(value["topicId"], "invalid-arguments", "Topic id is required.", id),
      };
    case "agent.register":
      return {
        ...base,
        action: "agent.register",
        topicId: shortString(value["topicId"], "invalid-arguments", "Topic id is required.", id),
        sessionId: shortString(
          value["sessionId"],
          "invalid-arguments",
          "Session id is required.",
          id,
        ),
        sessionFile: boundedString(value["sessionFile"], 1_000, "Session file is required.", id),
        token: shortString(
          value["token"],
          "invalid-arguments",
          "Registration token is required.",
          id,
        ),
        ...(value["affiliationToken"] === undefined
          ? {}
          : {
              affiliationToken: shortString(
                value["affiliationToken"],
                "invalid-arguments",
                "Affiliation token is invalid.",
                id,
              ),
            }),
      };
    case "agent.heartbeat":
    case "agent.thinking":
    case "agent.waiting":
    case "agent.stopped":
      return { ...base, action: value["action"] };
    case "action.confirm":
    case "action.reject":
      return {
        ...base,
        action: value["action"],
        token: shortString(
          value["token"],
          "invalid-arguments",
          "Confirmation token is required.",
          id,
        ),
      };
    default:
      throw new ProtocolError("unknown-action", "Unknown protocol request action.", id);
  }
}

export class ProtocolError extends Error {
  readonly code: string;
  readonly requestId: string | null;

  constructor(code: string, message: string, requestId: string | null = null) {
    super(boundMessage(message));
    this.name = "ProtocolError";
    this.code = code;
    this.requestId = requestId;
  }
}

export function encodeMessage(message: ServerMessage | WorkRequest): string {
  const frame = `${JSON.stringify(message)}\n`;
  if (Buffer.byteLength(frame) > MAX_FRAME_BYTES) {
    throw new ProtocolError("frame-too-large", "Protocol output frame is too large.");
  }
  return frame;
}

export function failure(id: string | null, code: string, message: string): WorkFailure {
  return {
    version: WORK_PROTOCOL_VERSION,
    kind: "response",
    id,
    ok: false,
    error: { code, message: boundMessage(message) },
  };
}

function requestId(value: Record<string, unknown>): string | null {
  const id = value["id"];
  return typeof id === "string" && id.length > 0 && id.length <= 100 ? id : null;
}

function shortString(
  value: unknown,
  code: string,
  message: string,
  requestId: string | null = null,
): string {
  if (typeof value !== "string" || value.length === 0 || value.length > 200) {
    throw new ProtocolError(code, message, requestId);
  }
  return value;
}

function boundedString(
  value: unknown,
  maximum: number,
  message: string,
  requestId: string,
): string {
  if (typeof value !== "string" || value.length === 0 || value.length > maximum) {
    throw new ProtocolError("invalid-arguments", message, requestId);
  }
  return value;
}

function record(value: unknown, requestId: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new ProtocolError("invalid-arguments", "Topic input must be an object.", requestId);
  }
  return value as Record<string, unknown>;
}
