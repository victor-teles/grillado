// Plan 002: read access to the project. Path rules, who may read, what the engine keeps, and the
// server end to end with the fake agent CLI (which logs its argv and cwd).
import { afterEach, describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, symlinkSync, writeFileSync } from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { createAdapters } from "../src/core/providers/adapters.ts";
import { MAX_FINDINGS, checkEvidence, isSensitive, mergeFindings, relativePath } from "../src/core/project-read.ts";
import { buildRoundPrompt, groundRound, stateFor } from "../src/core/engine.ts";
import { INTERVIEW_METHOD, ROUND_CONTRACT, roundSystemPrompt } from "../src/core/prompts.ts";
import { createSession, inYourCode, renderPlanMarkdown } from "../src/core/session.ts";
import { pathCheck, readPlace } from "../src/cli/project-read.ts";
import { GrilladoServer } from "../src/cli/server.ts";
import { Store } from "../src/cli/store.ts";
import { fakeBinDir, fakeEnv } from "./helpers.ts";

/** A git repository with a few files, a secret, and a file next to it (outside). */
function gitProject() {
  const parent = realpathSync(mkdtempSync(path.join(os.tmpdir(), "grillado-read-")));
  const root = path.join(parent, "recipes");
  mkdirSync(path.join(root, "src"), { recursive: true });
  writeFileSync(path.join(root, "package.json"), '{"name":"recipes"}');
  writeFileSync(path.join(root, "README.md"), "# Recipes");
  writeFileSync(path.join(root, ".env"), "TOKEN=x");
  writeFileSync(path.join(root, "src", "store.ts"), "export {}");
  writeFileSync(path.join(parent, "outside.txt"), "outside");
  symlinkSync(path.join(parent, "outside.txt"), path.join(root, "link.txt"));
  execFileSync("git", ["init", "-q"], { cwd: root });
  return { root, parent };
}

describe("path rules", () => {
  test.each([
    ["src/store.ts", "src/store.ts"],
    ["./src//store.ts", "src/store.ts"],
    ["/repo/src/store.ts", "src/store.ts"],
    ["src\\store.ts", "src/store.ts"],
    ["../etc/passwd", null],
    ["src/../../x", null],
    ["/etc/passwd", null],
    ["/repository/x", null],
    ["~/x", null],
    ["", null],
    [".env", null],
    ["config/.env.local", null],
    ["keys/server.pem", null],
    ["id_rsa.pub", null],
    ["credentials.json", null],
    [".git/config", null],
  ])("relativePath(%p) → %p", (raw, want) => {
    expect(relativePath(raw, "/repo")).toBe(want);
  });

  test("windows paths compare without case", () => {
    expect(relativePath("C:/Code/App/src/a.ts", "c:/code/app")).toBe("src/a.ts");
    expect(relativePath("D:/other/a.ts", "c:/code/app")).toBeNull();
  });

  test("sensitive names match any segment, not substrings", () => {
    expect(isSensitive("a/b/.env")).toBe(true);
    expect(isSensitive("docs/environment.md")).toBe(false);
    expect(isSensitive("src/keyboard.ts")).toBe(false);
  });

  test("on disk: must exist, symlinks must stay inside, absolute paths inside become relative", () => {
    const { root, parent } = gitProject();
    const check = pathCheck(root);
    expect(check("package.json")).toBe("package.json");
    expect(check(path.join(root, "src", "store.ts"))).toBe("src/store.ts");
    expect(check("src")).toBe("src");
    expect(check("missing.ts")).toBeNull();
    expect(check("link.txt")).toBeNull();
    expect(check(path.join(parent, "outside.txt"))).toBeNull();
    expect(check("../outside.txt")).toBeNull();
    expect(check(".env")).toBeNull();
  });
});

describe("who may read", () => {
  const dataDir = mkdtempSync(path.join(os.tmpdir(), "grillado-data-"));
  test("a git repository is read from its top level", async () => {
    const { root } = gitProject();
    expect(await readPlace(path.join(root, "src"), { dataDir })).toEqual({ ok: true, root, name: "recipes" });
  });
  test("refused: no project, not git, home, root, data dir, --no-code", async () => {
    const plain = realpathSync(mkdtempSync(path.join(os.tmpdir(), "grillado-plain-")));
    const { root } = gitProject();
    expect(await readPlace(undefined, { dataDir })).toEqual({ ok: false, reason: "no-project" });
    expect(await readPlace(plain, { dataDir })).toMatchObject({ ok: false, reason: "not-git" });
    expect(await readPlace(root, { dataDir, home: root })).toMatchObject({ ok: false, reason: "home" });
    expect(await readPlace("/", { dataDir })).toMatchObject({ ok: false, reason: "root" });
    expect(await readPlace(root, { dataDir: root })).toMatchObject({ ok: false, reason: "data-dir" });
    expect(await readPlace(root, { dataDir, noCode: true })).toMatchObject({ ok: false, reason: "off", name: "recipes" });
  });
  test("a repository whose top level is home is too wide, even from a subfolder", async () => {
    const { root } = gitProject();
    expect(await readPlace(path.join(root, "src"), { dataDir, home: root })).toMatchObject({ ok: false, reason: "home" });
  });
});

describe("what the engine keeps", () => {
  const check = (p: string) => (["package.json", "src/a.ts"].includes(p) ? p : null);
  const q = (key: string, evidence?: { path: string; note: string }[]) => ({
    key, label: key, title: `${key}?`, body: "", options: [{ id: "a", label: "A", description: "" }, { id: "b", label: "B", description: "" }], recommendedOptionId: "a", dependsOn: [], evidence,
  });

  test("evidence keeps good paths; findings need a valid source; known findings are skipped", () => {
    const s = createSession({ idea: "x", provider: "claude" });
    const reply: any = {
      type: "ask_round", summary: "", upcoming: [],
      questions: [q("one", [{ path: "package.json", note: "n" }, { path: ".env", note: "n" }, { path: "package.json", note: "dup" }]), q("two", [{ path: "nope", note: "n" }])],
      findings: [{ label: "Stack", fact: "Node", paths: ["package.json", "x"] }, { label: "Secret", fact: "a key", paths: [".env"] }],
    };
    groundRound(s, reply, check);
    expect(reply.questions[0].evidence).toEqual([{ path: "package.json", note: "n" }]);
    expect(reply.questions[1].evidence).toBeUndefined();
    expect(reply.findings).toBeUndefined();
    expect(s.findings).toEqual([{ id: "f1-1", round: 1, label: "Stack", fact: "Node", paths: ["package.json"] }]);
    // The same finding again next round is not added twice.
    groundRound(s, { ...reply, findings: [{ label: "stack", fact: "node", paths: ["src/a.ts"] }] }, check);
    expect(s.findings).toHaveLength(1);
  });

  test("findings are capped", () => {
    const many = Array.from({ length: MAX_FINDINGS + 5 }, (_, i) => ({ label: `L${i}`, fact: `F${i}`, paths: ["package.json"] }));
    expect(mergeFindings([], many, 1, check).all).toHaveLength(MAX_FINDINGS);
    expect(checkEvidence(Array.from({ length: 9 }, (_, i) => ({ path: i % 2 ? "package.json" : "src/a.ts", note: "" })), check)).toHaveLength(2);
  });

  test("findings ride along in the next round's state; a session without them sends today's state", () => {
    const s = createSession({ idea: "x", provider: "claude" });
    expect(stateFor(s)).not.toHaveProperty("findings", expect.anything());
    expect(buildRoundPrompt(s)).not.toContain("findings");
    s.findings = [{ id: "f1-1", round: 1, label: "Stack", fact: "Node", paths: ["package.json"] }];
    expect(stateFor(s).findings).toEqual([{ label: "Stack", fact: "Node", paths: ["package.json"] }]);
  });

  test("the prompt without read access is the one Grillado always sent", () => {
    expect(roundSystemPrompt()).toBe(`${INTERVIEW_METHOD}\n\n${ROUND_CONTRACT}`);
    expect(roundSystemPrompt({ read: true })).not.toContain("You have no tools");
  });

  test("the plan gets an In your code section from checked touches only", () => {
    const s = createSession({ idea: "x", provider: "claude" });
    const md = renderPlanMarkdown(s, { type: "plan", title: "T", markdown: "## Problem\nx", decisions: [], openDecisions: [], touches: [{ path: "src/a.ts", why: "the store" }] });
    expect(md).toContain("## In your code\n\n- `src/a.ts`: the store");
    expect(renderPlanMarkdown(s, { type: "plan", title: "T", markdown: "## Problem\nx", decisions: [], openDecisions: [] })).not.toContain("In your code");
    expect(inYourCode([{ path: "a`b.ts", why: "" }])).toEqual(["## In your code", "", "- `ab.ts`"]);
  });
});

// ---------------------------------------------------------------- server, end to end

const servers: GrilladoServer[] = [];
afterEach(async () => {
  while (servers.length) await servers.pop()!.close();
});

function webDir() {
  const dir = mkdtempSync(path.join(os.tmpdir(), "grillado-web-"));
  writeFileSync(path.join(dir, "index.html"), "<!doctype html><title>Grillado</title>");
  return dir;
}

function request(port: number, token: string, method: string, p: string, body?: unknown) {
  return new Promise<any>((resolve, reject) => {
    const req = http.request({ host: "127.0.0.1", port, method, path: p, headers: { "x-grillado-token": token, "content-type": "application/json" } }, (res) => {
      let d = "";
      res.on("data", (c) => (d += c));
      res.on("end", () => resolve({ status: res.statusCode, json: d ? JSON.parse(d) : {} }));
    });
    req.on("error", reject);
    req.end(body === undefined ? undefined : JSON.stringify(body));
  });
}

async function waitFor<T>(fn: () => Promise<T | undefined>, ms = 10_000): Promise<T> {
  const end = Date.now() + ms;
  for (;;) {
    const v = await fn();
    if (v !== undefined) return v;
    if (Date.now() > end) throw new Error("timed out");
    await new Promise((r) => setTimeout(r, 50));
  }
}

async function start(project: string, over: Partial<ConstructorParameters<typeof GrilladoServer>[0]> = {}, ids: ("claude" | "pi")[] = ["claude"]) {
  const log = path.join(mkdtempSync(path.join(os.tmpdir(), "grillado-log-")), "calls.jsonl");
  const env = fakeEnv(fakeBinDir(ids), { FAKE_LOG: log });
  const store = new Store(mkdtempSync(path.join(os.tmpdir(), "grillado-home-")));
  const server = new GrilladoServer({ adapters: createAdapters({ env }), store, webDir: webDir(), port: 0, strictPort: true, launchDir: project, ...over });
  servers.push(server);
  await server.detect();
  await server.listen();
  const api = (method: string, p: string, body?: unknown) => request(server.port, server.token, method, p, body);
  const calls = () =>
    readFileSync(log, "utf8")
      .trim()
      .split("\n")
      .map((l) => JSON.parse(l))
      .filter((c) => c.args[0] !== "--version");
  return { server, store, api, calls };
}

async function session(api: (m: string, p: string, b?: unknown) => Promise<any>, body: Record<string, unknown> = {}) {
  const created = await api("POST", "/api/sessions", { idea: "Save recipes offline", ...body });
  const id = created.json.id as string;
  const idle = (status: string) =>
    waitFor(async () => {
      const s = (await api("GET", `/api/sessions/${id}`)).json;
      return !s.busy && s.status === status ? s : undefined;
    });
  return { id, idle };
}

const accept = (s: any) => s.rounds.at(-1).questions.map((q: any) => ({ questionId: q.key, optionId: q.recommendedOptionId, accepted_recommendation: true }));
const isReadArgv = (c: any) => c.args.includes("Read,Grep,Glob") && c.args.includes("--strict-mcp-config");

describe("server: rounds and the plan read the project", () => {
  test("a session in a git repository reads for rounds and the plan, and keeps only checked paths", async () => {
    const { root } = gitProject();
    const { api, calls, store } = await start(path.join(root, "src"));
    const state = (await api("GET", "/api/state")).json;
    expect(state.project).toMatchObject({ name: "recipes", readable: true, on: true });
    expect(state.providers.find((p: any) => p.id === "claude").canRead).toBe(true);

    const { id, idle } = await session(api);
    let s = await idle("answering");
    expect(s.codeRead).toBe(true);
    expect(s.readRoot).toBe(root);
    expect(s.rounds[0].questions[0].evidence).toEqual([
      { path: "package.json", note: "Scripts and dependencies" },
      { path: "README.md", note: "What the project says it is" },
    ]);
    expect(s.rounds[0].questions[1].evidence).toBeUndefined();
    expect(s.findings).toEqual([{ id: "f1-1", round: 1, label: "Stack", fact: "The project is a Node package.", paths: ["package.json"] }]);
    expect(JSON.stringify(s)).not.toContain(".env");

    await api("POST", `/api/sessions/${id}/answers`, { round: 1, answers: accept(s) });
    s = await idle("answering");
    expect(s.findings).toHaveLength(1);
    await api("POST", `/api/sessions/${id}/answers`, { round: 2, answers: accept(s) });
    await idle("confirm");
    await api("POST", `/api/sessions/${id}/confirm`);
    s = await idle("plated");
    const md = readFileSync(s.plan.path, "utf8");
    expect(md).toContain("## In your code\n\n- `package.json`: Add the new script");
    expect(md).not.toContain("src/nope.ts");
    expect(md).not.toContain(".env");

    const runs = calls();
    expect(runs.length).toBeGreaterThanOrEqual(3);
    for (const c of runs) {
      expect(isReadArgv(c)).toBe(true);
      expect(c.cwd).toBe(root);
    }
    // The second round's prompt carried what round 1 learned.
    expect(store.load(id)?.findings?.[0].label).toBe("Stack");
  });

  test("other run kinds stay tools-off in a temp folder", async () => {
    const { root } = gitProject();
    const { api, calls } = await start(root);
    const { id, idle } = await session(api);
    let s = await idle("answering");
    await api("POST", `/api/sessions/${id}/answers`, { round: 1, answers: accept(s), wrap: true });
    await idle("confirm");
    await api("POST", `/api/sessions/${id}/confirm`);
    s = await idle("plated");
    const quote = s.plan.markdown.split("\n").find((l: string) => l.startsWith("- ") && l.includes("[R1:"))!.slice(2, 22);
    await api("POST", `/api/sessions/${id}/comments`, { quote, text: "Why this?" });
    // Every round and plan run of this session reads; the comment reply is the run that doesn't.
    const reply = await waitFor(async () => calls().find((c) => c.args.includes("stream-json") && !isReadArgv(c)));
    expect(reply.args[reply.args.indexOf("--tools") + 1]).toBe("");
    expect(reply.cwd).not.toBe(root);
    expect(isReadArgv(reply)).toBe(false);
  });

  test.each([
    ["--no-code", { noCode: true }, {}],
    ["the session's own switch", {}, { read: false }],
  ])("off with %s: today's argv in a temp folder", async (_name, over, body) => {
    const { root } = gitProject();
    const { api, calls } = await start(root, over);
    const { idle } = await session(api, body);
    const s = await idle("answering");
    expect(s.codeRead).toBe(false);
    expect(s.findings).toBeUndefined();
    expect(s.rounds[0].questions[0].evidence).toBeUndefined();
    const [first] = calls();
    expect(first.args[first.args.indexOf("--tools") + 1]).toBe("");
    expect(first.cwd).not.toBe(root);
  });

  test("the project preference turns reading off for the next session and survives a restart", async () => {
    const { root } = gitProject();
    const { api, calls, store } = await start(root);
    const off = await api("POST", "/api/project-read", { on: false });
    expect(off.json.project).toMatchObject({ readable: true, on: false });
    expect(store.readConfig().codeReadOff).toEqual([root]);
    const { idle } = await session(api);
    expect((await idle("answering")).codeRead).toBe(false);
    expect(isReadArgv(calls()[0])).toBe(false);
    expect((await api("POST", "/api/project-read", { on: "no" })).status).toBe(400);
  });

  test("what the composer showed at Start wins over the saved preference", async () => {
    const { root } = gitProject();
    const { api, calls } = await start(root);
    await api("POST", "/api/project-read", { on: false });
    const { idle } = await session(api, { read: true });
    expect((await idle("answering")).codeRead).toBe(true);
    expect(isReadArgv(calls()[0])).toBe(true);
  });

  test("outside a git repository, and with an agent that can't read, nothing changes", async () => {
    const plain = realpathSync(mkdtempSync(path.join(os.tmpdir(), "grillado-plain-")));
    const a = await start(plain);
    expect((await a.api("GET", "/api/state")).json.project).toMatchObject({ readable: false, reason: "not-git" });
    expect((await (await session(a.api)).idle("answering")).codeRead).toBe(false);

    const { root } = gitProject();
    const b = await start(root, { provider: "pi" }, ["pi"]);
    expect((await b.api("GET", "/api/state")).json.providers.find((p: any) => p.id === "pi").canRead).toBe(false);
    const s = await (await session(b.api)).idle("answering");
    expect(s.codeRead).toBe(false);
    expect(b.calls()[0].args).toContain("--no-tools");
  });

  test("a session from before plan 002 (no codeRead, rounds already asked) never starts reading", async () => {
    const { root } = gitProject();
    const { api, store, calls } = await start(root);
    const { id, idle } = await session(api, { read: false });
    const s = await idle("answering");
    const disk = store.load(id)!;
    delete disk.codeRead;
    store.save(disk);
    await api("POST", `/api/sessions/${id}/answers`, { round: 1, answers: accept(s) });
    await idle("answering");
    expect(calls().every((c) => !isReadArgv(c))).toBe(true);
  });
});

describe("server: Home's project is a choice (plan 005)", () => {
  test("switching projects moves the chip, the scan, reading and where new plans are saved", async () => {
    const plain = realpathSync(mkdtempSync(path.join(os.tmpdir(), "grillado-plain-")));
    const { root } = gitProject();
    const scanned: string[] = [];
    const foundFor = (cwd: string) => {
      scanned.push(cwd);
      return { state: "done", skip: null, view: () => ({ enabled: false, reason: "off" }) } as any;
    };
    const { api, store, calls } = await start(plain, { foundFor });
    expect((await api("GET", "/api/state")).json.project).toMatchObject({ readable: false, reason: "not-git", plansDir: "" });

    const r = await api("POST", "/api/project", { folder: root });
    expect(r.status).toBe(200);
    expect(r.json.project).toMatchObject({ name: "recipes", readable: true, on: true });
    expect(r.json.project.known.map((k: any) => k.name)).toEqual(["recipes", path.basename(plain)]);
    expect(scanned).toEqual([root]);
    expect(store.readConfig().projects).toEqual([root]);

    const { id, idle } = await session(api);
    const s = await idle("answering");
    expect(s.project).toBe(root);
    expect(s.readRoot).toBe(root);
    expect(store.load(id)!.planFile).toBe(path.join(root, "docs", "plans", `grillado-plan-${id}.md`));
    expect(isReadArgv(calls()[0])).toBe(true);

    // Back to the first folder, Recent names the other project's session; a second visit reuses a scan.
    const back = (await api("POST", "/api/project", { folder: plain })).json;
    expect(back.sessions.find((x: any) => x.id === id).project).toMatchObject({ name: "recipes" });
    await api("POST", "/api/project", { folder: root });
    expect(scanned).toEqual([root, plain]);
  });

  test("a folder that can't be a project is refused with a reason", async () => {
    const plain = realpathSync(mkdtempSync(path.join(os.tmpdir(), "grillado-plain-")));
    writeFileSync(path.join(plain, "a.txt"), "x");
    const { api } = await start(plain);
    const err = async (folder: unknown) => (await api("POST", "/api/project", { folder })).json.error;
    expect(await err(path.join(plain, "nope"))).toBe("That folder doesn’t exist.");
    expect(await err("code/app")).toBe("Type the full path, like ~/code/app.");
    expect(await err(path.join(plain, "a.txt"))).toBe("That’s a file. Pick its folder.");
    expect(await err("/")).toBe("Pick a project folder, not the whole disk.");
    expect(await err("  ")).toBe("Type the project’s folder.");
    expect((await api("GET", "/api/state")).json.project.folder).toContain(path.basename(plain));
  });

  test("the plans folder: --plans-dir for this run, then what Home saves, per project", async () => {
    const { root } = gitProject();
    const { api, store } = await start(root, { plansDir: "notes" });
    let p = (await api("GET", "/api/state")).json.project;
    expect(p.plansDir).toBe("notes");
    expect(p.plansAt.endsWith(path.join("recipes", "notes"))).toBe(true);

    p = (await api("POST", "/api/project", { plansDir: "decisions/grillado" })).json.project;
    expect(p.plansDir).toBe("decisions/grillado");
    expect(store.readConfig().plansDirs).toEqual({ [root]: "decisions/grillado" });
    const { id } = await session(api, { read: false });
    expect(store.load(id)!.planFile).toBe(path.join(root, "decisions", "grillado", `grillado-plan-${id}.md`));

    const abs = realpathSync(mkdtempSync(path.join(os.tmpdir(), "grillado-vault-")));
    p = (await api("POST", "/api/project", { plansDir: abs })).json.project;
    expect(p.plansAt).toBe(abs);

    p = (await api("POST", "/api/project", { plansDir: "" })).json.project;
    expect(p.plansDir).toBe("");
    expect(store.readConfig().plansDirs).toEqual({});
  });
});
