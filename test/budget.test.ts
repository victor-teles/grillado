// Round budget (#35) and what counts as a re-ask (review of #42): only rounds that ask something the
// user sent back are re-asks, and past the cap only those decisions may be asked.
import { describe, expect, test } from "bun:test";
import os from "node:os";
import { fold, type ActivityLine } from "../src/core/activity.ts";
import { buildRoundPrompt, nextRound, synthesize } from "../src/core/engine.ts";
import { roundSystemPrompt } from "../src/core/prompts.ts";
import type { ProviderAdapter, ProviderEvent, RunRequest } from "../src/core/providers/types.ts";
import { RoundReplySchema, roundJsonSchema } from "../src/core/schema.ts";
import {
  type Answer,
  type Session,
  adoptExternalPlan,
  atCap,
  createSession,
  currentRound,
  dismissExternal,
  owed,
  reaskStale,
  reopen,
  roundsSaved,
  startSynthesis,
  stopAtCap,
  submitAnswers,
} from "../src/core/session.ts";

/** In-process fake agent: replies come from a script; every request is kept. */
function scripted(replies: unknown[]): ProviderAdapter & { requests: RunRequest[] } {
  const requests: RunRequest[] = [];
  return {
    id: "claude",
    displayName: "Fake",
    bin: "fake",
    installHint: "n/a",
    loginHint: "fake login",
    requests,
    async detect() {
      return { status: "ready", version: "1", path: "/fake" };
    },
    async *run(req: RunRequest): AsyncIterable<ProviderEvent> {
      requests.push(req);
      yield { type: "result", raw: replies.shift() };
    },
  };
}

const opts = () => ({ cwd: os.tmpdir(), timeoutMs: 10_000, signal: new AbortController().signal });
const q = (key: string, dependsOn: string[] = []) => ({
  key,
  title: `Question ${key}?`,
  body: "",
  options: ["a", "b"].map((id) => ({ id, label: `Option ${id}`, description: "" })),
  recommendedOptionId: "a",
  dependsOn,
});
const round = (...questions: ReturnType<typeof q>[]) => ({ type: "ask_round", summary: "s", questions });
const empty = { type: "frontier_empty", summary: "done", questions: [] };
const acceptAll = (s: Session): Answer[] =>
  currentRound(s)!.questions.map((x) => ({ questionId: x.key, optionId: "a", accepted_recommendation: true }));
const answer = (s: Session) => submitAnswers(s, currentRound(s)!.n, acceptAll(s));
const asked = (s: Session) => currentRound(s)!.questions.map((x) => x.key);
const lastPrompt = (a: { requests: RunRequest[] }) => a.requests.at(-1)!.userPrompt;

describe("the round budget in every round prompt (#35)", () => {
  test("rounds left, at most 6 questions, one decision each, may end early; the closing line only on round N", async () => {
    const s = createSession({ idea: "A notes app", provider: "claude" });
    const a = scripted([round(q("scope")), round(q("platform")), round(q("storage", ["platform"]))]);
    await nextRound(s, a, opts(), 3);
    const first = lastPrompt(a);
    expect(first).toContain("Round budget: 3 of 3 question rounds left, counting this one.");
    expect(first).toContain("Ask at most 6 questions, one decision per question.");
    expect(first).toContain("You may end early: reply frontier_empty once nothing that matters is left to ask.");
    expect(first).not.toContain("last question round");
    answer(s);
    await nextRound(s, a, opts(), 3);
    expect(lastPrompt(a)).toContain("Round budget: 2 of 3 question rounds left");
    expect(lastPrompt(a)).not.toContain("last question round");
    answer(s);
    await nextRound(s, a, opts(), 3);
    expect(lastPrompt(a)).toContain("Round budget: 1 of 3 question rounds left");
    expect(lastPrompt(a)).toContain("This is the last question round. Ask what matters most for the plan; anything still open after it goes into the plan as an open question.");
  });

  test("--max-rounds 1: the first round is the last, and says so", () => {
    const p = buildRoundPrompt(createSession({ idea: "x", provider: "claude" }), 1);
    expect(p).toContain("Round budget: 1 of 1 question round left, counting this one.");
    expect(p).toContain("This is the last question round.");
  });

  test("the budget counts saved batches, not re-asks", async () => {
    const s = createSession({ idea: "x", provider: "claude" });
    const a = scripted([round(q("platform")), empty, round(q("platform"))]);
    await nextRound(s, a, opts(), 3);
    answer(s);
    await nextRound(s, a, opts(), 3); // the agent ends early: Confirm, where Reopen is offered
    reopen(s, "platform");
    await nextRound(s, a, opts(), 3);
    expect(currentRound(s)!.reask).toBe(true);
    answer(s);
    expect(buildRoundPrompt(s, 3)).toContain("Round budget: 2 of 3 question rounds left");
  });

  test("the system prompt drops keep-going-on-acceptance; contract and schema say 6", () => {
    const sys = roundSystemPrompt();
    expect(sys).not.toContain("keeps accepting");
    expect(sys).toContain('Use "ask_round" with 1 to 6 questions');
    expect(sys).toContain("Ask at most 6 questions a round, one decision per question.");
    expect(sys).not.toContain("1 to 9");
    const six = round(...["a", "b", "c", "d", "e", "f"].map((k) => q(k)));
    expect(RoundReplySchema.safeParse(six).success).toBe(true);
    expect(RoundReplySchema.safeParse(round(...["a", "b", "c", "d", "e", "f", "g"].map((k) => q(k)))).success).toBe(false);
    expect((roundJsonSchema() as any).properties.questions.maxItems).toBe(6);
  });

  test("a 7-question reply is never presented: repaired, and with no fix no round", async () => {
    const seven = round(...["a", "b", "c", "d", "e", "f", "g"].map((k) => q(k)));
    const s = createSession({ idea: "x", provider: "claude" });
    expect(await nextRound(s, scripted([seven, round(q("a"))]), opts())).toBe(true);
    expect(currentRound(s)!.questions).toHaveLength(1);
    const t = createSession({ idea: "x", provider: "claude" });
    expect(await nextRound(t, scripted([seven, seven]), opts())).toBe(false);
    expect(t.rounds).toHaveLength(0);
  });
});

describe("re-asks are rounds that ask what the user sent back (review of #42)", () => {
  test("at the cap, a Reopen reply that brings new questions keeps only the owed ones, and the prompt says so", async () => {
    const s = createSession({ idea: "x", provider: "claude" });
    const a = scripted([
      round(q("scope"), q("platform")),
      round(q("storage", ["platform"])),
      round(q("platform"), q("billing"), q("themes")),
      round(q("storage", ["platform"]), q("export")),
    ]);
    await nextRound(s, a, opts());
    answer(s);
    await nextRound(s, a, opts());
    answer(s);
    expect(roundsSaved(s)).toBe(2);
    stopAtCap(s); // what the server does at the cap instead of asking for round 3
    expect(reopen(s, "platform").sort()).toEqual(["platform", "storage"]);
    await nextRound(s, a, opts());
    const p = lastPrompt(a);
    expect(p).toContain("The question rounds are used up. Ask only what the user sent back to be asked again: platform, storage.");
    expect(p).toContain("Any other question is dropped.");
    expect(p).not.toContain("plus anything newly unblocked");
    expect(p).not.toContain("Round budget:");
    expect(asked(s)).toEqual(["platform"]);
    expect(currentRound(s)!.reask).toBe(true);
    answer(s);
    await nextRound(s, a, opts());
    expect(asked(s)).toEqual(["storage"]);
    answer(s);
    expect(s.decisions.billing).toBeUndefined();
    expect(s.decisions.export).toBeUndefined();
    expect(roundsSaved(s)).toBe(2);
    expect(owed(s)).toBe(false);
  });

  test("a stale decision still pending doesn't make rounds of new questions re-asks: they count, and the cap stops them", async () => {
    const max = 4;
    const s = createSession({ idea: "x", provider: "claude" });
    const a = scripted([
      round(q("scope"), q("platform")),
      round(q("storage", ["platform"])),
      round(q("sync", ["storage"])),
      empty,
      { type: "plan", title: "Notes", markdown: "A notes app.", decisions: [], openDecisions: [] },
      round(q("storage", ["platform"])), // the Re-ask on the stale storage
      round(q("billing")), // new: sync is still stale, but this round doesn't ask it
      round(q("themes")), // past the cap with only new questions
    ]);
    for (let i = 0; i < 3; i++) {
      await nextRound(s, a, opts(), max);
      answer(s);
    }
    await nextRound(s, a, opts(), max);
    expect(s.stop).toBe("empty");
    startSynthesis(s);
    const plan = await synthesize(s, a, opts());
    expect(plan.ok).toBe(true);
    const markdown = (plan as any).markdown as string;
    s.plan = { title: "Notes", markdown, path: "/tmp/plan.md", openDecisions: [], createdAt: new Date().toISOString() };
    s.status = "plated";
    // An outside edit to platform, dismissed: storage and sync go stale; only storage is re-asked.
    adoptExternalPlan(s, markdown.replace(/(key: platform\n[^`]*?answer: )Option a/, "$1Option b"));
    dismissExternal(s);
    expect(Object.keys(s.stale ?? {}).sort()).toEqual(["storage", "sync"]);
    reaskStale(s, ["storage"]);
    await nextRound(s, a, opts(), max);
    expect(currentRound(s)!.reask).toBe(true);
    answer(s);
    expect(Object.keys(s.stale ?? {})).toEqual(["sync"]);
    expect(roundsSaved(s)).toBe(3);

    await nextRound(s, a, opts(), max);
    expect(asked(s)).toEqual(["billing"]);
    expect(currentRound(s)!.reask).toBeUndefined();
    answer(s);
    expect(roundsSaved(s)).toBe(4);

    // sync is still owed, so the gate lets a round run; the agent asks only something new.
    expect(owed(s)).toBe(true);
    await nextRound(s, a, opts(), max);
    expect(lastPrompt(a)).toContain("Ask only what the user sent back to be asked again: sync.");
    expect(s.rounds.at(-1)!.questions.map((x) => x.key)).toEqual(["billing"]);
    expect(s).toMatchObject({ status: "confirm", stop: "cap" });
    expect(s.decisions.themes).toBeUndefined();
    expect(atCap(s, max)).toBe(false); // sync is still owed: it can be re-asked later, nothing new can
  });

  test("Activity follows the saved round, not the guess at start", () => {
    const at = "2026-10-29T13:00:00.000Z";
    const line = (reask: boolean): ActivityLine[] => [
      { v: 1, id: `r${reask}`, type: "run.started", kind: "round", at, agent: "claude", target: { round: 3, reask: true } },
      { v: 1, run: `r${reask}`, type: "run.ended", status: "done", ms: 5, at, result: { questions: 1, reask } },
    ];
    expect(fold(line(false))[0]).toMatchObject({ target: { round: 3 } });
    expect((fold(line(false))[0] as any).target.reask).toBeUndefined();
    expect((fold(line(true))[0] as any).target).toEqual({ round: 3, reask: true });
  });
});
