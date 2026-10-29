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
    expect(HELP).toMatch(/--max-rounds <n>\s+Rounds of questions before the plan \(default 2\)/);
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

async function start(id: ProviderId, opts: { maxRounds?: number; extra?: Record<string, string>; store?: Store } = {}) {
  const dir = mkdtempSync(path.join(os.tmpdir(), "grillado-rounds-"));
  const log = path.join(dir, "agent.jsonl");
  const env = fakeEnv(fakeBinDir([id]), { FAKE_LOG: log, ...opts.extra });
  const store = opts.store ?? new Store(path.join(dir, "home"));
  const server = new GrilladoServer({ adapters: createAdapters({ env }), store, webDir: webDir(), port: 0, strictPort: true, provider: id, maxRounds: opts.maxRounds });
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

  test("reopened decisions are re-asked past the cap, then Confirm", async () => {
    const t = await start("claude");
    const sid = (await t.api("POST", "/api/sessions", { idea: "x" })).json.id;
    await t.answer(sid);
    await t.answer(sid);
    await t.idle(sid, "confirm");
    expect((await t.api("POST", `/api/sessions/${sid}/reopen`, { key: "platform" })).status).toBe(200);
    await t.answer(sid); // platform again
    await t.answer(sid); // storage, which depended on it
    const s = await t.idle(sid, "confirm");
    expect(s.rounds).toHaveLength(4);
    expect(s.stop).toBe("cap");
    expect(t.runs()).toBe(4);
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
    expect(roundStatus(view(1, { wrappedUp: true }), "Grok")).toBeUndefined();
    expect(atCap(view(2))).toBe(true);
    expect(atCap(view(1))).toBe(false);
    expect(atCap(view(2, { stale: { a: {} } }))).toBe(false);
  });
});
