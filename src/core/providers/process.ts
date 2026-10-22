import { spawn } from "node:child_process";
import { spawnTarget } from "./resolve.ts";

export interface ProcessResult {
  exitCode: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  aborted: boolean;
  spawnError?: string;
}

const MAX_OUTPUT = 8 * 1024 * 1024;

/** Every live child, so shutdown can kill them all (AC13). */
const live = new Set<() => void>();
export function killAllChildren() {
  for (const kill of [...live]) kill();
}

/** Spawn with a fixed argv (no shell), collect output, enforce a timeout, and honor an AbortSignal. */
export function runProcess(
  bin: string,
  args: string[],
  opts: { cwd: string; env?: NodeJS.ProcessEnv; stdin?: string; timeoutMs: number; signal?: AbortSignal },
): Promise<ProcessResult> {
  return new Promise((resolve) => {
    const target = spawnTarget(bin);
    const posix = process.platform !== "win32";
    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(target.command, [...target.prefixArgs, ...args], {
        cwd: opts.cwd,
        env: opts.env ?? process.env,
        stdio: [opts.stdin === undefined ? "ignore" : "pipe", "pipe", "pipe"],
        shell: false,
        windowsHide: true,
        detached: posix, // own process group, so we can kill the whole tree
      });
    } catch (err) {
      resolve({ exitCode: null, stdout: "", stderr: "", timedOut: false, aborted: false, spawnError: String(err) });
      return;
    }
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    let aborted = false;
    let done = false;

    const killTree = () => {
      if (child.exitCode !== null || child.pid === undefined) return;
      try {
        if (posix) process.kill(-child.pid, "SIGTERM");
        else spawn("taskkill", ["/pid", String(child.pid), "/T", "/F"], { windowsHide: true });
      } catch {
        child.kill("SIGTERM");
      }
      setTimeout(() => {
        if (child.exitCode === null && child.pid !== undefined) {
          try {
            if (posix) process.kill(-child.pid, "SIGKILL");
            else child.kill("SIGKILL");
          } catch {}
        }
      }, 1000).unref();
    };
    live.add(killTree);

    const timer = setTimeout(() => {
      timedOut = true;
      killTree();
    }, opts.timeoutMs);
    const onAbort = () => {
      aborted = true;
      killTree();
    };
    if (opts.signal?.aborted) onAbort();
    opts.signal?.addEventListener("abort", onAbort, { once: true });

    child.stdout?.setEncoding("utf8").on("data", (d: string) => {
      if (stdout.length < MAX_OUTPUT) stdout += d;
    });
    child.stderr?.setEncoding("utf8").on("data", (d: string) => {
      if (stderr.length < MAX_OUTPUT) stderr += d;
    });
    if (opts.stdin !== undefined) {
      child.stdin?.on("error", () => {});
      child.stdin?.end(opts.stdin);
    }
    const finish = (exitCode: number | null, spawnError?: string) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      live.delete(killTree);
      opts.signal?.removeEventListener("abort", onAbort);
      resolve({ exitCode, stdout, stderr, timedOut, aborted, spawnError });
    };
    child.on("error", (err) => finish(null, err.message));
    child.on("close", (code) => finish(code));
  });
}
