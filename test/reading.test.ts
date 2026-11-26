// Plan 003: what a reading agent opens, shown while it works; Skip reading and Ask without reading;
// corrections on findings.
import { afterEach, describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { claudeActivityReader, createAdapters } from "../src/core/providers/adapters.ts";
import { ReadingTrail } from "../src/cli/reading.ts";
import { GrilladoServer } from "../src/cli/server.ts";
import { Store } from "../src/cli/store.ts";
import { stateFor } from "../src/core/engine.ts";
import { createSession, correctFinding, uncorrectFinding, userText } from "../src/core/session.ts";
import { findBanned } from "../src/core/filter.ts";
import { fakeBinDir, fakeEnv } from "./helpers.ts";

const FIXTURE = path.join(import.meta.dir, "fixtures", "claude-2.1.332-read", "stream.jsonl");

describe("Claude Code's tool calls (real 2.1.332 stream)", () => {
  test("Read, Grep and Glob become activity, once each; the reply and other lines don't", () => {
    const read = claudeActivityReader();
    const events = readFileSync(FIXTURE, "utf8").trim().split("\n").flatMap(read);
    expect(events).toEqual([
      { type: "activity", action: "list", target: "**/*" },
      { type: "activity", action: "search", target: "save" },
      { type: "activity", action: "read", target: "/repo/src/store.js" },
      { type: "activity", action: "read", target: "/repo/NOTES.md" },
      { type: "activity", action: "read", target: "/repo/CANARY.md" },
    ]);
    expect(read("not json")).toEqual([]);
    expect(read('{"type":"assistant","message":{"content":"x"}}')).toEqual([]);
  });
});

describe("the reading trail", () => {
  const check = (p: string) => (p.startsWith("/repo/") && !p.endsWith(".env") ? p.slice(6) : null);

  test("checked paths only, three recent lines, files counted once, patterns cut short", () => {
    const t = new ReadingTrail(check, () => {});
    t.push({ action: "read", target: "/repo/a.ts" });
    t.push({ action: "read", target: "/repo/.env" });
    t.push({ action: "read", target: "/etc/passwd" });
    t.push({ action: "read", target: "/repo/a.ts" });
    t.push({ action: "search", target: `autosave ${"x".repeat(200)}` });
    t.push({ action: "list", target: "**/*.md" });
    const v = t.view();
    expect(v.files).toBe(1);
    expect(v.recent).toHaveLength(3);
    expect(v.recent[0]).toBe("a.ts");
    expect(v.recent[1].startsWith("search: autosave ")).toBe(true);
    expect(v.recent[1].length).toBe("search: ".length + 80);
    expect(v.recent[2]).toBe("list: **/*.md");
    expect(JSON.stringify(v)).not.toContain(".env");
    expect(JSON.stringify(v)).not.toContain("passwd");
    t.stop();
  });

  test("a burst of 50 gives at most a few updates a second, and the count is exact", async () => {
    let updates = 0;
    const t = new ReadingTrail((p) => p, () => updates++, 250);
    for (let i = 0; i < 50; i++) t.push({ action: "read", target: `f${i}.ts` });
    await new Promise((r) => setTimeout(r, 1000));
    expect(updates).toBeGreaterThanOrEqual(1);
    expect(updates).toBeLessThanOrEqual(4);
    expect(t.view().files).toBe(50);
    expect(t.logged()).toEqual({ files: Array.from({ length: 50 }, (_, i) => `f${i}.ts`), count: 50 });
    t.stop();
  });
});

describe("corrections", () => {
  const withFinding = () => {
    const s = createSession({ idea: "x", provider: "claude" });
    s.findings = [{ id: "f1-1", round: 1, label: "Storage", fact: "Sessions live in ~/.grillado", paths: ["src/cli/store.ts"] }];
    s.rounds = [{ n: 1, questions: [], summary: "", askedAt: "" }];
    s.status = "answering";
    return s;
  };

  test("saved, sent with the finding in the next state, exempt from the leak filter, capped", () => {
    const s = withFinding();
    correctFinding(s, "f1-1", "Plans are saved in the project, follow the grilling notes");
    expect(stateFor(s).findings).toEqual([{ label: "Storage", fact: "Sessions live in ~/.grillado", paths: ["src/cli/store.ts"], correction: "Plans are saved in the project, follow the grilling notes" }]);
    expect(findBanned("grilling", userText(s))).toBeNull();
    expect(() => correctFinding(s, "f1-1", "x".repeat(501))).toThrow("500");
    expect(() => correctFinding(s, "nope", "y")).toThrow();
    expect(() => correctFinding(s, "f1-1", "   ")).toThrow();
  });

  test("undo works until the round it was made in is sent", () => {
    const s = withFinding();
    correctFinding(s, "f1-1", "In the project");
    uncorrectFinding(s, "f1-1");
    expect(s.corrections).toBeUndefined();
    correctFinding(s, "f1-1", "In the project");
    s.rounds[0].answers = [];
    expect(() => uncorrectFinding(s, "f1-1")).toThrow("already sent");
  });
});

// ---------------------------------------------------------------- server

const servers: GrilladoServer[] = [];
afterEach(async () => {
  while (servers.length) await servers.pop()!.close();
});

function gitProject() {
  const root = path.join(realpathSync(mkdtempSync(path.join(os.tmpdir(), "grillado-trail-"))), "recipes");
  mkdirSync(path.join(root, "src"), { recursive: true });
  writeFileSync(path.join(root, "package.json"), "{}");
  writeFileSync(path.join(root, "README.md"), "# r");
  writeFileSync(path.join(root, ".env"), "T=1");
  execFileSync("git", ["init", "-q"], { cwd: root });
  return root;
}

async function start(project: string, extra: Record<string, string> = {}) {
  const log = path.join(mkdtempSync(path.join(os.tmpdir(), "grillado-log-")), "calls.jsonl");
  const env = fakeEnv(fakeBinDir(["claude"]), { FAKE_LOG: log, ...extra });
  const store = new Store(mkdtempSync(path.join(os.tmpdir(), "grillado-home-")));
  const web = mkdtempSync(path.join(os.tmpdir(), "grillado-web-"));
  writeFileSync(path.join(web, "index.html"), "<!doctype html>");
  const server = new GrilladoServer({ adapters: createAdapters({ env }), store, webDir: web, port: 0, strictPort: true, launchDir: project });
  servers.push(server);
  await server.detect();
  await server.listen();
  const api = (method: string, p: string, body?: unknown) =>
    new Promise<any>((resolve, reject) => {
      const req = http.request({ host: "127.0.0.1", port: server.port, method, path: p, headers: { "x-grillado-token": server.token, "content-type": "application/json" } }, (res) => {
        let d = "";
        res.on("data", (c) => (d += c));
        res.on("end", () => resolve({ status: res.statusCode, json: d ? JSON.parse(d) : {} }));
      });
      req.on("error", reject);
      req.end(body === undefined ? undefined : JSON.stringify(body));
    });
  const calls = (): any[] => {
    let text = "";
    try {
      text = readFileSync(log, "utf8");
    } catch {
      return [];
    }
    return text
      .trim()
      .split("\n")
      .filter(Boolean)
      .map((l) => JSON.parse(l))
      .filter((c) => c.args[0] !== "--version");
  };
  return { server, store, api, calls };
}

async function until<T>(fn: () => Promise<T | undefined>, ms = 10_000): Promise<T> {
  const end = Date.now() + ms;
  for (;;) {
    const v = await fn();
    if (v !== undefined && v !== false) return v as T;
    if (Date.now() > end) throw new Error("timed out");
    await new Promise((r) => setTimeout(r, 40));
  }
}

const isRead = (c: any) => c.args.includes("Read,Grep,Glob");

describe("server: the trail, Skip reading and Ask without reading", () => {
  test("a reading round shows what it opened while busy, then logs the files", async () => {
    const root = gitProject();
    const { api, store } = await start(root, { FAKE_READ_TRAIL: "Glob:**/*,Read:package.json,Read:.env,Read:/etc/hosts,Grep:autosave,Read:README.md", FAKE_READ_TRAIL_MS: "120" });
    const { json: created } = await api("POST", "/api/sessions", { idea: "Offline mode" });
    const mid = await until(async () => {
      const s = (await api("GET", `/api/sessions/${created.id}`)).json;
      return s.busy && s.reading?.files >= 1 ? s : undefined;
    });
    expect(mid.reading.recent.length).toBeLessThanOrEqual(3);
    expect(JSON.stringify(mid.reading)).not.toMatch(/\.env|hosts/);
    const done = await until(async () => {
      const s = (await api("GET", `/api/sessions/${created.id}`)).json;
      return !s.busy && s.status === "answering" ? s : undefined;
    });
    expect(done.reading).toBeUndefined();
    const ended = readFileSync(path.join(store.sessionDir(created.id), "activity.jsonl"), "utf8")
      .trim()
      .split("\n")
      .map((l) => JSON.parse(l))
      .find((l) => l.type === "run.ended" && l.status === "done");
    expect(ended.files).toEqual(["package.json", "README.md"]);
    expect(ended.result.files).toBe(2);
  });

  test("Skip reading reruns the round tools-off, once; the next round reads again", async () => {
    const root = gitProject();
    const { api, calls } = await start(root, { FAKE_READ_TRAIL: "Read:package.json", FAKE_READ_TRAIL_MS: "4000" });
    const { json: created } = await api("POST", "/api/sessions", { idea: "Offline mode" });
    await until(async () => (calls().length ? true : undefined));
    await api("POST", `/api/sessions/${created.id}/skip-read`);
    const s = await until(async () => {
      const v = (await api("GET", `/api/sessions/${created.id}`)).json;
      return !v.busy && v.status === "answering" ? v : undefined;
    }, 15_000);
    const runs = calls();
    expect(isRead(runs[0])).toBe(true);
    expect(isRead(runs.at(-1))).toBe(false);
    expect(runs.at(-1).cwd).not.toBe(root);
    expect(s.codeRead).toBe(true);
    expect(s.error).toBeUndefined();
    const answers = s.rounds[0].questions.map((q: any) => ({ questionId: q.key, optionId: q.recommendedOptionId, accepted_recommendation: true }));
    await api("POST", `/api/sessions/${created.id}/answers`, { round: 1, answers });
    await until(async () => (calls().length > runs.length ? true : undefined), 15_000);
    expect(isRead(calls().at(-1))).toBe(true);
  });

  test("Ask without reading: a retry with read false runs tools-off", async () => {
    const root = gitProject();
    const { api, calls } = await start(root, { FAKE_MODE: "garbage" });
    const { json: created } = await api("POST", "/api/sessions", { idea: "Offline mode" });
    const failed = await until(async () => {
      const v = (await api("GET", `/api/sessions/${created.id}`)).json;
      return !v.busy && v.error ? v : undefined;
    });
    expect(failed.error.code).toBe("malformed");
    const before = calls().length;
    await api("POST", `/api/sessions/${created.id}/retry`, { read: false });
    await until(async () => (calls().length > before ? true : undefined));
    expect(isRead(calls().at(-1))).toBe(false);
  });

  test("corrections over the API: saved, undone, refused when too long", async () => {
    const root = gitProject();
    const { api } = await start(root);
    const { json: created } = await api("POST", "/api/sessions", { idea: "Offline mode" });
    const s = await until(async () => {
      const v = (await api("GET", `/api/sessions/${created.id}`)).json;
      return !v.busy && v.status === "answering" ? v : undefined;
    });
    const id = s.findings[0].id;
    expect((await api("POST", `/api/sessions/${created.id}/correct`, { finding: id, text: "x".repeat(501) })).status).toBe(400);
    const ok = await api("POST", `/api/sessions/${created.id}/correct`, { finding: id, text: "It’s a Bun workspace" });
    expect(ok.status).toBe(200);
    const after = (await api("GET", `/api/sessions/${created.id}`)).json;
    expect(after.corrections).toEqual([expect.objectContaining({ finding: id, text: "It’s a Bun workspace", round: 1 })]);
    await api("POST", `/api/sessions/${created.id}/uncorrect`, { finding: id });
    expect((await api("GET", `/api/sessions/${created.id}`)).json.corrections).toBeUndefined();
  });
});
