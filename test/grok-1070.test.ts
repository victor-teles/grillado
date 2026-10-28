import { afterEach, describe, expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { GrilladoServer } from "../src/cli/server.ts";
import { Store } from "../src/cli/store.ts";
import { SPECS, createAdapters } from "../src/core/providers/adapters.ts";
import { agentNameFrom, lastJsonObject } from "../src/core/providers/base.ts";
import type { ProviderAdapter, ProviderEvent, RunRequest } from "../src/core/providers/types.ts";
import { fakeBinDir, fakeEnv } from "./helpers.ts";

// Real output of the Grok CLI 1.0.70 (test/fixtures/grok-1.0.70/README.md).
const FIX = path.join(import.meta.dir, "fixtures", "grok-1.0.70");
const real = (f: string) => readFileSync(path.join(FIX, f), "utf8");
const result = (stdout: string, exitCode = 0) => ({ stdout, stderr: "", exitCode, timedOut: false, signal: null }) as any;
const files = { dir: "/tmp/run", systemPromptFile: "/tmp/run/s", promptFile: "/tmp/run/p", schemaFile: "/tmp/run/j", outputFile: "/tmp/run/o" };

/** A `grok` that replays the captured 1.0.70 output: --version, --help, then one reply. */
function replayGrok(reply: string): string {
  const dir = mkdtempSync(path.join(os.tmpdir(), "grillado-grok1070-"));
  const file = path.join(dir, "grok");
  writeFileSync(
    file,
    `#!/bin/sh\ncase "$1" in\n  --version) cat "${path.join(FIX, "version.txt")}" ;;\n  --help) echo "      --output-format <OUTPUT_FORMAT>" ;;\n  *) cat "${path.join(FIX, reply)}" ;;\nesac\n`,
  );
  chmodSync(file, 0o755);
  return dir;
}
async function collect(a: ProviderAdapter, r: RunRequest): Promise<ProviderEvent[]> {
  const out: ProviderEvent[] = [];
  for await (const ev of a.run(r, new AbortController().signal)) out.push(ev);
  return out;
}
const req = (cwd: string): RunRequest => ({ kind: "round", systemPrompt: "S", userPrompt: "U", jsonSchema: { type: "object" }, cwd, timeoutMs: 10_000 });

describe("agent name from `--version`", () => {
  test("the real 1.0.70 line names no agent: its bracket is a commit hash", () => {
    expect(real("version.txt").trim()).toBe("grok 1.0.70 (f50904eaee6c)");
    expect(agentNameFrom(real("version.txt"))).toBeUndefined();
  });
  test("names are words of letters; hashes, dates and build ids are not", () => {
    expect(agentNameFrom("2.1.3 (Claude Code)")).toBe("Claude Code");
    expect(agentNameFrom("2.1.3 ( Claude Code )\n")).toBe("Claude Code");
    expect(agentNameFrom("tool 1.4.0-beta.2 (Tool.app)")).toBe("Tool.app");
    for (const out of ["grok 1.0.70 (f50904eaee6c)", "x 1.2.3 (deadbeef)", "x 1.2.3 (abc1234-dirty)", "x 1.2.3 (g1a2b3c)", "x 1.2.3 (2026-10-28)", "x 1.2.3 (build 4512)", "x 1.2.3 (r2)", "claude 9.9.9-fake"])
      expect(agentNameFrom(out)).toBeUndefined();
  });
  test("channel tags and digit-free hex of any case are not names either (review-pr26 nice-to-have 1)", () => {
    for (const out of ["x 2.0.0 (beta)", "x 2.0.0 (nightly)", "x 2.0.0 (canary build)", "x 1.2.3 (abcdef)", "x 1.2.3 (DEADBEEF)", "x 1.2.3 (Deadbeef)", "x 1.2.3 (ABCDEF)"])
      expect(agentNameFrom(out)).toBeUndefined();
    for (const [out, name] of [["2.1.3 (Claude Code)", "Claude Code"], ["0.50.1 (Codex)", "Codex"], ["2026.1.2 (Cursor Agent)", "Cursor Agent"], ["1.0.0 (Grok CLI)", "Grok CLI"], ["1.0.0 (Bead)", "Bead"]])
      expect(agentNameFrom(out)).toBe(name);
  });
  test("detection: ready, version 1.0.70, no name; the app falls back to “Grok”", async () => {
    const env = { PATH: `${replayGrok("json-small.out")}:/usr/bin:/bin`, HOME: os.tmpdir() };
    const grok = createAdapters({ env }).find((a) => a.id === "grok")!;
    const d = await grok.detect();
    expect(d).toEqual({ status: "ready", version: "1.0.70", path: expect.any(String) });
    const server = new GrilladoServer({ adapters: [grok], store: new Store(mkdtempSync(path.join(os.tmpdir(), "grillado-home-"))), webDir: webDir(), port: 0, strictPort: true });
    servers.push(server);
    await server.detect();
    await server.listen();
    const state = JSON.parse(await get(server.port, "/api/state", server.token));
    expect(state.providers.find((p: any) => p.id === "grok").displayName).toBe("Grok");
  });
});

describe("lastJsonObject", () => {
  test("a pretty-printed envelope over many lines (grok 1.0.70)", () => {
    const out = lastJsonObject(real("json-import.out"))!;
    expect(out.stopReason).toBe("end_turn");
    expect((out.structuredOutput as any).decisions).toHaveLength(5);
  });
  test("log lines around it, and nested objects never win", () => {
    const out = lastJsonObject(`Starting…\n${real("json-small.out")}warn: {not json}\n`)!;
    expect(out.structuredOutput).toEqual({ type: "ok", note: "hi" });
    // Cut short: the envelope never closes, and its indented inner objects aren't taken for it.
    const cut = real("json-import.out").split("\n").slice(0, -3).join("\n");
    expect(lastJsonObject(cut)).toBeUndefined();
  });
  test("one object per line, as before: the last whole one wins", () => {
    expect(lastJsonObject('{"a":1}\n{"b":2}\n')).toEqual({ b: 2 });
    expect(lastJsonObject('{"a":1}\n{"b":2\n')).toEqual({ a: 1 });
    expect(lastJsonObject('{"a":1}\n{"type":"cut\n{"c":3}\n')).toEqual({ c: 3 });
    expect(lastJsonObject("  {\"a\":1}  \r\n")).toEqual({ a: 1 });
    expect(lastJsonObject(real("json-error.out"))).toMatchObject({ type: "error" });
    expect(lastJsonObject("plain text\n[1,2]\n")).toBeUndefined();
  });
});

describe("grok parse", () => {
  test("1.0.70: structuredOutput from the multi-line envelope", () => {
    expect(SPECS.grok.parse(result(real("json-import.out")), files)).toMatchObject({ type: "result", raw: { type: "decisions", decisions: expect.any(Array) } });
    expect(SPECS.grok.parse(result(real("json-small.out")), files)).toEqual({ type: "result", raw: { type: "ok", note: "hi" } });
  });
  test("1.0.67: structured_output on one line still works, and text when there's no structured output", () => {
    expect(SPECS.grok.parse(result('{"text":"x","structured_output":{"type":"ok"}}\n'), files)).toEqual({ type: "result", raw: { type: "ok" } });
    expect(SPECS.grok.parse(result('{\n  "text": "{\\"type\\":\\"ok\\"}",\n  "stopReason": "end_turn"\n}\n'), files)).toEqual({ type: "result", raw: '{"type":"ok"}' });
  });
  test("1.0.70: an error is an error", () => {
    expect(SPECS.grok.parse(result(real("json-error.out"), 1), files)).toMatchObject({ type: "error", message: expect.stringContaining("unknown model id") });
  });
  test("claude: its one-line envelope after a log line is unchanged", () => {
    expect(SPECS.claude.parse(result('note\n{"type":"result","is_error":false,"result":"r","structured_output":{"type":"ok"}}\n'), files)).toEqual({ type: "result", raw: { type: "ok" } });
  });
  test("end to end: the replayed 1.0.70 reply comes through the adapter", async () => {
    const env = { PATH: `${replayGrok("json-import.out")}:/usr/bin:/bin`, HOME: os.tmpdir() };
    const grok = createAdapters({ env }).find((a) => a.id === "grok")!;
    const ev = (await collect(grok, req(os.tmpdir()))).find((e) => e.type === "result") as any;
    expect(ev.raw.decisions[0].label).toBe("Who adds");
  });
  test("the fake grok speaks 1.0.70 by default and 1.0.67 with FAKE_GROK_FORMAT=legacy", async () => {
    for (const extra of [{}, { FAKE_GROK_FORMAT: "legacy" }] as Record<string, string>[]) {
      const grok = createAdapters({ env: fakeEnv(fakeBinDir(["grok"]), extra) }).find((a) => a.id === "grok")!;
      expect(await grok.detect()).toEqual({ status: "ready", version: "9.9.9-fake", path: expect.any(String) });
      const ev = (await collect(grok, { ...req(mkdtempSync(path.join(os.tmpdir(), "grillado-cwd-"))), systemPrompt: 'Output contract: {"type":"ask_round"|"frontier_empty"}', userPrompt: `<state>${JSON.stringify({ idea: "x", nextRound: 1, decisions: [] })}</state>` })).find((e) => e.type === "result") as any;
      expect(ev?.raw?.type).toBe("ask_round");
    }
  });
});

const servers: GrilladoServer[] = [];
afterEach(async () => {
  while (servers.length) await servers.pop()!.close();
});
function webDir() {
  const dir = mkdtempSync(path.join(os.tmpdir(), "grillado-web-"));
  writeFileSync(path.join(dir, "index.html"), "<!doctype html><title>Grillado</title>");
  mkdirSync(path.join(dir, "assets"));
  return dir;
}
function get(port: number, p: string, token: string) {
  return new Promise<string>((resolve, reject) => {
    http.get({ host: "127.0.0.1", port, path: p, headers: { "x-grillado-token": token } }, (res) => {
      let body = "";
      res.on("data", (d) => (body += d));
      res.on("end", () => resolve(body));
    }).on("error", reject);
  });
}
