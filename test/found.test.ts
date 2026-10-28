import { afterEach, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { appendFileSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, renameSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { parseArgs } from "../src/cli/args.ts";
import { FoundService, type Row, skipReason } from "../src/cli/found.ts";
import { createMcpServer } from "../src/cli/mcp.ts";
import { GrilladoServer } from "../src/cli/server.ts";
import { Store } from "../src/cli/store.ts";
import { ImportError } from "../src/core/found/import.ts";
import { reasonText } from "../src/core/reason.ts";
import { createAdapters } from "../src/core/providers/adapters.ts";
import { fakeBinDir, fakeEnv } from "./helpers.ts";
import { type ImportLine, fold, groupLabel, groupMeta, groups, importRows, metaParts, title } from "../src/core/activity.ts";

const FIX = path.join(import.meta.dir, "fixtures", "found");
/** Wait for a condition (each turn of the event loop), not for a fixed time. */
async function until(ok: () => boolean, ms = 5000) {
  const end = Date.now() + ms;
  while (!ok()) {
    if (Date.now() > end) throw new Error("timed out waiting for the condition");
    await new Promise((r) => setImmediate(r));
  }
}
const HOUR_AGO = (Date.now() - 3600_000) / 1000;

/** A project folder plus a home folder holding Claude Code, Codex and Cursor data, all from fixtures. */
function world(o: { git?: boolean } = {}) {
  const tmp = realpathSync(mkdtempSync(path.join(os.tmpdir(), "grillado-found-")));
  const home = path.join(tmp, "home");
  const root = path.join(tmp, "proj");
  cpSync(path.join(FIX, "repo"), root, { recursive: true });
  renameSync(path.join(root, "_node_modules"), path.join(root, "node_modules"));
  renameSync(path.join(root, "gitignore.txt"), path.join(root, ".gitignore"));
  mkdirSync(path.join(root, "pkg", "web"), { recursive: true });
  if (o.git !== false) spawnSync("git", ["init", "-q", "-b", "main"], { cwd: root });
  const plansDir = path.join(home, ".claude", "plans");
  const fill = (src: string, dest: string) => {
    mkdirSync(path.dirname(dest), { recursive: true });
    writeFileSync(dest, readFileSync(src, "utf8").replaceAll("__ROOT__", root).replaceAll("__PLANS__", plansDir));
  };
  const claude = path.join(home, ".claude", "projects", root.replace(/[^a-zA-Z0-9]/g, "-"));
  for (const f of readdirSync(path.join(FIX, "claude"))) fill(path.join(FIX, "claude", f), path.join(claude, f));
  // Claude Code's helpers: never read.
  fill(path.join(FIX, "claude", "structured.jsonl"), path.join(claude, "subagents", "agent-1.jsonl"));
  fill(path.join(FIX, "brave-otter.md"), path.join(plansDir, "brave-otter.md"));
  const day = new Date().toISOString().slice(0, 10).split("-");
  const codex = path.join(home, ".codex", "sessions", ...day);
  for (const f of readdirSync(path.join(FIX, "codex"))) fill(path.join(FIX, "codex", f), path.join(codex, f));
  cpSync(path.join(FIX, "home-cursor"), path.join(home, ".cursor", "plans"), { recursive: true });
  const age = (dir: string) => {
    for (const e of readdirSync(dir, { withFileTypes: true, recursive: true })) if (e.isFile()) utimesSync(path.join(e.parentPath, e.name), HOUR_AGO, HOUR_AGO);
  };
  age(home);
  age(root);
  const store = new Store(path.join(home, ".grillado"));
  const svc = (over: Partial<ConstructorParameters<typeof FoundService>[0]> = {}) => new FoundService({ store, cwd: root, home, env: {}, ...over });
  return { tmp, home, root, store, svc, claude, codex, plansDir };
}

const by = (rows: Row[], title: string) => {
  const r = rows.find((x) => x.title === title);
  if (!r) throw new Error(`no row "${title}" in ${rows.map((x) => x.title).join(" | ")}`);
  return r;
};

/** A free-text interview (no AskUserQuestion): 6 answers for {agent} to turn into decisions (§4). */
function cpFree(w: ReturnType<typeof world>, name: string, id = name) {
  const f = path.join(w.claude, name);
  writeFileSync(f, readFileSync(path.join(FIX, "freetext.jsonl"), "utf8").replaceAll("__ROOT__", w.root).replaceAll("claude-free", `claude-${id}`));
  utimesSync(f, HOUR_AGO, HOUR_AGO);
  return f;
}

const ALL = ["Family recipe app", "Home budget tracker", "Interview me about a chore rota for our flat", "Order delay dashboard", "Billing v2", "Onboarding checklist", "Faster search"];

describe("found in this project: scan", () => {
  test("finds the planning sessions and plan files, and nothing else", async () => {
    const w = world();
    const r = await w.svc().scan();
    expect(r.partial).toBe(false);
    expect(r.project).toMatchObject({ root: w.root, name: "proj", git: true, branch: "main" });
    expect(r.rows.map((x) => x.title).sort()).toEqual([...ALL].sort());
    expect(r.rows.every((x) => x.status === "new")).toBe(true);
    // Newest first.
    expect(r.rows.map((x) => x.date)).toEqual([...r.rows.map((x) => x.date)].sort().reverse());

    const s = by(r.rows, "Family recipe app");
    expect(s).toMatchObject({ app: "claude", kind: "session", questions: 3, hasPlan: true, importable: "structured", branch: "main" });
    expect(by(r.rows, "Home budget tracker")).toMatchObject({ compacted: true, hasPlan: true, questions: 3 });
    expect(by(r.rows, "Interview me about a chore rota for our flat")).toMatchObject({ questions: 3, unanswered: 1, hasPlan: false });
    expect(by(r.rows, "Order delay dashboard")).toMatchObject({ app: "codex", subfolder: "pkg/web", branch: "feat/dash", compacted: true });
    // Gitignored .cursor/plans is read anyway; its home-folder twin is the same plan, listed once.
    expect(by(r.rows, "Onboarding checklist")).toMatchObject({ app: "cursor", kind: "plan", relPath: ".cursor/plans/onboarding.plan.md" });
    expect(by(r.rows, "Billing v2")).toMatchObject({ app: "file", relPath: "docs/plans/billing.md", decisions: 1 });
    // A home Cursor plan counts because it names a file in this project.
    expect(by(r.rows, "Faster search")).toMatchObject({ app: "cursor", path: path.join(w.home, ".cursor", "plans", "search.plan.md") });
    // Ids are stable and the sources were only read.
    expect(new Set(r.rows.map((x) => x.id)).size).toBe(7);
    expect((await w.svc().scan()).rows.map((x) => x.id).sort()).toEqual(r.rows.map((x) => x.id).sort());
  });

  test("without git: the tree walk skips node_modules and still reads plan folders", async () => {
    const w = world({ git: false });
    const r = await w.svc().scan();
    expect(r.project.git).toBe(false);
    expect(r.rows.map((x) => x.title).sort()).toEqual([...ALL].sort());
    expect(r.rows.some((x) => x.path.includes("node_modules"))).toBe(false);
  });

  test("cache: a second launch re-reads only what changed", async () => {
    const w = world();
    const first = await w.svc().scan();
    expect(first.stats.read).toBeGreaterThan(0);
    expect(first.stats.cached).toBe(0);
    const second = await w.svc().scan();
    expect(second.stats.read).toBe(0);
    expect(second.stats.cached).toBe(first.stats.read);
    expect(second.rows).toEqual(first.rows);

    writeFileSync(path.join(w.root, "docs", "plans", "billing.md"), `${readFileSync(path.join(w.root, "docs", "plans", "billing.md"), "utf8")}\n## Milestones\n- May\n`);
    utimesSync(path.join(w.root, "docs", "plans", "billing.md"), HOUR_AGO + 60, HOUR_AGO + 60);
    const third = await w.svc().scan();
    expect(third.stats.read).toBe(1);
    // The other project's Codex rollout was read up to its first line only, and the cache remembers whose it is.
    const cache = JSON.parse(readFileSync(path.join(w.store.dir, "scan-cache.json"), "utf8"));
    const other = cache.entries[path.join(w.codex, "rollout-other.jsonl")];
    expect(other).toMatchObject({ cwd: "/somewhere/else" });
    expect("extract" in other).toBe(false);
  });

  test("one cache serves several projects: a transcript skipped for one is still found for another", async () => {
    const w = world();
    // A sibling project whose encoded name is a prefix match ("proj" → "proj-web" shares the prefix).
    const sib = `${w.root}-web`;
    mkdirSync(sib);
    await new FoundService({ store: w.store, cwd: sib, home: w.home, env: {} }).scan();
    const r = await w.svc().scan();
    expect(r.rows.map((x) => x.title).sort()).toEqual([...ALL].sort());
  });

  test("the budget: past it, the rows found so far come back marked partial", async () => {
    const w = world();
    const r = await w.svc({ budget: { paths: 3 } }).scan();
    expect(r.partial).toBe(true);
    expect(r.rows.length).toBeLessThan(7);
    let t = 0;
    const slow = await w.svc({ budget: { ms: 1500 }, now: () => (t += 1000) }).scan();
    expect(slow.partial).toBe(true);
  });

  test("a session written in the last 2 minutes is in progress and can't be imported", async () => {
    const w = world();
    const now = Date.now() / 1000;
    utimesSync(path.join(w.claude, "structured.jsonl"), now, now);
    const svc = w.svc();
    const r = await svc.scan();
    const row = by(r.rows, "Family recipe app");
    expect(row.status).toBe("in_progress");
    expect(r.rows[r.rows.length - 1].id).toBe(row.id);
    await expect(svc.import(row.id, "claude")).rejects.toMatchObject({ code: "in_progress" });
  });

  test("--no-scan turns it off; mcp doesn't take it", () => {
    expect(parseArgs([]).scan).toBe(true);
    expect(parseArgs(["--no-scan"]).scan).toBe(false);
    expect(() => parseArgs(["mcp", "--no-scan"])).toThrow("mcp only takes --data-dir");
  });

  test("no scan from home, a filesystem root, the data folder, or when turned off", async () => {
    const w = world();
    expect(skipReason(w.home, { home: w.home, dataDir: w.store.dir })).toBe("home");
    expect(skipReason("/", { home: w.home, dataDir: w.store.dir })).toBe("root");
    expect(skipReason(path.join(w.store.dir, "sessions"), { home: w.home, dataDir: w.store.dir })).toBe("data-dir");
    expect(skipReason(w.root, { home: w.home, dataDir: w.store.dir, off: true })).toBe("off");
    expect(skipReason(w.root, { home: w.home, dataDir: w.store.dir })).toBeNull();
    const off = w.svc({ cwd: w.home });
    expect(off.view()).toEqual({ enabled: false, reason: "home" });
    await expect(off.scan()).rejects.toThrow();
    expect(existsSync(path.join(w.store.dir, "scan-cache.json"))).toBe(false);
  });
});

describe("found in this project: import", () => {
  test("a structured Claude Code session becomes a normal plan, once", async () => {
    const w = world();
    const svc = w.svc();
    const row = by((await svc.scan()).rows, "Family recipe app");
    const before = readFileSync(path.join(w.claude, "structured.jsonl"), "utf8");
    const r = await svc.import(row.id, "codex");
    expect(r.result).toBe("created");
    const s = w.store.load(r.planId)!;
    expect(s.provider).toBe("claude");
    expect(s.idea).toBe("a recipe app for my family");
    expect(s.status).toBe("plated");
    expect(s.project).toBe(w.root);
    expect(s.rounds.map((x) => x.questions.length)).toEqual([2, 1]);
    expect(Object.keys(s.decisions)).toHaveLength(3);
    const q1 = s.rounds[0].questions[0];
    expect(s.decisions[q1.key]).toMatchObject({ kind: "option", accepted_recommendation: true });
    const q3 = s.rounds[1].questions[0];
    expect(s.decisions[q3.key]).toMatchObject({ kind: "other", answer: "Both, links and typed", accepted_recommendation: false });
    expect(s.source).toMatchObject({ app: "claude", kind: "session", path: row.path, sessionId: "claude-struct", questions: 3 });
    // Recent names it as the Found row did (review-pr21 #6).
    expect(s.source!.title).toBe(row.title);
    expect(w.store.readPlan(s.id)).toContain("# Family recipe app");
    expect(s.plan!.path).toBe(w.store.planPath(s.id));
    // The injected skill body never makes it in.
    expect(JSON.stringify(s) + w.store.readPlan(s.id)).not.toMatch(/grill-me|relentlessly/i);
    // Read-only on the source.
    expect(readFileSync(path.join(w.claude, "structured.jsonl"), "utf8")).toBe(before);

    // Twice: same plan, nothing new; a fresh launch shows it imported.
    expect(await svc.import(row.id, "claude")).toEqual({ planId: s.id, result: "unchanged" });
    expect(w.store.list()).toHaveLength(1);
    const again = await w.svc().scan();
    expect(by(again.rows, "Family recipe app")).toMatchObject({ status: "imported", planId: s.id });
    const sources = JSON.parse(readFileSync(path.join(w.store.dir, "sources.json"), "utf8")).sources;
    expect(Object.values(sources)).toEqual([expect.objectContaining({ planId: s.id, app: "claude", path: row.path, sessionId: "claude-struct", project: w.root })]);
    const stats = JSON.parse(readFileSync(path.join(w.store.dir, "stats.json"), "utf8")).found;
    expect(stats).toMatchObject({ projectLaunches: 2, launchesWithImport: 1 });
    expect(stats.firstPlanMs).toHaveLength(1);
  });

  test("change detection: a source that changed offers Update, into the same plan, keeping comments", async () => {
    const w = world();
    const svc = w.svc();
    const row = by((await svc.scan()).rows, "Family recipe app");
    const { planId } = await svc.import(row.id, "claude");
    w.store.update(planId, (s) => {
      s.comments = [{ id: "t1", quote: "Recipes are scattered.", messages: [] } as any];
    });
    const file = path.join(w.claude, "structured.jsonl");
    const Q = { header: "Share", question: "Can friends see recipes?", options: [{ label: "No (Recommended)", description: "" }, { label: "Yes", description: "" }] };
    appendFileSync(
      file,
      `${JSON.stringify({ sessionId: "claude-struct", cwd: w.root, timestamp: "2026-10-20T11:00:00.000Z", type: "assistant", message: { role: "assistant", content: [{ type: "tool_use", id: "tu9", name: "AskUserQuestion", input: { questions: [Q] } }] } })}\n${JSON.stringify({ sessionId: "claude-struct", cwd: w.root, timestamp: "2026-10-20T11:01:00.000Z", type: "user", message: { role: "user", content: [{ type: "tool_result", tool_use_id: "tu9", content: "ok" }] }, toolUseResult: { answers: { [Q.question]: "No" } } })}\n`,
    );
    utimesSync(file, HOUR_AGO + 120, HOUR_AGO + 120);
    const next = w.svc();
    expect(by((await next.scan()).rows, "Family recipe app")).toMatchObject({ status: "changed", planId });
    expect(next.view().plans).toEqual({ [planId]: "changed" });
    expect(await next.import(row.id, "claude")).toMatchObject({ planId, result: "updated" });
    const s = w.store.load(planId)!;
    expect(Object.keys(s.decisions)).toHaveLength(4);
    expect(s.comments).toHaveLength(1);
    expect(w.store.list()).toHaveLength(1);
    expect(by((await w.svc().scan()).rows, "Family recipe app").status).toBe("imported");
  });

  test("an Update after the user edited plan.md leaves their plan and writes plan.conflict.md", async () => {
    const w = world();
    const svc = w.svc();
    const row = by((await svc.scan()).rows, "Billing v2");
    const { planId } = await svc.import(row.id, "claude");
    const mine = `${w.store.readPlan(planId)}\n\nMy own note.\n`;
    w.store.writePlan(planId, mine);
    const file = path.join(w.root, "docs", "plans", "billing.md");
    appendFileSync(file, "\n## Open questions\n- Taxes?\n");
    utimesSync(file, HOUR_AGO + 120, HOUR_AGO + 120);
    const next = w.svc();
    await next.scan();
    const r = await next.import(row.id, "claude");
    expect(r).toMatchObject({ planId, result: "conflict" });
    expect(w.store.readPlan(planId)).toBe(mine);
    expect(readFileSync(r.conflictPath!, "utf8")).toContain("Taxes?");
    expect(w.store.load(planId)!.source!.conflict).toBeTruthy();
  });

  test("a compacted session: the idea comes from the summary and the plan from its plan file", async () => {
    const w = world();
    const svc = w.svc();
    const row = by((await svc.scan()).rows, "Home budget tracker");
    const s = w.store.load((await svc.import(row.id, "claude")).planId)!;
    expect(s.idea).toBe("Planning a home budget tracker");
    expect(s.source).toMatchObject({ compacted: true, ideaFromSummary: true, questions: 3 });
    expect(s.rounds).toHaveLength(1);
    expect(w.store.readPlan(s.id)).toContain("Import bank CSVs");
  });

  test("a partial session (unanswered question, torn last line) imports what was answered", async () => {
    const w = world();
    const svc = w.svc();
    const row = by((await svc.scan()).rows, "Interview me about a chore rota for our flat");
    const s = w.store.load((await svc.import(row.id, "claude")).planId)!;
    expect(Object.keys(s.decisions)).toHaveLength(3);
    expect(s.source).toMatchObject({ questions: 3, unanswered: 1 });
    // No plan yet: it opens at the decisions, like a finished interview.
    expect(s.status).toBe("confirm");
    expect(s.plan).toBeUndefined();
  });

  test("a compacted Codex session from a subfolder, and Cursor and repo plan files", async () => {
    const w = world();
    const svc = w.svc();
    const rows = (await svc.scan()).rows;
    const c = w.store.load((await svc.import(by(rows, "Order delay dashboard").id, "claude")).planId)!;
    expect(c.provider).toBe("codex");
    expect(c.idea).toBe("An ops dashboard for order delays");
    expect(Object.values(c.decisions).map((d: any) => [d.kind, d.accepted_recommendation])).toEqual([
      ["option", true],
      ["option", true],
      ["option", false],
    ]);
    expect(c.source).toMatchObject({ app: "codex", sessionId: "codex-web", compacted: true });
    expect(w.store.readPlan(c.id)).toContain("# Order delay dashboard");

    const cur = w.store.load((await svc.import(by(rows, "Onboarding checklist").id, "grok")).planId)!;
    expect(cur.provider).toBe("grok");
    expect(w.store.readPlan(cur.id)).toContain("- [x] Draft the steps");
    expect(w.store.readPlan(cur.id)).toContain("- [ ] Wire the checklist page");
    const file = w.store.load((await svc.import(by(rows, "Billing v2").id, "claude")).planId)!;
    expect(w.store.readPlan(file.id)).toBe(readFileSync(path.join(w.root, "docs", "plans", "billing.md"), "utf8").trim() + "\n");
  });

  test("a source that's gone marks its plan; an unknown id is refused", async () => {
    const w = world();
    const svc = w.svc();
    const row = by((await svc.scan()).rows, "Billing v2");
    const { planId } = await svc.import(row.id, "claude");
    rmSync(row.path);
    const next = w.svc();
    await next.scan();
    expect(next.view().plans).toEqual({ [planId]: "gone" });
    await expect(next.import("0123456789abcdef", "claude")).rejects.toBeInstanceOf(ImportError);
    await expect(next.import("0123456789abcdef", "claude")).rejects.toMatchObject({ code: "unknown" });
  });

  test("dismissal is per project", async () => {
    const w = world();
    const svc = w.svc();
    await svc.scan();
    svc.setHidden(true);
    expect(svc.view()).toMatchObject({ hidden: true });
    expect(w.svc({ cwd: path.join(w.root, "pkg", "web") }).view()).toMatchObject({ hidden: false });
    svc.setHidden(false);
    expect(svc.view()).toMatchObject({ hidden: false });
  });
});

describe("found in this project: HTTP API and MCP", () => {
  const servers: GrilladoServer[] = [];
  afterEach(async () => {
    while (servers.length) await servers.pop()!.close();
  });
  const req = (port: number, token: string, method: string, p: string, body?: unknown) =>
    new Promise<{ status: number; json: any }>((resolve, reject) => {
      const r = http.request({ host: "127.0.0.1", port, method, path: p, headers: { "x-grillado-token": token, "content-type": "application/json" } }, (res) => {
        let b = "";
        res.on("data", (d) => (b += d));
        res.on("end", () => resolve({ status: res.statusCode!, json: JSON.parse(b) }));
      });
      r.on("error", reject);
      r.end(body === undefined ? undefined : JSON.stringify(body));
    });

  test("GET /api/found, POST import, rescan and dismiss", async () => {
    const w = world();
    const web = mkdtempSync(path.join(os.tmpdir(), "grillado-web-"));
    writeFileSync(path.join(web, "index.html"), "<!doctype html>");
    const server = new GrilladoServer({ adapters: [], store: w.store, webDir: web, port: 0, strictPort: true, found: w.svc() });
    servers.push(server);
    await server.listen();
    const call = (m: string, p: string, b?: unknown) => req(server.port, server.token, m, p, b);
    expect((await call("GET", "/api/found")).json).toMatchObject({ enabled: true, state: "idle", rows: [] });
    await server.scanProject();
    const view = (await call("GET", "/api/found")).json;
    expect(view).toMatchObject({ enabled: true, state: "done", partial: false, hidden: false, project: { name: "proj" } });
    expect(view.rows).toHaveLength(7);
    const row = view.rows.find((x: Row) => x.title === "Family recipe app");
    const imp = await call("POST", "/api/found/import", { id: row.id });
    expect(imp.status).toBe(200);
    expect(imp.json).toMatchObject({ result: "created", url: `/s/${imp.json.planId}`, row: { status: "imported", planId: imp.json.planId } });
    const state = (await call("GET", "/api/state")).json;
    expect(state.sessions[0]).toMatchObject({ id: imp.json.planId, source: { app: "claude", kind: "session" } });
    expect((await call("POST", "/api/found/import", { id: "0123456789abcdef" })).status).toBe(404);
    expect((await call("POST", "/api/found/import", {})).status).toBe(400);
    expect((await call("POST", "/api/found/rescan", {})).json.rows.find((x: Row) => x.id === row.id).status).toBe("imported");
    expect((await call("POST", "/api/found/dismiss", { hidden: true })).json.hidden).toBe(true);
  });

  test("an import logs its Activity entry, dated at the source, and the plan's view says where it came from (§5, #154)", async () => {
    const w = world();
    const web = mkdtempSync(path.join(os.tmpdir(), "grillado-web-"));
    writeFileSync(path.join(web, "index.html"), "<!doctype html>");
    const server = new GrilladoServer({ adapters: [], store: w.store, webDir: web, port: 0, strictPort: true, found: w.svc() });
    servers.push(server);
    await server.listen();
    const call = (m: string, p: string, b?: unknown) => req(server.port, server.token, m, p, b);
    await server.scanProject();
    const row = (await call("GET", "/api/found")).json.rows.find((x: Row) => x.title === "Family recipe app");
    const imp = (await call("POST", "/api/found/import", { id: row.id })).json;
    const view = (await call("GET", `/api/sessions/${imp.planId}`)).json;
    expect(view.sourceInfo).toMatchObject({ state: "current", row: row.id, date: row.date });
    expect(view.activity.legacy).toBe(false);
    expect(view.activity.entries).toHaveLength(1);
    const e = view.activity.entries[0];
    expect(e).toMatchObject({ type: "import", what: "imported", at: row.date, source: { app: "claude", kind: "session", answers: 3, hasPlan: true, project: "proj", gone: false } });
    expect(e.source.path.startsWith("/")).toBe(true);
    expect(title(e)).toBe("Imported from a Claude Code session");
    // Unchanged: nothing more is logged.
    await call("POST", "/api/found/import", { id: row.id });
    expect((await call("GET", `/api/sessions/${imp.planId}/activity`)).json.entries).toHaveLength(1);
    // A free-text session with no ready agent fails with words, not a crash, and saves nothing.
    cpFree(w, "free.jsonl");
    const free = (await call("POST", "/api/found/rescan", {})).json.rows.find((x: Row) => x.importable === "agent");
    const r = await call("POST", "/api/found/import", { id: free.id });
    expect(r.status).toBe(502);
    expect(r.json).toMatchObject({ code: "agent", reason: "not_found" });
    // Found's row says reasonText(reason): "Couldn't import · Claude Code isn't installed".
    expect(reasonText(r.json.reason, "Claude Code")).toBe("Claude Code isn’t installed");
    expect(w.store.list()).toHaveLength(1);
    expect((await call("POST", "/api/found/stop", { id: free.id })).status).toBe(200);
  });

  test("a free-text import that hits the usage limit says so (usage-limit wording fix)", async () => {
    const w = world();
    cpFree(w, "free.jsonl");
    const web = mkdtempSync(path.join(os.tmpdir(), "grillado-web-"));
    writeFileSync(path.join(web, "index.html"), "<!doctype html>");
    const adapters = createAdapters({ env: fakeEnv(fakeBinDir(["claude"]), { FAKE_IMPORT: "fail" }) });
    const server = new GrilladoServer({ adapters, store: w.store, webDir: web, port: 0, strictPort: true, found: w.svc() });
    servers.push(server);
    await server.detect();
    await server.listen();
    const call = (m: string, p: string, b?: unknown) => req(server.port, server.token, m, p, b);
    await server.scanProject();
    const free = (await call("GET", "/api/found")).json.rows.find((x: Row) => x.importable === "agent");
    const r = await call("POST", "/api/found/import", { id: free.id });
    expect(r.status).toBe(502);
    expect(r.json).toMatchObject({ code: "agent", reason: "rate_limit" });
    expect(reasonText(r.json.reason, "Claude Code")).toBe("Claude Code hit its usage limit");
    // The row's failed state, after a reload, reads the same code from the view.
    const failed = (await call("GET", "/api/found")).json.agent.failed[free.id];
    expect(reasonText(failed, "Claude Code")).toBe("Claude Code hit its usage limit");
  });

  test("the scan off: GET says why, POSTs are refused", async () => {
    const w = world();
    const web = mkdtempSync(path.join(os.tmpdir(), "grillado-web-"));
    const server = new GrilladoServer({ adapters: [], store: w.store, webDir: web, port: 0, strictPort: true, found: w.svc({ off: true }) });
    servers.push(server);
    await server.listen();
    expect((await req(server.port, server.token, "GET", "/api/found")).json).toEqual({ enabled: false, reason: "off" });
    expect((await req(server.port, server.token, "POST", "/api/found/rescan", {})).status).toBe(409);
  });

  test("list_project_sources and import_source", async () => {
    const w = world();
    {
      const [a, b] = InMemoryTransport.createLinkedPair();
      await createMcpServer(w.store, "0.0.0-dev", undefined, { home: w.home, env: {} }).connect(a);
      const c = new Client({ name: "test-coder", version: "1.0.0" });
      await c.connect(b);
      const list = (await c.callTool({ name: "list_project_sources", arguments: { path: w.root } })) as any;
      expect(list.structuredContent.sources).toHaveLength(7);
      const id = list.structuredContent.sources.find((x: Row) => x.title === "Billing v2").id;
      const r = (await c.callTool({ name: "import_source", arguments: { id, path: w.root } })) as any;
      expect(r.structuredContent).toMatchObject({ result: "created" });
      expect(w.store.load(r.structuredContent.planId)!.source!.app).toBe("file");
      const bad = (await c.callTool({ name: "list_project_sources", arguments: { path: w.home } })) as any;
      expect(bad.isError).toBe(true);
      expect(bad.content[0].text).toContain("home folder");
    }
  });
});

describe("found in this project: v1.3 item 1 UI paths", () => {
  test("cache first (§1): a second launch shows the last scan's rows before it scans", async () => {
    const w = world();
    const first = w.svc();
    const r = await first.scan();
    await first.import(by(r.rows, "Family recipe app").id, "claude");
    const next = w.svc();
    const v = next.view();
    expect(v).toMatchObject({ enabled: true, state: "idle", cached: true, partial: false, project: { name: "proj", branch: "main" } });
    if (!v.enabled) throw new Error("off");
    expect(v.rows.map((x) => x.id).sort()).toEqual(r.rows.map((x) => x.id).sort());
    expect(by(v.rows, "Family recipe app").status).toBe("imported");
    expect(v.scannedAt).toBeTruthy();
    await next.scan();
    expect(next.view()).toMatchObject({ state: "done", cached: false });
    // Another launch folder has no cache: nothing to show until it scans.
    expect(w.svc({ cwd: path.join(w.root, "pkg") }).view()).toMatchObject({ cached: false, rows: [] });
  });

  test("free text (§4): {agent} turns the answers into decisions; the plan says so", async () => {
    const w = world();
    cpFree(w, "free.jsonl");
    const svc = w.svc();
    const row = (await svc.scan()).rows.find((x) => x.importable === "agent")!;
    expect(row).toMatchObject({ app: "claude", subfolder: "pkg/web", branch: "sync-rework", answers: 6, questions: 0 });
    await expect(svc.import(row.id, "claude")).rejects.toMatchObject({ code: "needs_agent" });
    let seen = 0;
    const res = await svc.import(row.id, "claude", undefined, async (x) => {
      seen = x.pairs?.length ?? 0;
      return { ok: true, decisions: x.pairs!.map((p, i) => ({ label: `D${i + 1}`, title: p.question, answer: p.answer })) };
    });
    expect(seen).toBe(6);
    expect(res).toMatchObject({ result: "created", source: { answers: 6, viaAgent: true, project: "proj", hasPlan: false } });
    const s = w.store.load(res.planId)!;
    expect(Object.keys(s.decisions)).toHaveLength(6);
    expect(s.source).toMatchObject({ viaAgent: true, questions: 6 });
    // Imported once: the next scan has it as imported.
    expect((await w.svc().scan()).rows.find((x) => x.id === row.id)!.status).toBe("imported");
  });

  test("one agent import at a time: the next waits in click order; Stop leaves the row as it was", async () => {
    const w = world();
    cpFree(w, "a.jsonl");
    cpFree(w, "b.jsonl");
    const svc = w.svc();
    const [a, b] = (await svc.scan()).rows.filter((x) => x.importable === "agent");
    let calls = 0;
    const agent = (_x: unknown, signal: AbortSignal) => {
      calls++;
      return new Promise<never>((_, rej) => signal.addEventListener("abort", () => rej(new Error("aborted"))));
    };
    const pa = svc.import(a.id, "claude", undefined, agent);
    const pb = svc.import(b.id, "claude", undefined, agent);
    // Both reach the slot (no fixed sleep): whichever source read finishes first, a was clicked first.
    await until(() => calls === 1 && svc.view().agent?.waiting.length === 1);
    expect(svc.view()).toMatchObject({ agent: { running: a.id, waiting: [b.id] } });
    expect(calls).toBe(1);
    svc.stop(b.id);
    await expect(pb).rejects.toMatchObject({ code: "stopped" });
    expect(svc.view()).toMatchObject({ agent: { running: a.id, waiting: [] } });
    svc.stop(a.id);
    await expect(pa).rejects.toMatchObject({ code: "stopped" });
    expect(svc.view()).toMatchObject({ agent: { running: null, waiting: [], failed: {} } });
    expect(calls).toBe(1);
    expect(w.store.list()).toHaveLength(0);
  });

  test("an agent failure is kept per row with its reason; nothing is saved; Try again clears it", async () => {
    const w = world();
    cpFree(w, "free.jsonl");
    const svc = w.svc();
    const row = (await svc.scan()).rows.find((x) => x.importable === "agent")!;
    const err = await svc.import(row.id, "claude", undefined, async () => ({ ok: false, code: "rate_limit" })).catch((e) => e);
    expect(err).toBeInstanceOf(ImportError);
    expect(err).toMatchObject({ code: "agent", reason: "rate_limit" });
    expect(svc.view()).toMatchObject({ agent: { failed: { [row.id]: "rate_limit" } } });
    expect(w.store.list()).toHaveLength(0);
    const ok = await svc.import(row.id, "claude", undefined, async (x) => ({ ok: true, decisions: x.pairs!.map((p) => ({ label: "X", title: p.question, answer: p.answer })) }));
    expect(ok.result).toBe("created");
    expect(svc.view()).toMatchObject({ agent: { failed: {} } });
  });

  test("the Activity entry (§5): title, meta and body rows", () => {
    const line: ImportLine = { v: 1, type: "import", what: "imported", at: "2026-10-24T21:02:00.000Z", importedAt: "2026-10-27T12:00:00.000Z", app: "claude", kind: "session", path: "~/.claude/projects/flatlist/4f1c.jsonl", answers: 7, hasPlan: true, project: "flatlist" };
    const [e] = fold([line]);
    expect(e).toMatchObject({ type: "import", at: line.at });
    expect(title(e)).toBe("Imported from a Claude Code session");
    expect(metaParts(e, { agent: "Claude Code" })).toEqual(["7 answers", "flatlist"]);
    expect(importRows(e, "Claude Code")).toEqual([
      ["Source", "~/.claude/projects/flatlist/4f1c.jsonl"],
      ["Imported", "The opening idea, 7 questions with your answers, and the plan text"],
      ["Left out", "Tool calls and file contents"],
    ]);
    const gone = { ...e, source: { ...e.source!, gone: true, compacted: true, ideaFromSummary: true } };
    expect(importRows(gone, "Claude Code").slice(3)).toEqual([
      ["Missing", "The start of the session was compacted; the opening idea came from its summary"],
      ["Now", "The session file is no longer on disk. The plan is unchanged."],
    ]);
    const [viaAgent] = fold([{ ...line, viaAgent: true, hasPlan: false, answers: 6 }]);
    expect(importRows(viaAgent, "Codex")[1]).toEqual(["Imported", "The opening idea, 6 answers Codex turned into decisions"]);
    const [file] = fold([{ ...line, app: "file", kind: "plan", answers: 5, what: "updated" }]);
    expect(title(file)).toBe("Updated from a plan file");
    expect(metaParts(file, { agent: "Claude Code" })).toEqual(["5 decisions", "flatlist"]);
    expect(importRows(file, "Claude Code").map((r) => r[0])).toEqual(["Source", "Imported"]);
    expect(title(fold([{ ...line, app: "cursor", kind: "plan" }])[0])).toBe("Imported from a Cursor plan");
    // Its own session in Activity: one moment, "1 entry" (no "6:02–6:02 PM").
    const [g] = groups([e]);
    expect(groupLabel(g, new Date("2026-10-27T12:00:00.000Z")).label).toMatch(/^Sat, Oct 24 · \d+:\d\d [AP]M$/);
    expect(groupMeta(g)).toBe("1 entry");
  });
});

describe("review-pr26 r2 n4: a Claude Code import picked onto Grok gets Grok's 600 s", () => {
  const servers: GrilladoServer[] = [];
  afterEach(async () => {
    while (servers.length) await servers.pop()!.close();
  });
  const req = (port: number, token: string, method: string, p: string, body?: unknown) =>
    new Promise<{ status: number; json: any }>((resolve, reject) => {
      const r = http.request({ host: "127.0.0.1", port, method, path: p, headers: { "x-grillado-token": token, "content-type": "application/json" } }, (res) => {
        let b = "";
        res.on("data", (d) => (b += d));
        res.on("end", () => resolve({ status: res.statusCode!, json: JSON.parse(b) }));
      });
      r.on("error", reject);
      r.end(body === undefined ? undefined : JSON.stringify(body));
    });
  for (const [what, timeoutMs, want] of [["the default", undefined, 600_000], ["GRILLADO_TIMEOUT_MS", 45_000, 45_000]] as const) {
    test(`${what}: ${want / 1000} s`, async () => {
      const w = world();
      cpFree(w, "free.jsonl");
      const web = mkdtempSync(path.join(os.tmpdir(), "grillado-web-"));
      writeFileSync(path.join(web, "index.html"), "<!doctype html>");
      const seen: [string, number][] = [];
      const adapters = createAdapters({ env: fakeEnv(fakeBinDir(["grok"])) }).map((a) => ({ ...a, run: (req: any, signal: any) => (seen.push([a.id, req.timeoutMs]), a.run(req, signal)) }));
      const server = new GrilladoServer({ adapters, store: w.store, webDir: web, port: 0, strictPort: true, found: w.svc(), ...(timeoutMs ? { timeoutMs } : {}) });
      servers.push(server);
      await server.detect();
      await server.listen();
      const call = (m: string, p: string, b?: unknown) => req(server.port, server.token, m, p, b);
      await server.scanProject();
      const free = (await call("GET", "/api/found")).json.rows.find((x: Row) => x.importable === "agent");
      expect(free.app ?? "claude").toBe("claude");
      const r = await call("POST", "/api/found/import", { id: free.id });
      expect(r.status).toBe(200);
      expect(seen).toEqual([["grok", want]]);
    });
  }
});
