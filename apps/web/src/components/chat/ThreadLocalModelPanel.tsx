import { useAtomValue } from "@effect/atom-react";
import type { EnvironmentId, LocalModelProfile, LocalModelStatus } from "@t3tools/contracts";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import { LoaderCircleIcon, PlayIcon, SquareIcon } from "lucide-react";
import { useState, type ReactNode } from "react";

import { cn } from "../../lib/utils";
import { useEnvironment } from "../../state/environments";
import { localModelsEnvironment } from "../../state/localModels";
import { useEnvironmentQuery } from "../../state/query";
import { useAtomCommand } from "../../state/use-atom-command";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { stackedThreadToast, toastManager } from "../ui/toast";
import {
  CACHE_TYPES,
  CONTEXT_PRESETS,
  STATE_LABELS,
  TOGGLES,
  applyDraft,
  canStart,
  canStop,
  draftFromProfile,
  findLocalModelProfile,
  formatBytes,
  formatMiB,
  formatPercent,
  formatRate,
  formatTokenCount,
  formatUptime,
  isDraftDirty,
  needsRestart,
  type LocalModelDraft,
} from "./localModelPanel.logic";
import { ThreadDetailsSection } from "./ThreadDetailsSection";

const SELECT_CLASS =
  "h-7 min-w-0 rounded-md border border-input bg-background px-1.5 text-xs text-foreground outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring";

const DOT_CLASS: Record<LocalModelStatus["state"], string> = {
  stopped: "bg-muted-foreground/40",
  starting: "animate-pulse bg-warning",
  running: "bg-success",
  stopping: "animate-pulse bg-warning",
  blocked: "bg-destructive",
};

export function ThreadLocalModelPanel(props: {
  readonly environmentId: EnvironmentId;
  readonly modelSlug: string | null | undefined;
}) {
  const supported =
    useEnvironment(props.environmentId)?.serverConfig?.environment.capabilities.localModels ===
    true;
  const list = useEnvironmentQuery(
    supported && props.modelSlug
      ? localModelsEnvironment.list({ environmentId: props.environmentId, input: {} })
      : null,
  );
  const profile = findLocalModelProfile(list.data?.profiles ?? [], props.modelSlug);
  if (!profile) return null;
  return (
    <LocalModelSection
      key={profile.id}
      environmentId={props.environmentId}
      profile={profile}
      onProfilesChanged={list.refresh}
    />
  );
}

function reportFailure(title: string, error: unknown) {
  toastManager.add(
    stackedThreadToast({
      type: "error",
      title,
      description: error instanceof Error ? error.message : String(error),
    }),
  );
}

function LocalModelSection(props: {
  readonly environmentId: EnvironmentId;
  readonly profile: LocalModelProfile;
  readonly onProfilesChanged: () => void;
}) {
  const { environmentId, profile } = props;
  const statusQuery = useEnvironmentQuery(
    localModelsEnvironment.status({ environmentId, input: { profileId: profile.id } }),
  );
  const status = statusQuery.data;
  const canOperate = useAtomValue(localModelsEnvironment.start.permissionAtom(environmentId));
  const canEdit = useAtomValue(localModelsEnvironment.save.permissionAtom(environmentId));
  const startModel = useAtomCommand(localModelsEnvironment.start, {
    label: "local model start",
    reportFailure: false,
  });
  const stopModel = useAtomCommand(localModelsEnvironment.stop, {
    label: "local model stop",
    reportFailure: false,
  });
  const saveProfile = useAtomCommand(localModelsEnvironment.save, {
    label: "local model save",
    reportFailure: false,
  });
  const [busy, setBusy] = useState<"start" | "stop" | "save" | null>(null);

  const state = status?.state ?? "stopped";
  const transitioning = busy !== null || state === "stopping";

  const start = async () => {
    setBusy("start");
    const result = await startModel({ environmentId, input: { profileId: profile.id } });
    setBusy(null);
    if (result._tag === "Failure" && !isAtomCommandInterrupted(result)) {
      reportFailure(`Could not start ${profile.name}`, squashAtomCommandFailure(result));
      return false;
    }
    return true;
  };

  const stop = async () => {
    setBusy("stop");
    const result = await stopModel({ environmentId, input: { profileId: profile.id } });
    setBusy(null);
    if (result._tag === "Failure" && !isAtomCommandInterrupted(result)) {
      reportFailure(`Could not stop ${profile.name}`, squashAtomCommandFailure(result));
      return false;
    }
    return true;
  };

  const save = async (next: LocalModelProfile) => {
    setBusy("save");
    const result = await saveProfile({ environmentId, input: { profile: next } });
    setBusy(null);
    if (result._tag === "Failure" && !isAtomCommandInterrupted(result)) {
      reportFailure("Could not save the model settings", squashAtomCommandFailure(result));
      return false;
    }
    props.onProfilesChanged();
    return true;
  };

  const saveAndRestart = async (next: LocalModelProfile) => {
    if (!(await save(next))) return;
    if (!(await stop())) return;
    await start();
  };

  const restartHint = needsRestart(status ?? null, profile);

  return (
    <ThreadDetailsSection headingId="thread-details-local-model-heading" title="Local model">
      <div className="flex flex-col gap-2 px-2.5 pb-0.5">
        <div className="flex min-h-8 items-center gap-2">
          <span aria-hidden className={cn("size-2 shrink-0 rounded-full", DOT_CLASS[state])} />
          <div className="flex min-w-0 flex-1 flex-col">
            <span className="truncate text-sm font-medium leading-4 text-foreground/85">
              {profile.name}
            </span>
            <span className="truncate text-2xs leading-4 text-muted-foreground">
              {STATE_LABELS[state]} · {profile.engine === "llamacpp" ? "llama.cpp" : "Strata"} · :
              {profile.port}
            </span>
          </div>
          {canStop(state) ? (
            <Button
              size="compact"
              variant="outline"
              disabled={!canOperate || transitioning}
              onClick={() => void stop()}
            >
              {busy === "stop" ? (
                <LoaderCircleIcon aria-hidden className="animate-spin" />
              ) : (
                <SquareIcon aria-hidden className="fill-current" />
              )}
              Stop
            </Button>
          ) : (
            <Button
              size="compact"
              disabled={!canOperate || !canStart(state) || transitioning}
              onClick={() => void start()}
            >
              {busy === "start" || state === "stopping" ? (
                <LoaderCircleIcon aria-hidden className="animate-spin" />
              ) : (
                <PlayIcon aria-hidden className="fill-current" />
              )}
              Start
            </Button>
          )}
        </div>

        {state === "blocked" ? (
          <p className="m-0 text-2xs leading-4 text-destructive-foreground">
            Port {profile.port} is held by {status?.blockedBy ?? "another program"}. Stop it or
            change this model&apos;s port.
          </p>
        ) : null}
        {status?.error ? (
          <p className="m-0 text-2xs leading-4 text-destructive-foreground">{status.error}</p>
        ) : null}
        {state === "starting" ? (
          <p className="m-0 text-2xs leading-4 text-muted-foreground">
            Loading the model. Large models can take several minutes.
          </p>
        ) : null}

        {status ? <Monitor status={status} profile={profile} /> : null}

        {restartHint ? (
          <p className="m-0 text-2xs leading-4 text-warning-foreground">
            Running with {formatTokenCount(status?.activeContextSize ?? 0)} context; saved settings
            use {formatTokenCount(profile.contextSize)}. Restart to apply.
          </p>
        ) : null}

        <SettingsForm
          key={JSON.stringify(profile)}
          profile={profile}
          running={state === "running" || state === "starting"}
          disabled={!canEdit || transitioning}
          onSave={save}
          onSaveAndRestart={saveAndRestart}
        />

        {status && status.logTail.length > 0 ? (
          <details className="group text-2xs">
            <summary className="cursor-pointer list-none select-none py-1 text-muted-foreground hover:text-foreground">
              Log
            </summary>
            <pre className="m-0 max-h-40 overflow-auto rounded-md bg-muted/50 p-2 font-mono text-3xs leading-4 whitespace-pre-wrap break-all text-muted-foreground">
              {status.logTail.join("\n")}
            </pre>
          </details>
        ) : null}
      </div>
    </ThreadDetailsSection>
  );
}

function Stat(props: { readonly label: string; readonly children: ReactNode }) {
  return (
    <div className="flex min-w-0 flex-col">
      <span className="text-3xs leading-3.5 text-muted-foreground">{props.label}</span>
      <span className="truncate text-xs leading-4 tabular-nums text-foreground/85">
        {props.children}
      </span>
    </div>
  );
}

function Monitor(props: {
  readonly status: LocalModelStatus;
  readonly profile: LocalModelProfile;
}) {
  const { status } = props;
  const live = status.state === "running" || status.state === "starting";
  const gpu = status.gpu;
  const gpuRatio =
    gpu && gpu.memoryTotalMiB > 0 ? Math.min(1, gpu.memoryUsedMiB / gpu.memoryTotalMiB) : 0;
  const sampledAt = Date.parse(status.sampledAt);

  return (
    <div className="flex flex-col gap-2">
      {live ? (
        <div className="grid grid-cols-3 gap-x-3 gap-y-1.5">
          <Stat label="Context">
            {status.activeContextSize ? formatTokenCount(status.activeContextSize) : "n/a"}
          </Stat>
          <Stat label="Slots">
            {status.slotsTotal === undefined
              ? "n/a"
              : `${status.slotsBusy ?? 0}/${status.slotsTotal}`}
          </Stat>
          <Stat label="Uptime">{formatUptime(status.startedAt, sampledAt)}</Stat>
          <Stat label="Generation">{formatRate(status.generationTokensPerSecond)}</Stat>
          <Stat label="Prompt">{formatRate(status.promptTokensPerSecond)}</Stat>
          <Stat label="KV cache">{formatPercent(status.kvCacheUsage)}</Stat>
          <Stat label="Memory">
            {status.processMemoryBytes === undefined
              ? "n/a"
              : formatBytes(status.processMemoryBytes)}
          </Stat>
          <Stat label="PID">{status.pid ?? "n/a"}</Stat>
          <Stat label="Health">{status.reachable ? "OK" : "Loading"}</Stat>
        </div>
      ) : null}
      {gpu ? (
        <div className="flex flex-col gap-1">
          <div className="flex items-baseline justify-between gap-2 text-3xs leading-3.5 text-muted-foreground">
            <span className="truncate">{gpu.name}</span>
            <span className="shrink-0 tabular-nums">
              {formatMiB(gpu.memoryUsedMiB)} / {formatMiB(gpu.memoryTotalMiB)} ·{" "}
              {Math.round(gpu.utilizationPercent)}%
              {gpu.temperatureC === undefined ? "" : ` · ${Math.round(gpu.temperatureC)}°C`}
            </span>
          </div>
          <div
            role="progressbar"
            aria-label="GPU memory in use"
            aria-valuemin={0}
            aria-valuemax={gpu.memoryTotalMiB}
            aria-valuenow={gpu.memoryUsedMiB}
            className="h-1 w-full overflow-hidden rounded-full bg-foreground/10"
          >
            <div
              className={cn(
                "h-full rounded-full",
                gpuRatio > 0.92 ? "bg-warning" : "bg-foreground/50",
              )}
              style={{ width: `${Math.round(gpuRatio * 100)}%` }}
            />
          </div>
        </div>
      ) : null}
    </div>
  );
}

function Field(props: { readonly label: string; readonly children: ReactNode }) {
  return (
    <label className="grid grid-cols-[6.5rem_1fr] items-center gap-2 text-xs text-muted-foreground">
      <span className="truncate">{props.label}</span>
      {props.children}
    </label>
  );
}

function SettingsForm(props: {
  readonly profile: LocalModelProfile;
  readonly running: boolean;
  readonly disabled: boolean;
  readonly onSave: (profile: LocalModelProfile) => Promise<boolean>;
  readonly onSaveAndRestart: (profile: LocalModelProfile) => Promise<void>;
}) {
  const { profile } = props;
  const [draft, setDraft] = useState<LocalModelDraft>(() => draftFromProfile(profile));
  const [error, setError] = useState<string | null>(null);
  const dirty = isDraftDirty(profile, draft);
  const set = <K extends keyof LocalModelDraft>(key: K, value: LocalModelDraft[K]) => {
    setError(null);
    setDraft((current) => ({ ...current, [key]: value }));
  };
  const submit = async (restart: boolean) => {
    const result = applyDraft(profile, draft);
    if (!result.ok) {
      setError(result.error);
      return;
    }
    if (restart) await props.onSaveAndRestart(result.profile);
    else await props.onSave(result.profile);
  };
  const datalistId = `local-model-context-${profile.id}`;

  return (
    <details className="group text-xs">
      <summary className="cursor-pointer list-none select-none py-1 text-2xs text-muted-foreground hover:text-foreground">
        Settings{dirty ? " (unsaved)" : ""}
      </summary>
      <div className="flex flex-col gap-1.5 pt-1">
        <Field label="Context size">
          <>
            <Input
              size="compact"
              font="mono"
              value={draft.contextSize}
              list={datalistId}
              onChange={(event) => set("contextSize", event.target.value)}
              aria-label="Context size in tokens"
            />
            <datalist id={datalistId}>
              {CONTEXT_PRESETS.map((tokens) => (
                <option key={tokens} value={String(tokens)}>
                  {formatTokenCount(tokens)}
                </option>
              ))}
            </datalist>
          </>
        </Field>
        <Field label="Parallel slots">
          <Input
            size="compact"
            font="mono"
            value={draft.parallel}
            onChange={(event) => set("parallel", event.target.value)}
            aria-label="Parallel slots"
          />
        </Field>
        {profile.engine === "llamacpp" ? (
          <>
            <Field label="GPU layers">
              <Input
                size="compact"
                font="mono"
                value={draft.gpuLayers}
                onChange={(event) => set("gpuLayers", event.target.value)}
                aria-label="GPU layers: all, auto, or a number"
              />
            </Field>
            <Field label="Flash attention">
              <select
                className={SELECT_CLASS}
                value={draft.flashAttn}
                onChange={(event) =>
                  set("flashAttn", event.target.value as LocalModelDraft["flashAttn"])
                }
              >
                {TOGGLES.map((value) => (
                  <option key={value} value={value}>
                    {value}
                  </option>
                ))}
              </select>
            </Field>
            <Field label="KV cache (K)">
              <select
                className={SELECT_CLASS}
                value={draft.cacheTypeK}
                onChange={(event) =>
                  set("cacheTypeK", event.target.value as LocalModelDraft["cacheTypeK"])
                }
              >
                {CACHE_TYPES.map((value) => (
                  <option key={value} value={value}>
                    {value}
                  </option>
                ))}
              </select>
            </Field>
            <Field label="KV cache (V)">
              <select
                className={SELECT_CLASS}
                value={draft.cacheTypeV}
                onChange={(event) =>
                  set("cacheTypeV", event.target.value as LocalModelDraft["cacheTypeV"])
                }
              >
                {CACHE_TYPES.map((value) => (
                  <option key={value} value={value}>
                    {value}
                  </option>
                ))}
              </select>
            </Field>
          </>
        ) : (
          <>
            <Field label="KV format">
              <Input
                size="compact"
                font="mono"
                value={draft.kv}
                onChange={(event) => set("kv", event.target.value)}
                aria-label="KV cache format"
              />
            </Field>
            <Field label="Vision">
              <select
                className={SELECT_CLASS}
                value={draft.vision}
                onChange={(event) => set("vision", event.target.value as LocalModelDraft["vision"])}
              >
                <option value="off">off</option>
                <option value="on">on</option>
              </select>
            </Field>
            <Field label="VRAM reserve (MiB)">
              <Input
                size="compact"
                font="mono"
                value={draft.vramReserveMib}
                onChange={(event) => set("vramReserveMib", event.target.value)}
                aria-label="VRAM reserve in MiB"
              />
            </Field>
          </>
        )}
        {error ? (
          <p className="m-0 text-2xs leading-4 text-destructive-foreground">{error}</p>
        ) : null}
        <div className="flex items-center justify-end gap-1.5 pt-0.5">
          <Button
            size="compact"
            variant="outline"
            disabled={props.disabled || !dirty}
            onClick={() => void submit(false)}
          >
            Save
          </Button>
          {props.running ? (
            <Button size="compact" disabled={props.disabled} onClick={() => void submit(true)}>
              Save &amp; restart
            </Button>
          ) : null}
        </div>
      </div>
    </details>
  );
}
