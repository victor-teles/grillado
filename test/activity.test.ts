// v1.1 item 6: the activity log (DECISIONS #51–66).
import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { GrilladoServer } from "../src/cli/server.ts";
import { Store } from "../src/cli/store.ts";
import {
  type ActivityLine,
  RunRecorder,
  accName,
  copyText,
  fmt,
  fold,
  groupLabel,
  groupMeta,
  groups,
  interrupted,
  liveMessage,
  meta,
  parseLines,
  say,
  title,
} from "../src/core/activity.ts";
import { createAdapters } from "../src/core/providers/adapters.ts";
import { createSession } from "../src/core/session.ts";
import { fakeBinDir, fakeEnv } from "./helpers.ts";

const at = (min: number) => new Date(Date.UTC(2026, 9, 26, 20, 0) + min * 60_000).toISOString();
const run = (id: string, kind: any, min: number, extra: Partial<Extract<ActivityLine, { type: "run.ended" }>> = {}, steps: [string, number][] = [["Read plan.md", 9]]): ActivityLine[] => [
  { v: 1, id, type: "run.started", kind, at: at(min), agent: "claude", target: { section: "Hosting", round: 4 } },
  ...steps.map(([label, ms]) => ({ v: 1 as const, run: id, type: "step" as const, label, ms })),
  { v: 1, run: id, type: "run.ended", status: "done", ms: steps.reduce((a, [, m]) => a + m, 0), at: at(min + 1), ...extra },
];

describe("durations (#53, §18 B)", () => {
  test("number, space, unit; one decimal under a minute", () => {
    expect([fmt(10), fmt(999), fmt(4200), fmt(59_940), fmt(72_000), fmt(3_840_000)]).toEqual(["10 ms", "999 ms", "4.2 s", "59.9 s", "1 min 12 s", "1 h 4 min"]);
  });
  test("no “0 ms” and no “60.0 s” (#83)", () => {
    expect([fmt(0), fmt(0.4), fmt(59_949), fmt(59_960), fmt(3_599_700)]).toEqual(["<1 ms", "<1 ms", "59.9 s", "1 min 0 s", "1 h 0 min"]);
    expect(say(0)).toBe("less than 1 millisecond");
  });
  test("spoken form for aria-label", () => {
    expect([say(4200), say(1000), say(10), say(72_000)]).toEqual(["4.2 seconds", "1.0 second", "10 milliseconds", "1 minute 12 seconds"]);
  });
});

describe("entries (#51)", () => {
  test("runs fold newest first with steps, titles and meta; a running run has no number", () => {
    const lines: ActivityLine[] = [...run("r1", "apply", 0, { result: { suggestions: 1 }, suggestions: [{ id: "s1", section: "Hosting" }] }, [["Read plan.md", 9], ["{agent} wrote 1 suggestion", 4400]]), { v: 1, id: "r2", type: "run.started", kind: "diagrams", at: at(5), agent: "claude" }];
    const [live, done] = fold(lines, new Map([["r2", "{agent} is drawing “Sync”"]]));
    expect(title(done)).toBe("Applied feedback on “Hosting”");
    expect(done.ms).toBe(4409);
    expect(meta(done, { agent: "Claude Code" })).toMatch(/^\d+:\d\d [AP]M · from your comment · 1 suggestion$/);
    expect(accName(done, { agent: "Claude Code" })).toMatch(/^Applied feedback on “Hosting”, finished, 4\.4 seconds, \d+:\d\d [AP]M, from your comment, 1 suggestion$/);
    expect(title(live)).toBe("Adding diagrams");
    expect(meta(live, { agent: "Claude Code" })).toMatch(/^Started \d+:\d\d [AP]M$/);
    expect(live.ms).toBeUndefined();
    expect(live.steps).toEqual([{ label: "{agent} is drawing “Sync”", state: "running" }]);
  });
  test("reviews on the latest run's suggestions update one row; ⌘Z amends it; an older run adds a row", () => {
    const base = [...run("r1", "apply", 0), ...run("r2", "diagrams", 2)];
    const rv = (runId: string, a: string[], r: string[] = [], undone?: string[]): ActivityLine => ({ v: 1, type: "review", run: runId, accepted: a, rejected: r, ...(undone ? { undone } : {}), at: at(3) });
    let e = fold([...base, rv("r2", ["s1"]), rv("r2", [], ["s2"])]);
    expect(e.length).toBe(3);
    expect(title(e[0])).toBe("You reviewed 2 suggestions");
    expect(meta(e[0], { agent: "A" })).toMatch(/1 accepted · 1 rejected$/);
    // All one way: the meta lists the sections, not the count the title already says (#82).
    const one = fold([...base, rv("r2", ["s1", "s2"])]);
    expect(meta(one[0], { agent: "A", sectionOf: (id) => ({ s1: "Sync", s2: "Hosting" })[id] })).toMatch(/· Sync · Hosting$/);
    expect(meta(one[0], { agent: "A" })).not.toMatch(/accepted/);
    e = fold([...base, rv("r2", ["s1"]), rv("r2", [], [], ["s1"])]);
    expect(e.length).toBe(2); // all undone: the row goes
    e = fold([...base, rv("r2", ["s1"]), rv("r1", ["s9"])]);
    expect(e.filter((x) => x.type === "review").length).toBe(2);
  });
  test("a torn last line is skipped; a started run with no end is interrupted", () => {
    const text = `${run("r1", "round", 0).map((l) => JSON.stringify(l)).join("\n")}\n${JSON.stringify({ v: 1, id: "r2", type: "run.started", kind: "round", at: at(3), agent: "claude" })}\n{"v":1,"ty`;
    const lines = parseLines(text);
    expect(lines.length).toBe(4);
    expect(interrupted(lines)).toEqual(["r2"]);
  });
  test("the agent's name shows only when it differs from the current one (#65)", () => {
    const [e] = fold(run("r1", "plan", 0, { result: { decisions: 18, sections: 6 } }));
    expect(meta(e, { agent: "Codex", agentId: "codex", agentNameOf: () => "Claude Code" })).toMatch(/after you confirmed · 18 decisions · 6 sections · Claude Code$/);
    expect(meta(e, { agent: "Claude Code", agentId: "claude" })).not.toMatch(/Claude Code$/);
  });
  test("failed, stopped and retry", () => {
    const [f] = fold(run("r1", "apply", 0, { status: "failed", reason: "rate" }));
    expect(title(f)).toBe("Couldn’t apply feedback on “Hosting”");
    expect(meta(f, { agent: "Claude Code" })).toMatch(/Claude Code hit its usage limit · nothing was changed$/);
    const [s] = fold(run("r2", "diagrams", 0, { status: "stopped", result: { diagrams: 1 }, notDone: ["Risks", "Hosting"] }));
    expect(meta(s, { agent: "A" })).toMatch(/stopped by you · 1 of 3 diagrams kept$/);
    const [r] = fold(run("r3", "apply", 0, { retryOf: "r1" }));
    expect(meta(r, { agent: "A" })).toMatch(/started again after the run below/);
  });
});

describe("groups (#52), copy log (#60), live region (#61)", () => {
  test("a gap over 30 minutes starts a work session; the count is runs only", () => {
    const e = fold([...run("r1", "apply", 0), { v: 1, type: "user", what: "answered", round: 4, answers: 3, at: at(2) }, ...run("r2", "diagrams", 50)]);
    const g = groups(e);
    expect(g.map((x) => x.entries.length)).toEqual([1, 2]);
    expect(groupMeta(g[1])).toBe("1 run · 9 ms");
    expect(groupLabel(g[0], new Date(at(60))).label).toMatch(/^Today · from \d+:\d\d [AP]M$/);
    expect(groupLabel(g[0], new Date(at(60 * 24 * 3))).label).toMatch(/^Mon, Oct 26 · \d+:\d\d–\d+:\d\d [AP]M$/);
  });
  test("Copy log is Markdown plain text with the current agent name", () => {
    const [e] = fold(run("r1", "apply", 0, { suggestions: [{ id: "s1", section: "Sync" }] }, [["Read your comment and {agent}’s reply", 3], ["{agent} wrote 1 suggestion", 4200]]));
    expect(copyText(e, { agent: "Claude Code", statusOf: () => "accepted" })).toMatch(/^Applied feedback on "Hosting" · Claude Code · Oct 26, \d+:\d\d [AP]M · 4\.2 s\n- Read your comment and Claude Code's reply · 3 ms\n- Claude Code wrote 1 suggestion · 4\.2 s\nResult: 1 suggestion \(Sync: accepted\)$/);
    const [f] = fold(run("r2", "apply", 0, { status: "failed", reason: "rate" }));
    expect(copyText(f, { agent: "Claude Code" }).split("\n").at(-1)).toBe("Result: failed — Claude Code hit its usage limit. Nothing was changed.");
  });
  test("live messages are run-level", () => {
    const lines = run("r1", "apply", 0, { suggestions: [{ id: "s1" }] }, [["x", 4400]]);
    expect(liveMessage(fold(lines.slice(0, 1))[0], "Claude Code")).toBe("Claude Code started applying feedback on Hosting.");
    expect(liveMessage(fold(lines)[0], "Claude Code")).toBe("Applied feedback on Hosting in 4.4 seconds. 1 suggestion to review.");
  });
});

describe("RunRecorder (#53, #54)", () => {
  test("steps are timed back to back and add up to the run total", async () => {
    const out: ActivityLine[] = [];
    const rec = new RunRecorder((l) => out.push(l), () => {}, { kind: "apply", agent: "claude", target: { section: "Sync" } });
    rec.step("Read plan.md", "{agent} is writing a suggestion");
    await new Promise((r) => setTimeout(r, 30));
    rec.step("{agent} wrote 1 suggestion");
    rec.end("done", { result: { suggestions: 1 } });
    const steps = out.filter((l) => l.type === "step") as Extract<ActivityLine, { type: "step" }>[];
    const end = out.at(-1) as Extract<ActivityLine, { type: "run.ended" }>;
    expect(steps.map((s) => s.label)).toEqual(["Read plan.md", "{agent} wrote 1 suggestion"]);
    expect(steps[1].ms).toBeGreaterThanOrEqual(25);
    expect(end.ms).toBe(steps.reduce((a, s) => a + s.ms, 0));
  });
  test("a stop closes the running step as stopped", () => {
    const out: ActivityLine[] = [];
    const rec = new RunRecorder((l) => out.push(l), () => {}, { kind: "diagrams", agent: "claude" });
    rec.running("{agent} is drawing “Sync”");
    rec.end("stopped", { last: "Stopped while {agent} was drawing “Sync”" });
    expect(out.filter((l) => l.type === "step")).toMatchObject([{ label: "Stopped while {agent} was drawing “Sync”", state: "stopped" }]);
    rec.step("late");
    expect(out.at(-1)).toMatchObject({ type: "run.ended", status: "stopped" });
  });
});

const PLAN = `# Shopping list

## Problem
Families lose track of the list.

## Sync
- Edits queue offline
- Last edit wins
`;

describe("activity.jsonl from the server (#59)", () => {
  const servers: GrilladoServer[] = [];
  afterEach(async () => {
    while (servers.length) await servers.pop()!.close();
  });
  async function serve(extra: Record<string, string> = {}, pre?: (store: Store, id: string) => void) {
    const store = new Store(mkdtempSync(path.join(os.tmpdir(), "grillado-home-")));
    const s = createSession({ idea: "Shopping list", provider: "claude" });
    s.status = "plated";
    s.plan = { title: "Shopping list", markdown: PLAN, path: "", openDecisions: [], createdAt: new Date().toISOString() };
    s.plan.path = store.writePlan(s.id, PLAN);
    store.save(s);
    pre?.(store, s.id);
    const web = mkdtempSync(path.join(os.tmpdir(), "grillado-web-"));
    writeFileSync(path.join(web, "index.html"), "<!doctype html>");
    mkdirSync(path.join(web, "assets"));
    const server = new GrilladoServer({ adapters: createAdapters({ env: { ...fakeEnv(fakeBinDir(["claude"])), ...extra } }), store, webDir: web, port: 0, strictPort: true });
    servers.push(server);
    await server.detect();
    await server.listen();
    const call = (method: string, p: string, body?: unknown) =>
      new Promise<{ status: number; json: any }>((resolve, reject) => {
        const req = http.request(
          { host: "127.0.0.1", port: server.port, method, path: `/api/sessions/${s.id}${p}`, headers: { "x-grillado-token": server.token, "content-type": "application/json" } },
          (res) => {
            let data = "";
            res.on("data", (d) => (data += d));
            res.on("end", () => resolve({ status: res.statusCode!, json: JSON.parse(data) }));
          },
        );
        req.on("error", reject);
        req.end(body === undefined ? undefined : JSON.stringify(body));
      });
    const settle = async () => {
      for (let i = 0; i < 300; i++) {
        const v = (await call("GET", "")).json;
        if (v.diagramRun && v.diagramRun.state !== "running") return v;
        await new Promise((r) => setTimeout(r, 40));
      }
      throw new Error("run never finished");
    };
    return { call, settle, file: store.activityPath(s.id) };
  }

  test("a diagrams run writes started, one step per section and ended; reviews are logged; the view folds them", async () => {
    const { call, settle, file } = await serve();
    await call("POST", "/diagrams", { sections: ["Problem", "Sync"], kinds: ["flowchart"] });
    let v = await settle();
    const lines = parseLines(readFileSync(file, "utf8"));
    expect(lines.map((l) => l.type)).toEqual(["run.started", "step", "step", "run.ended"]);
    const end = lines.at(-1) as Extract<ActivityLine, { type: "run.ended" }>;
    expect(end.ms).toBe(lines.filter((l) => l.type === "step").reduce((a, l: any) => a + l.ms, 0));
    expect(v.activity.entries[0]).toMatchObject({ type: "run", kind: "diagrams", status: "done" });
    const id = v.suggestions[0].id;
    expect(v.suggestions[0].run).toBe(lines[0].type === "run.started" ? lines[0].id : "");
    v = (await call("POST", "/suggestions", { op: "accept", ids: [id] })).json;
    expect(v.activity.entries[0]).toMatchObject({ type: "review", accepted: [id] });
    const page = (await call("GET", "/activity?limit=1")).json;
    expect(page.entries.length).toBe(1);
    expect(page.total).toBe(2);
  });

  test("a plan.md conflict logs which version won (#84 MF4)", async () => {
    const { call } = await serve();
    const md = (await call("GET", "")).json.plan.markdown;
    let v = (await call("POST", "/plan-conflict", { markdown: md, keep: "mine" })).json;
    v = (await call("GET", "")).json;
    expect(v.activity.entries[0]).toMatchObject({ type: "file", what: "kept-mine" });
    await call("POST", "/plan-conflict", { markdown: md, keep: "file" });
    v = (await call("GET", "")).json;
    expect(v.activity.entries[0]).toMatchObject({ type: "file", what: "loaded-file" });
    expect(meta(v.activity.entries[0], { agent: "A" })).toMatch(/you loaded the file$/);
  });

  test("a run with no end is written as interrupted at the next launch", async () => {
    const { call, file } = await serve({}, (store, id) =>
      store.appendActivity(id, [{ v: 1, id: "r_old", type: "run.started", kind: "apply", at: new Date().toISOString(), agent: "claude", target: { section: "Sync" } }]),
    );
    const v = (await call("GET", "")).json;
    expect(v.activity.entries[0]).toMatchObject({ id: "r_old", status: "interrupted" });
    expect(parseLines(readFileSync(file, "utf8")).at(-1)).toMatchObject({ type: "run.ended", run: "r_old", status: "interrupted" });
  });
});
