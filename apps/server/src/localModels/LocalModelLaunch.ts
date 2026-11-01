import type {
  LlamaCppModelProfile,
  LocalModelProfile,
  StrataModelProfile,
} from "@t3tools/contracts";

const LOCAL_MODEL_HOST = "127.0.0.1";

const PATH_SEPARATOR = /[\\/]/;

const baseName = (value: string): string => value.split(PATH_SEPARATOR).at(-1) ?? value;

const directoryName = (value: string): string => {
  const parts = value.split(PATH_SEPARATOR);
  return parts.length > 1 ? parts.slice(0, -1).join(value.includes("\\") ? "\\" : "/") : value;
};

const joinPath = (root: string, ...segments: ReadonlyArray<string>): string =>
  [root.replace(/[\\/]+$/, ""), ...segments].join(root.includes("\\") ? "\\" : "/");

export interface LocalModelCommandSpec {
  readonly command: string;
  readonly args: ReadonlyArray<string>;
  readonly env: Readonly<Record<string, string>>;
  readonly cwd: string;
  readonly windowsVerbatimArguments: boolean;
}

const CMD_UNSAFE_CHARACTERS = /["%^&|<>\r\n]/;
const STRIPPED_ENV_KEYS = new Set(["ELECTRON_RUN_AS_NODE", "VITE_DEV_SERVER_URL"]);

export const formatStrataContext = (tokens: number): string =>
  tokens % 1024 === 0 ? `${tokens / 1024}k` : String(tokens);

const isWindowsBatchFile = (binaryPath: string, platform: NodeJS.Platform): boolean =>
  platform === "win32" && /\.(cmd|bat)$/i.test(binaryPath);

const quoteForCmd = (value: string): string => (/[\s]/.test(value) ? `"${value}"` : value);

const findUnsafeCmdArgument = (values: ReadonlyArray<string>): string | undefined =>
  values.find((value) => CMD_UNSAFE_CHARACTERS.test(value));

export const buildLlamaCppArgs = (profile: LlamaCppModelProfile): ReadonlyArray<string> => {
  const args: Array<string> = [
    "--model",
    profile.modelPath,
    ...(profile.alias ? ["--alias", profile.alias] : []),
    "--host",
    LOCAL_MODEL_HOST,
    "--port",
    String(profile.port),
    "--gpu-layers",
    String(profile.gpuLayers),
    ...(profile.fit === undefined ? [] : ["--fit", profile.fit]),
    "--ctx-size",
    String(profile.contextSize),
    "--parallel",
    String(profile.parallel),
    "--batch-size",
    String(profile.batchSize),
    "--ubatch-size",
    String(profile.ubatchSize),
    ...(profile.threads === undefined ? [] : ["--threads", String(profile.threads)]),
    "--flash-attn",
    profile.flashAttn,
    "--cache-type-k",
    profile.cacheTypeK,
    "--cache-type-v",
    profile.cacheTypeV,
    ...(profile.jinja ? ["--jinja"] : []),
    ...(profile.reasoningBudget === undefined
      ? []
      : ["--reasoning-budget", String(profile.reasoningBudget)]),
    "--metrics",
    ...profile.extraArgs,
  ];
  return args;
};

export const buildStrataLaunchArgs = (profile: StrataModelProfile): ReadonlyArray<string> => [
  "launch",
  "--family",
  profile.family,
  "--model",
  profile.model,
  "--context",
  formatStrataContext(profile.contextSize),
  ...(profile.kv === undefined ? [] : ["--kv", profile.kv]),
  "--vision",
  profile.vision,
  "--data-dir",
  profile.dataDir,
  "--access",
  "local",
  "--port",
  String(profile.port),
  "--parallel",
  String(profile.parallel),
  ...(profile.vramReserveMib === undefined
    ? []
    : ["--set", `vram-reserve-mib=${profile.vramReserveMib}`]),
  "--save-preset",
  profile.preset,
  "--yes",
  "--no-tui",
  ...profile.extraArgs,
];

const buildStrataStopArgs = (profile: StrataModelProfile): ReadonlyArray<string> => [
  "launch",
  "--stop",
  "--preset",
  profile.preset,
];

const cleanEnvironment = (
  base: NodeJS.ProcessEnv,
  extra: Readonly<Record<string, string>>,
): Record<string, string> => {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(base)) {
    if (value !== undefined && !STRIPPED_ENV_KEYS.has(key)) env[key] = value;
  }
  return { ...env, ...extra };
};

const wrapBinary = (
  binaryPath: string,
  args: ReadonlyArray<string>,
  platform: NodeJS.Platform,
): Pick<LocalModelCommandSpec, "command" | "args" | "windowsVerbatimArguments"> => {
  if (!isWindowsBatchFile(binaryPath, platform)) {
    return { command: binaryPath, args, windowsVerbatimArguments: false };
  }
  const unsafe = findUnsafeCmdArgument([binaryPath, ...args]);
  if (unsafe !== undefined) {
    throw new Error(
      `Argument contains a character that cannot be passed through cmd.exe: ${unsafe}`,
    );
  }
  const commandLine = [binaryPath, ...args].map(quoteForCmd).join(" ");
  return {
    command: process.env.ComSpec ?? "cmd.exe",
    args: ["/d", "/s", "/c", `"${commandLine}"`],
    windowsVerbatimArguments: true,
  };
};

export interface LaunchEnvironment {
  readonly platform: NodeJS.Platform;
  readonly baseEnv: NodeJS.ProcessEnv;
}

export const buildLaunchSpec = (
  profile: LocalModelProfile,
  { platform, baseEnv }: LaunchEnvironment,
): LocalModelCommandSpec => {
  if (profile.engine === "llamacpp") {
    return {
      ...wrapBinary(profile.binaryPath, buildLlamaCppArgs(profile), platform),
      env: cleanEnvironment(baseEnv, {}),
      cwd: directoryName(profile.binaryPath),
    };
  }
  return {
    ...wrapBinary(profile.binaryPath, buildStrataLaunchArgs(profile), platform),
    env: cleanEnvironment(baseEnv, { STRATA_DATA_DIR: profile.runtimeDir, PYTHONUTF8: "1" }),
    cwd: profile.runtimeDir,
  };
};

export const buildStopSpec = (
  profile: StrataModelProfile,
  { platform, baseEnv }: LaunchEnvironment,
): LocalModelCommandSpec => {
  return {
    ...wrapBinary(profile.binaryPath, buildStrataStopArgs(profile), platform),
    env: cleanEnvironment(baseEnv, { STRATA_DATA_DIR: profile.runtimeDir, PYTHONUTF8: "1" }),
    cwd: profile.runtimeDir,
  };
};

export const validateLaunchableProfile = (
  profile: LocalModelProfile,
  platform: NodeJS.Platform,
): string | undefined => {
  if (profile.engine === "strata" && isWindowsBatchFile(profile.binaryPath, platform)) {
    const unsafe = findUnsafeCmdArgument([
      profile.binaryPath,
      profile.runtimeDir,
      profile.dataDir,
      profile.preset,
      profile.family,
      profile.model,
      ...(profile.kv === undefined ? [] : [profile.kv]),
      ...profile.extraArgs,
    ]);
    if (unsafe !== undefined) return `Contains a character cmd.exe cannot pass safely: ${unsafe}`;
  }
  return undefined;
};

const expectedProcessImage = (profile: LocalModelProfile): string =>
  profile.engine === "llamacpp" ? baseName(profile.binaryPath).toLowerCase() : "strata";

export const isCompatibleProcessImage = (profile: LocalModelProfile, image: string): boolean => {
  const normalized = image.trim().toLowerCase();
  return profile.engine === "llamacpp"
    ? normalized === expectedProcessImage(profile)
    : normalized.startsWith("strata");
};

export const strataEngineLogPath = (
  profile: StrataModelProfile,
  localAppData: string | undefined,
): string | undefined =>
  localAppData === undefined
    ? undefined
    : joinPath(localAppData, "Strata", "launch", `${profile.preset.toLowerCase()}.engine.log`);
