import type { LocalModelGpuStats } from "@t3tools/contracts";

export const parseListenerPid = (netstatOutput: string, port: number): number | null => {
  for (const line of netstatOutput.split(/\r?\n/)) {
    const columns = line.trim().split(/\s+/);
    if (columns.length < 5 || !/^TCP/i.test(columns[0] ?? "")) continue;
    if (!/^LISTEN/i.test(columns[3] ?? "")) continue;
    const local = columns[1] ?? "";
    const separator = local.lastIndexOf(":");
    if (separator === -1 || Number(local.slice(separator + 1)) !== port) continue;
    const pid = Number(columns[4]);
    if (Number.isInteger(pid) && pid > 0) return pid;
  }
  return null;
};

export const parseLsofPid = (lsofOutput: string): number | null => {
  for (const line of lsofOutput.split(/\r?\n/)) {
    const pid = Number(line.trim());
    if (Number.isInteger(pid) && pid > 0) return pid;
  }
  return null;
};

export interface TasklistEntry {
  readonly image: string;
  readonly memoryBytes: number | null;
}

const splitCsvLine = (line: string): ReadonlyArray<string> =>
  [...line.matchAll(/"((?:[^"]|"")*)"/g)].map((match) => (match[1] ?? "").replaceAll('""', '"'));

export const parseTasklistCsv = (output: string, pid: number): TasklistEntry | null => {
  for (const line of output.split(/\r?\n/)) {
    const fields = splitCsvLine(line);
    if (fields.length < 5 || Number(fields[1]) !== pid) continue;
    const digits = (fields[4] ?? "").replace(/\D/g, "");
    return {
      image: fields[0] ?? "",
      memoryBytes: digits === "" ? null : Number(digits) * 1024,
    };
  }
  return null;
};

export const parseNvidiaSmi = (output: string): LocalModelGpuStats | null => {
  const line = output
    .split(/\r?\n/)
    .map((candidate) => candidate.trim())
    .find((candidate) => candidate !== "");
  if (line === undefined) return null;
  const [name, used, total, utilization, temperature] = line.split(",").map((part) => part.trim());
  const memoryUsedMiB = Number(used);
  const memoryTotalMiB = Number(total);
  const utilizationPercent = Number(utilization);
  if (
    name === undefined ||
    name === "" ||
    !Number.isFinite(memoryUsedMiB) ||
    !Number.isFinite(memoryTotalMiB) ||
    !Number.isFinite(utilizationPercent)
  ) {
    return null;
  }
  const temperatureC = Number(temperature);
  return {
    name,
    memoryUsedMiB: Math.max(0, Math.round(memoryUsedMiB)),
    memoryTotalMiB: Math.max(0, Math.round(memoryTotalMiB)),
    utilizationPercent,
    ...(temperature !== undefined && temperature !== "" && Number.isFinite(temperatureC)
      ? { temperatureC }
      : {}),
  };
};

export interface LlamaMetrics {
  readonly promptTokensPerSecond?: number;
  readonly generationTokensPerSecond?: number;
  readonly kvCacheUsage?: number;
  readonly requestsProcessing?: number;
}

const METRIC_FIELDS: ReadonlyArray<readonly [string, keyof LlamaMetrics]> = [
  ["llamacpp:prompt_tokens_seconds", "promptTokensPerSecond"],
  ["llamacpp:predicted_tokens_seconds", "generationTokensPerSecond"],
  ["llamacpp:kv_cache_usage_ratio", "kvCacheUsage"],
  ["llamacpp:requests_processing", "requestsProcessing"],
];

export const parseLlamaMetrics = (text: string): LlamaMetrics => {
  const values: Record<string, number> = {};
  for (const line of text.split(/\r?\n/)) {
    if (line.startsWith("#")) continue;
    const match =
      /^([A-Za-z_:][A-Za-z0-9_:]*)(?:\{[^}]*\})?\s+(-?[0-9.eE+-]+|NaN|[+-]?Inf)\s*$/.exec(line);
    if (!match) continue;
    const value = Number(match[2]);
    if (Number.isFinite(value)) values[match[1] ?? ""] = value;
  }
  const result: { -readonly [K in keyof LlamaMetrics]: LlamaMetrics[K] } = {};
  for (const [metric, field] of METRIC_FIELDS) {
    const value = values[metric];
    if (value !== undefined) result[field] = value;
  }
  return result;
};

export interface LlamaProps {
  readonly contextSize?: number;
  readonly slotsTotal?: number;
  readonly modelName?: string;
}

const asRecord = (value: unknown): Record<string, unknown> | null =>
  typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;

export const parseLlamaProps = (json: unknown): LlamaProps => {
  const root = asRecord(json);
  if (root === null) return {};
  const settings = asRecord(root.default_generation_settings);
  const contextSize = Number(settings?.n_ctx);
  const slotsTotal = Number(root.total_slots);
  const modelName =
    typeof root.model_alias === "string"
      ? root.model_alias
      : typeof root.model_path === "string"
        ? root.model_path
        : undefined;
  return {
    ...(Number.isInteger(contextSize) && contextSize > 0 ? { contextSize } : {}),
    ...(Number.isInteger(slotsTotal) && slotsTotal >= 0 ? { slotsTotal } : {}),
    ...(modelName === undefined ? {} : { modelName }),
  };
};

export const countBusySlots = (json: unknown): { total: number; busy: number } | null => {
  if (!Array.isArray(json)) return null;
  let busy = 0;
  for (const slot of json) {
    const record = asRecord(slot);
    if (record !== null && (record.is_processing === true || Number(record.state) === 1)) busy += 1;
  }
  return { total: json.length, busy };
};

export const parseOpenAiModels = (json: unknown): { modelName?: string; contextSize?: number } => {
  const root = asRecord(json);
  const first = Array.isArray(root?.data) ? asRecord(root.data[0]) : null;
  if (first === null) return {};
  const meta = asRecord(first.meta);
  const contextSize = Number(meta?.n_ctx ?? meta?.context_length ?? first.context_length);
  return {
    ...(typeof first.id === "string" ? { modelName: first.id } : {}),
    ...(Number.isInteger(contextSize) && contextSize > 0 ? { contextSize } : {}),
  };
};

export const tailLines = (text: string, count: number): ReadonlyArray<string> => {
  const lines = text
    .split(/\r?\n/)
    .map((line) => line.replace(/\u001b\[[0-9;]*[A-Za-z]/g, "").trimEnd())
    .filter((line) => line !== "");
  return lines.slice(-count).map((line) => (line.length > 400 ? `${line.slice(0, 400)}…` : line));
};
