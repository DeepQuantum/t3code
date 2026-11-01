import {
  LOCAL_MODEL_CONTEXT_MAX,
  LOCAL_MODEL_CONTEXT_MIN,
  type LocalModelCacheType,
  type LocalModelProfile,
  type LocalModelRuntimeState,
  type LocalModelStatus,
  type LocalModelToggle,
} from "@t3tools/contracts";

export const CONTEXT_PRESETS: ReadonlyArray<number> = [
  4_096, 8_192, 16_384, 32_768, 65_536, 131_072, 262_144, 524_288, 1_048_576,
];

export const CACHE_TYPES: ReadonlyArray<LocalModelCacheType> = [
  "f32",
  "f16",
  "bf16",
  "q8_0",
  "q5_1",
  "q5_0",
  "q4_1",
  "q4_0",
  "iq4_nl",
];

export const TOGGLES: ReadonlyArray<LocalModelToggle> = ["on", "off", "auto"];

export interface LocalModelDraft {
  readonly contextSize: string;
  readonly parallel: string;
  readonly gpuLayers: string;
  readonly flashAttn: LocalModelToggle;
  readonly cacheTypeK: LocalModelCacheType;
  readonly cacheTypeV: LocalModelCacheType;
  readonly kv: string;
  readonly vision: "on" | "off";
  readonly vramReserveMib: string;
}

export type DraftResult =
  | { readonly ok: true; readonly profile: LocalModelProfile }
  | { readonly ok: false; readonly error: string };

export function findLocalModelProfile(
  profiles: ReadonlyArray<LocalModelProfile>,
  modelSlug: string | null | undefined,
): LocalModelProfile | null {
  const wanted = modelSlug?.trim().toLowerCase();
  if (!wanted) return null;
  return profiles.find((profile) => profile.openCodeModel.toLowerCase() === wanted) ?? null;
}

export function formatTokenCount(tokens: number): string {
  if (tokens >= 1_048_576 && tokens % 1_048_576 === 0) return `${tokens / 1_048_576}M`;
  if (tokens >= 1_024 && tokens % 1_024 === 0) return `${tokens / 1_024}K`;
  return tokens.toLocaleString("en-US");
}

export function parseContextInput(text: string): number | null {
  const match = /^\s*(\d+(?:\.\d+)?)\s*([kKmM]?)\s*$/.exec(text);
  if (!match) return null;
  const unit = (match[2] ?? "").toLowerCase();
  const multiplier = unit === "k" ? 1_024 : unit === "m" ? 1_048_576 : 1;
  const value = Math.round(Number(match[1]) * multiplier);
  return Number.isSafeInteger(value) &&
    value >= LOCAL_MODEL_CONTEXT_MIN &&
    value <= LOCAL_MODEL_CONTEXT_MAX
    ? value
    : null;
}

export function formatBytes(bytes: number): string {
  const gib = bytes / 1_073_741_824;
  if (gib >= 1) return `${gib.toFixed(gib >= 10 ? 1 : 2)} GB`;
  return `${Math.round(bytes / 1_048_576)} MB`;
}

export function formatMiB(mib: number): string {
  return mib >= 1_024 ? `${(mib / 1_024).toFixed(1)} GB` : `${mib} MB`;
}

export function formatRate(value: number | undefined): string {
  if (value === undefined) return "n/a";
  return `${value >= 100 ? Math.round(value) : value.toFixed(1)} tok/s`;
}

export function formatPercent(ratio: number | undefined): string {
  return ratio === undefined ? "n/a" : `${Math.round(ratio * 100)}%`;
}

export function formatUptime(startedAt: string | undefined, now: number): string {
  if (startedAt === undefined) return "n/a";
  const started = Date.parse(startedAt);
  if (Number.isNaN(started)) return "n/a";
  const seconds = Math.max(0, Math.floor((now - started) / 1_000));
  const hours = Math.floor(seconds / 3_600);
  const minutes = Math.floor((seconds % 3_600) / 60);
  if (hours > 0) return `${hours}h ${minutes}m`;
  if (minutes > 0) return `${minutes}m ${seconds % 60}s`;
  return `${seconds}s`;
}

export const STATE_LABELS: Record<LocalModelRuntimeState, string> = {
  stopped: "Stopped",
  starting: "Starting",
  running: "Running",
  stopping: "Stopping",
  blocked: "Port in use",
};

export const canStart = (state: LocalModelRuntimeState): boolean => state === "stopped";

export const canStop = (state: LocalModelRuntimeState): boolean =>
  state === "running" || state === "starting";

export function needsRestart(status: LocalModelStatus | null, profile: LocalModelProfile): boolean {
  return (
    status !== null &&
    status.state === "running" &&
    status.activeContextSize !== undefined &&
    status.activeContextSize !== profile.contextSize
  );
}

export function draftFromProfile(profile: LocalModelProfile): LocalModelDraft {
  return {
    contextSize: String(profile.contextSize),
    parallel: String(profile.parallel),
    gpuLayers: profile.engine === "llamacpp" ? String(profile.gpuLayers) : "all",
    flashAttn: profile.engine === "llamacpp" ? profile.flashAttn : "on",
    cacheTypeK: profile.engine === "llamacpp" ? profile.cacheTypeK : "f16",
    cacheTypeV: profile.engine === "llamacpp" ? profile.cacheTypeV : "f16",
    kv: profile.engine === "strata" ? (profile.kv ?? "") : "",
    vision: profile.engine === "strata" ? profile.vision : "off",
    vramReserveMib:
      profile.engine === "strata" && profile.vramReserveMib !== undefined
        ? String(profile.vramReserveMib)
        : "",
  };
}

const parseCount = (text: string, min: number, max: number): number | null => {
  if (!/^\d+$/.test(text.trim())) return null;
  const value = Number(text);
  return value >= min && value <= max ? value : null;
};

export function applyDraft(profile: LocalModelProfile, draft: LocalModelDraft): DraftResult {
  const contextSize = parseContextInput(draft.contextSize);
  if (contextSize === null) {
    return {
      ok: false,
      error: `Context must be between ${LOCAL_MODEL_CONTEXT_MIN.toLocaleString("en-US")} and ${LOCAL_MODEL_CONTEXT_MAX.toLocaleString("en-US")} tokens (for example 32768 or 32k).`,
    };
  }
  const parallel = parseCount(draft.parallel, 1, 64);
  if (parallel === null) return { ok: false, error: "Parallel slots must be between 1 and 64." };

  if (profile.engine === "llamacpp") {
    const layers = draft.gpuLayers.trim().toLowerCase();
    const gpuLayers = layers === "all" || layers === "auto" ? layers : parseCount(layers, 0, 4_096);
    if (gpuLayers === null) {
      return { ok: false, error: "GPU layers must be all, auto, or a number." };
    }
    return {
      ok: true,
      profile: {
        ...profile,
        contextSize,
        parallel,
        gpuLayers,
        flashAttn: draft.flashAttn,
        cacheTypeK: draft.cacheTypeK,
        cacheTypeV: draft.cacheTypeV,
      },
    };
  }

  const kv = draft.kv.trim();
  const reserveText = draft.vramReserveMib.trim();
  const reserve = reserveText === "" ? undefined : parseCount(reserveText, 0, 1_000_000);
  if (reserve === null) return { ok: false, error: "VRAM reserve must be a number of MiB." };
  const { vramReserveMib: _previous, kv: _kv, ...rest } = profile;
  return {
    ok: true,
    profile: {
      ...rest,
      contextSize,
      parallel,
      ...(kv === "" ? {} : { kv }),
      vision: draft.vision,
      ...(reserve === undefined ? {} : { vramReserveMib: reserve }),
    },
  };
}

export function isDraftDirty(profile: LocalModelProfile, draft: LocalModelDraft): boolean {
  const original = draftFromProfile(profile);
  return (Object.keys(original) as Array<keyof LocalModelDraft>).some(
    (key) => original[key] !== draft[key],
  );
}
