// "Send to issues" (v1.3 item 2) over HTTP: every route before the confirm is a read, the export runs
// in the background with its progress on the session, the Linear key never leaves secrets.json.
import { afterEach, describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { issuesOf } from "../src/cli/mcp.ts";
import { GrilladoServer } from "../src/cli/server.ts";
import { Store } from "../src/cli/store.ts";
import { createAdapters } from "../src/core/providers/adapters.ts";
import type { ProviderId } from "../src/core/providers/types.ts";
import { fakeBinDir, fakeEnv } from "./helpers.ts";
import { type LinearMock, STORY_MD, fakeGh, isWrite, linearMock, storySession } from "./issues-fixture.ts";
import { draftSession } from "./mcp-fixture.ts";
import { buildItems, contentHash, fallbackSlices } from "../src/core/issues.ts";

const servers: GrilladoServer[] = [];
let mock: LinearMock | undefined;
afterEach(async () => {
  while (servers.length) await servers.pop()!.close();
  await mock?.close();
  mock = undefined;
});

function webDir() {
  const dir = mkdtempSync(path.join(os.tmpdir(), "grillado-web-"));
  writeFileSync(path.join(dir, "index.html"), "<!doctype html><title>Grillado</title>");
  mkdirSync(path.join(dir, "assets"));
  return dir;
}

/** A project folder with a GitHub origin (local git only). */
function project() {
  const dir = mkdtempSync(path.join(os.tmpdir(), "grillado-proj-"));
  execFileSync("git", ["init", "-q", dir]);
  execFileSync("git", ["-C", dir, "remote", "add", "origin", "git@github.com:victor-teles/grillado.git"]);
  return dir;
}

async function start(ghEnv: Record<string, string> = {}, agentEnv: Record<string, string> = {}, o: { bins?: ProviderId[]; timeoutMs?: number; seen?: [string, number][] } = {}) {
  const gh = fakeGh(ghEnv);
  mock = await linearMock();
  const store = new Store(mkdtempSync(path.join(os.tmpdir(), "grillado-home-")));
  const env = fakeEnv(fakeBinDir(o.bins ?? ["claude"]), agentEnv);
  // o.seen records every run's agent and timeout (review-pr26 r2 n4).
  const adapters = createAdapters({ env }).map((a) => (o.seen ? { ...a, run: (req: any, signal: any) => (o.seen!.push([a.id, req.timeoutMs]), a.run(req, signal)) } : a));
  const server = new GrilladoServer({ adapters, store, ...(o.timeoutMs ? { timeoutMs: o.timeoutMs } : {}), webDir: webDir(), port: 0, strictPort: true, launchDir: project(), issues: { gh: { bin: gh.bin, env: gh.env }, linear: { url: mock.url, retryMs: 5 } } });
  servers.push(server);
  await server.detect();
  await server.listen();
  const call = (method: string, p: string, body?: unknown) =>
    new Promise<{ status: number; json: any; raw: string }>((resolve, reject) => {
      const req = http.request({ host: "127.0.0.1", port: server.port, method, path: p, headers: { "x-grillado-token": server.token, "content-type": "application/json" } }, (res) => {
        let raw = "";
        res.on("data", (d) => (raw += d));
        res.on("end", () => resolve({ status: res.statusCode!, raw, json: raw ? JSON.parse(raw) : null }));
      });
      req.on("error", reject);
      req.end(body === undefined ? undefined : JSON.stringify(body));
    });
  const done = async (id: string) => {
    for (let i = 0; i < 200; i++) {
      const r = await call("GET", `/api/sessions/${id}/issues`);
      if (r.json.run?.state === "done") return r.json;
      await new Promise((r) => setTimeout(r, 50));
    }
    throw new Error("export never finished");
  };
  return { server, store, gh, call, done, mock: mock! };
}

const GH = { tracker: "github", repo: "victor-teles/grillado" };

describe("before the confirm, nothing is written", () => {
  test("state, gh status, repo, labels, split and preview only read", async () => {
    const { store, gh, call } = await start();
    const s = storySession(store);
    const st = await call("GET", `/api/sessions/${s.id}/issues`);
    expect(st.json).toMatchObject({ destination: { tracker: "github" }, github: { origin: { host: "github.com", repo: "victor-teles/grillado" } }, issues: null, run: null, linear: { connected: false } });
    expect((await call("GET", "/api/github/status")).json).toMatchObject({ state: "ready", subIssues: "flag" });
    expect((await call("GET", "/api/github/repo?repo=victor-teles/grillado")).json).toMatchObject({ access: true, visibility: "private" });
    expect((await call("GET", "/api/github/repo?repo=bad")).status).toBe(400);
    expect((await call("GET", "/api/github/status?host=bad%20host")).json).toEqual({ error: "That isn’t a GitHub host." });
    expect((await call("GET", "/api/github/labels?repo=victor-teles/grillado")).json.labels[0].name).toBe("bug");
    const split = await call("POST", `/api/sessions/${s.id}/issues/split`, { use: "fallback" });
    expect(split.json.source).toBe("stories");
    expect(split.json.items.length).toBe(4);
    const pre = await call("POST", `/api/sessions/${s.id}/issues/preview`, GH);
    expect(pre.json.changes.map((c: any) => c.change)).toEqual(["new", "new", "new", "new"]);
    expect(gh.calls().length).toBeGreaterThan(0);
    expect(gh.calls().filter((c) => isWrite(c.args))).toEqual([]);
    expect(gh.state().issues).toEqual([]);
  });

  test("a draft can't be sent", async () => {
    const { store, call } = await start();
    const s = draftSession(store);
    const r = await call("POST", `/api/sessions/${s.id}/issues/export`, { ...GH, selected: ["plan"] });
    expect(r.status).toBe(409);
    expect(r.json.code).toBe("draft");
  });

  test("an issue with a banned word is refused before anything is sent", async () => {
    const { store, gh, call } = await start();
    const s = storySession(store);
    const r = await call("POST", `/api/sessions/${s.id}/issues/export`, { ...GH, selected: ["plan"], titles: { plan: "Run the grill-me flow" } });
    expect(r.status).toBe(422);
    expect(r.json.code).toBe("filtered");
    expect(gh.calls().filter((c) => isWrite(c.args))).toEqual([]);
  });

  test("gh logged out is a fix-it with the exact command, before any run starts", async () => {
    const { store, call } = await start({ FAKE_GH_AUTH: "out" });
    const s = storySession(store);
    expect((await call("GET", "/api/github/status")).json).toMatchObject({ state: "auth", command: "gh auth login" });
    const r = await call("POST", `/api/sessions/${s.id}/issues/export`, { ...GH, selected: ["plan"] });
    expect(r.status).toBe(424);
    expect(r.json.code).toBe("auth");
    expect(r.json.error).toBe("gh isn’t signed in to github.com.");
  });
});

describe("export", () => {
  test("202, progress on the session, links saved, re-export skips, get_plan has the links", async () => {
    const { store, gh, call, done } = await start();
    const s = storySession(store);
    const { json } = await call("POST", `/api/sessions/${s.id}/issues/split`, { use: "fallback" });
    const keys = json.items.map((it: any) => it.key);
    const r = await call("POST", `/api/sessions/${s.id}/issues/export`, { ...GH, selected: keys, labels: ["bug"] });
    expect(r.status).toBe(202);
    expect(r.json.run.state).toBe("running");
    const st = await done(s.id);
    expect(st.run.rows.map((x: any) => x.status)).toEqual(["created", "created", "created", "created"]);
    expect(st.issues.parent.url).toBe("https://github.com/victor-teles/grillado/issues/1");
    const view = (await call("GET", `/api/sessions/${s.id}`)).json;
    expect(view.issuesRun.state).toBe("done");
    expect(view.issueSplit).toBeUndefined();
    const onDisk = store.load(s.id)!;
    expect(issuesOf(onDisk)).toMatchObject({ tracker: "github", target: "victor-teles/grillado", parent: { number: 1 } });
    expect(Object.keys(issuesOf(onDisk)!.items)).toEqual(keys.slice(1));
    // Remembered: GitHub for this project, its labels (#177, #179).
    expect(store.readConfig().issues).toMatchObject({ last: "github", labels: { "github:victor-teles/grillado": ["bug"] } });
    const pre = await call("POST", `/api/sessions/${s.id}/issues/preview`, GH);
    expect(pre.json.changes.every((c: any) => c.change === "unchanged")).toBe(true);
    await call("POST", `/api/sessions/${s.id}/issues/export`, { ...GH, selected: keys });
    expect((await done(s.id)).run.rows.every((x: any) => x.status === "unchanged")).toBe(true);
    expect(gh.state().issues.length).toBe(4);
    const stats = JSON.parse(readFileSync(path.join(store.dir, "stats.json"), "utf8")).issues;
    expect(stats).toMatchObject({ runs: 2, cleanRuns: 2, created: 4, github: 2, plans: [s.id] });
  });

  // review-pr28 must 3: a plan exported before #28 ("**Covers:** R1·1 question answer") reads unchanged after it,
  // and an export over it writes nothing. Store and fake gh are seeded as that export left them, before the server reads them.
  test("issues sent with the old R·n Covers line read unchanged, and an export leaves them as sent", async () => {
    const { store, gh, call, done } = await start();
    const s = storySession(store);
    const q = (key: string, title: string) => ({ key, label: "", title, body: "", options: [{ id: "a", label: "A" }, { id: "b", label: "B" }], recommendedOptionId: "a", dependsOn: [] });
    const round = (n: number, questions: unknown[]) => ({ n, questions, summary: "", askedAt: s.createdAt, answeredAt: s.createdAt }) as any;
    s.rounds = [round(1, [q("storage", "Where do recipes live?")]), round(2, [q("other", "Who cooks?"), q("sync", "Sync between devices?")])];
    const { items } = buildItems(s, STORY_MD, "github", fallbackSlices(s, STORY_MD).slices);
    const old = (b: string) => b.replace("**Covers:** Where do recipes live?", "**Covers:** R1·1 Where do recipes live?").replace("**Covers:** Sync between devices?", "**Covers:** R2·2 Sync between devices?");
    expect(items.filter((it) => old(it.body) !== it.body).length).toBe(2);
    const url = (n: number) => `https://github.com/victor-teles/grillado/issues/${n}`;
    writeFileSync(path.join(gh.dir, "state.json"), JSON.stringify({
      next: items.length + 1, creates: items.length, failed: [], labels: [{ name: "bug", color: "d73a4a" }],
      issues: items.map((it, i) => ({ id: 9001 + i, number: i + 1, title: it.title, body: old(it.body), labels: [], state: "open", parent: i ? 1 : null })),
    }));
    const link = (i: number) => ({ id: String(9001 + i), number: i + 1, url: url(i + 1), contentHash: contentHash(items[i].title, old(items[i].body)) });
    s.issues = { tracker: "github", target: "victor-teles/grillado", labels: [], parent: link(0), items: Object.fromEntries(items.slice(1).map((it, i) => [it.key, link(i + 1)])), exportedAt: new Date().toISOString() };
    store.save(s);
    const pre = await call("POST", `/api/sessions/${s.id}/issues/preview`, GH);
    expect(pre.json.changes.map((c: any) => c.change)).toEqual(["unchanged", "unchanged", "unchanged", "unchanged"]);
    const before = gh.calls().length;
    await call("POST", `/api/sessions/${s.id}/issues/export`, { ...GH, selected: items.map((it) => it.key) });
    expect((await done(s.id)).run.rows.map((x: any) => x.status)).toEqual(["unchanged", "unchanged", "unchanged", "unchanged"]);
    expect(gh.calls().slice(before).filter((c) => isWrite(c.args))).toEqual([]);
    expect(gh.state().issues.map((x) => x.body)).toEqual(items.map((it) => old(it.body)));
  });

  test("Retry failed sends only the failed ones", async () => {
    const { store, gh, call, done } = await start({ FAKE_GH_FAIL_CREATE: "2" });
    const s = storySession(store);
    const keys = (await call("POST", `/api/sessions/${s.id}/issues/split`, { use: "fallback" })).json.items.map((it: any) => it.key);
    await call("POST", `/api/sessions/${s.id}/issues/export`, { ...GH, selected: keys });
    const first = await done(s.id);
    expect(Object.keys(first.issues.failed)).toEqual([keys[1]]);
    expect((await call("POST", `/api/sessions/${s.id}/issues/retry`)).status).toBe(202);
    const again = await done(s.id);
    expect(again.run.rows.map((x: any) => [x.key, x.status])).toEqual([["plan", "unchanged"], [keys[1], "created"]]);
    expect(gh.state().issues.length).toBe(4);
    expect((await call("POST", `/api/sessions/${s.id}/issues/retry`)).status).toBe(409);
  });

  test("one export per plan: a held lock is busy", async () => {
    const { store, call } = await start();
    const s = storySession(store);
    writeFileSync(path.join(store.sessionDir(s.id), "issues.lock"), String(process.pid));
    const r = await call("POST", `/api/sessions/${s.id}/issues/export`, { ...GH, selected: ["plan"] });
    expect(r.status).toBe(409);
    expect(r.json).toMatchObject({ code: "busy", error: "Issues are already being created for this plan." });
  });

  test("a story over 65,536 characters is cut to fit", async () => {
    const { store, gh, call, done } = await start();
    const long = `- As a cook, I ${"keep a very long note about this. ".repeat(2500)}\n`;
    const s = storySession(store, STORY_MD.replace("## Out of scope", `${long}\n## Out of scope`));
    const keys = (await call("POST", `/api/sessions/${s.id}/issues/split`, { use: "fallback" })).json.items.map((it: any) => it.key);
    await call("POST", `/api/sessions/${s.id}/issues/export`, { ...GH, selected: keys });
    await done(s.id);
    const bodies = gh.state().issues.map((x) => x.body);
    expect(Math.max(...bodies.map((b) => b.length))).toBeLessThanOrEqual(65_536);
    expect(bodies.some((b) => b.includes("_Cut to fit GitHub. The rest is in the parent issue “Recipe box”._"))).toBe(true);
  });
});

describe("what the sheet reads", () => {
  test("with no destination yet, preview still lists the items and reads nothing remote", async () => {
    const { store, gh, call } = await start();
    const s = storySession(store);
    const before = gh.calls().length;
    const r = await call("POST", `/api/sessions/${s.id}/issues/preview`, { tracker: "github" });
    expect(r.status).toBe(200);
    expect(r.json.items.length).toBe(4);
    expect(r.json.changes.every((c: any) => c.change === "new")).toBe(true);
    expect(gh.calls().length).toBe(before);
  });

  test("titles edited in the sheet stay with their items, so the next check reads unchanged", async () => {
    const { store, call, done } = await start();
    const s = storySession(store);
    const { json } = await call("POST", `/api/sessions/${s.id}/issues/preview`, GH);
    const keys = json.items.map((it: any) => it.key);
    await call("POST", `/api/sessions/${s.id}/issues/export`, { ...GH, selected: keys, titles: { plan: "Recipe box, v1" } });
    await done(s.id);
    const pre = await call("POST", `/api/sessions/${s.id}/issues/preview`, GH);
    expect(pre.json.items[0].title).toBe("Recipe box, v1");
    expect(pre.json.changes.every((c: any) => c.change === "unchanged")).toBe(true);
  });

  test("review r2: after a title edit, story edits and new stories still show (the fallback isn't frozen)", async () => {
    const { store, call, done } = await start();
    const s = storySession(store);
    const { json } = await call("POST", `/api/sessions/${s.id}/issues/preview`, GH);
    const keys = json.items.map((it: any) => it.key);
    // The sheet sends every row's title; only the edited one is kept.
    const sent = Object.fromEntries(json.items.map((it: any) => [it.key, it.title]));
    await call("POST", `/api/sessions/${s.id}/issues/export`, { ...GH, selected: keys, titles: { ...sent, [keys[1]]: "Photo import" } });
    await done(s.id);
    store.writePlan(s.id, STORY_MD.replace("I find a recipe by ingredient.", "I find a recipe by ingredient or by tag.").replace("- As a cook, I see my recipes on a second phone [R2:sync].\n", "- As a cook, I see my recipes on a second phone [R2:sync].\n- As a cook, I share a recipe with a friend.\n"));
    const pre = await call("POST", `/api/sessions/${s.id}/issues/preview`, GH);
    expect(pre.json.source).toBe("stories");
    const by = (k: string) => pre.json.changes.find((c: any) => c.key === k)?.change;
    const titles = pre.json.items.map((it: any) => it.title);
    expect(pre.json.items.find((it: any) => it.key === keys[1])?.title).toBe("Photo import");
    expect(by(keys[1])).toBe("unchanged");
    // The reworded story keeps its key (the slug of its start), so its issue is updated; the new one is offered.
    expect(by(keys[2])).toBe("update");
    expect(titles).toContain("As a cook, I find a recipe by ingredient or by tag");
    expect(titles).toContain("As a cook, I share a recipe with a friend");
    expect(pre.json.changes.filter((c: any) => c.change === "new").length).toBe(1);
  });

  test("an item taken out of the plan is listed as removed, with its title from the tracker", async () => {
    const { store, call, done } = await start();
    const s = storySession(store);
    const { json } = await call("POST", `/api/sessions/${s.id}/issues/preview`, GH);
    const keys = json.items.map((it: any) => it.key);
    await call("POST", `/api/sessions/${s.id}/issues/export`, { ...GH, selected: keys });
    await done(s.id);
    const last = json.items[json.items.length - 1];
    store.writePlan(s.id, STORY_MD.replace("- As a cook, I see my recipes on a second phone [R2:sync].\n", ""));
    const pre = await call("POST", `/api/sessions/${s.id}/issues/preview`, GH);
    expect(pre.json.items.length).toBe(3);
    expect(pre.json.changes.find((c: any) => c.key === last.key)?.change).toBe("removed");
    expect(pre.json.removed[last.key]).toBe(last.title);
  });

  test("once exported, a plan edit updates the split's issues instead of reading them as removed", async () => {
    const { store, call, done } = await start();
    const s = storySession(store);
    const split = await call("POST", `/api/sessions/${s.id}/issues/split`, {});
    const keys = split.json.items.map((it: any) => it.key);
    await call("POST", `/api/sessions/${s.id}/issues/export`, { ...GH, selected: keys });
    await done(s.id);
    store.writePlan(s.id, STORY_MD.replace("One app that keeps them on the device.", "One app that keeps them on the device, for the whole family."));
    const pre = await call("POST", `/api/sessions/${s.id}/issues/preview`, GH);
    expect(pre.json.source).toBe("agent");
    expect(pre.json.items.map((it: any) => it.key)).toEqual(keys);
    expect(pre.json.changes.map((c: any) => c.change)).toEqual(["update", "unchanged"]);
  });
  test("gh signed out: the exported items still show, unchecked against GitHub", async () => {
    const { store, call, done, gh } = await start();
    const s = storySession(store);
    await call("POST", `/api/sessions/${s.id}/issues/export`, { ...GH, selected: ["plan"] });
    await done(s.id);
    gh.set({ FAKE_GH_AUTH: "out" });
    const pre = await call("POST", `/api/sessions/${s.id}/issues/preview`, GH);
    expect(pre.status).toBe(200);
    expect(pre.json.changes[0]).toMatchObject({ key: "plan", change: "unchanged" });
  });
});

describe("the agent split", () => {
  test("{agent}'s slices, cached for the plan text; a failure falls back to the stories", async () => {
    const { store, call } = await start();
    const s = storySession(store);
    const r = await call("POST", `/api/sessions/${s.id}/issues/split`, {});
    expect(r.json.source).toBe("agent");
    expect(r.json.items.length).toBe(2);
    expect(r.json.items[1].covers).toEqual(["storage", "sync"]);
    expect((await call("GET", `/api/sessions/${s.id}/issues`)).json.split.source).toBe("agent");
  });

  test("review r4 (PO): an imported plan's to-dos are split by {agent} when asked", async () => {
    const { store, call } = await start();
    const s = storySession(store, "# Recipe box\n\n## Tasks\n- [ ] Save a recipe\n- [ ] Sync later\n");
    s.source = { app: "cursor", kind: "plan", path: "/nowhere/recipe.plan.md", date: s.createdAt } as never;
    store.save(s);
    const fb = await call("POST", `/api/sessions/${s.id}/issues/split`, { use: "fallback" });
    expect(fb.json.source).toBe("todos");
    // Review r5: with decisions it's still the split (slices that cover decisions), not the to-do grouping.
    expect(fb.json.decisions).toBeGreaterThan(0);
    const r = await call("POST", `/api/sessions/${s.id}/issues/split`, {});
    expect(r.json.source).toBe("agent");
    expect(r.json.failed).toBeUndefined();
    expect(r.json.items.slice(1).every((it: any) => it.body.includes("**Covers:**"))).toBe(true);
  });

  test("review r5: an empty agent reply keeps the stories and says so; it isn't a failure", async () => {
    const { store, call } = await start();
    const s = storySession(store);
    s.decisions = {};
    store.save(s);
    const r = await call("POST", `/api/sessions/${s.id}/issues/split`, {});
    expect(r.json.source).toBe("stories");
    expect(r.json.empty).toBe(true);
    expect(r.json.failed).toBeUndefined();
  });

  const TODO_MD = "# Budget\n\n## Tasks\n\n- [ ] Import bank CSVs\n- [ ] Tag each expense\n- [ ] Show the totals\n";
  const todoPlan = (store: Store) => {
    const s = storySession(store, TODO_MD);
    s.source = { app: "cursor", kind: "plan", path: "/nowhere/budget.plan.md", date: s.createdAt } as never;
    s.decisions = {};
    store.save(s);
    return s;
  };

  test("review r5: no decisions, so the to-dos are grouped (its own prompt), each in exactly one slice", async () => {
    const { store, call } = await start();
    const s = todoPlan(store);
    const pv = await call("POST", `/api/sessions/${s.id}/issues/preview`, {});
    expect(pv.json.source).toBe("todos");
    expect(pv.json.decisions).toBe(0);
    const r = await call("POST", `/api/sessions/${s.id}/issues/split`, {});
    expect(r.json.source).toBe("agent");
    expect(r.json.failed).toBeUndefined();
    const kids = r.json.items.slice(1);
    expect(kids.map((it: any) => it.title)).toEqual(["Ship Import bank CSVs and Tag each expense", "Ship Show the totals"]);
    expect(kids[0].body).toContain("- [ ] Import bank CSVs\n- [ ] Tag each expense");
  });

  for (const [mode, what] of [["missing", "a to-do left out"], ["dup", "a to-do in two slices"], ["invent", "an invented to-do"]] as const)
    test(`review r5: ${what} is an invalid grouping, so a failure that keeps the to-dos`, async () => {
      const { store, call } = await start({}, { FAKE_GROUP: mode });
      const s = todoPlan(store);
      const r = await call("POST", `/api/sessions/${s.id}/issues/split`, {});
      expect(r.json.source).toBe("todos");
      expect(r.json.failed).toBe("malformed");
      expect(r.json.items.length).toBe(4);
    });

  test("review r5: an empty grouping keeps the to-dos, plainly", async () => {
    const { store, call } = await start({}, { FAKE_GROUP: "empty" });
    const s = todoPlan(store);
    const r = await call("POST", `/api/sessions/${s.id}/issues/split`, {});
    expect(r.json.source).toBe("todos");
    expect(r.json.empty).toBe(true);
    expect(r.json.failed).toBeUndefined();
    expect(r.json.items.length).toBe(4);
  });

  test("FAKE_SPLIT=fail: the user stories, with the reason", async () => {
    const { store, call } = await start({}, { FAKE_SPLIT: "fail" });
    const s = storySession(store);
    const r = await call("POST", `/api/sessions/${s.id}/issues/split`, {});
    expect(r.json.source).toBe("stories");
    expect(r.json.failed).toBeTruthy();
  });
});

describe("Linear over HTTP", () => {
  test("connect checks the key, keeps it at 0600, never sends it back; disconnect removes it", async () => {
    const { store, call, mock, done } = await start();
    const bad = await call("POST", "/api/linear/connect", { key: "lin_api_nope" });
    expect(bad.status).toBe(401);
    expect(bad.json.help).toBe("https://linear.app/settings/account/security");
    const ok = await call("POST", "/api/linear/connect", { key: "lin_api_good" });
    expect(ok.json).toEqual({ connected: true, name: "Victor", last4: "good" });
    const file = path.join(store.dir, "secrets.json");
    expect(statSync(file).mode & 0o777).toBe(0o600);
    const teams = await call("GET", "/api/linear/teams");
    const projects = await call("GET", "/api/linear/projects?team=team-1");
    const labels = await call("GET", "/api/linear/labels?team=team-1");
    const s = storySession(store);
    const keys = (await call("POST", `/api/sessions/${s.id}/issues/split`, { use: "fallback", tracker: "linear" })).json.items.map((it: any) => it.key);
    const pre = await call("POST", `/api/sessions/${s.id}/issues/preview`, { tracker: "linear", team: "team-1" });
    expect(mock.requests.filter((q) => /mutation/.test(q.query))).toEqual([]);
    await call("POST", `/api/sessions/${s.id}/issues/export`, { tracker: "linear", team: "team-1", teamName: "Core", project: "proj-1", labels: ["label-1"], selected: keys });
    const st = await done(s.id);
    expect(st.run.name).toBe("Linear · Core");
    expect(st.run.rows.every((x: any) => x.status === "created")).toBe(true);
    expect(mock.issues.map((x) => x.parentId)).toEqual([null, "iss-1", "iss-1", "iss-1"]);
    for (const r of [ok, teams, projects, labels, pre, await call("GET", `/api/sessions/${s.id}`), await call("GET", "/api/linear"), await call("GET", "/api/state")]) expect(r.raw).not.toContain("lin_api_good");
    // On disk, only secrets.json has it.
    const hits = execFileSync("grep", ["-rl", "lin_api_good", store.dir], { encoding: "utf8" }).trim().split("\n");
    expect(hits).toEqual([file]);
    expect((await call("POST", "/api/linear/disconnect")).json).toEqual({ connected: false });
    expect((await call("GET", "/api/linear/teams")).status).toBe(401);
  });
});

describe("review-pr26 r2 n4: Split and grouping run on Grok get Grok's 600 s", () => {
  const todoPlan = (store: Store) => {
    const s = storySession(store, "# Budget\n\n## Tasks\n\n- [ ] Import bank CSVs\n- [ ] Tag each expense\n- [ ] Show the totals\n");
    s.source = { app: "cursor", kind: "plan", path: "/nowhere/budget.plan.md", date: s.createdAt } as never;
    s.decisions = {};
    store.save(s);
    return s;
  };
  test("a Claude Code plan split on Grok (the only agent here): 600 s; GRILLADO_TIMEOUT_MS still wins", async () => {
    const seen: [string, number][] = [];
    const { store, call } = await start({}, {}, { bins: ["grok"], seen });
    const s = storySession(store);
    expect(s.provider).toBe("claude");
    expect((await call("POST", `/api/sessions/${s.id}/issues/split`, {})).json.source).toBe("agent");
    expect(seen).toEqual([["grok", 600_000]]);
    const seen2: [string, number][] = [];
    const o = await start({}, {}, { bins: ["grok"], seen: seen2, timeoutMs: 45_000 });
    const s2 = storySession(o.store);
    await o.call("POST", `/api/sessions/${s2.id}/issues/split`, {});
    expect(seen2).toEqual([["grok", 45_000]]);
  });

  test("an imported to-do plan grouped on Grok: 600 s; GRILLADO_TIMEOUT_MS still wins", async () => {
    const seen: [string, number][] = [];
    const { store, call } = await start({}, {}, { bins: ["grok"], seen });
    const s = todoPlan(store);
    const r = await call("POST", `/api/sessions/${s.id}/issues/split`, {});
    expect(r.json.source).toBe("agent");
    expect(r.json.decisions).toBe(0);
    expect(seen).toEqual([["grok", 600_000]]);
    const seen2: [string, number][] = [];
    const o = await start({}, {}, { bins: ["grok"], seen: seen2, timeoutMs: 45_000 });
    await o.call("POST", `/api/sessions/${todoPlan(o.store).id}/issues/split`, {});
    expect(seen2).toEqual([["grok", 45_000]]);
  });
});
