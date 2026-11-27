import os from "node:os";
import { classifyFailure, summarizeError } from "../classify.ts";
import { type AdapterOptions, type AdapterSpec, createAdapter, failureFromProcess, lastJsonObject, readIfExists } from "./base.ts";
import { runProcess } from "./process.ts";
import { partialStringField } from "./partial-json.ts";
import type { ProviderAdapter, ProviderEvent, ProviderId, RunFiles, RunRequest } from "./types.ts";
import { claudeDenyRules, grokDenyRules } from "../project-read.ts";

const modelArgs = (flag: string, model?: string) => (model ? [flag, model] : []);

/** The read-only file tools each CLI gets for `access: "read"` (plan 002). */
export const CLAUDE_READ_TOOLS = "Read,Grep,Glob";
export const GROK_READ_TOOLS = ["read_file", "grep", "list_dir"];
/**
 * Grok 1.0.89 offers MCP tools (from the user's and a trusted project's config) even with an allowlist:
 * through these two gateway tools, or directly once they're removed. Read runs remove both and deny
 * every MCP call (`--deny MCPTool`).
 */
export const GROK_MCP_GATEWAY = ["search_tool", "use_tool"];
/** Grok's turn cap when it reads the project: each file it opens takes a turn. */
export const GROK_READ_TURNS = 24;

/**
 * Claude Code (C1). Tools off with `--tools ""`; `dontAsk` as a backstop. Uses the user's own login (no --bare).
 * Read access (plan 002): only Read, Grep and Glob, the sensitive files denied, user settings only (a
 * project's own settings and hooks are not loaded) and no MCP servers.
 */
const claudeArgs = (req: RunRequest, files: RunFiles, format: string[]) => ({
  args: [
    "-p",
    ...format,
    "--json-schema",
    JSON.stringify(req.jsonSchema),
    "--tools",
    req.access === "read" ? CLAUDE_READ_TOOLS : "",
    ...(req.access === "read" ? ["--setting-sources", "user", "--strict-mcp-config", "--disallowedTools", ...claudeDenyRules()] : []),
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

/**
 * Claude Code's tool calls (plan 003): each finished assistant message in its stream-json output
 * lists the tool calls it made. Read, Grep and Glob become `activity` events; the reply itself
 * (StructuredOutput) and anything else are not reading.
 */
export function claudeActivityReader(): (line: string) => ProviderEvent[] {
  const seen = new Set<string>();
  return (line) => {
    let msg: any;
    try {
      msg = JSON.parse(line);
    } catch {
      return [];
    }
    if (msg?.type !== "assistant" || !Array.isArray(msg.message?.content)) return [];
    const out: ProviderEvent[] = [];
    for (const c of msg.message.content) {
      if (c?.type !== "tool_use" || (c.id && seen.has(c.id))) continue;
      if (c.id) seen.add(c.id);
      const input = c.input ?? {};
      if (c.name === "Read" && typeof input.file_path === "string") out.push({ type: "activity", action: "read", target: input.file_path });
      else if (c.name === "Grep" && typeof input.pattern === "string") out.push({ type: "activity", action: "search", target: input.pattern });
      else if (c.name === "Glob" && typeof input.pattern === "string") out.push({ type: "activity", action: "list", target: input.pattern });
    }
    return out;
  };
}

export const claudeSpec: AdapterSpec = {
  id: "claude",
  displayName: "Claude Code",
  bin: "claude",
  installHint: "npm i -g @anthropic-ai/claude-code",
  loginHint: "Run `claude` in a terminal and use /login",
  canRead: true,
  buildInvocation: (req, files) => claudeArgs(req, files, ["--output-format", "json"]),
  stream: {
    buildInvocation: (req, files) => claudeArgs(req, files, ["--output-format", "stream-json", "--verbose", "--include-partial-messages"]),
    reader: claudeStreamReader,
    activity: claudeActivityReader,
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

/**
 * Codex (C2). No "no tools" flag exists, so it runs in the read-only sandbox (Codex can read, not write).
 * No read access (plan 002): Codex 0.170 offers its plugin and connected-app tools (some write to online
 * services) even with --ignore-user-config, and has no flag to remove them, so untrusted file contents
 * could steer a tool that goes online. It keeps the empty temp folder until it can be limited.
 */
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
  // Read access (plan 002): only read_file, grep and list_dir, every other built-in and the MCP gateway
  // removed, every MCP tool call and the sensitive files denied, more turns.
  canRead: true,
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
      req.access === "read" ? GROK_READ_TOOLS.join(",") : "",
      "--disallowed-tools",
      (req.access === "read" ? [...GROK_DISALLOWED_TOOLS.filter((t) => !GROK_READ_TOOLS.includes(t)), ...GROK_MCP_GATEWAY] : GROK_DISALLOWED_TOOLS).join(","),
      ...(req.access === "read" ? grokDenyRules().flatMap((r) => ["--deny", r]) : []),
      "--disable-web-search",
      "--no-subagents",
      "--no-plan",
      "--max-turns",
      req.access === "read" ? String(GROK_READ_TURNS) : "3",
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

/** pi (C4). No read access yet (plan 002: not verified against a real pi). `--no-tools`; prompt on stdin (pi reads stdin when it isn't a TTY, so it must always be closed). */
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
