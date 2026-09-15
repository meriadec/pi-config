import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";
import * as SubscriptionRef from "effect/SubscriptionRef";
import { basename, dirname } from "node:path";
import {
  AbsolutePath,
  Branch,
  ConfigurationFailure,
  Repository,
  TopicId,
  boundPublicMessage,
} from "../domain/index.ts";

export const WORK_CONFIG_VERSION = 2 as const;

const ActionPolicy = Schema.Literals(["allow", "ask", "deny"]);
const PolicyOverrides = Schema.Struct({
  "repository.clone": Schema.optional(ActionPolicy),
  "topic.create-worktree": Schema.optional(ActionPolicy),
  "topic.run-setup": Schema.optional(ActionPolicy),
  "terminal.open": Schema.optional(ActionPolicy),
  "agent.open": Schema.optional(ActionPolicy),
  "agent.reset": Schema.optional(ActionPolicy),
  "topic.delete": Schema.optional(ActionPolicy),
});
const DefaultPolicies = Schema.Struct({
  "repository.clone": ActionPolicy,
  "topic.create-worktree": ActionPolicy,
  "topic.run-setup": ActionPolicy,
  "terminal.open": ActionPolicy,
  "agent.open": ActionPolicy,
  "agent.reset": ActionPolicy,
  "topic.delete": ActionPolicy,
});
const SetupCommand = Schema.String.check(
  Schema.isMaxLength(4_000),
  Schema.makeFilter((value) => value.trim().length > 0, { expected: "a non-empty Setup command" }),
);
const RepositoryRecipe = Schema.Struct({
  setupCommands: Schema.Array(SetupCommand).check(Schema.isMaxLength(50)),
  basePath: Schema.optional(AbsolutePath),
  integrationBranch: Schema.optional(Branch),
});

/** The complete human-authored configuration format after the v1 migration. */
export const WorkConfiguration = Schema.Struct({
  version: Schema.Literal(WORK_CONFIG_VERSION),
  workBase: Schema.optional(AbsolutePath),
  policies: Schema.Struct({
    defaults: DefaultPolicies,
    repositories: Schema.Record(Repository, PolicyOverrides),
    topics: Schema.Record(TopicId, PolicyOverrides),
  }),
  repositories: Schema.Record(Repository, RepositoryRecipe),
});
export type WorkConfiguration = typeof WorkConfiguration.Type;

export interface ConfigurationDiagnostic {
  readonly revision: number;
  readonly message: string;
}

export interface ConfigurationSnapshot {
  readonly revision: number;
  readonly configuration: WorkConfiguration | undefined;
  readonly diagnostic: ConfigurationDiagnostic | undefined;
}

export interface WorkConfigurationService {
  /** Validates the startup file. The daemon must not become ready when this fails. */
  readonly validateStartup: Effect.Effect<WorkConfiguration, ConfigurationFailure>;
  /** Reloads after an explicit user refresh. */
  readonly refresh: Effect.Effect<WorkConfiguration, ConfigurationFailure>;
  /** Reloads immediately before work whose policy can change. */
  readonly loadForPolicyCommand: Effect.Effect<WorkConfiguration, ConfigurationFailure>;
  /** Atomically writes only an explicitly supplied, already-current configuration. */
  readonly write: (
    configuration: WorkConfiguration,
  ) => Effect.Effect<WorkConfiguration, ConfigurationFailure>;
  /** Includes the last valid value after a later invalid edit, for display only. */
  readonly display: Effect.Effect<ConfigurationSnapshot>;
  /** Snapshot-first publication of valid reloads and safe diagnostics. */
  readonly changes: Stream.Stream<ConfigurationSnapshot>;
}

export function makeWorkConfigurationService(
  path: string,
): Effect.Effect<WorkConfigurationService, never, FileSystem.FileSystem> {
  return Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const lock = yield* Semaphore.make(1);
    const state = yield* SubscriptionRef.make<ConfigurationSnapshot>({
      revision: 0,
      configuration: undefined,
      diagnostic: undefined,
    });

    const publishFailure = (failure: ConfigurationFailure) =>
      SubscriptionRef.update(state, (current) => {
        const revision = current.revision + 1;
        return {
          revision,
          configuration: current.configuration,
          diagnostic: { revision, message: failure.message },
        };
      }).pipe(Effect.andThen(Effect.fail(failure)));

    const read = Effect.gen(function* () {
      const exists = yield* fs
        .exists(path)
        .pipe(
          Effect.mapError((cause) =>
            configurationFailure("unavailable", "Cannot inspect Work configuration.", cause),
          ),
        );
      if (!exists) {
        return yield* Effect.fail(
          configurationFailure("missing", "Work configuration does not exist.", path),
        );
      }
      yield* validatePrivatePath(fs, path);
      const text = yield* fs
        .readFileString(path)
        .pipe(
          Effect.mapError((cause) =>
            configurationFailure("unavailable", "Cannot read Work configuration.", cause),
          ),
        );
      const json = yield* Effect.try({
        try: () => JSON.parse(text) as unknown,
        catch: (cause) =>
          configurationFailure("invalid", "Work configuration is not valid JSON.", cause),
      });
      return yield* decodeConfiguration(json);
    });

    const reload = lock.withPermit(
      read.pipe(
        Effect.tap((configuration) =>
          SubscriptionRef.update(state, (current) => ({
            revision: current.revision + 1,
            configuration,
            diagnostic: undefined,
          })),
        ),
        Effect.catch((failure) => publishFailure(failure)),
      ),
    );

    const write = (configuration: WorkConfiguration) =>
      lock.withPermit(
        decodeConfiguration(configuration).pipe(
          Effect.tap((validated) => writeAtomic(fs, path, validated)),
          Effect.tap((validated) =>
            SubscriptionRef.update(state, (current) => ({
              revision: current.revision + 1,
              configuration: validated,
              diagnostic: undefined,
            })),
          ),
          Effect.catch((failure) => publishFailure(failure)),
        ),
      );

    return {
      validateStartup: reload,
      refresh: reload,
      loadForPolicyCommand: reload,
      write,
      display: SubscriptionRef.get(state),
      changes: SubscriptionRef.changes(state),
    };
  });
}

function decodeConfiguration(
  input: unknown,
): Effect.Effect<WorkConfiguration, ConfigurationFailure> {
  return Schema.decodeUnknownEffect(WorkConfiguration, {
    errors: "first",
    onExcessProperty: "error",
  })(input).pipe(
    Effect.mapError((cause) =>
      configurationFailure("invalid", `Work configuration is invalid: ${cause.message}`, cause),
    ),
  );
}

function validatePrivatePath(
  fs: FileSystem.FileSystem,
  path: string,
): Effect.Effect<void, ConfigurationFailure> {
  return Effect.gen(function* () {
    const directoryInfo = yield* fs.stat(dirname(path));
    const fileInfo = yield* fs.stat(path);
    if (directoryInfo.type !== "Directory" || (directoryInfo.mode & 0o077) !== 0) {
      return yield* Effect.fail(
        configurationFailure(
          "unavailable",
          "Work configuration directory must be private (mode 0700).",
          directoryInfo,
        ),
      );
    }
    if (fileInfo.type !== "File" || (fileInfo.mode & 0o077) !== 0) {
      return yield* Effect.fail(
        configurationFailure(
          "unavailable",
          "Work configuration file must be private (mode 0600).",
          fileInfo,
        ),
      );
    }
  }).pipe(
    Effect.mapError((cause) =>
      cause instanceof ConfigurationFailure
        ? cause
        : configurationFailure("unavailable", "Cannot validate Work configuration.", cause),
    ),
  );
}

function writeAtomic(
  fs: FileSystem.FileSystem,
  path: string,
  configuration: WorkConfiguration,
): Effect.Effect<void, ConfigurationFailure> {
  const parent = dirname(path);
  return Effect.gen(function* () {
    yield* fs.makeDirectory(parent, { recursive: true, mode: 0o700 });
    yield* fs.chmod(parent, 0o700);
    const temporaryPath = yield* fs.makeTempFile({
      directory: parent,
      prefix: `.${basename(path)}.`,
      suffix: ".tmp",
    });
    yield* Effect.gen(function* () {
      yield* fs.writeFileString(temporaryPath, `${JSON.stringify(configuration, null, 2)}\n`, {
        flag: "w",
        mode: 0o600,
      });
      yield* fs.chmod(temporaryPath, 0o600);
      yield* Effect.scoped(
        Effect.gen(function* () {
          const file = yield* fs.open(temporaryPath, { flag: "r" });
          yield* file.sync;
        }),
      );
      yield* fs.rename(temporaryPath, path);
      yield* fs.chmod(path, 0o600);
      yield* Effect.scoped(
        Effect.gen(function* () {
          const directory = yield* fs.open(parent, { flag: "r" });
          yield* directory.sync;
        }),
      );
    }).pipe(
      Effect.ensuring(
        fs.remove(temporaryPath, { force: true }).pipe(Effect.catchCause(() => Effect.void)),
      ),
    );
  }).pipe(
    Effect.mapError((cause) =>
      configurationFailure("unavailable", "Cannot write Work configuration.", cause),
    ),
  );
}

function configurationFailure(
  reason: "missing" | "invalid" | "unsupported-version" | "unavailable",
  message: string,
  internalCause: unknown,
): ConfigurationFailure {
  return new ConfigurationFailure({
    reason,
    message: boundPublicMessage(message),
    internalCause,
  });
}
