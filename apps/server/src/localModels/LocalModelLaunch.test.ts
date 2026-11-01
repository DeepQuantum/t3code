import type { LlamaCppModelProfile, StrataModelProfile } from "@t3tools/contracts";
import { describe, expect, it } from "@effect/vitest";

import {
  buildLaunchSpec,
  buildLlamaCppArgs,
  buildStrataLaunchArgs,
  buildStopSpec,
  formatStrataContext,
  isCompatibleProcessImage,
  strataEngineLogPath,
  validateLaunchableProfile,
} from "./LocalModelLaunch.ts";

const llama: LlamaCppModelProfile = {
  engine: "llamacpp",
  id: "qwen4",
  name: "Qwen3.5-4B",
  openCodeModel: "local-qwen4/qwen3.5-4b-bf16",
  port: 8084,
  contextSize: 131072,
  binaryPath: "X:\\ai\\llama.cpp\\bin\\llama-server.exe",
  modelPath: "X:\\ai\\models\\Qwen3.5-4B-BF16\\Qwen3.5-4B-BF16.gguf",
  alias: "qwen3.5-4b-bf16",
  gpuLayers: "all",
  fit: "off",
  flashAttn: "on",
  cacheTypeK: "f16",
  cacheTypeV: "f16",
  parallel: 1,
  batchSize: 512,
  ubatchSize: 128,
  threads: 16,
  reasoningBudget: 2048,
  jinja: true,
  extraArgs: [],
};

const strata: StrataModelProfile = {
  engine: "strata",
  id: "strata-qwen",
  name: "Qwen3.8-Flash-Next",
  openCodeModel: "strata-qwen/qwen3.8-flash-next-q2_0",
  port: 8081,
  contextSize: 32768,
  binaryPath: "X:\\ai\\strata-runtime\\terminal\\current\\bin\\strata.cmd",
  runtimeDir: "X:\\ai\\strata-runtime",
  dataDir: "X:\\ai\\strata-data",
  preset: "Qwen38-Q2",
  family: "qwen",
  model: "q2_0",
  kv: "int8",
  vision: "off",
  vramReserveMib: 1536,
  parallel: 1,
  extraArgs: [],
};

describe("local model launch", () => {
  it("reproduces the hand-written llama-server command", () => {
    expect(buildLlamaCppArgs(llama).join(" ")).toBe(
      [
        "--model X:\\ai\\models\\Qwen3.5-4B-BF16\\Qwen3.5-4B-BF16.gguf",
        "--alias qwen3.5-4b-bf16 --host 127.0.0.1 --port 8084",
        "--gpu-layers all --fit off --ctx-size 131072 --parallel 1",
        "--batch-size 512 --ubatch-size 128 --threads 16 --flash-attn on",
        "--cache-type-k f16 --cache-type-v f16 --jinja --reasoning-budget 2048 --metrics",
      ].join(" "),
    );
  });

  it("lets llama.cpp fit layers itself for auto and drops optional flags", () => {
    const args = buildLlamaCppArgs({
      ...llama,
      gpuLayers: "auto",
      jinja: false,
      extraArgs: ["--no-webui"],
    });
    const { threads: _t, reasoningBudget: _b, alias: _a, fit: _f, ...bare } = llama;
    expect(args).toContain("--fit");
    expect(args).not.toContain("--jinja");
    expect(args.at(-1)).toBe("--no-webui");
    expect(buildLlamaCppArgs(bare)).not.toContain("--threads");
    expect(buildLlamaCppArgs(bare)).not.toContain("--alias");
    expect(buildLlamaCppArgs(bare)).not.toContain("--fit");
  });

  it("omits the KV format for Strata when the profile leaves it to Strata", () => {
    const { kv: _kv, ...withoutKv } = strata;
    expect(buildStrataLaunchArgs(withoutKv)).not.toContain("--kv");
  });

  it("reproduces the Strata launch and stop commands", () => {
    expect(buildStrataLaunchArgs(strata).join(" ")).toBe(
      "launch --family qwen --model q2_0 --context 32k --kv int8 --vision off --data-dir X:\\ai\\strata-data --access local --port 8081 --parallel 1 --set vram-reserve-mib=1536 --save-preset Qwen38-Q2 --yes --no-tui",
    );
    const stop = buildStopSpec(strata, { platform: "win32", baseEnv: { PATH: "x" } });
    expect(stop.args.join(" ")).toBe(
      '/d /s /c "X:\\ai\\strata-runtime\\terminal\\current\\bin\\strata.cmd launch --stop --preset Qwen38-Q2"',
    );
    expect(stop.windowsVerbatimArguments).toBe(true);
    expect(stop.env.STRATA_DATA_DIR).toBe("X:\\ai\\strata-runtime");
  });

  it("runs binaries directly and strips Electron's node mode from the environment", () => {
    const spec = buildLaunchSpec(llama, {
      platform: "win32",
      baseEnv: { PATH: "x", ELECTRON_RUN_AS_NODE: "1" },
    });
    expect(spec.command).toBe(llama.binaryPath);
    expect(spec.cwd).toBe("X:\\ai\\llama.cpp\\bin");
    expect(spec.env).toEqual({ PATH: "x" });
  });

  it("formats Strata context sizes the way its CLI expects", () => {
    expect(formatStrataContext(32768)).toBe("32k");
    expect(formatStrataContext(131072)).toBe("128k");
    expect(formatStrataContext(10000)).toBe("10000");
  });

  it("refuses arguments cmd.exe could interpret", () => {
    const unsafe = { ...strata, extraArgs: ["a&calc"] };
    expect(validateLaunchableProfile(strata, "win32")).toBeUndefined();
    expect(validateLaunchableProfile(unsafe, "win32")).toContain("cmd.exe");
    expect(validateLaunchableProfile(unsafe, "linux")).toBeUndefined();
  });

  it("only treats the profile's own engine as the owner of its port", () => {
    expect(isCompatibleProcessImage(llama, "LLAMA-SERVER.EXE")).toBe(true);
    expect(isCompatibleProcessImage(llama, "node.exe")).toBe(false);
    expect(isCompatibleProcessImage(strata, "strata.exe")).toBe(true);
    expect(isCompatibleProcessImage(strata, "chrome.exe")).toBe(false);
  });

  it("finds Strata's engine log from the preset name", () => {
    expect(strataEngineLogPath(strata, "C:\\Users\\damix\\AppData\\Local")).toBe(
      "C:\\Users\\damix\\AppData\\Local\\Strata\\launch\\qwen38-q2.engine.log",
    );
    expect(strataEngineLogPath(strata, undefined)).toBeUndefined();
  });
});
