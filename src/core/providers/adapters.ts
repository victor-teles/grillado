import os from "node:os";
import { classifyFailure, summarizeError } from "../classify.ts";
import { type AdapterOptions, type AdapterSpec, createAdapter, failureFromProcess, lastJsonObject, readIfExists } from "./base.ts";
import { runProcess } from "./process.ts";
import { partialStringField } from "./partial-json.ts";
import type { ProviderAdapter, ProviderEvent, ProviderId, RunFiles, RunRequest } from "./types.ts";

const modelArgs = (flag: string, model?: string) => (model ? [flag, model] : []);

/** Claude Code (C1). Tools off with `--tools ""`; `dontAsk` as a backstop. Uses the user's own login (no --bare). */
const claudeArgs = (req: RunRequest, files: RunFiles, format: string[]) => ({
  args: [
    "-p",
    ...format,
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
});

/**
 * Claude Code's stream (#97): with `--json-schema`, the reply arrives as a `StructuredOutput` tool
 * call whose input streams as `input_json_delta` chunks. This reads the chunks so far and hands out
 * the new part of one string field. A second StructuredOutput call (Claude Code's own schema retry)
 * starts the text over. Text blocks outside the tool call are not the reply and are ignored. The
 * validated object still comes from the final `result` line, through `parse`.
 */
export function claudeStreamReader(field: string): (line: string) => ProviderEvent[] {
  let open = -1; // index of the StructuredOutput block being written, or -1
  let json = "";
  let sent = "";
  return (line) => {
    let msg: any;
    try {
      msg = JSON.parse(line);
    } catch {
      return [];
    }
    if (msg?.type !== "stream_event") return [];
    const ev = msg.event ?? {};
    if (ev.type === "content_block_start") {
      if (ev.content_block?.type === "tool_use" && ev.content_block?.name === "StructuredOutput") {
        open = ev.index;
        json = "";
        if (sent) {
          sent = "";
          return [{ type: "text-reset" }];
        }
      }
      return [];
    }
    if (ev.type === "content_block_stop" && ev.index === open) {
      open = -1;
      return [];
    }
    if (ev.type !== "content_block_delta" || ev.index !== open || ev.delta?.type !== "input_json_delta") return [];
    json += String(ev.delta.partial_json ?? "");
    const now = partialStringField(json, field);
    if (now === undefined || now === sent) return [];
    if (!now.startsWith(sent)) {
      sent = now;
      return [{ type: "text-reset" }, { type: "text-delta", text: now }];
    }
    const add = now.slice(sent.length);
    sent = now;
    return [{ type: "text-delta", text: add }];
  };
}

export const claudeSpec: AdapterSpec = {
  id: "claude",
  displayName: "Claude Code",
  bin: "claude",
  installHint: "npm i -g @anthropic-ai/claude-code",
  loginHint: "Run `claude` in a terminal and use /login",
  buildInvocation: (req, files) => claudeArgs(req, files, ["--output-format", "json"]),
  stream: {
    buildInvocation: (req, files) => claudeArgs(req, files, ["--output-format", "stream-json", "--verbose", "--include-partial-messages"]),
    reader: claudeStreamReader,
  },
  parse: (res) => {
    let out: Record<string, unknown> | undefined;
    try {
      out = JSON.parse(res.stdout.trim());
    } catch {
      out = lastJsonObject(res.stdout);
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
      // exec already defaults to never asking; pin it so a user config can't add a prompt.
      "-c",
      'approval_policy="never"',
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
 * Grok CLI (C3, v1.0.67 and v1.0.70 checked). `--tools ""` parses without error or warning, but the docs don't define an
 * empty allowlist, so we also remove every built-in with --disallowed-tools (which wins over --tools),
 * disable web search and subagents, and run in the read-only sandbox.
 */
export const grokSpec: AdapterSpec = {
  id: "grok",
  displayName: "Grok",
  bin: "grok",
  installHint: "curl -fsSL https://x.ai/cli/install.sh | bash",
  loginHint: "Run `grok login` in a terminal",
  // Real 1.0.70 rounds took 115–220 s on a plain idea, past the 180 s default (PR #26 verification).
  defaultTimeoutMs: 600_000,
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
    const out = lastJsonObject(res.stdout);
    if (!out) return res.exitCode === 0 && res.stdout.trim() ? { type: "result", raw: res.stdout } : failureFromProcess(res);
    if (out.type === "error" || out.is_error) {
      const message = String(out.message ?? out.result ?? out.error ?? "");
      return { type: "error", code: classifyFailure({ message, stderr: res.stderr }), message: summarizeError(message) };
    }
    // Grok CLI 1.0.70 names it structuredOutput; earlier versions structured_output.
    return { type: "result", raw: out.structuredOutput ?? out.structured_output ?? out.text ?? out.result };
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
  loginHint: "Run `pi` in a terminal and use /login, or set your provider’s API key",
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
