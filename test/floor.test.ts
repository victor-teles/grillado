// List every unasked item in the plan (#40), frictions 21/28 (open counts agree) and 30 (override answers on the plan card).
import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { decisionsOf } from "../src/cli/mcp.ts";
import { GrilladoServer } from "../src/cli/server.ts";
import { Store } from "../src/cli/store.ts";
import { synthesize } from "../src/core/engine.ts";
import { openFloor, reasonLine, stopReason } from "../src/core/floor.ts";
import { createAdapters } from "../src/core/providers/adapters.ts";
import type { ProviderAdapter, ProviderEvent, RunRequest } from "../src/core/providers/types.ts";
import { type Session, applyRound, askMore, createSession, keepGoing, stopAtCap, submitAnswers, wrapUp } from "../src/core/session.ts";
import { cardAnswer } from "../web/src/app/editor/decision-meta.ts";
import { confirmCounts, planCounts, stillOpen } from "../web/src/app/counts.ts";
import { fakeBinDir, fakeEnv } from "./helpers.ts";

const q = (key: string, label = key) => ({
  key,
  label,
  title: `Question ${key}?`,
  body: "",
  options: [{ id: "a", label: "Option a", description: "" }, { id: "b", label: "Option b", description: "" }],
  recommendedOptionId: "a",
  dependsOn: [],
});
const up = (key: string, label: string) => ({ key, label, dependsOn: [] });
const ask = (s: Session, keys: string[], upcoming: ReturnType<typeof up>[] = [], max = 2) =>
  applyRound(s, { type: "ask_round", summary: "s", questions: keys.map((k) => q(k)), upcoming } as any, max);
const answerAll = (s: Session) => {
  const r = s.rounds.at(-1)!;
  submitAnswers(s, r.n, r.questions.map((x) => ({ questionId: x.key, optionId: "a", accepted_recommendation: true })));
};
function writer(openDecisions: string[]): ProviderAdapter & { requests: RunRequest[] } {
  const requests: RunRequest[] = [];
  return {
    id: "claude",
    displayName: "Claude Code",
    bin: "fake",
    installHint: "n/a",
    loginHint: "n/a",
    requests,
    async detect() {
      return { status: "ready", version: "1", path: "/fake" };
    },
    async *run(req: RunRequest): AsyncIterable<ProviderEvent> {
      requests.push(req);
      yield { type: "result", raw: { type: "plan", title: "Plan", markdown: "## Problem\n\nText.", decisions: [], openDecisions } };
    },
  };
}
const opts = () => ({ cwd: os.tmpdir(), timeoutMs: 10_000, signal: new AbortController().signal });
const write = async (s: Session, openDecisions: string[] = [], max = 2) => {
  s.status = "synthesizing";
  const a = writer(openDecisions);
  const out = await synthesize(s, a, opts(), max);
  if (!out.ok) throw new Error("no plan");
  return { ...out, prompt: a.requests[0].userPrompt };
};
const REASONS = [
  "The interview stopped early because you chose to wrap up.",
  "The interview stopped after the extra round.",
  "The interview stopped at the round cap, after round 2 of 2.",
  "The interview stopped before the cap because Claude Code had nothing left to ask.",
];
const reasonsIn = (md: string) => REASONS.filter((r) => md.includes(r));

/** Two rounds: round 1 hints at storage and sync; round 2 asks storage and hints at export; sync and export are never asked. */
function twoRounds(): Session {
  const s = createSession({ idea: "x", provider: "claude" });
  ask(s, ["platform"], [up("storage", "Storage"), up("sync", "Sync")]);
  answerAll(s);
  ask(s, ["storage"], [up("sync", "Sync"), up("export", "Export")]);
  return s;
}

describe("the open floor (#40)", () => {
  test("is the union of every round's unasked upcoming items, plus a wrap's unanswered questions", () => {
    const s = twoRounds();
    expect(openFloor(s).map((f) => [f.key, f.asked])).toEqual([
      ["storage", true],
      ["sync", false],
      ["export", false],
    ]);
    answerAll(s);
    stopAtCap(s);
    // Storage was asked in round 2: outside the floor once answered. Sync is listed once.
    expect(openFloor(s).map((f) => f.label)).toEqual(["Sync", "Export"]);
  });

  test("the writer gets the queued keys, and Grillado appends any it left out, after one reason line", async () => {
    const s = twoRounds();
    answerAll(s);
    stopAtCap(s);
    const out = await write(s, ["Sync across devices later"]);
    expect(out.prompt).toContain('"notAsked":[{"key":"sync","label":"Sync"},{"key":"export","label":"Export"}]');
    expect(out.markdown).toContain(
      "## Open decisions\n\nThe interview stopped at the round cap, after round 2 of 2.\n\n- Sync across devices later\n- Export: not asked before the interview stopped.\n",
    );
    expect(out.markdown).not.toContain("- Sync: not asked");
    expect(out.open).toEqual(["Sync across devices later", "Export"]);
  });

  test("exactly one reason line, matching the final stop", async () => {
    const wrap = twoRounds();
    wrapUp(wrap);
    expect(reasonsIn((await write(wrap)).markdown)).toEqual([REASONS[0]]);

    const extra = twoRounds();
    answerAll(extra);
    stopAtCap(extra);
    askMore(extra);
    ask(extra, ["sync"]);
    answerAll(extra);
    stopAtCap(extra);
    expect(reasonsIn((await write(extra)).markdown)).toEqual([REASONS[1]]);

    const cap = twoRounds();
    answerAll(cap);
    stopAtCap(cap);
    expect(reasonsIn((await write(cap)).markdown)).toEqual([REASONS[2]]);

    const agent = createSession({ idea: "x", provider: "claude" });
    ask(agent, ["platform"], [up("sync", "Sync")]);
    answerAll(agent);
    applyRound(agent, { type: "frontier_empty", summary: "s", questions: [], upcoming: [] } as any, 2);
    expect(reasonsIn((await write(agent)).markdown)).toEqual([REASONS[3]]);

    // A wrap abandoned by Keep going isn't the final stop.
    const back = createSession({ idea: "x", provider: "claude" });
    ask(back, ["platform"], [up("sync", "Sync")]);
    wrapUp(back);
    keepGoing(back);
    expect(stopReason(back)).toBeUndefined();
    expect(reasonLine("cap", 3, "Grok")).toBe("The interview stopped at the round cap, after round 3 of 3.");
  });

  test("Confirm, the plan page, plan.openDecisions and MCP get_plan count the same open items", async () => {
    const s = twoRounds();
    wrapUp(s);
    const view = JSON.parse(JSON.stringify(s));
    expect(stillOpen(view).map((f) => f.label)).toEqual(["storage", "Sync", "Export"]);
    expect(confirmCounts(view).open).toBe(3);
    const out = await write(s);
    s.plan = { title: "Plan", markdown: out.markdown, path: "", openDecisions: out.open, createdAt: new Date().toISOString() };
    s.status = "plated";
    expect(planCounts(JSON.parse(JSON.stringify(s)), out.markdown).open).toBe(3);
    expect(s.plan.openDecisions).toHaveLength(3);
    expect(decisionsOf(s).open).toHaveLength(3);
  });
});

describe("the plan card shows an override as the decision (friction 30)", () => {
  test("a note that begins Overridden is the answer; other notes aren't", () => {
    const note = "Overridden by the PO: at most 6 questions a round.";
    expect(cardAnswer({ answer: "Lean wide", note })).toBe(note);
    expect(cardAnswer({ answer: "Lean wide", note: "Ask more each round." })).toBe("Lean wide");
    expect(cardAnswer({ answer: "Lean wide" })).toBe("Lean wide");
  });
});

// The server end to end with the fake claude: what the sessions list and MCP report after a real plan write.
const servers: GrilladoServer[] = [];
afterEach(async () => {
  for (const s of servers.splice(0)) await s.close?.();
});
function request(port: number, method: string, p: string, headers: Record<string, string>, body?: unknown): Promise<{ status: number; json: any }> {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: "127.0.0.1", port, method, path: p, headers }, (res) => {
      let data = "";
      res.on("data", (c) => (data += c));
      res.on("end", () => resolve({ status: res.statusCode ?? 0, json: data ? JSON.parse(data) : null }));
    });
    req.on("error", reject);
    if (body !== undefined) req.write(JSON.stringify(body));
    req.end();
  });
}
async function waitFor<T>(fn: () => Promise<T | undefined>, ms = 10_000): Promise<T> {
  const end = Date.now() + ms;
  for (;;) {
    const v = await fn();
    if (v !== undefined) return v;
    if (Date.now() > end) throw new Error("timed out");
    await new Promise((r) => setTimeout(r, 25));
  }
}
function webDir() {
  const dir = mkdtempSync(path.join(os.tmpdir(), "grillado-web-"));
  writeFileSync(path.join(dir, "index.html"), "<!doctype html><title>Grillado</title>");
  mkdirSync(path.join(dir, "assets"));
  return dir;
}

test("a wrap on round 2: the plan's open section, the sessions list, MCP and Confirm agree (frictions 21, 28)", async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "grillado-floor-"));
  const env = fakeEnv(fakeBinDir(["claude"]), {});
  const store = new Store(path.join(dir, "home"));
  const server = new GrilladoServer({ adapters: createAdapters({ env }), store, webDir: webDir(), port: 0, strictPort: true, provider: "claude" });
  servers.push(server);
  await server.detect();
  await server.listen();
  const h = { "x-grillado-token": server.token, "content-type": "application/json" };
  const api = (method: string, p: string, body?: unknown) => request(server.port, method, p, h, body);
  const idle = (sid: string, status: string) =>
    waitFor(async () => {
      const s = (await api("GET", `/api/sessions/${sid}`)).json;
      return !s.busy && s.status === status ? s : undefined;
    });
  const sid = (await api("POST", "/api/sessions", { idea: "A grilling recipe app" })).json.id;
  const r1 = await idle(sid, "answering");
  await api("POST", `/api/sessions/${sid}/answers`, { round: 1, answers: r1.rounds[0].questions.map((x: any) => ({ questionId: x.key, optionId: x.recommendedOptionId, accepted_recommendation: true })) });
  await idle(sid, "answering");
  const c = (await api("POST", `/api/sessions/${sid}/wrap`)).json;
  const floor = stillOpen(c);
  expect(floor.some((f) => !f.asked)).toBe(true);
  expect(c.rounds.some((r: any) => (r.upcoming ?? []).length)).toBe(true);
  expect((await api("POST", `/api/sessions/${sid}/confirm`)).status).toBe(200);
  const done = await idle(sid, "plated");
  const md = readFileSync(done.plan.path, "utf8");
  expect(md).toContain("The interview stopped early because you chose to wrap up.");
  for (const f of floor.filter((x) => !x.asked)) expect(md).toContain(`- ${f.label}: not asked before the interview stopped.`);
  expect(done.plan.openDecisions).toHaveLength(confirmCounts(c).open);
  expect(planCounts(done, md).open).toBe(confirmCounts(c).open);
  const row = (await api("GET", "/api/state")).json.sessions.find((x: any) => x.id === sid);
  expect(row.open).toBe(confirmCounts(c).open);
  expect(decisionsOf(store.load(sid)!).open).toHaveLength(confirmCounts(c).open);
  expect(existsSync(done.plan.path)).toBe(true);
});
