// Cap planning rounds (#31): --max-rounds (#32), the cap gate (#33), no passivity nudge (#34).
import { afterEach, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { HELP, MAX_ROUNDS_ERROR, parseArgs } from "../src/cli/args.ts";
import { GrilladoServer } from "../src/cli/server.ts";
import { Store } from "../src/cli/store.ts";
import { createAdapters } from "../src/core/providers/adapters.ts";
import type { ProviderId } from "../src/core/providers/types.ts";
import { fakeBinDir, fakeEnv } from "./helpers.ts";

const ERR = "--max-rounds needs a whole number of 1 or more, like --max-rounds 2.";

describe("--max-rounds (#32)", () => {
  test("absent means 2; whole numbers of 1 or more start", () => {
    expect(parseArgs([]).maxRounds).toBe(2);
    expect(parseArgs(["--max-rounds", "1"]).maxRounds).toBe(1);
    expect(parseArgs(["--max-rounds=7"]).maxRounds).toBe(7);
    expect(parseArgs(["--max-rounds", "12", "--no-open"])).toMatchObject({ maxRounds: 12, open: false });
  });

  test("anything else is refused with the one message", () => {
    expect(MAX_ROUNDS_ERROR).toBe(ERR);
    for (const bad of [["0"], ["-1"], ["1.5"], ["2.0"], ["abc"], [""], ["1e1"], [" 3"], ["0x2"], ["99999999999999999999"], []])
      expect(() => parseArgs(["--max-rounds", ...bad].filter((x, i) => i === 0 || bad.length))).toThrow(ERR);
    expect(() => parseArgs(["--max-rounds", "--no-open"])).toThrow(ERR);
    expect(() => parseArgs(["--max-rounds=0"])).toThrow(ERR);
  });

  test("help names the flag and its default; mcp refuses it", () => {
    expect(HELP).toContain("--max-rounds <n>    Question rounds before the plan is written (default 2)\n");
    expect(() => parseArgs(["mcp", "--max-rounds", "3"])).toThrow("mcp only takes --data-dir");
  });

  test("a bad value exits before any session or agent exists", () => {
    const home = mkdtempSync(path.join(os.tmpdir(), "grillado-home-"));
    const log = path.join(home, "agent.jsonl");
    const env = fakeEnv(fakeBinDir(), { FAKE_LOG: log, GRILLADO_HOME: home });
    const r = spawnSync(process.execPath, [path.join(import.meta.dir, "..", "src", "cli", "main.ts"), "--max-rounds", "0", "--no-open", "--port", "0"], {
      env: { ...env, PATH: `${path.dirname(process.execPath)}:${env.PATH}` },
      encoding: "utf8",
      timeout: 20_000,
    });
    expect(r.status).toBe(2);
    expect(r.stderr.split("\n")[0]).toBe(`grillado: ${ERR}`);
    expect(r.stdout).toBe("");
    expect(existsSync(log)).toBe(false);
    expect(existsSync(path.join(home, "sessions")) ? readdirSync(path.join(home, "sessions")) : []).toEqual([]);
  });
});

// ---------------------------------------------------------------- the server

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

function request(port: number, method: string, p: string, headers: Record<string, string>, body?: unknown) {
  return new Promise<{ status: number; json: any }>((resolve, reject) => {
    const req = http.request({ host: "127.0.0.1", port, method, path: p, headers }, (res) => {
      let data = "";
      res.on("data", (d) => (data += d));
      res.on("end", () => resolve({ status: res.statusCode!, json: data ? JSON.parse(data) : null }));
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
    await new Promise((r) => setTimeout(r, 40));
  }
}

async function start(id: ProviderId, opts: { maxRounds?: number; extra?: Record<string, string>; store?: Store; log?: (line: string) => void } = {}) {
  const dir = mkdtempSync(path.join(os.tmpdir(), "grillado-rounds-"));
  const log = path.join(dir, "agent.jsonl");
  const env = fakeEnv(fakeBinDir([id]), { FAKE_LOG: log, ...opts.extra });
  const store = opts.store ?? new Store(path.join(dir, "home"));
  const server = new GrilladoServer({ adapters: createAdapters({ env }), store, webDir: webDir(), port: 0, strictPort: true, provider: id, maxRounds: opts.maxRounds, log: opts.log });
  servers.push(server);
  await server.detect();
  await server.listen();
  const h = { "x-grillado-token": server.token, "content-type": "application/json" };
  const api = (method: string, p: string, body?: unknown) => request(server.port, method, p, h, body);
  /** Agent runs so far (the fake logs one line per run; --version and --help aren't logged). */
  const runs = () => (existsSync(log) ? readFileSync(log, "utf8").trim().split("\n").filter(Boolean).length : 0);
  const idle = (sid: string, status: string) =>
    waitFor(async () => {
      const s = (await api("GET", `/api/sessions/${sid}`)).json;
      return !s.busy && s.status === status ? s : undefined;
    });
  const acceptAll = (s: any) => s.rounds.at(-1).questions.map((q: any) => ({ questionId: q.key, optionId: q.recommendedOptionId, accepted_recommendation: true }));
  const answer = async (sid: string) => {
    const s = await idle(sid, "answering");
    expect((await api("POST", `/api/sessions/${sid}/answers`, { round: s.rounds.at(-1).n, answers: acceptAll(s) })).status).toBe(200);
  };
  return { server, store, api, runs, idle, answer };
}

describe("the cap (#33)", () => {
  for (const id of ["claude", "codex", "grok", "pi"] as ProviderId[]) {
    test(`${id}: two saved rounds, then Confirm with no third question call`, async () => {
      const t = await start(id);
      const sid = (await t.api("POST", "/api/sessions", { idea: "A grilling recipe app" })).json.id;
      await t.answer(sid);
      await t.answer(sid);
      const s = await t.idle(sid, "confirm");
      expect(s).toMatchObject({ maxRounds: 2, stop: "cap", wrappedUp: false });
      expect(s.rounds).toHaveLength(2);
      // The fake would still ask a third time (frontier_empty); at the cap it is never called.
      expect(t.runs()).toBe(2);
      const more = await t.api("POST", `/api/sessions/${sid}/keep-going`);
      expect(more.status).toBe(400);
      expect(more.json.error).toBe("That was the last round. Write the plan.");
      expect(t.runs()).toBe(2);
    });
  }

  test("--max-rounds 1 stops after one round", async () => {
    const t = await start("claude", { maxRounds: 1 });
    const sid = (await t.api("POST", "/api/sessions", { idea: "x" })).json.id;
    await t.answer(sid);
    const s = await t.idle(sid, "confirm");
    expect(s).toMatchObject({ maxRounds: 1, stop: "cap" });
    expect(t.runs()).toBe(1);
  });

  test("an empty frontier below the cap ends early; Keep going still runs a round", async () => {
    const t = await start("claude", { maxRounds: 5 });
    const sid = (await t.api("POST", "/api/sessions", { idea: "x" })).json.id;
    await t.answer(sid);
    await t.answer(sid);
    const s = await t.idle(sid, "confirm");
    expect(s).toMatchObject({ stop: "empty", maxRounds: 5 });
    expect(s.rounds).toHaveLength(2);
    expect(t.runs()).toBe(3);
    expect((await t.api("POST", `/api/sessions/${sid}/keep-going`)).status).toBe(200);
    const next = await t.idle(sid, "answering");
    expect(next.rounds).toHaveLength(3);
    expect(next.stop).toBeUndefined();
  });

  test("a session reopened at the cap goes to Confirm, using the running process's N", async () => {
    const t = await start("claude");
    const sid = (await t.api("POST", "/api/sessions", { idea: "x" })).json.id;
    await t.answer(sid);
    await t.idle(sid, "answering");
    // Cut off while asking after round 1 (an old Grillado would have asked for round 2 here).
    const saved = t.store.load(sid)!;
    saved.rounds.length = 1;
    saved.rounds[0].answers = saved.rounds[0].questions.map((q) => ({ questionId: q.key, optionId: q.recommendedOptionId, accepted_recommendation: true }));
    saved.status = "asking";
    await t.server.close();
    servers.length = 0;
    t.store.save(saved);

    // Reopened with --max-rounds 1: at the cap, so Confirm with no agent call.
    const a = await start("claude", { maxRounds: 1, store: t.store });
    const s1 = (await a.api("GET", `/api/sessions/${sid}`)).json;
    expect(s1).toMatchObject({ status: "confirm", stop: "cap", maxRounds: 1 });
    expect(s1.error).toBeUndefined();
    expect(a.runs()).toBe(0);
    await a.server.close();
    servers.length = 0;
    t.store.save(saved);

    // Reopened with no flag: N is 2, so the old rule applies (interrupted, Retry asks round 2).
    const b = await start("claude", { store: t.store });
    const s2 = (await b.api("GET", `/api/sessions/${sid}`)).json;
    expect(s2).toMatchObject({ status: "asking", maxRounds: 2 });
    expect(s2.error.message).toBe("Interrupted. Retry to continue.");
  });

  test("Reopen on the cap Confirm: the re-ask runs, doesn't count, and Confirm reads Round 2 of 2 again", async () => {
    const { roundStatus } = await import("../web/src/app/rounds.ts");
    const t = await start("claude");
    const sid = (await t.api("POST", "/api/sessions", { idea: "x" })).json.id;
    await t.answer(sid);
    await t.answer(sid);
    expect(roundStatus(await t.idle(sid, "confirm"), "Claude Code")).toBe("Round 2 of 2 is done.");
    expect((await t.api("POST", `/api/sessions/${sid}/reopen`, { key: "platform" })).status).toBe(200);
    await t.answer(sid); // platform again
    await t.answer(sid); // storage, which depended on it
    const s = await t.idle(sid, "confirm");
    expect(s.rounds).toHaveLength(4);
    expect(s.rounds.map((r: any) => !!r.reask)).toEqual([false, false, true, true]);
    expect(s.rounds.filter((r: any) => !r.reask)).toHaveLength(2);
    expect(s.stop).toBe("cap");
    expect(t.runs()).toBe(4);
    expect(roundStatus(s, "Claude Code")).toBe("Round 2 of 2 is done.");
    expect(roundStatus(s, "Claude Code")).not.toBe("3 rounds done. The cap is 2.");
    // The repair didn't buy a new round: Keep going is still refused.
    expect((await t.api("POST", `/api/sessions/${sid}/keep-going`)).status).toBe(400);
  });

  test("a relaunch with a lower --max-rounds is the one case that reads \"{s} rounds done\"", async () => {
    const { roundStatus } = await import("../web/src/app/rounds.ts");
    const t = await start("claude", { maxRounds: 3, extra: { FAKE_MODE: "long" } });
    const sid = (await t.api("POST", "/api/sessions", { idea: "x" })).json.id;
    for (let i = 0; i < 3; i++) await t.answer(sid);
    expect(roundStatus(await t.idle(sid, "confirm"), "Claude Code")).toBe("Round 3 of 3 is done.");
    await t.server.close();
    servers.length = 0;
    const b = await start("claude", { store: t.store });
    const s = (await b.api("GET", `/api/sessions/${sid}`)).json;
    expect(s).toMatchObject({ status: "confirm", stop: "cap", maxRounds: 2 });
    expect(roundStatus(s, "Claude Code")).toBe("3 rounds done. The cap is 2.");
  });

  test("PR44-rounds M1: past a lowered cap, no Ask 1 more round, the grant is refused and nothing runs", async () => {
    const { capAction, roundCounter } = await import("../web/src/app/rounds.ts");
    const t = await start("claude", { maxRounds: 3, extra: { FAKE_MODE: "long" } });
    const sid = (await t.api("POST", "/api/sessions", { idea: "x" })).json.id;
    for (let i = 0; i < 3; i++) await t.answer(sid);
    await t.idle(sid, "confirm");
    await t.server.close();
    servers.length = 0;
    const b = await start("claude", { store: t.store });
    const s = (await b.api("GET", `/api/sessions/${sid}`)).json;
    expect(capAction(s)).toBeNull();
    const c = roundCounter(s, 3);
    expect([c.lead, c.tag, !!c.strong]).toEqual(["Round 3", "the cap is 2", false]);
    const more = await b.api("POST", `/api/sessions/${sid}/ask-more`);
    expect([more.status, more.json.error]).toEqual([400, "That was the last round. Write the plan."]);
    expect(t.store.load(sid)!.extra).toBeUndefined();
    expect((await b.api("GET", `/api/sessions/${sid}`)).json).toMatchObject({ status: "confirm", stop: "cap" });
    expect(b.runs()).toBe(0);
  });

  test("an older session without reask flags or stop loads, and every round it has counts", async () => {
    const { roundStatus, atCap } = await import("../web/src/app/rounds.ts");
    const t = await start("claude");
    const sid = (await t.api("POST", "/api/sessions", { idea: "x" })).json.id;
    await t.answer(sid);
    await t.answer(sid);
    await t.idle(sid, "confirm");
    await t.server.close();
    servers.length = 0;
    const saved: any = t.store.load(sid)!;
    for (const r of saved.rounds) delete r.reask;
    delete saved.stop;
    t.store.save(saved);
    const b = await start("claude", { store: t.store });
    const s = (await b.api("GET", `/api/sessions/${sid}`)).json;
    expect(s.status).toBe("confirm");
    expect(atCap(s)).toBe(true);
    expect(roundStatus(s, "Claude Code")).toBeUndefined(); // no stop recorded: no line, as before
    expect((await b.api("POST", `/api/sessions/${sid}/keep-going`)).status).toBe(400);
  });
});

describe("no passivity nudge (#34)", () => {
  test("four all-recommendation rounds in a row, and round 5 shows no nudge", async () => {
    const t = await start("claude", { maxRounds: 6, extra: { FAKE_MODE: "long" } });
    const sid = (await t.api("POST", "/api/sessions", { idea: "x" })).json.id;
    for (let i = 0; i < 4; i++) await t.answer(sid);
    const s = await t.idle(sid, "answering");
    expect(s.rounds).toHaveLength(5);
    expect(s.rounds.slice(0, 4).every((r: any) => r.answers.every((a: any) => a.accepted_recommendation))).toBe(true);
    expect(s).not.toHaveProperty("nudge");
    expect(s).not.toHaveProperty("acceptStreak");
    expect((await t.api("POST", `/api/sessions/${sid}/nudge`)).status).toBe(404);
  });
});

describe("Confirm's status line (#33)", () => {
  const view = (k: number, over: Record<string, unknown> = {}) =>
    ({ rounds: Array.from({ length: k }, (_, i) => ({ n: i + 1 })), reopened: [], stale: {}, maxRounds: 2, wrappedUp: false, ...over }) as any;
  test("the cap, the agent ending early, above the cap, and nothing after a wrap", async () => {
    const { roundStatus, atCap } = await import("../web/src/app/rounds.ts");
    expect(roundStatus(view(2, { stop: "cap" }), "Grok")).toBe("Round 2 of 2 is done.");
    expect(roundStatus(view(1, { stop: "empty" }), "Grok")).toBe("Round 1 of 2 · Grok has nothing left to ask.");
    expect(roundStatus(view(4, { stop: "cap" }), "Grok")).toBe("4 rounds done. The cap is 2.");
    const reasked = view(4, { stop: "cap" });
    reasked.rounds[2].reask = reasked.rounds[3].reask = true;
    expect(roundStatus(reasked, "Grok")).toBe("Round 2 of 2 is done.");
    expect(atCap(reasked)).toBe(true);
    expect(roundStatus(view(1, { wrappedUp: true }), "Grok")).toBeUndefined();
    expect(atCap(view(2))).toBe(true);
    expect(atCap(view(1))).toBe(false);
    expect(atCap(view(2, { stale: { a: {} } }))).toBe(false);
  });
});

describe("plan time (#41)", () => {
  const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

  test("round 1's start, every round's time and the plan's are stamped; the plan updates the session; stdout gets the elapsed line", async () => {
    const lines: string[] = [];
    const t = await start("claude", { log: (l) => lines.push(l) });
    const sid = (await t.api("POST", "/api/sessions", { idea: "A grilling recipe app" })).json.id;
    await t.answer(sid);
    await t.answer(sid);
    const confirm = await t.idle(sid, "confirm");
    const before = confirm.updatedAt;
    await new Promise((r) => setTimeout(r, 5));
    expect((await t.api("POST", `/api/sessions/${sid}/confirm`)).status).toBe(200);
    await t.idle(sid, "plated");
    const s = t.store.load(sid)!;
    expect(s.roundsStartedAt).toMatch(ISO);
    expect(s.rounds.map((r) => r.askedAt)).toEqual([expect.stringMatching(ISO), expect.stringMatching(ISO)]);
    expect(Date.parse(s.roundsStartedAt!)).toBeLessThanOrEqual(Date.parse(s.rounds[0].askedAt));
    expect(s.plan!.createdAt).toMatch(ISO);
    // Friction 15: writing the plan updates the session.
    expect(s.updatedAt).toBe(s.plan!.createdAt);
    expect(Date.parse(s.updatedAt)).toBeGreaterThan(Date.parse(before));
    const ms = Date.parse(s.plan!.createdAt) - Date.parse(s.roundsStartedAt!);
    expect(lines).toEqual([`Plan written ${Math.floor(ms / 60_000)} min ${Math.floor((ms % 60_000) / 1000)} s after round 1 started.`]);
    expect(lines[0]).toMatch(/^Plan written \d+ min \d+ s after round 1 started\.$/);
  });

  test("minutes and seconds are whole; a session with no round-1 start prints nothing", async () => {
    const { createSession, planTiming } = await import("../src/core/session.ts");
    const s = createSession({ idea: "x", provider: "claude" });
    s.plan = { title: "t", markdown: "m", path: "/tmp/p.md", openDecisions: [], createdAt: "2026-10-29T13:12:05.999Z" };
    expect(planTiming(s)).toBeUndefined();
    s.roundsStartedAt = "2026-10-29T13:00:00.000Z";
    expect(planTiming(s)).toBe("Plan written 12 min 5 s after round 1 started.");
    s.plan.createdAt = "2026-10-29T15:00:59.000Z";
    expect(planTiming(s)).toBe("Plan written 120 min 59 s after round 1 started.");
  });

  test("elapsed time never starts, stops or extends a round", async () => {
    const t = await start("claude");
    const sid = (await t.api("POST", "/api/sessions", { idea: "x" })).json.id;
    await t.idle(sid, "answering");
    // Round 1 started a day ago: nothing about the rounds changes.
    await t.server.close();
    servers.length = 0;
    const saved = t.store.load(sid)!;
    const started = new Date(Date.now() - 86_400_000).toISOString();
    saved.roundsStartedAt = started;
    t.store.save(saved);
    const b = await start("claude", { store: t.store });
    await b.answer(sid);
    await b.answer(sid);
    const s = await b.idle(sid, "confirm");
    expect(s).toMatchObject({ stop: "cap" });
    expect(s.rounds).toHaveLength(2);
    expect(b.store.load(sid)!.roundsStartedAt).toBe(started);
  });
});

describe("Ask 1 more round (#37)", () => {
  test("at the cap: one extra round runs, then You’ve used the extra round and only the plan write", async () => {
    const { roundStatus, roundCounter, capAction } = await import("../web/src/app/rounds.ts");
    const t = await start("claude", { extra: { FAKE_MODE: "long" } });
    const sid = (await t.api("POST", "/api/sessions", { idea: "x" })).json.id;
    await t.answer(sid);
    await t.answer(sid);
    const cap = await t.idle(sid, "confirm");
    expect(capAction(cap)).toEqual({ label: "Ask 1 more round", action: "ask-more" });
    expect(t.runs()).toBe(2);
    const more = await t.api("POST", `/api/sessions/${sid}/ask-more`);
    expect(more.status).toBe(200);
    expect(more.json).toMatchObject({ extra: true, status: "asking" });
    const r3 = await t.idle(sid, "answering");
    expect(r3.rounds).toHaveLength(3);
    expect(r3.maxRounds).toBe(2);
    const c = roundCounter(r3, 3);
    expect(`${c.lead} · ${c.tag}`).toBe("Extra round · last round");
    await t.answer(sid);
    const done = await t.idle(sid, "confirm");
    expect(done).toMatchObject({ stop: "cap", extra: true });
    expect(t.runs()).toBe(3);
    expect(roundStatus(done, "Claude Code")).toBe("You’ve used the extra round.");
    expect(capAction(done)).toBeNull();
    for (const action of ["ask-more", "keep-going"]) expect((await t.api("POST", `/api/sessions/${sid}/${action}`)).status).toBe(400);
    expect(t.runs()).toBe(3);
  });

  test("below the cap there is no extra round to ask for", async () => {
    const t = await start("claude", { maxRounds: 5 });
    const sid = (await t.api("POST", "/api/sessions", { idea: "x" })).json.id;
    await t.answer(sid);
    await t.answer(sid);
    await t.idle(sid, "confirm"); // the agent ended early at 2 of 5
    expect((await t.api("POST", `/api/sessions/${sid}/ask-more`)).status).toBe(400);
    expect(t.store.load(sid)!.extra).toBeUndefined();
  });

  test("the grant is saved on the click, before the batch: a reload keeps one grant and can't take a second", async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "grillado-ctl-"));
    const ctl = path.join(dir, "ctl.json");
    writeFileSync(ctl, JSON.stringify({ FAKE_MODE: "long" }));
    const t = await start("claude", { extra: { FAKE_CTL: ctl } });
    const sid = (await t.api("POST", "/api/sessions", { idea: "x" })).json.id;
    await t.answer(sid);
    await t.answer(sid);
    await t.idle(sid, "confirm");
    writeFileSync(ctl, JSON.stringify({ FAKE_MODE: "long", FAKE_DELAY_MS: "20000" }));
    expect((await t.api("POST", `/api/sessions/${sid}/ask-more`)).status).toBe(200);
    // Saved before the agent answers, and a second click is refused.
    expect(t.store.load(sid)).toMatchObject({ extra: true, status: "asking" });
    expect(t.store.load(sid)!.rounds).toHaveLength(2);
    expect((await t.api("POST", `/api/sessions/${sid}/ask-more`)).status).toBe(400);
    await t.server.close();
    servers.length = 0;

    writeFileSync(ctl, JSON.stringify({ FAKE_MODE: "long" }));
    const b = await start("claude", { store: t.store, extra: { FAKE_CTL: ctl } });
    const s = (await b.api("GET", `/api/sessions/${sid}`)).json;
    expect(s).toMatchObject({ status: "asking", extra: true });
    expect(s.error.message).toBe("Interrupted. Retry to continue.");
    expect((await b.api("POST", `/api/sessions/${sid}/retry`)).status).toBe(200);
    await b.answer(sid);
    const done = await b.idle(sid, "confirm");
    expect(done.rounds).toHaveLength(3);
    expect(done).toMatchObject({ stop: "cap", extra: true });
    expect((await b.api("POST", `/api/sessions/${sid}/ask-more`)).status).toBe(400);
    expect(b.runs()).toBe(1);
  });

  test("a saved extra batch still unanswered is shown again after a reload", async () => {
    const t = await start("claude", { extra: { FAKE_MODE: "long" } });
    const sid = (await t.api("POST", "/api/sessions", { idea: "x" })).json.id;
    await t.answer(sid);
    await t.answer(sid);
    await t.idle(sid, "confirm");
    await t.api("POST", `/api/sessions/${sid}/ask-more`);
    const r3 = await t.idle(sid, "answering");
    await t.server.close();
    servers.length = 0;
    const b = await start("claude", { store: t.store, extra: { FAKE_MODE: "long" } });
    const s = (await b.api("GET", `/api/sessions/${sid}`)).json;
    expect(s).toMatchObject({ status: "answering", extra: true });
    expect(s.rounds.at(-1).questions).toEqual(r3.rounds.at(-1).questions);
    expect(b.runs()).toBe(0);
  });
});

describe("Wrap up early and Send and wrap up (#38, #39)", () => {
  const stopped = (t: { store: Store }, sid: string) => {
    const f = t.store.activityPath(sid);
    return existsSync(f) ? readFileSync(f, "utf8").split("\n").filter((l) => l.includes('"stopped"')).length : 0;
  };

  test("Send and wrap up on round 1 saves the answers and opens Confirm with no agent run and no stopped entry", async () => {
    const { roundStatus, capAction } = await import("../web/src/app/rounds.ts");
    const t = await start("claude");
    const sid = (await t.api("POST", "/api/sessions", { idea: "x" })).json.id;
    const s1 = await t.idle(sid, "answering");
    const answers = s1.rounds[0].questions.map((q: any) => ({ questionId: q.key, optionId: q.recommendedOptionId, accepted_recommendation: true }));
    const r = await t.api("POST", `/api/sessions/${sid}/answers`, { round: 1, answers, wrap: true });
    expect(r.status).toBe(200);
    expect(r.json).toMatchObject({ status: "confirm", wrappedUp: true, busy: false });
    expect(r.json.stop).toBeUndefined();
    expect(t.runs()).toBe(1);
    const saved = t.store.load(sid)!;
    expect(Object.keys(saved.decisions).sort()).toEqual(answers.map((a: any) => a.questionId).sort());
    expect(saved.rounds[0].answers).toHaveLength(answers.length);
    expect(stopped(t, sid)).toBe(0);
    // Below the cap: no status line, and Keep going is still the second button.
    expect(roundStatus(r.json, "Claude Code")).toBeUndefined();
    expect(capAction(r.json)).toBeNull();
    expect((await t.api("POST", `/api/sessions/${sid}/keep-going`)).status).toBe(200);
    await t.idle(sid, "answering");
    expect(t.runs()).toBe(2);
  });

  test("wrap: true on round N is a plain Send round: the cap Confirm, still no agent run", async () => {
    const t = await start("claude");
    const sid = (await t.api("POST", "/api/sessions", { idea: "x" })).json.id;
    await t.answer(sid);
    const s2 = await t.idle(sid, "answering");
    const answers = s2.rounds[1].questions.map((q: any) => ({ questionId: q.key, optionId: q.recommendedOptionId, accepted_recommendation: true }));
    expect((await t.api("POST", `/api/sessions/${sid}/answers`, { round: 2, answers, wrap: true })).status).toBe(200);
    expect(await t.idle(sid, "confirm")).toMatchObject({ stop: "cap", wrappedUp: false });
    expect(t.runs()).toBe(2);
  });

  test("Wrap it up during round N lands on the cap Confirm; unanswered questions stay open", async () => {
    const { roundStatus, capAction } = await import("../web/src/app/rounds.ts");
    const t = await start("claude");
    const sid = (await t.api("POST", "/api/sessions", { idea: "x" })).json.id;
    await t.answer(sid);
    const open = (await t.idle(sid, "answering")).rounds[1].questions.map((q: any) => q.key);
    const w = await t.api("POST", `/api/sessions/${sid}/wrap`);
    expect(w.json).toMatchObject({ status: "confirm", wrappedUp: true, stop: "cap" });
    expect(roundStatus(w.json, "Claude Code")).toBe("Round 2 of 2 is done.");
    expect(capAction(w.json)).toEqual({ label: "Ask 1 more round", action: "ask-more" });
    for (const k of open) expect(t.store.load(sid)!.decisions[k]).toBeUndefined();
    expect((await t.api("POST", `/api/sessions/${sid}/keep-going`)).status).toBe(400);
  });

  test("Wrap it up during the extra round offers only the plan write", async () => {
    const { roundStatus, capAction, capReached } = await import("../web/src/app/rounds.ts");
    const t = await start("claude", { extra: { FAKE_MODE: "long" } });
    const sid = (await t.api("POST", "/api/sessions", { idea: "x" })).json.id;
    await t.answer(sid);
    await t.answer(sid);
    await t.idle(sid, "confirm");
    expect((await t.api("POST", `/api/sessions/${sid}/ask-more`)).status).toBe(200);
    await t.idle(sid, "answering");
    const w = (await t.api("POST", `/api/sessions/${sid}/wrap`)).json;
    expect(w).toMatchObject({ status: "confirm", stop: "cap", extra: true });
    expect(roundStatus(w, "Claude Code")).toBe("You’ve used the extra round.");
    expect(capAction(w)).toBeNull();
    expect(capReached(w)).toBe(true);
    for (const a of ["ask-more", "keep-going"]) expect((await t.api("POST", `/api/sessions/${sid}/${a}`)).status).toBe(400);
  });

  test("Wrap it up while the granted extra round prepares gives the grant back (PR45 M1)", async () => {
    const { roundStatus, capAction } = await import("../web/src/app/rounds.ts");
    const t = await start("claude", { extra: { FAKE_MODE: "long", FAKE_DELAY_MS: "400" } });
    const sid = (await t.api("POST", "/api/sessions", { idea: "x" })).json.id;
    await t.answer(sid);
    await t.answer(sid);
    await t.idle(sid, "confirm");
    const g = await t.api("POST", `/api/sessions/${sid}/ask-more`);
    expect(g.json).toMatchObject({ extra: true, status: "asking" });
    const w = (await t.api("POST", `/api/sessions/${sid}/wrap`)).json;
    expect(w).toMatchObject({ status: "confirm", stop: "cap" });
    expect(w.extra).toBeFalsy();
    expect(roundStatus(w, "Claude Code")).toBe("Round 2 of 2 is done.");
    expect(capAction(w)).toEqual({ label: "Ask 1 more round", action: "ask-more" });
    expect((await t.api("POST", `/api/sessions/${sid}/keep-going`)).status).toBe(400);
    expect((await t.api("POST", `/api/sessions/${sid}/ask-more`)).status).toBe(200);
  });

  test("Wrap it up below the cap keeps Keep going and has no status line", async () => {
    const { roundStatus } = await import("../web/src/app/rounds.ts");
    const t = await start("claude");
    const sid = (await t.api("POST", "/api/sessions", { idea: "x" })).json.id;
    await t.idle(sid, "answering");
    const w = (await t.api("POST", `/api/sessions/${sid}/wrap`)).json;
    expect(w).toMatchObject({ status: "confirm", wrappedUp: true });
    expect(w.stop).toBeUndefined();
    expect(roundStatus(w, "Claude Code")).toBeUndefined();
    expect((await t.api("POST", `/api/sessions/${sid}/keep-going`)).status).toBe(200);
  });
});
