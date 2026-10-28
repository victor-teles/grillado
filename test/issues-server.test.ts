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
import { fakeBinDir, fakeEnv } from "./helpers.ts";
import { type LinearMock, STORY_MD, fakeGh, isWrite, linearMock, storySession } from "./issues-fixture.ts";
import { draftSession } from "./mcp-fixture.ts";

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

async function start(ghEnv: Record<string, string> = {}, agentEnv: Record<string, string> = {}) {
  const gh = fakeGh(ghEnv);
  mock = await linearMock();
  const store = new Store(mkdtempSync(path.join(os.tmpdir(), "grillado-home-")));
  const env = fakeEnv(fakeBinDir(["claude"]), agentEnv);
  const server = new GrilladoServer({ adapters: createAdapters({ env }), store, webDir: webDir(), port: 0, strictPort: true, launchDir: project(), issues: { gh: { bin: gh.bin, env: gh.env }, linear: { url: mock.url, retryMs: 5 } } });
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
