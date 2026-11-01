import { Schema } from "effect";
import { NonNegativeInt, PositiveInt, TrimmedNonEmptyString } from "./baseSchemas.ts";

export const LOCAL_MODEL_CONTEXT_MIN = 512;
export const LOCAL_MODEL_CONTEXT_MAX = 4_194_304;
export const LOCAL_MODEL_PROFILES_MAX = 64;
export const LOCAL_MODEL_LOG_TAIL_LINES = 14;

export const LocalModelProfileId = TrimmedNonEmptyString.check(
  Schema.isMaxLength(64),
  Schema.isPattern(/^[A-Za-z0-9][A-Za-z0-9._-]*$/),
);
export type LocalModelProfileId = typeof LocalModelProfileId.Type;

const Label = TrimmedNonEmptyString.check(Schema.isMaxLength(128));
const PathString = TrimmedNonEmptyString.check(Schema.isMaxLength(1_024));
const Token = TrimmedNonEmptyString.check(Schema.isMaxLength(128));

export const LocalModelPort = Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 65_535 }));
export const LocalModelContextSize = Schema.Int.check(
  Schema.isBetween({ minimum: LOCAL_MODEL_CONTEXT_MIN, maximum: LOCAL_MODEL_CONTEXT_MAX }),
);

const ExtraArgs = Schema.Array(Schema.String.check(Schema.isMaxLength(512))).check(
  Schema.isMaxLength(64),
);

export const LocalModelCacheType = Schema.Literals([
  "f32",
  "f16",
  "bf16",
  "q8_0",
  "q5_1",
  "q5_0",
  "q4_1",
  "q4_0",
  "iq4_nl",
]);
export type LocalModelCacheType = typeof LocalModelCacheType.Type;

export const LocalModelToggle = Schema.Literals(["on", "off", "auto"]);
export type LocalModelToggle = typeof LocalModelToggle.Type;

export const LocalModelGpuLayers = Schema.Union([
  Schema.Literals(["all", "auto"]),
  NonNegativeInt.check(Schema.isLessThanOrEqualTo(4_096)),
]);
export type LocalModelGpuLayers = typeof LocalModelGpuLayers.Type;

export const LlamaCppModelProfile = Schema.Struct({
  engine: Schema.Literal("llamacpp"),
  id: LocalModelProfileId,
  name: Label,
  openCodeModel: TrimmedNonEmptyString.check(Schema.isMaxLength(256)),
  port: LocalModelPort,
  contextSize: LocalModelContextSize,
  binaryPath: PathString,
  modelPath: PathString,
  alias: Schema.optionalKey(Token),
  gpuLayers: LocalModelGpuLayers,
  fit: Schema.optionalKey(Schema.Literals(["on", "off"])),
  flashAttn: LocalModelToggle,
  cacheTypeK: LocalModelCacheType,
  cacheTypeV: LocalModelCacheType,
  parallel: PositiveInt.check(Schema.isLessThanOrEqualTo(64)),
  batchSize: PositiveInt,
  ubatchSize: PositiveInt,
  threads: Schema.optionalKey(PositiveInt.check(Schema.isLessThanOrEqualTo(1_024))),
  reasoningBudget: Schema.optionalKey(Schema.Int.check(Schema.isGreaterThanOrEqualTo(-1))),
  jinja: Schema.Boolean,
  extraArgs: ExtraArgs,
});
export type LlamaCppModelProfile = typeof LlamaCppModelProfile.Type;

export const StrataModelProfile = Schema.Struct({
  engine: Schema.Literal("strata"),
  id: LocalModelProfileId,
  name: Label,
  openCodeModel: TrimmedNonEmptyString.check(Schema.isMaxLength(256)),
  port: LocalModelPort,
  contextSize: LocalModelContextSize,
  binaryPath: PathString,
  runtimeDir: PathString,
  dataDir: PathString,
  preset: Token,
  family: Token,
  model: Token,
  kv: Schema.optionalKey(Token),
  vision: Schema.Literals(["on", "off"]),
  vramReserveMib: Schema.optionalKey(NonNegativeInt),
  parallel: PositiveInt.check(Schema.isLessThanOrEqualTo(64)),
  extraArgs: ExtraArgs,
});
export type StrataModelProfile = typeof StrataModelProfile.Type;

export const LocalModelProfile = Schema.Union([LlamaCppModelProfile, StrataModelProfile]);
export type LocalModelProfile = typeof LocalModelProfile.Type;

export const LocalModelRuntimeState = Schema.Literals([
  "stopped",
  "starting",
  "running",
  "stopping",
  "blocked",
]);
export type LocalModelRuntimeState = typeof LocalModelRuntimeState.Type;

export const LocalModelGpuStats = Schema.Struct({
  name: Schema.String,
  memoryUsedMiB: NonNegativeInt,
  memoryTotalMiB: NonNegativeInt,
  utilizationPercent: Schema.Number,
  temperatureC: Schema.optionalKey(Schema.Number),
});
export type LocalModelGpuStats = typeof LocalModelGpuStats.Type;

export const LocalModelStatus = Schema.Struct({
  profileId: LocalModelProfileId,
  state: LocalModelRuntimeState,
  sampledAt: Schema.String,
  pid: Schema.optionalKey(PositiveInt),
  startedAt: Schema.optionalKey(Schema.String),
  reachable: Schema.Boolean,
  loadedModel: Schema.optionalKey(Schema.String),
  activeContextSize: Schema.optionalKey(PositiveInt),
  slotsTotal: Schema.optionalKey(NonNegativeInt),
  slotsBusy: Schema.optionalKey(NonNegativeInt),
  promptTokensPerSecond: Schema.optionalKey(Schema.Number),
  generationTokensPerSecond: Schema.optionalKey(Schema.Number),
  kvCacheUsage: Schema.optionalKey(Schema.Number),
  processMemoryBytes: Schema.optionalKey(NonNegativeInt),
  gpu: Schema.optionalKey(LocalModelGpuStats),
  logTail: Schema.Array(Schema.String),
  blockedBy: Schema.optionalKey(Schema.String),
  error: Schema.optionalKey(Schema.String),
});
export type LocalModelStatus = typeof LocalModelStatus.Type;

export const LocalModelsListResult = Schema.Struct({
  profiles: Schema.Array(LocalModelProfile).check(Schema.isMaxLength(LOCAL_MODEL_PROFILES_MAX)),
});
export type LocalModelsListResult = typeof LocalModelsListResult.Type;

export const LocalModelsSaveInput = Schema.Struct({ profile: LocalModelProfile });
export type LocalModelsSaveInput = typeof LocalModelsSaveInput.Type;

export const LocalModelsProfileRefInput = Schema.Struct({ profileId: LocalModelProfileId });
export type LocalModelsProfileRefInput = typeof LocalModelsProfileRefInput.Type;

export const LocalModelsRemoveResult = Schema.Struct({});

export class LocalModelsError extends Schema.TaggedError<LocalModelsError>()("LocalModelsError", {
  reason: Schema.Literals([
    "unknown-profile",
    "invalid-profile",
    "already-running",
    "port-in-use",
    "not-running",
    "launch-failed",
    "stop-failed",
    "storage-failed",
  ]),
  detail: Schema.optional(Schema.String),
  cause: Schema.optional(Schema.Defect()),
}) {
  override get message() {
    const suffix = this.detail ? `: ${this.detail}` : "";
    switch (this.reason) {
      case "unknown-profile":
        return `No local model profile with that id${suffix}`;
      case "invalid-profile":
        return `The local model profile is not valid${suffix}`;
      case "already-running":
        return `This model is already running${suffix}`;
      case "port-in-use":
        return `The port is in use by another program${suffix}`;
      case "not-running":
        return `This model is not running${suffix}`;
      case "launch-failed":
        return `The model server could not be started${suffix}`;
      case "stop-failed":
        return `The model server could not be stopped${suffix}`;
      case "storage-failed":
        return `The local model profiles could not be saved${suffix}`;
    }
  }
}
