import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { classifyFailure, summarizeError } from "../classify.ts";
import { type ProcessResult, runProcess } from "./process.ts";
import { which } from "./resolve.ts";
import type { Detection, ProviderAdapter, ProviderEvent, ProviderId, RunFiles, RunRequest } from "./types.ts";

export interface Invocation {
  args: string[];
  stdin?: string;
  env?: Record<string, string>;
}

/** Per-run timeout for providers that don't set their own. */
export const DEFAULT_TIMEOUT_MS = 180_000;

export interface AdapterSpec {
  id: ProviderId;
  displayName: string;
  bin: string;
  installHint: string;
  loginHint: string;
  /** Per-run timeout for this CLI; DEFAULT_TIMEOUT_MS when unset. */
  defaultTimeoutMs?: number;
  /** Pure: request + file paths → argv. Asserted verbatim in tests (AC4). */
  buildInvocation(req: RunRequest, files: RunFiles): Invocation;
  /** Turn a finished process into a result or a classified error. */
  parse(result: ProcessResult, files: RunFiles): ProviderEvent;
  /**
   * Real streaming, for CLIs that emit text deltas (#97). When a request asks for `stream`, this
   * invocation is used instead, and each stdout line goes through a reader made for the run.
   * `parse` still turns the finished process into the result.
   */
  stream?: {
    buildInvocation(req: RunRequest, files: RunFiles): Invocation;
    reader(field: string): (line: string) => ProviderEvent[];
  };
  /** Optional extra check that the binary on PATH is the CLI we support. */
  verify?(bin: string, env: NodeJS.ProcessEnv): Promise<string | null>;
}

export interface AdapterOptions {
  /** PATH and friends; tests point this at fake binaries. */
  env?: NodeJS.ProcessEnv;
}

export function createAdapter(spec: AdapterSpec, opts: AdapterOptions = {}): ProviderAdapter {
  const env = () => opts.env ?? process.env;
  let resolved: string | null = null;

  return {
    id: spec.id,
    displayName: spec.displayName,
    bin: spec.bin,
    installHint: spec.installHint,
    loginHint: spec.loginHint,
    defaultTimeoutMs: spec.defaultTimeoutMs ?? DEFAULT_TIMEOUT_MS,

    async detect(): Promise<Detection> {
      const e = env();
      const found = which(spec.bin, { PATH: e.PATH ?? e.Path, PATHEXT: e.PATHEXT });
      resolved = found;
      if (!found) return { status: "missing" };
      const res = await runProcess(found, ["--version"], { cwd: os.tmpdir(), env: e, timeoutMs: 5000 });
      if (res.spawnError) return { status: "broken", path: found, reason: `Could not start: ${res.spawnError}` };
      if (res.timedOut) return { status: "broken", path: found, reason: "`--version` took longer than 5 s" };
      if (res.exitCode !== 0)
        return { status: "broken", path: found, reason: `\`--version\` exited with ${res.exitCode}: ${summarizeError(res.stderr || res.stdout, 200)}` };
      const version = (res.stdout + res.stderr).match(/\d+\.\d+\.\d+[\w.+-]*/)?.[0];
      if (!version) return { status: "broken", path: found, reason: "Could not read a version number" };
      if (spec.verify) {
        const problem = await spec.verify(found, e);
        if (problem) return { status: "broken", version, path: found, reason: problem };
      }
      const name = agentNameFrom(res.stdout + res.stderr);
      return { status: "ready", version, path: found, ...(name ? { name } : {}) };
    },

    async *run(req: RunRequest, signal: AbortSignal): AsyncIterable<ProviderEvent> {
      const e = env();
      const bin = resolved ?? which(spec.bin, { PATH: e.PATH ?? e.Path, PATHEXT: e.PATHEXT });
      if (!bin) {
        yield { type: "error", code: "not_found", message: `${spec.displayName} is not installed or not on PATH.` };
        return;
      }
      const files = writeRunFiles(req);
      try {
        const streaming = req.stream && spec.stream ? spec.stream : undefined;
        const inv = streaming ? streaming.buildInvocation(req, files) : spec.buildInvocation(req, files);
        yield { type: "progress", label: "Thinking" };
        // Events read from stdout while the process runs; the loop below hands them out in order.
        const queue: ProviderEvent[] = [];
        let wake: (() => void) | null = null;
        const read = streaming && req.stream ? streaming.reader(req.stream.field) : undefined;
        let pending = "";
        const onStdout = read
          ? (chunk: string) => {
              pending += chunk;
              let nl = pending.indexOf("\n");
              while (nl !== -1) {
                const line = pending.slice(0, nl).trim();
                pending = pending.slice(nl + 1);
                if (line) queue.push(...read(line));
                nl = pending.indexOf("\n");
              }
              if (queue.length) wake?.();
            }
          : undefined;
        let finished = false;
        const done = runProcess(bin, inv.args, {
          cwd: req.cwd,
          env: { ...e, ...inv.env },
          stdin: inv.stdin,
          timeoutMs: req.timeoutMs,
          signal,
          onStdout,
        }).then((r) => {
          finished = true;
          wake?.();
          return r;
        });
        while (read && !finished && !signal.aborted) {
          if (!queue.length) await new Promise<void>((r) => (wake = r));
          wake = null;
          // Nothing streamed after Stop: the run ends as stopped.
          while (queue.length && !signal.aborted) yield queue.shift()!;
        }
        const res = await done;
        if (read && !res.aborted) {
          if (pending.trim()) queue.push(...read(pending.trim()));
          while (queue.length) yield queue.shift()!;
        }
        if (res.aborted) {
          yield { type: "error", code: "unknown", message: "Stopped." };
          return;
        }
        if (res.timedOut) {
          yield { type: "error", code: "timeout", message: `${spec.displayName} took longer than ${Math.round(req.timeoutMs / 1000)} s.` };
          return;
        }
        if (res.spawnError) {
          yield { type: "error", code: "not_found", message: `Could not start ${spec.displayName}: ${res.spawnError}` };
          return;
        }
        yield spec.parse(res, files);
      } finally {
        rmSync(files.dir, { recursive: true, force: true });
      }
    },
  };
}

/** Prompts and schema go to a private temp dir (deleted after the run), outside the agent's cwd. */
function writeRunFiles(req: RunRequest): RunFiles {
  const dir = mkdtempSync(path.join(os.tmpdir(), "grillado-run-"));
  const files: RunFiles = {
    dir,
    systemPromptFile: path.join(dir, "system.md"),
    promptFile: path.join(dir, "prompt.md"),
    schemaFile: path.join(dir, "schema.json"),
    outputFile: path.join(dir, "output.json"),
  };
  writeFileSync(files.systemPromptFile, req.systemPrompt, { mode: 0o600 });
  writeFileSync(files.promptFile, req.userPrompt, { mode: 0o600 });
  writeFileSync(files.schemaFile, JSON.stringify(req.jsonSchema), { mode: 0o600 });
  return files;
}

export function readIfExists(file: string): string {
  try {
    return readFileSync(file, "utf8");
  } catch {
    return "";
  }
}

/** Generic failure from a non-zero exit with no structured error. */
export function failureFromProcess(res: ProcessResult, message = ""): ProviderEvent {
  const code = classifyFailure({ exitCode: res.exitCode, stderr: res.stderr, message });
  return { type: "error", code, message: summarizeError(message || res.stderr || res.stdout) };
}

/**
 * The last JSON object a CLI printed on stdout. Two shapes count: an object on one line (stream events,
 * Claude Code's and older Grok CLIs' envelopes), and a pretty-printed object that opens with `{` and closes
 * with `}` at the start of a line (Grok CLI 1.0.70's `--output-format json`). The nested objects of a
 * pretty-printed envelope are indented, so they never count, and a parsed envelope's own lines are skipped.
 */
export function lastJsonObject(stdout: string): Record<string, unknown> | undefined {
  const lines = stdout.split(/\r?\n/);
  const asObject = (text: string) => {
    try {
      const v = JSON.parse(text);
      return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : undefined;
    } catch {
      return undefined;
    }
  };
  let last: Record<string, unknown> | undefined;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line.startsWith("{")) continue;
    const one = asObject(line);
    if (one) {
      last = one;
      continue;
    }
    if (!lines[i].startsWith("{")) continue;
    const end = lines.findIndex((l, j) => j > i && l.startsWith("}"));
    if (end === -1) continue;
    const many = asObject(lines.slice(i, end + 1).join("\n"));
    if (many) {
      last = many;
      i = end;
    }
  }
  return last;
}

/**
 * The display name a CLI prints with its version ("2.1.3 (Claude Code)"), when it prints one. The brackets
 * after a version also carry build metadata: a commit hash ("1.0.70 (f50904eaee6c)"), a date, a build number,
 * a channel tag ("beta", "nightly"). A name is words of letters that start with a capital, so anything with a
 * digit in it, or a lowercase tag, is never taken for one; neither is a hex word with no digits in it
 * ("abcdef", "DEADBEEF"). The caller then falls back to the adapter's own display name.
 */
export function agentNameFrom(out: string): string | undefined {
  const m = /\d+\.\d+\.\d+[\w.+-]*\s*\(\s*([A-Z][A-Za-z]*(?:[ .-][A-Za-z]+)*)\s*\)/.exec(out);
  if (!m || m[1].length > 31 || /^[A-Fa-f]{6,}$/.test(m[1])) return undefined;
  return m[1];
}
