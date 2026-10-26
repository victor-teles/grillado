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

export interface AdapterSpec {
  id: ProviderId;
  displayName: string;
  bin: string;
  installHint: string;
  loginHint: string;
  /** Pure: request + file paths → argv. Asserted verbatim in tests (AC4). */
  buildInvocation(req: RunRequest, files: RunFiles): Invocation;
  /** Turn a finished process into a result or a classified error. */
  parse(result: ProcessResult, files: RunFiles): ProviderEvent;
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
        const inv = spec.buildInvocation(req, files);
        yield { type: "progress", label: "Thinking" };
        const res = await runProcess(bin, inv.args, {
          cwd: req.cwd,
          env: { ...e, ...inv.env },
          stdin: inv.stdin,
          timeoutMs: req.timeoutMs,
          signal,
        });
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

/** Last stdout line that parses as a JSON object. */
export function lastJsonLine(stdout: string): Record<string, unknown> | undefined {
  const lines = stdout.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  for (let i = lines.length - 1; i >= 0; i--) {
    if (!lines[i].startsWith("{")) continue;
    try {
      const v = JSON.parse(lines[i]);
      if (v && typeof v === "object") return v;
    } catch {}
  }
  return undefined;
}

/** The display name a CLI prints with its version ("2.1.3 (Claude Code)"), when it prints one. */
export function agentNameFrom(out: string): string | undefined {
  const m = /\d+\.\d+\.\d+[\w.+-]*\s*\(([A-Za-z][\w .-]{0,30})\)/.exec(out);
  return m?.[1].trim() || undefined;
}
