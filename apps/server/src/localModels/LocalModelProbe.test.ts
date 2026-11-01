import { describe, expect, it } from "@effect/vitest";

import {
  countBusySlots,
  parseListenerPid,
  parseLlamaMetrics,
  parseLlamaProps,
  parseNvidiaSmi,
  parseOpenAiModels,
  parseTasklistCsv,
  tailLines,
} from "./LocalModelProbe.ts";

const NETSTAT = `
Active Connections

  Proto  Local Address          Foreign Address        State           PID
  TCP    0.0.0.0:135            0.0.0.0:0              LISTENING       1316
  TCP    127.0.0.1:80840        0.0.0.0:0              LISTENING       999
  TCP    127.0.0.1:8084         0.0.0.0:0              LISTENING       28760
  TCP    127.0.0.1:8084         127.0.0.1:50211        ESTABLISHED     28760
`;

describe("local model probes", () => {
  it("matches the exact listening port and ignores other states", () => {
    expect(parseListenerPid(NETSTAT, 8084)).toBe(28760);
    expect(parseListenerPid(NETSTAT, 808)).toBeNull();
    expect(parseListenerPid("  TCP    [::]:8084    [::]:0    LISTENING    77", 8084)).toBe(77);
  });

  it("reads image and memory from tasklist CSV in any thousands format", () => {
    const row = '"llama-server.exe","28760","Console","1","8,412,100 K"';
    expect(parseTasklistCsv(row, 28760)).toEqual({
      image: "llama-server.exe",
      memoryBytes: 8_412_100 * 1024,
    });
    expect(parseTasklistCsv('"x.exe","1","Console","1","1.234 K"', 1)?.memoryBytes).toBe(
      1234 * 1024,
    );
    expect(parseTasklistCsv("INFO: No tasks are running which match", 28760)).toBeNull();
  });

  it("parses nvidia-smi output and rejects unusable rows", () => {
    expect(parseNvidiaSmi("NVIDIA GeForce RTX 5080, 2452, 16303, 13, 39.76\n")).toEqual({
      name: "NVIDIA GeForce RTX 5080",
      memoryUsedMiB: 2452,
      memoryTotalMiB: 16303,
      utilizationPercent: 13,
      temperatureC: 39.76,
    });
    expect(parseNvidiaSmi("NVIDIA X, [N/A], 16303, 13, 40")).toBeNull();
    expect(parseNvidiaSmi("")).toBeNull();
  });

  it("extracts llama-server throughput and cache usage from Prometheus text", () => {
    const text = [
      "# HELP llamacpp:prompt_tokens_seconds Average prompt throughput in tokens/s.",
      "# TYPE llamacpp:prompt_tokens_seconds gauge",
      "llamacpp:prompt_tokens_seconds 412.5",
      "llamacpp:predicted_tokens_seconds 93.25",
      "llamacpp:kv_cache_usage_ratio 0.0625",
      "llamacpp:requests_processing 1",
      "llamacpp:requests_deferred 0",
    ].join("\n");
    expect(parseLlamaMetrics(text)).toEqual({
      promptTokensPerSecond: 412.5,
      generationTokensPerSecond: 93.25,
      kvCacheUsage: 0.0625,
      requestsProcessing: 1,
    });
    expect(parseLlamaMetrics("llamacpp:prompt_tokens_seconds NaN")).toEqual({});
  });

  it("reads context and slots from /props and /slots", () => {
    expect(
      parseLlamaProps({
        default_generation_settings: { n_ctx: 131072 },
        total_slots: 1,
        model_alias: "qwen3.5-4b-bf16",
      }),
    ).toEqual({ contextSize: 131072, slotsTotal: 1, modelName: "qwen3.5-4b-bf16" });
    expect(parseLlamaProps("garbage")).toEqual({});
    expect(
      countBusySlots([{ is_processing: true }, { is_processing: false }, { state: 1 }]),
    ).toEqual({ total: 3, busy: 2 });
    expect(countBusySlots({ error: "slots disabled" })).toBeNull();
  });

  it("reads the loaded model from an OpenAI-compatible listing", () => {
    expect(parseOpenAiModels({ data: [{ id: "local-glm", meta: { n_ctx: 4096 } }] })).toEqual({
      modelName: "local-glm",
      contextSize: 4096,
    });
    expect(parseOpenAiModels({ data: [] })).toEqual({});
  });

  it("keeps the newest non-empty log lines without terminal colors", () => {
    expect(tailLines("a\n\n\u001b[31mred\u001b[0m\nc\n", 2)).toEqual(["red", "c"]);
  });
});
