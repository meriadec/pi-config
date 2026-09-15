import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import type {
  ClientId,
  DurableOperationInput,
  DurableOperationResult,
  DurableOperationState,
  OperationFailure,
  OperationId,
  PrivateLocalCapability,
  RequestId,
  SetupStepState,
  StorageFailure,
  TopicId,
} from "../../domain/index.ts";

export interface DurableOperation {
  readonly id: OperationId;
  readonly clientId: ClientId;
  readonly requestId: RequestId;
  readonly topicId?: TopicId;
  readonly state: DurableOperationState;
  readonly phase: string;
  readonly input: DurableOperationInput;
  readonly result?: DurableOperationResult;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly terminalAt?: string;
  readonly revision: number;
}

export interface SetupStep {
  readonly operationId: OperationId;
  readonly index: number;
  readonly state: SetupStepState;
  readonly startedAt: string;
  readonly completedAt?: string;
  readonly revision: number;
}

export type OperationClaim =
  | { readonly claimed: true; readonly operation: DurableOperation }
  | { readonly claimed: false; readonly operation: DurableOperation };
export type ConfirmationConsumption = "consumed" | "expired" | "invalid";
export type OperationConfirmationConsumption =
  | { readonly status: "consumed"; readonly action: string }
  | { readonly status: "expired"; readonly action: string }
  | { readonly status: "invalid" };
export type CapabilityKind = "registration" | "affiliation";
export interface PendingConfirmation {
  readonly operationId: OperationId;
  readonly expiresAt: string;
}

type RepositoryFailure = StorageFailure | OperationFailure;

/** Deep persistence contract used by the operation engine. SQL stays in its adapter. */
export interface OperationRepository {
  readonly claim: (input: {
    readonly id: OperationId;
    readonly clientId: ClientId;
    readonly requestId: RequestId;
    readonly fingerprint: string;
    readonly topicId?: TopicId;
    readonly operationInput: DurableOperationInput;
    readonly phase: string;
    readonly now: string;
  }) => Effect.Effect<OperationClaim, RepositoryFailure>;
  readonly get: (id: OperationId) => Effect.Effect<DurableOperation, RepositoryFailure>;
  /** Associates an accepted operation after its Topic is created in a short transaction. */
  readonly attachTopic: (
    id: OperationId,
    topicId: TopicId,
    expectedRevision: number,
    now: string,
  ) => Effect.Effect<DurableOperation, RepositoryFailure>;
  readonly listActive: () => Effect.Effect<ReadonlyArray<DurableOperation>, RepositoryFailure>;
  /** Hydrates retained terminal and active operations for a complete daemon snapshot. */
  readonly listAll?: () => Effect.Effect<ReadonlyArray<DurableOperation>, RepositoryFailure>;
  readonly listPendingConfirmations: () => Effect.Effect<
    ReadonlyArray<PendingConfirmation>,
    RepositoryFailure
  >;
  readonly transition: (input: {
    readonly id: OperationId;
    readonly expectedState: DurableOperationState;
    readonly expectedRevision: number;
    readonly state: DurableOperationState;
    readonly phase: string;
    readonly now: string;
    readonly result?: DurableOperationResult;
  }) => Effect.Effect<DurableOperation, RepositoryFailure>;
  readonly listSteps: (
    id: OperationId,
  ) => Effect.Effect<ReadonlyArray<SetupStep>, RepositoryFailure>;
  readonly startSetupStep: (
    id: OperationId,
    index: number,
    expectedOperationRevision: number,
    now: string,
  ) => Effect.Effect<SetupStep, RepositoryFailure>;
  readonly completeSetupStep: (
    id: OperationId,
    index: number,
    expectedStepRevision: number,
    now: string,
  ) => Effect.Effect<SetupStep, RepositoryFailure>;
  readonly recoverInterruptedSetup: (
    now: string,
  ) => Effect.Effect<ReadonlyArray<OperationId>, RepositoryFailure>;
  readonly replayCommandResult: (input: {
    readonly clientId: ClientId;
    readonly requestId: RequestId;
    readonly fingerprint: string;
  }) => Effect.Effect<DurableOperationResult | undefined, RepositoryFailure>;
  readonly storeCommandResult: (input: {
    readonly clientId: ClientId;
    readonly requestId: RequestId;
    readonly fingerprint: string;
    readonly result: DurableOperationResult;
    readonly now: string;
  }) => Effect.Effect<
    { readonly stored: boolean; readonly result: DurableOperationResult },
    RepositoryFailure
  >;
  readonly createConfirmation: (input: {
    readonly capability: PrivateLocalCapability;
    readonly operationId?: OperationId;
    readonly action: string;
    readonly expiresAt: string;
  }) => Effect.Effect<void, RepositoryFailure>;
  readonly consumeConfirmation: (
    capability: PrivateLocalCapability,
    now: string,
  ) => Effect.Effect<ConfirmationConsumption, RepositoryFailure>;
  readonly consumeOperationConfirmation: (
    operationId: OperationId,
    capability: PrivateLocalCapability,
    now: string,
  ) => Effect.Effect<OperationConfirmationConsumption, RepositoryFailure>;
  readonly expireOperationConfirmation: (
    operationId: OperationId,
    now: string,
  ) => Effect.Effect<boolean, RepositoryFailure>;
  readonly storeCapability: (input: {
    readonly capability: PrivateLocalCapability;
    readonly kind: CapabilityKind;
    readonly topicId: TopicId;
    readonly expiresAt?: string;
    readonly now: string;
  }) => Effect.Effect<void, RepositoryFailure>;
  readonly verifyCapability: (
    capability: PrivateLocalCapability,
    kind: CapabilityKind,
    topicId: TopicId,
    now: string,
  ) => Effect.Effect<boolean, RepositoryFailure>;
  readonly consumeRegistration: (
    capability: PrivateLocalCapability,
    topicId: TopicId,
    now: string,
  ) => Effect.Effect<boolean, RepositoryFailure>;
  readonly revokeTopicCapabilities: (topicId: TopicId) => Effect.Effect<void, RepositoryFailure>;
  readonly pruneTerminalResults: (
    now: string,
    maximum?: number,
  ) => Effect.Effect<{ readonly operations: number; readonly commands: number }, RepositoryFailure>;
}

export const OperationRepository = Context.Service<OperationRepository>("Work/OperationRepository");
