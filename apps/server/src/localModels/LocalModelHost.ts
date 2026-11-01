// @effect-diagnostics nodeBuiltinImport:off globalDate:off globalTimers:off globalFetch:off
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

import type { LocalModelCommandSpec } from "./LocalModelLaunch.ts";
import {
  parseListenerPid,
  parseLsofPid,
  parseTasklistCsv,
  type TasklistEntry,
} from "./LocalModelProbe.ts";

const COMMAND_TIMEOUT_MS = 4_000;
const HTTP_TIMEOUT_MS = 1_500;
const LOG_TAIL_BYTES = 24 * 1_024;

export interface ExecResult {
  readonly stdout: string;
  readonly code: number | null;
}

export interface ExecOptions {
  readonly timeoutMs?: number;
  readonly env?: Readonly<Record<string, string>>;
  readonly cwd?: string;
  readonly windowsVerbatimArguments?: boolean;
}

export const nowMs = (): number => Date.now();

export const nowIso = (): string => new Date().toISOString();

export const sleepMs = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

export const directoryExists = (directory: string): boolean => NodeFS.existsSync(directory);

export const execText = (
  file: string,
  args: ReadonlyArray<string>,
  options: ExecOptions = {},
): Promise<ExecResult> =>
  new Promise((resolve) => {
    NodeChildProcess.execFile(
      file,
      [...args],
      {
        timeout: options.timeoutMs ?? COMMAND_TIMEOUT_MS,
        windowsHide: true,
        maxBuffer: 16 * 1_024 * 1_024,
        ...(options.env === undefined ? {} : { env: { ...options.env } }),
        ...(options.cwd === undefined ? {} : { cwd: options.cwd }),
        ...(options.windowsVerbatimArguments === undefined
          ? {}
          : { windowsVerbatimArguments: options.windowsVerbatimArguments }),
      },
      (error, stdout) => {
        resolve({
          stdout: String(stdout ?? ""),
          code: error === null ? 0 : typeof error.code === "number" ? error.code : 1,
        });
      },
    );
  });

export const fetchText = async (
  url: string,
): Promise<{ readonly status: number; readonly text: string } | null> => {
  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(HTTP_TIMEOUT_MS) });
    return { status: response.status, text: await response.text() };
  } catch {
    return null;
  }
};

export const readTextFile = async (filePath: string): Promise<string | null> => {
  try {
    return await NodeFS.promises.readFile(filePath, "utf8");
  } catch (cause) {
    if ((cause as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw cause;
  }
};

export const writeTextFileAtomic = async (filePath: string, text: string): Promise<void> => {
  const temporary = `${filePath}.${process.pid}.tmp`;
  try {
    await NodeFS.promises.mkdir(NodePath.dirname(filePath), { recursive: true });
    await NodeFS.promises.writeFile(temporary, text, "utf8");
    await NodeFS.promises.rename(temporary, filePath);
  } catch (cause) {
    await NodeFS.promises.rm(temporary, { force: true }).catch(() => undefined);
    throw cause;
  }
};

export const readFileTail = async (filePath: string): Promise<string> => {
  let handle: NodeFS.promises.FileHandle | undefined;
  try {
    handle = await NodeFS.promises.open(filePath, "r");
    const { size } = await handle.stat();
    const length = Math.min(size, LOG_TAIL_BYTES);
    const buffer = Buffer.alloc(length);
    await handle.read(buffer, 0, length, size - length);
    return buffer.toString("utf8");
  } catch {
    return "";
  } finally {
    await handle?.close().catch(() => undefined);
  }
};

export const findListenerPid = async (
  platform: NodeJS.Platform,
  port: number,
): Promise<number | null> => {
  if (platform === "win32") {
    for (const protocol of ["tcp", "tcpv6"]) {
      const { stdout } = await execText("netstat.exe", ["-ano", "-p", protocol]);
      const pid = parseListenerPid(stdout, port);
      if (pid !== null) return pid;
    }
    return null;
  }
  const { stdout } = await execText("lsof", ["-nP", `-iTCP:${port}`, "-sTCP:LISTEN", "-t"]);
  return parseLsofPid(stdout);
};

export const readProcess = async (
  platform: NodeJS.Platform,
  pid: number,
): Promise<TasklistEntry | null> => {
  if (platform === "win32") {
    const { stdout } = await execText("tasklist.exe", [
      "/FI",
      `PID eq ${pid}`,
      "/FO",
      "CSV",
      "/NH",
    ]);
    return parseTasklistCsv(stdout, pid);
  }
  const { stdout } = await execText("ps", ["-o", "comm=,rss=", "-p", String(pid)]);
  const match = /^\s*(.+?)\s+(\d+)\s*$/.exec(stdout.trim());
  if (!match) return null;
  return { image: NodePath.basename(match[1] ?? ""), memoryBytes: Number(match[2]) * 1_024 };
};

export const readProcessStart = async (
  platform: NodeJS.Platform,
  pid: number,
): Promise<string | null> => {
  if (platform === "win32") {
    const { stdout } = await execText(
      "powershell.exe",
      [
        "-NoLogo",
        "-NoProfile",
        "-NonInteractive",
        "-Command",
        `(Get-Process -Id ${pid}).StartTime.ToUniversalTime().ToString('o')`,
      ],
      { timeoutMs: 8_000 },
    );
    const value = stdout.trim();
    return Number.isNaN(Date.parse(value)) ? null : value;
  }
  const { stdout } = await execText("ps", ["-o", "etimes=", "-p", String(pid)]);
  const seconds = Number(stdout.trim());
  return Number.isFinite(seconds) && seconds >= 0
    ? new Date(Date.now() - seconds * 1_000).toISOString()
    : null;
};

export const killProcessTree = async (platform: NodeJS.Platform, pid: number): Promise<void> => {
  if (platform === "win32") {
    await execText("taskkill.exe", ["/PID", String(pid), "/T", "/F"], { timeoutMs: 15_000 });
    return;
  }
  try {
    process.kill(pid, "SIGTERM");
  } catch {
    return;
  }
  await sleepMs(3_000);
  try {
    process.kill(pid, 0);
    process.kill(pid, "SIGKILL");
  } catch {
    return;
  }
};

export interface DetachedLaunchHandlers {
  readonly onError: (message: string) => void;
  readonly onExit: (code: number | null, signal: NodeJS.Signals | null) => void;
}

export const spawnDetached = (
  spec: LocalModelCommandSpec,
  logPath: string,
  handlers: DetachedLaunchHandlers,
): number => {
  NodeFS.mkdirSync(NodePath.dirname(logPath), { recursive: true });
  const logFd = NodeFS.openSync(logPath, "w");
  try {
    const child = NodeChildProcess.spawn(spec.command, [...spec.args], {
      ...(NodeFS.existsSync(spec.cwd) ? { cwd: spec.cwd } : {}),
      env: { ...spec.env },
      detached: true,
      stdio: ["ignore", logFd, logFd],
      windowsHide: true,
      windowsVerbatimArguments: spec.windowsVerbatimArguments,
    });
    if (child.pid === undefined) throw new Error(`${spec.command} did not start`);
    child.once("error", (cause) => handlers.onError(cause.message));
    child.once("exit", handlers.onExit);
    child.unref();
    return child.pid;
  } finally {
    NodeFS.closeSync(logFd);
  }
};
