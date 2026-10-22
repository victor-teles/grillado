import os from "node:os";
import { classifyFailure, summarizeError } from "../classify.ts";
import { type AdapterOptions, type AdapterSpec, createAdapter, failureFromProcess, lastJsonLine, readIfExists } from "./base.ts";
import { runProcess } from "./process.ts";
import type { ProviderAdapter, ProviderId } from "./types.ts";

const modelArgs = (flag: string, model?: string) => (model ? [flag, model] : []);

/** Claude Code (C1). Tools off with `--tools ""`; `dontAsk` as a backstop. Uses the user's own login (no --bare). */
export const claudeSpec: AdapterSpec = {
  id: "claude",
  displayName: "Claude Code",
  bin: "claude",
  installHint: "npm i -g @anthropic-ai/claude-code",
  loginHint: "Run `claude` in a terminal and use /login",
  buildInvocation: (req, files) => ({
    args: [
      "-p",
      "--output-format",
      "json",
      "--json-schema",
      JSON.stringify(req.jsonSchema),
      "--tools",
      "",
      "--permission-mode",
      "dontAsk",
      "--system-prompt-file",
      files.systemPromptFile,
      "--no-session-persistence",
      ...modelArgs("--model", req.model),
    ],
    stdin: req.userPrompt,
  }),
  parse: (res) => {
    let out: Record<string, unknown> | undefined;
    try {
      out = JSON.parse(res.stdout.trim());
    } catch {
      out = lastJsonLine(res.stdout);
    }
    if (!out) return res.exitCode === 0 ? { type: "result", raw: res.stdout } : failureFromProcess(res);
    if (out.is_error) {
      const message = String(out.result ?? out.error ?? "");
      const status = out.api_error_status ? ` (${out.api_error_status})` : "";
      return { type: "error", code: classifyFailure({ message: message + status, stderr: res.stderr }), message: summarizeError(message || res.stderr) };
    }
    return { type: "result", raw: out.structured_output ?? out.result };
  },
};

/** Codex (C2). No "no tools" flag exists, so it runs in the read-only sandbox (Codex can read, not write). */
export const codexSpec: AdapterSpec = {
  id: "codex",
  displayName: "Codex",
  bin: "codex",
  installHint: "npm i -g @openai/codex",
  loginHint: "Run `codex login` in a terminal",
  buildInvocation: (req, files) => ({
    args: [
      "exec",
      "--sandbox",
      "read-only",
      "--skip-git-repo-check",
      "--ephemeral",
      "--ignore-rules",
      "--color",
      "never",
      "-C",
      req.cwd,
      "--output-schema",
      files.schemaFile,
      "-o",
      files.outputFile,
      ...modelArgs("-m", req.model),
      "-",
    ],
    // Codex has no system-prompt flag for exec; the instructions lead the stdin prompt.
    stdin: `${req.systemPrompt}\n\n---\n\n${req.userPrompt}`,
  }),
  parse: (res, files) => {
    const text = readIfExists(files.outputFile).trim();
    if (text && res.exitCode === 0) return { type: "result", raw: text };
    return failureFromProcess(res);
  },
};

/** Built-in Grok tool IDs, removed explicitly in case an empty allowlist is ignored. */
export const GROK_DISALLOWED_TOOLS = [
  "run_terminal_cmd",
  "read_file",
  "search_replace",
  "write",
  "grep",
  "list_dir",
  "web_search",
  "web_fetch",
  "todo_write",
  "task",
  "Agent",
];

/**
 * Grok CLI (C3, v1.0.67 checked). `--tools ""` parses without error or warning, but the docs don't define an
 * empty allowlist, so we also remove every built-in with --disallowed-tools (which wins over --tools),
 * disable web search and subagents, and run in the read-only sandbox.
 */
export const grokSpec: AdapterSpec = {
  id: "grok",
  displayName: "Grok",
  bin: "grok",
  installHint: "curl -fsSL https://x.ai/cli/install.sh | bash",
  loginHint: "Run `grok login` in a terminal",
  buildInvocation: (req, files) => ({
    args: [
      "--prompt-file",
      files.promptFile,
      "--output-format",
      "json",
      "--json-schema",
      JSON.stringify(req.jsonSchema),
      "--system-prompt-override",
      req.systemPrompt,
      "--tools",
      "",
      "--disallowed-tools",
      GROK_DISALLOWED_TOOLS.join(","),
      "--disable-web-search",
      "--no-subagents",
      "--no-plan",
      "--max-turns",
      "3",
      "--sandbox",
      "read-only",
      "--no-auto-update",
      "--cwd",
      req.cwd,
      ...modelArgs("--model", req.model),
    ],
    env: { GROK_MEMORY: "0" },
  }),
  parse: (res) => {
    const out = lastJsonLine(res.stdout);
    if (!out) return res.exitCode === 0 && res.stdout.trim() ? { type: "result", raw: res.stdout } : failureFromProcess(res);
    if (out.type === "error" || out.is_error) {
      const message = String(out.message ?? out.result ?? out.error ?? "");
      return { type: "error", code: classifyFailure({ message, stderr: res.stderr }), message: summarizeError(message) };
    }
    return { type: "result", raw: out.structured_output ?? out.text ?? out.result };
  },
  // An unrelated npm package also installs `grok`; the official CLI documents --output-format.
  verify: async (bin, env) => {
    const res = await runProcess(bin, ["--help"], { cwd: os.tmpdir(), env, timeoutMs: 5000 });
    return /--output-format/.test(res.stdout + res.stderr) ? null : "Unsupported grok binary (not the xAI Grok CLI)";
  },
};

/** pi (C4). `--no-tools`; prompt on stdin (pi reads stdin when it isn't a TTY, so it must always be closed). */
export const piSpec: AdapterSpec = {
  id: "pi",
  displayName: "pi",
  bin: "pi",
  installHint: "npm i -g @mariozechner/pi-coding-agent",
  loginHint: "Run `pi` in a terminal and use /login, or set your provider's API key",
  buildInvocation: (req) => ({
    args: [
      "-p",
      "--mode",
      "json",
      "--no-tools",
      "--no-session",
      "--no-context-files",
      "--no-skills",
      "--no-extensions",
      "--no-prompt-templates",
      "--system-prompt",
      req.systemPrompt,
      ...modelArgs("--model", req.model),
    ],
    stdin: req.userPrompt,
  }),
  parse: (res) => {
    let last: Record<string, any> | undefined;
    for (const line of res.stdout.split(/\r?\n/)) {
      if (!line.startsWith("{")) continue;
      try {
        const ev = JSON.parse(line);
        if (ev.type === "message_end" && ev.message?.role === "assistant") last = ev.message;
      } catch {}
    }
    if (!last) return failureFromProcess(res);
    // pi exits 0 even when the model call failed; the error rides on the message.
    if (last.stopReason === "error" || last.errorMessage) {
      const message = String(last.errorMessage ?? "The model call failed");
      return { type: "error", code: classifyFailure({ message }), message: summarizeError(message) };
    }
    const text = (last.content ?? [])
      .filter((c: any) => c?.type === "text")
      .map((c: any) => c.text)
      .join("");
    return { type: "result", raw: text };
  },
};

export const SPECS: Record<ProviderId, AdapterSpec> = { claude: claudeSpec, codex: codexSpec, grok: grokSpec, pi: piSpec };

export function createAdapters(opts: AdapterOptions = {}): ProviderAdapter[] {
  return [claudeSpec, codexSpec, grokSpec, piSpec].map((s) => createAdapter(s, opts));
}
