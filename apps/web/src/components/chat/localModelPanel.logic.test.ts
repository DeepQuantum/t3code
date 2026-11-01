import type { LocalModelProfile, LocalModelStatus } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  applyDraft,
  draftFromProfile,
  findLocalModelProfile,
  formatTokenCount,
  formatUptime,
  isDraftDirty,
  needsRestart,
  parseContextInput,
} from "./localModelPanel.logic";

const llama: LocalModelProfile = {
  engine: "llamacpp",
  id: "qwen4",
  name: "Qwen3.5-4B",
  openCodeModel: "local-qwen4/qwen3.5-4b-bf16",
  port: 8084,
  contextSize: 131072,
  binaryPath: "X:\\ai\\llama.cpp\\bin\\llama-server.exe",
  modelPath: "X:\\ai\\models\\q.gguf",
  gpuLayers: "all",
  flashAttn: "on",
  cacheTypeK: "f16",
  cacheTypeV: "f16",
  parallel: 1,
  batchSize: 512,
  ubatchSize: 128,
  jinja: true,
  extraArgs: [],
};

const strata: LocalModelProfile = {
  engine: "strata",
  id: "strata-qwen",
  name: "Strata Qwen",
  openCodeModel: "strata-qwen/qwen3.8-flash-next-q2_0",
  port: 8081,
  contextSize: 32768,
  binaryPath: "X:\\strata.cmd",
  runtimeDir: "X:\\rt",
  dataDir: "X:\\data",
  preset: "Qwen38-Q2",
  family: "qwen",
  model: "q2_0",
  kv: "int8",
  vision: "off",
  vramReserveMib: 1536,
  parallel: 1,
  extraArgs: [],
};

describe("local model panel logic", () => {
  it("matches a profile by the selected OpenCode model, ignoring case", () => {
    expect(findLocalModelProfile([llama, strata], " Local-Qwen4/Qwen3.5-4B-BF16 ")).toBe(llama);
    expect(findLocalModelProfile([llama, strata], "claude-opus-5-5")).toBeNull();
    expect(findLocalModelProfile([llama], undefined)).toBeNull();
  });

  it("parses context sizes written as tokens or with a k/m suffix", () => {
    expect(parseContextInput("32768")).toBe(32768);
    expect(parseContextInput("32k")).toBe(32768);
    expect(parseContextInput(" 1.5K ")).toBe(1536);
    expect(parseContextInput("1m")).toBe(1_048_576);
    expect(parseContextInput("100")).toBeNull();
    expect(parseContextInput("lots")).toBeNull();
    expect(parseContextInput("9999m")).toBeNull();
  });

  it("formats token counts and uptime", () => {
    expect(formatTokenCount(131072)).toBe("128K");
    expect(formatTokenCount(1_048_576)).toBe("1M");
    expect(formatTokenCount(10000)).toBe("10,000");
    expect(formatUptime("2026-11-01T10:00:00Z", Date.parse("2026-11-01T11:05:30Z"))).toBe("1h 5m");
    expect(formatUptime(undefined, 0)).toBe("n/a");
  });

  it("applies a valid llama.cpp draft and leaves untouched fields alone", () => {
    const draft = {
      ...draftFromProfile(llama),
      contextSize: "64k",
      gpuLayers: "24",
      cacheTypeK: "q8_0",
    } as const;
    const result = applyDraft(llama, draft);
    expect(result).toEqual({
      ok: true,
      profile: { ...llama, contextSize: 65536, gpuLayers: 24, cacheTypeK: "q8_0" },
    });
  });

  it("rejects bad input with a message instead of saving", () => {
    expect(applyDraft(llama, { ...draftFromProfile(llama), contextSize: "tiny" })).toMatchObject({
      ok: false,
    });
    expect(applyDraft(llama, { ...draftFromProfile(llama), gpuLayers: "some" })).toMatchObject({
      ok: false,
    });
    expect(applyDraft(llama, { ...draftFromProfile(llama), parallel: "0" })).toMatchObject({
      ok: false,
    });
  });

  it("applies Strata edits and clears the VRAM reserve when left empty", () => {
    const draft = { ...draftFromProfile(strata), contextSize: "64k", vramReserveMib: "" };
    const result = applyDraft(strata, draft);
    expect(result.ok).toBe(true);
    if (result.ok && result.profile.engine === "strata") {
      expect(result.profile.contextSize).toBe(65536);
      expect("vramReserveMib" in result.profile).toBe(false);
    }
  });

  it("tracks unsaved edits and when a running server predates the saved context", () => {
    expect(isDraftDirty(llama, draftFromProfile(llama))).toBe(false);
    expect(isDraftDirty(llama, { ...draftFromProfile(llama), contextSize: "64k" })).toBe(true);
    const status = { state: "running", activeContextSize: 8192 } as LocalModelStatus;
    expect(needsRestart(status, llama)).toBe(true);
    expect(needsRestart({ ...status, activeContextSize: 131072 } as LocalModelStatus, llama)).toBe(
      false,
    );
    expect(needsRestart({ ...status, state: "stopped" } as LocalModelStatus, llama)).toBe(false);
    expect(needsRestart(null, llama)).toBe(false);
  });
});
