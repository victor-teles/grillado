import { describe, expect, test } from "bun:test";
import { chmodSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { classifyFailure } from "../src/core/classify.ts";
import { GROK_DISALLOWED_TOOLS, SPECS, createAdapters } from "../src/core/providers/adapters.ts";
import { claudeDenyRules, grokDenyRules } from "../src/core/project-read.ts";
import { scriptFromCmdShim, spawnTarget, which } from "../src/core/providers/resolve.ts";
import type { ProviderAdapter, ProviderEvent, RunFiles, RunRequest } from "../src/core/providers/types.ts";
import { fakeBinDir, fakeEnv } from "./helpers.ts";

const req: RunRequest = {
  kind: "round",
  systemPrompt: "SYSTEM",
  userPrompt: "USER",
  jsonSchema: { type: "object" },
  cwd: "/tmp/agent-cwd",
  timeoutMs: 10_000,
};
const files: RunFiles = {
  dir: "/tmp/run",
  systemPromptFile: "/tmp/run/system.md",
  promptFile: "/tmp/run/prompt.md",
  schemaFile: "/tmp/run/schema.json",
  outputFile: "/tmp/run/output.json",
};

describe("AC4: exact argv per adapter (tools off / read-only)", () => {
  test("claude", () => {
    expect(SPECS.claude.buildInvocation(req, files)).toEqual({
      args: [
        "-p", "--output-format", "json", "--json-schema", '{"type":"object"}', "--tools", "",
        "--permission-mode", "dontAsk", "--system-prompt-file", "/tmp/run/system.md", "--no-session-persistence",
      ],
      stdin: "USER",
    });
  });
  test("codex", () => {
    expect(SPECS.codex.buildInvocation(req, files)).toEqual({
      args: [
        "exec", "--sandbox", "read-only", "-c", 'approval_policy="never"', "--skip-git-repo-check", "--ephemeral", "--ignore-rules", "--color", "never",
        "-C", "/tmp/agent-cwd", "--output-schema", "/tmp/run/schema.json", "-o", "/tmp/run/output.json", "-",
      ],
      stdin: "SYSTEM\n\n---\n\nUSER",
    });
  });
  test("grok", () => {
    expect(SPECS.grok.buildInvocation(req, files)).toEqual({
      args: [
        "--prompt-file", "/tmp/run/prompt.md", "--output-format", "json", "--json-schema", '{"type":"object"}',
        "--system-prompt-override", "SYSTEM", "--tools", "", "--disallowed-tools", GROK_DISALLOWED_TOOLS.join(","),
        "--disable-web-search", "--no-subagents", "--no-plan", "--max-turns", "3", "--sandbox", "read-only",
        "--no-auto-update", "--cwd", "/tmp/agent-cwd",
      ],
      env: { GROK_MEMORY: "0" },
    });
    expect(GROK_DISALLOWED_TOOLS).toContain("run_terminal_cmd");
    expect(GROK_DISALLOWED_TOOLS).toContain("search_replace");
  });
  test("pi", () => {
    expect(SPECS.pi.buildInvocation(req, files)).toEqual({
      args: [
        "-p", "--mode", "json", "--no-tools", "--no-session", "--no-context-files", "--no-skills", "--no-extensions",
        "--no-prompt-templates", "--system-prompt", "SYSTEM",
      ],
      stdin: "USER",
    });
  });
  test("model passthrough only when set", () => {
    const withModel = { ...req, model: "m1" };
    expect(SPECS.claude.buildInvocation(withModel, files).args.slice(-2)).toEqual(["--model", "m1"]);
    expect(SPECS.codex.buildInvocation(withModel, files).args.slice(-3)).toEqual(["-m", "m1", "-"]);
    expect(SPECS.pi.buildInvocation(withModel, files).args.slice(-2)).toEqual(["--model", "m1"]);
  });
});

describe("plan 002: exact read-only argv per adapter", () => {
  const read: RunRequest = { ...req, access: "read", cwd: "/repo" };
  test("claude: Read, Grep and Glob only, user settings only, no MCP servers, sensitive files denied", () => {
    expect(SPECS.claude.buildInvocation(read, files)).toEqual({
      args: [
        "-p", "--output-format", "json", "--json-schema", '{"type":"object"}', "--tools", "Read,Grep,Glob",
        "--setting-sources", "user", "--strict-mcp-config", "--disallowedTools", ...claudeDenyRules(),
        "--permission-mode", "dontAsk", "--system-prompt-file", "/tmp/run/system.md", "--no-session-persistence",
      ],
      stdin: "USER",
    });
    expect(claudeDenyRules()).toContain("Read(**/.env)");
    expect(claudeDenyRules()).toContain("Read(**/.git/**)");
  });
  test("claude: the streaming variant keeps every read-only flag", () => {
    const args = SPECS.claude.stream!.buildInvocation(read, files).args;
    for (const f of ["Read,Grep,Glob", "--setting-sources", "user", "--strict-mcp-config", "dontAsk", ...claudeDenyRules()]) expect(args).toContain(f);
  });
  test("codex can't read: its app and plugin tools can't be removed, so it keeps today's argv", () => {
    expect(SPECS.codex.canRead).toBeUndefined();
    expect(SPECS.codex.buildInvocation(read, files)).toEqual(SPECS.codex.buildInvocation({ ...req, cwd: "/repo" }, files));
  });
  test("grok: read_file, grep and list_dir only; every other built-in and the MCP gateway removed; MCP calls and secrets denied", () => {
    expect(SPECS.grok.buildInvocation(read, files)).toEqual({
      args: [
        "--prompt-file", "/tmp/run/prompt.md", "--output-format", "json", "--json-schema", '{"type":"object"}',
        "--system-prompt-override", "SYSTEM", "--tools", "read_file,grep,list_dir",
        "--disallowed-tools", "run_terminal_cmd,search_replace,write,web_search,web_fetch,todo_write,task,Agent,search_tool,use_tool",
        ...grokDenyRules().flatMap((r) => ["--deny", r]),
        "--disable-web-search", "--no-subagents", "--no-plan", "--max-turns", "24", "--sandbox", "read-only",
        "--no-auto-update", "--cwd", "/repo",
      ],
      env: { GROK_MEMORY: "0" },
    });
  });
  test("grok denies every MCP call and the sensitive files", () => {
    expect(grokDenyRules()[0]).toBe("MCPTool");
    expect(grokDenyRules()).toContain("Read(**/.env)");
    expect(grokDenyRules()).toContain("Grep(**/.env)");
  });
  test("pi can't read yet: no canRead, and a read request gets today's tools-off argv", () => {
    expect(SPECS.pi.canRead).toBeUndefined();
    expect(SPECS.pi.buildInvocation(read, files)).toEqual(SPECS.pi.buildInvocation(req, files));
    const byId = Object.fromEntries(createAdapters().map((a) => [a.id, a.canRead]));
    expect(byId).toEqual({ claude: true, codex: false, grok: true, pi: false });
  });
  test('access "none" is exactly the tools-off argv', () => {
    for (const id of ["claude", "codex", "grok", "pi"] as const)
      expect(SPECS[id].buildInvocation({ ...req, access: "none" }, files)).toEqual(SPECS[id].buildInvocation(req, files));
  });
});

describe("AC1: detection on a temp PATH", () => {
  test("ready, missing, broken", async () => {
    const bin = fakeBinDir(["claude", "grok"]);
    const brokenDir = mkdtempSync(path.join(os.tmpdir(), "grillado-broken-"));
    writeFileSync(path.join(brokenDir, "codex"), "#!/bin/sh\necho boom >&2\nexit 3\n");
    chmodSync(path.join(brokenDir, "codex"), 0o755);
    const env = fakeEnv(bin);
    env.PATH = `${env.PATH}:${brokenDir}`;
    const byId = Object.fromEntries(
      await Promise.all(createAdapters({ env }).map(async (a) => [a.id, await a.detect()] as const)),
    );
    expect(byId.claude).toMatchObject({ status: "ready", version: "9.9.9-fake" });
    expect(byId.grok).toMatchObject({ status: "ready" });
    expect(byId.codex).toMatchObject({ status: "broken" });
    expect((byId.codex as any).reason).toContain("exited with 3");
    expect(byId.pi).toEqual({ status: "missing" });
  });

  test("an unrelated `grok` binary is flagged", async () => {
    const env = fakeEnv(fakeBinDir(["grok"]), { FAKE_MODE: "wrong-grok" });
    const grok = createAdapters({ env }).find((a) => a.id === "grok")!;
    expect(await grok.detect()).toMatchObject({ status: "broken", reason: expect.stringContaining("Unsupported grok binary") });
  });

  test("Windows: PATHEXT lookup and npm .cmd shims", () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "grillado-win-"));
    writeFileSync(
      path.join(dir, "claude.CMD"),
      '@ECHO off\r\nGOTO start\r\n:start\r\n"%_prog%"  "%dp0%\\node_modules\\@anthropic-ai\\claude-code\\cli.js" %*\r\n',
    );
    const found = which("claude", { PATH: dir, PATHEXT: ".EXE;.CMD", platform: "win32" });
    expect(found).toBe(path.join(dir, "claude.CMD"));
    expect(scriptFromCmdShim(found!)).toBe(path.win32.join(path.win32.dirname(found!), "node_modules\\@anthropic-ai\\claude-code\\cli.js"));
    const target = spawnTarget(found!, "win32");
    expect(target.command).toBe(process.execPath);
    expect(target.prefixArgs[0]).toEndWith("cli.js");
    expect(spawnTarget("/usr/bin/claude", "linux")).toEqual({ command: "/usr/bin/claude", prefixArgs: [] });
  });
});

async function collect(a: ProviderAdapter, r: RunRequest): Promise<ProviderEvent[]> {
  const out: ProviderEvent[] = [];
  for await (const ev of a.run(r, new AbortController().signal)) out.push(ev);
  return out;
}

const roundReq = (cwd: string): RunRequest => ({
  kind: "round",
  systemPrompt: 'Output contract: {"type":"ask_round"|"frontier_empty"}',
  userPrompt: `<state>${JSON.stringify({ idea: "x", nextRound: 1, decisions: [] })}</state>`,
  jsonSchema: { type: "object" },
  cwd,
  timeoutMs: 10_000,
});

describe("adapters against fake CLIs", () => {
  for (const id of ["claude", "codex", "grok", "pi"] as const) {
    test(`${id}: returns a round from its own output format`, async () => {
      const env = fakeEnv(fakeBinDir([id]));
      const a = createAdapters({ env }).find((x) => x.id === id)!;
      const cwd = mkdtempSync(path.join(os.tmpdir(), "grillado-cwd-"));
      const events = await collect(a, roundReq(cwd));
      const result = events.find((e) => e.type === "result");
      expect(result).toBeDefined();
      const raw = (result as any).raw;
      const text = typeof raw === "string" ? raw : JSON.stringify(raw);
      expect(text).toContain('"ask_round"');
    });

    test(`${id}: auth failure is classified as auth (AC8)`, async () => {
      const env = fakeEnv(fakeBinDir([id]), { FAKE_MODE: "auth" });
      const a = createAdapters({ env }).find((x) => x.id === id)!;
      const events = await collect(a, roundReq(os.tmpdir()));
      expect(events.at(-1)).toMatchObject({ type: "error", code: "auth" });
    });

    test(`${id}: rate limit is classified as rate_limit (AC8)`, async () => {
      const env = fakeEnv(fakeBinDir([id]), { FAKE_MODE: "rate" });
      const a = createAdapters({ env }).find((x) => x.id === id)!;
      const events = await collect(a, roundReq(os.tmpdir()));
      expect(events.at(-1)).toMatchObject({ type: "error", code: "rate_limit" });
    });
  }

  test("timeout kills the CLI and is classified (AC8)", async () => {
    const env = fakeEnv(fakeBinDir(["claude"]), { FAKE_MODE: "slow" });
    const a = createAdapters({ env }).find((x) => x.id === "claude")!;
    const started = Date.now();
    const events = await collect(a, { ...roundReq(os.tmpdir()), timeoutMs: 500 });
    expect(events.at(-1)).toMatchObject({ type: "error", code: "timeout" });
    expect(Date.now() - started).toBeLessThan(5000);
  });

  test("missing CLI yields not_found", async () => {
    const a = createAdapters({ env: { PATH: "/nonexistent" } }).find((x) => x.id === "pi")!;
    expect((await collect(a, roundReq(os.tmpdir()))).at(-1)).toMatchObject({ type: "error", code: "not_found" });
  });

  test("runs in the given empty cwd and logs a fixed argv", async () => {
    const log = path.join(mkdtempSync(path.join(os.tmpdir(), "grillado-log-")), "log.jsonl");
    const env = fakeEnv(fakeBinDir(["pi"]), { FAKE_LOG: log });
    const a = createAdapters({ env }).find((x) => x.id === "pi")!;
    const cwd = mkdtempSync(path.join(os.tmpdir(), "grillado-cwd-"));
    await collect(a, roundReq(cwd));
    const entry = JSON.parse(readFileSync(log, "utf8").trim());
    expect(realpathSync(entry.cwd)).toBe(realpathSync(cwd));
    expect(entry.args).toContain("--no-tools");
  });
});

describe("failure classification from real CLI messages", () => {
  test.each([
    ["Not logged in · Please run /login", "auth"],
    ["Your organization has disabled Claude subscription access for Claude Code", "auth"],
    ["unexpected status 401 Unauthorized: Missing bearer or basic authentication in header", "auth"],
    ["Not signed in. To authenticate without a browser, run: grok login --device-code", "auth"],
    ["400 checking third-party user token: bad request: Personal Access Tokens are not supported", "auth"],
    ["429 Too Many Requests", "rate_limit"],
    ["You've hit your usage limit", "rate_limit"],
    ["something odd happened", "unknown"],
  ])("%s → %s", (message, code) => {
    expect(classifyFailure({ message })).toBe(code as any);
  });
});
