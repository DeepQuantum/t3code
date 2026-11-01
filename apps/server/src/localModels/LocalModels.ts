import {
  LOCAL_MODEL_LOG_TAIL_LINES,
  LOCAL_MODEL_PROFILES_MAX,
  LocalModelProfile,
  LocalModelsError,
  type LocalModelGpuStats,
  type LocalModelProfileId,
  type LocalModelsListResult,
  type LocalModelStatus,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Queue from "effect/Queue";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as HostProcess from "@t3tools/shared/HostProcess";

import { ServerConfig } from "../config.ts";
import {
  directoryExists,
  execText,
  fetchText,
  findListenerPid,
  killProcessTree,
  nowIso,
  nowMs,
  readFileTail,
  readProcess,
  readProcessStart,
  readTextFile,
  sleepMs,
  spawnDetached,
  writeTextFileAtomic,
} from "./LocalModelHost.ts";
import {
  buildLaunchSpec,
  buildStopSpec,
  isCompatibleProcessImage,
  strataEngineLogPath,
  validateLaunchableProfile,
} from "./LocalModelLaunch.ts";
import {
  countBusySlots,
  parseLlamaMetrics,
  parseLlamaProps,
  parseNvidiaSmi,
  parseOpenAiModels,
  tailLines,
} from "./LocalModelProbe.ts";

const PROFILES_FILE_VERSION = 1;
const SAMPLE_INTERVAL = Duration.seconds(2);
const STOP_WAIT_MS = 20_000;
const STOP_POLL_MS = 300;
const STRATA_STOP_TIMEOUT_MS = 90_000;
const GPU_RETRY_MS = 60_000;

const ProfilesFile = Schema.Struct({
  version: Schema.Literal(PROFILES_FILE_VERSION),
  profiles: Schema.Array(LocalModelProfile),
});
const decodeProfilesFile = Schema.decodeUnknownSync(Schema.fromJsonString(ProfilesFile));
const isLocalModelsError = Schema.is(LocalModelsError);

export class LocalModels extends Context.Service<
  LocalModels,
  {
    readonly list: Effect.Effect<LocalModelsListResult, LocalModelsError>;
    readonly save: (
      profile: LocalModelProfile,
    ) => Effect.Effect<LocalModelProfile, LocalModelsError>;
    readonly remove: (profileId: LocalModelProfileId) => Effect.Effect<void, LocalModelsError>;
    readonly start: (
      profileId: LocalModelProfileId,
    ) => Effect.Effect<LocalModelStatus, LocalModelsError>;
    readonly stop: (
      profileId: LocalModelProfileId,
    ) => Effect.Effect<LocalModelStatus, LocalModelsError>;
    readonly statusStream: (
      profileId: LocalModelProfileId,
    ) => Stream.Stream<LocalModelStatus, LocalModelsError>;
  }
>()("t3/localModels/LocalModels") {}

interface RuntimeEntry {
  phase: "starting" | "stopping" | null;
  launcherPid: number | null;
  startedAt: string | null;
  error: string | null;
  launcherLogPath: string;
}

const errorMessage = (cause: unknown): string =>
  cause instanceof Error ? cause.message : String(cause);

const failure = (
  reason: LocalModelsError["reason"],
  detail: string,
  cause?: unknown,
): LocalModelsError =>
  new LocalModelsError({
    reason,
    detail,
    ...(cause === undefined ? {} : { cause }),
  });

const parseJson = (text: string): unknown => {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
};

const make = Effect.gen(function* LocalModelsMake() {
  const config = yield* ServerConfig;
  const platform = yield* HostProcess.Platform;
  const baseEnv = yield* HostProcess.Environment;
  const profilesPath = `${config.stateDir}/local-models.json`;
  const logsDir = `${config.logsDir}/local-models`;
  const runtimes = new Map<string, RuntimeEntry>();
  const startTimes = new Map<number, string | null>();
  let gpuRetryAt = 0;
  let operationQueue: Promise<unknown> = Promise.resolve();

  const serialize = <A>(operation: () => Promise<A>): Promise<A> => {
    const next = operationQueue.then(operation, operation);
    operationQueue = next.catch(() => undefined);
    return next;
  };

  const runtimeFor = (profile: LocalModelProfile): RuntimeEntry => {
    const existing = runtimes.get(profile.id);
    if (existing) return existing;
    const created: RuntimeEntry = {
      phase: null,
      launcherPid: null,
      startedAt: null,
      error: null,
      launcherLogPath: `${logsDir}/${profile.id}.log`,
    };
    runtimes.set(profile.id, created);
    return created;
  };

  const readProfiles = async (): Promise<ReadonlyArray<LocalModelProfile>> => {
    let text: string | null;
    try {
      text = await readTextFile(profilesPath);
    } catch (cause) {
      throw failure("storage-failed", errorMessage(cause), cause);
    }
    if (text === null) return [];
    try {
      return decodeProfilesFile(text).profiles;
    } catch (cause) {
      throw failure(
        "storage-failed",
        `${profilesPath} is not valid: ${errorMessage(cause)}`,
        cause,
      );
    }
  };

  const writeProfiles = async (profiles: ReadonlyArray<LocalModelProfile>): Promise<void> => {
    try {
      await writeTextFileAtomic(
        profilesPath,
        `${JSON.stringify({ version: PROFILES_FILE_VERSION, profiles }, null, 2)}\n`,
      );
    } catch (cause) {
      throw failure("storage-failed", errorMessage(cause), cause);
    }
  };

  const requireProfile = async (profileId: string): Promise<LocalModelProfile> => {
    const profile = (await readProfiles()).find((candidate) => candidate.id === profileId);
    if (!profile) throw failure("unknown-profile", profileId);
    return profile;
  };

  const sampleGpu = async (): Promise<LocalModelGpuStats | null> => {
    if (nowMs() < gpuRetryAt) return null;
    const { stdout, code } = await execText("nvidia-smi", [
      "--query-gpu=name,memory.used,memory.total,utilization.gpu,temperature.gpu",
      "--format=csv,noheader,nounits",
    ]);
    const stats = code === 0 ? parseNvidiaSmi(stdout) : null;
    if (stats === null) gpuRetryAt = nowMs() + GPU_RETRY_MS;
    return stats;
  };

  const readLogTail = async (
    profile: LocalModelProfile,
    runtime: RuntimeEntry,
  ): Promise<ReadonlyArray<string>> => {
    const strataLog =
      profile.engine === "strata" && runtime.phase !== "starting"
        ? strataEngineLogPath(profile, baseEnv.LOCALAPPDATA)
        : undefined;
    const primary = strataLog === undefined ? "" : await readFileTail(strataLog);
    const text = primary !== "" ? primary : await readFileTail(runtime.launcherLogPath);
    return tailLines(text, LOCAL_MODEL_LOG_TAIL_LINES);
  };

  const startTimeOf = async (pid: number): Promise<string | null> => {
    if (!startTimes.has(pid)) startTimes.set(pid, await readProcessStart(platform, pid));
    return startTimes.get(pid) ?? null;
  };

  const sample = async (profile: LocalModelProfile): Promise<LocalModelStatus> => {
    const runtime = runtimeFor(profile);
    const listenerPid = await findListenerPid(platform, profile.port);
    const [processInfo, gpu] = await Promise.all([
      listenerPid === null ? Promise.resolve(null) : readProcess(platform, listenerPid),
      sampleGpu(),
    ]);
    const base = `http://127.0.0.1:${profile.port}`;
    const compatible = processInfo !== null && isCompatibleProcessImage(profile, processInfo.image);

    let state: LocalModelStatus["state"];
    let reachable = false;
    let loadedModel: string | undefined;
    let activeContextSize: number | undefined;
    let slotsTotal: number | undefined;
    let slotsBusy: number | undefined;
    let metrics: ReturnType<typeof parseLlamaMetrics> = {};
    let blockedBy: string | undefined;

    if (listenerPid === null) {
      if (runtime.phase === "stopping") runtime.phase = null;
      state = runtime.phase === "starting" ? "starting" : "stopped";
    } else if (!compatible) {
      state = "blocked";
      blockedBy = processInfo?.image ?? `process ${listenerPid}`;
    } else {
      state = runtime.phase === "stopping" ? "stopping" : "running";
      if (profile.engine === "llamacpp") {
        const health = await fetchText(`${base}/health`);
        reachable = health?.status === 200;
        if (reachable) {
          const [props, slots, metricsResponse] = await Promise.all([
            fetchText(`${base}/props`),
            fetchText(`${base}/slots`),
            fetchText(`${base}/metrics`),
          ]);
          const parsedProps = parseLlamaProps(props ? parseJson(props.text) : null);
          const parsedSlots = slots?.status === 200 ? countBusySlots(parseJson(slots.text)) : null;
          loadedModel = parsedProps.modelName;
          activeContextSize =
            parsedProps.contextSize !== undefined && parsedProps.slotsTotal
              ? parsedProps.contextSize * parsedProps.slotsTotal
              : parsedProps.contextSize;
          slotsTotal = parsedSlots?.total ?? parsedProps.slotsTotal;
          slotsBusy = parsedSlots?.busy;
          metrics = metricsResponse?.status === 200 ? parseLlamaMetrics(metricsResponse.text) : {};
          if (runtime.phase === "starting") runtime.phase = null;
        } else if (runtime.phase === "starting") {
          state = "starting";
        }
      } else {
        const models = await fetchText(`${base}/v1/models`);
        reachable = models?.status === 200;
        if (reachable) {
          const parsed = parseOpenAiModels(parseJson(models?.text ?? ""));
          loadedModel = parsed.modelName;
          activeContextSize = parsed.contextSize;
        }
        if (runtime.phase === "starting") state = "starting";
      }
    }

    const startedAt =
      state === "running" || state === "starting" || state === "stopping"
        ? (runtime.startedAt ?? (listenerPid === null ? null : await startTimeOf(listenerPid)))
        : null;
    const logTail = await readLogTail(profile, runtime);
    const statusError = state === "stopped" ? (runtime.error ?? undefined) : undefined;

    return {
      profileId: profile.id,
      state,
      sampledAt: nowIso(),
      ...(listenerPid !== null && compatible ? { pid: listenerPid } : {}),
      ...(startedAt === null ? {} : { startedAt }),
      reachable,
      ...(loadedModel === undefined ? {} : { loadedModel }),
      ...(activeContextSize === undefined ? {} : { activeContextSize }),
      ...(slotsTotal === undefined ? {} : { slotsTotal }),
      ...(slotsBusy === undefined ? {} : { slotsBusy }),
      ...(metrics.promptTokensPerSecond === undefined
        ? {}
        : { promptTokensPerSecond: metrics.promptTokensPerSecond }),
      ...(metrics.generationTokensPerSecond === undefined
        ? {}
        : { generationTokensPerSecond: metrics.generationTokensPerSecond }),
      ...(metrics.kvCacheUsage === undefined ? {} : { kvCacheUsage: metrics.kvCacheUsage }),
      ...(compatible && processInfo?.memoryBytes != null
        ? { processMemoryBytes: processInfo.memoryBytes }
        : {}),
      ...(gpu === null ? {} : { gpu }),
      logTail,
      ...(blockedBy === undefined ? {} : { blockedBy }),
      ...(statusError === undefined ? {} : { error: statusError }),
    };
  };

  const launch = (profile: LocalModelProfile, runtime: RuntimeEntry): void => {
    const unsafe = validateLaunchableProfile(profile, platform);
    if (unsafe !== undefined) throw failure("invalid-profile", unsafe);
    let spec: ReturnType<typeof buildLaunchSpec>;
    try {
      spec = buildLaunchSpec(profile, { platform, baseEnv });
    } catch (cause) {
      throw failure("invalid-profile", errorMessage(cause), cause);
    }
    let launcherPid = -1;
    try {
      launcherPid = spawnDetached(spec, runtime.launcherLogPath, {
        onError: (message) => {
          if (runtime.launcherPid !== launcherPid) return;
          runtime.launcherPid = null;
          runtime.phase = null;
          runtime.error = `Could not run ${spec.command}: ${message}`;
        },
        onExit: (code, signal) => {
          if (runtime.launcherPid !== launcherPid) return;
          runtime.launcherPid = null;
          const finished = code === 0 && profile.engine === "strata";
          if (runtime.phase === "starting") runtime.phase = null;
          if (!finished && runtime.phase !== "stopping") {
            runtime.error = `The server exited (${code === null ? (signal ?? "unknown") : `code ${code}`}).`;
          }
        },
      });
    } catch (cause) {
      throw failure("launch-failed", errorMessage(cause), cause);
    }
    runtime.launcherPid = launcherPid;
  };

  const startNow = async (profileId: string): Promise<LocalModelStatus> => {
    const profile = await requireProfile(profileId);
    const runtime = runtimeFor(profile);
    if (runtime.phase !== null) {
      throw failure("already-running", `${profile.name} is ${runtime.phase}`);
    }
    const listenerPid = await findListenerPid(platform, profile.port);
    if (listenerPid !== null) {
      const processInfo = await readProcess(platform, listenerPid);
      if (processInfo !== null && isCompatibleProcessImage(profile, processInfo.image)) {
        throw failure("already-running", profile.name);
      }
      throw failure("port-in-use", `port ${profile.port} (${processInfo?.image ?? listenerPid})`);
    }
    runtime.error = null;
    runtime.startedAt = nowIso();
    runtime.phase = "starting";
    try {
      launch(profile, runtime);
    } catch (cause) {
      runtime.phase = null;
      runtime.startedAt = null;
      throw cause;
    }
    return sample(profile);
  };

  const waitForListenerGone = async (port: number): Promise<boolean> => {
    const deadline = nowMs() + STOP_WAIT_MS;
    while (nowMs() < deadline) {
      if ((await findListenerPid(platform, port)) === null) return true;
      await sleepMs(STOP_POLL_MS);
    }
    return (await findListenerPid(platform, port)) === null;
  };

  const stopNow = async (profileId: string): Promise<LocalModelStatus> => {
    const profile = await requireProfile(profileId);
    const runtime = runtimeFor(profile);
    const launcherPid = runtime.launcherPid;
    const listenerPid = await findListenerPid(platform, profile.port);
    const processInfo = listenerPid === null ? null : await readProcess(platform, listenerPid);
    if (
      listenerPid !== null &&
      !(processInfo !== null && isCompatibleProcessImage(profile, processInfo.image))
    ) {
      throw failure("port-in-use", `port ${profile.port} (${processInfo?.image ?? listenerPid})`);
    }
    if (listenerPid === null && launcherPid === null) {
      runtime.phase = null;
      throw failure("not-running", profile.name);
    }

    runtime.phase = "stopping";
    runtime.error = null;
    try {
      if (profile.engine === "strata") {
        const spec = buildStopSpec(profile, { platform, baseEnv });
        await execText(spec.command, spec.args, {
          timeoutMs: STRATA_STOP_TIMEOUT_MS,
          env: spec.env,
          ...(directoryExists(spec.cwd) ? { cwd: spec.cwd } : {}),
          windowsVerbatimArguments: spec.windowsVerbatimArguments,
        });
      }
      const current = await findListenerPid(platform, profile.port);
      if (current !== null && current === listenerPid) await killProcessTree(platform, current);
      if (launcherPid !== null && runtime.launcherPid === launcherPid) {
        await killProcessTree(platform, launcherPid);
        runtime.launcherPid = null;
      }
      if (!(await waitForListenerGone(profile.port))) {
        throw failure("stop-failed", `${profile.name} still holds port ${profile.port}`);
      }
    } finally {
      runtime.phase = null;
    }
    return sample(profile);
  };

  const validateProfile = async (profile: LocalModelProfile): Promise<void> => {
    const unsafe = validateLaunchableProfile(profile, platform);
    if (unsafe !== undefined) throw failure("invalid-profile", unsafe);
    const others = (await readProfiles()).filter((candidate) => candidate.id !== profile.id);
    if (others.length >= LOCAL_MODEL_PROFILES_MAX) {
      throw failure(
        "invalid-profile",
        `At most ${LOCAL_MODEL_PROFILES_MAX} profiles are supported`,
      );
    }
    const samePort = others.find((candidate) => candidate.port === profile.port);
    if (samePort)
      throw failure("invalid-profile", `Port ${profile.port} is used by ${samePort.name}`);
    const sameModel = others.find((candidate) => candidate.openCodeModel === profile.openCodeModel);
    if (sameModel) {
      throw failure(
        "invalid-profile",
        `${profile.openCodeModel} is already used by ${sameModel.name}`,
      );
    }
  };

  const saveNow = async (profile: LocalModelProfile): Promise<LocalModelProfile> => {
    await validateProfile(profile);
    const existing = await readProfiles();
    const next = existing.some((candidate) => candidate.id === profile.id)
      ? existing.map((candidate) => (candidate.id === profile.id ? profile : candidate))
      : [...existing, profile];
    await writeProfiles(next);
    return profile;
  };

  const removeNow = async (profileId: string): Promise<void> => {
    const existing = await readProfiles();
    const profile = existing.find((candidate) => candidate.id === profileId);
    if (!profile) throw failure("unknown-profile", profileId);
    const runtime = runtimes.get(profileId);
    if (runtime?.phase != null || (await findListenerPid(platform, profile.port)) !== null) {
      throw failure("invalid-profile", `Stop ${profile.name} before removing its profile`);
    }
    await writeProfiles(existing.filter((candidate) => candidate.id !== profileId));
    runtimes.delete(profileId);
  };

  const run = <A>(operation: () => Promise<A>, fallback: LocalModelsError["reason"]) =>
    Effect.tryPromise({
      try: operation,
      catch: (cause) =>
        isLocalModelsError(cause) ? cause : failure(fallback, errorMessage(cause), cause),
    });

  const save = Effect.fn("LocalModels.save")(function* (profile: LocalModelProfile) {
    return yield* run(() => serialize(() => saveNow(profile)), "storage-failed");
  });

  const remove = Effect.fn("LocalModels.remove")(function* (profileId: LocalModelProfileId) {
    return yield* run(() => serialize(() => removeNow(profileId)), "storage-failed");
  });

  const start = Effect.fn("LocalModels.start")(function* (profileId: LocalModelProfileId) {
    return yield* run(() => serialize(() => startNow(profileId)), "launch-failed");
  });

  const stop = Effect.fn("LocalModels.stop")(function* (profileId: LocalModelProfileId) {
    return yield* run(() => serialize(() => stopNow(profileId)), "stop-failed");
  });

  const statusStream = (profileId: LocalModelProfileId) =>
    Stream.callback<LocalModelStatus, LocalModelsError>((queue) =>
      Effect.forkScoped(
        Effect.forever(
          run(async () => sample(await requireProfile(profileId)), "launch-failed").pipe(
            Effect.flatMap((status) => Queue.offer(queue, status)),
            Effect.andThen(Effect.sleep(SAMPLE_INTERVAL)),
            Effect.catch((error) => Queue.fail(queue, error).pipe(Effect.andThen(Effect.never))),
          ),
        ),
      ).pipe(Effect.asVoid),
    );

  return LocalModels.of({
    list: run(async () => ({ profiles: await readProfiles() }), "storage-failed"),
    save,
    remove,
    start,
    stop,
    statusStream,
  });
}).pipe(Effect.withSpan("LocalModels.make"));

export const layer = Layer.effect(LocalModels, make);
