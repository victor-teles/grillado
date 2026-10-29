// Rounds PR 3: the round counter (#36), one extra round at the cap (#37), and the re-ask copy
// (Designer ROUNDS-REASK; PR43 review: Keep going names what was sent back at the cap).
import { describe, expect, test } from "bun:test";
import os from "node:os";
import { buildRoundPrompt, nextRound } from "../src/core/engine.ts";
import type { ProviderAdapter, ProviderEvent, RunRequest } from "../src/core/providers/types.ts";
import { type Session, askMore, atCap, createSession, currentRound, stopAtCap, submitAnswers } from "../src/core/session.ts";
import { COPY } from "../web/src/app/copy.ts";
import { capAction, preparing, roundCounter, roundStatus, sendAndWrap, settledLine } from "../web/src/app/rounds.ts";

/** A view as the browser gets it: k rounds, with the given ones flagged as re-asks. */
const view = (k: number, over: Record<string, unknown> = {}, reasks: number[] = []) =>
  ({
    rounds: Array.from({ length: k }, (_, i) => ({ n: i + 1, ...(reasks.includes(i + 1) ? { reask: true } : {}) })),
    reopened: [],
    stale: {},
    decisions: {},
    maxRounds: 2,
    wrappedUp: false,
    ...over,
  }) as any;
const text = (c: { lead: string; tag?: string }) => (c.tag ? `${c.lead} · ${c.tag}` : c.lead);

describe("the round counter (#36)", () => {
  test("Round k of N, Round N of N · last round, Extra round · last round", () => {
    expect(text(roundCounter(view(1), 1))).toBe("Round 1 of 2");
    expect(roundCounter(view(1), 1).strong).toBeFalsy();
    expect(text(roundCounter(view(2), 2))).toBe("Round 2 of 2 · last round");
    expect(roundCounter(view(2), 2).strong).toBe(true);
    expect(text(roundCounter(view(3, { maxRounds: 5 }), 3))).toBe("Round 3 of 5");
    expect(text(roundCounter(view(1, { maxRounds: 1 }), 1))).toBe("Round 1 of 1 · last round");
    const extra = roundCounter(view(3, { extra: true }), 3);
    expect(text(extra)).toBe("Extra round · last round");
    expect(extra.strong).toBe(true);
  });

  test("a re-ask never advances k (ROUNDS-REASK)", () => {
    // Below the cap: round 1, a re-ask, then round 2.
    const below = view(3, {}, [2]);
    expect(text(roundCounter(below, 2))).toBe("Round 1 of 2 · asking again");
    expect(roundCounter(below, 2).strong).toBeFalsy();
    expect(text(roundCounter(below, 3))).toBe("Round 2 of 2 · last round");
    // At the cap: never "Round 3 of 2".
    const cap = view(4, {}, [3, 4]);
    expect(text(roundCounter(cap, 3))).toBe("Round 2 of 2 · asking again");
    expect(text(roundCounter(cap, 4))).toBe("Round 2 of 2 · asking again");
    // After the extra round.
    expect(text(roundCounter(view(4, { extra: true }, [4]), 4))).toBe("Extra round · asking again");
  });

  test("waiting copy: Preparing round k of N, the extra round, asking again", () => {
    expect(preparing(view(1))).toBe("Preparing round 2 of 2 · reading your answers");
    expect(preparing(view(1, { maxRounds: 4 }))).toBe("Preparing round 2 of 4 · reading your answers");
    expect(preparing(view(2, { extra: true }))).toBe("Preparing the extra round · reading your answers");
    expect(preparing(view(2, { stale: { storage: { label: "Storage" } } }))).toBe("Asking again · reading your answers");
    expect(preparing(view(1, { reopened: ["platform"] }))).toBe("Asking again · reading your answers");
  });
});

describe("Confirm at the cap (#37, PR43 review)", () => {
  const stale = (...keys: string[]) => Object.fromEntries(keys.map((k) => [k, { key: k, label: k[0].toUpperCase() + k.slice(1), title: `${k}?` }]));
  test("Ask 1 more round at the cap, once; nothing after the extra round", () => {
    expect(capAction(view(1))).toBeNull(); // below the cap: Keep going
    expect(capAction(view(2))).toEqual({ label: "Ask 1 more round", action: "ask-more" });
    expect(capAction(view(3, { extra: true }))).toBeNull();
    expect(capAction(view(2, { extra: true }))).toBeNull(); // granted, the round not saved yet: not at the cap
  });

  test("something owed at the cap: Ask {name} again, or Ask {n} again", () => {
    expect(capAction(view(2, { stale: stale("storage") }))).toEqual({ label: "Ask Storage again", action: "keep-going" });
    expect(capAction(view(2, { stale: stale("storage", "sync") }))).toEqual({ label: "Ask 2 again", action: "keep-going" });
    expect(capAction(view(3, { extra: true, stale: stale("storage") }))).toEqual({ label: "Ask Storage again", action: "keep-going" });
    // A reopened decision is named from the settled one.
    expect(capAction(view(2, { reopened: ["platform"], decisions: { platform: { key: "platform", title: "Which platform?", label: "Platform" } } }))?.label).toBe("Ask Platform again");
    // Below the cap Keep going stays.
    expect(capAction(view(1, { stale: stale("storage") }))).toBeNull();
  });

  test("the line under the title counts what's owed, like the header", () => {
    expect(settledLine(2, 1)).toBe("2 decisions settled, 1 to ask again.");
    expect(settledLine(1, 3)).toBe("1 decision settled, 3 to ask again.");
    expect(settledLine(4, 0)).toBe("4 decisions settled, nothing open.");
  });

  test("status line: Round N of N is done, then You’ve used the extra round", () => {
    expect(roundStatus(view(2, { stop: "cap" }), "Grok")).toBe("Round 2 of 2 is done.");
    expect(roundStatus(view(3, { stop: "cap", extra: true }), "Grok")).toBe("You’ve used the extra round.");
    expect(roundStatus(view(4, { stop: "cap", extra: true }, [4]), "Grok")).toBe("You’ve used the extra round.");
    expect(roundStatus(view(4, { stop: "cap" }), "Grok")).toBe("4 rounds done. The cap is 2.");
  });
});

// ---------------------------------------------------------------- the session and the prompt

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
const q = (key: string) => ({ key, title: `Question ${key}?`, body: "", options: ["a", "b"].map((id) => ({ id, label: `Option ${id}`, description: "" })), recommendedOptionId: "a", dependsOn: [] });
const round = (...keys: string[]) => ({ type: "ask_round", summary: "s", questions: keys.map((k) => q(k)) });
const answer = (s: Session) => submitAnswers(s, currentRound(s)!.n, currentRound(s)!.questions.map((x) => ({ questionId: x.key, optionId: "a", accepted_recommendation: true })));

describe("the extra round in the session (#37)", () => {
  test("granted once at the cap; exactly one more round runs, and its prompt is the last", async () => {
    const s = createSession({ idea: "x", provider: "claude" });
    const a = scripted([round("scope"), round("platform"), round("storage", "sync"), round("more")]);
    await nextRound(s, a, opts(), 2);
    answer(s);
    await nextRound(s, a, opts(), 2);
    answer(s);
    expect(atCap(s, 2)).toBe(true);
    stopAtCap(s);
    expect(() => askMore({ ...s, status: "answering" } as Session, 2)).toThrow();
    askMore(s, 2);
    expect(s).toMatchObject({ extra: true, status: "asking" });
    expect(s.stop).toBeUndefined();
    expect(atCap(s, 2)).toBe(false);
    const p = buildRoundPrompt(s, 2);
    expect(p).toContain("one extra question round past the cap of 2");
    expect(p).toContain("This is the last question round.");
    await nextRound(s, a, opts(), 2);
    expect(currentRound(s)!.questions.map((x) => x.key)).toEqual(["storage", "sync"]);
    expect(currentRound(s)!.reask).toBeUndefined();
    answer(s);
    expect(atCap(s, 2)).toBe(true);
    stopAtCap(s);
    expect(() => askMore(s, 2)).toThrow("The extra round is used. Write the plan.");
  });

  test("below the cap there is no extra round to ask for", () => {
    const s = createSession({ idea: "x", provider: "claude" });
    s.status = "confirm";
    expect(() => askMore(s, 2)).toThrow();
    expect(s.extra).toBeUndefined();
  });
});

// PR44-rounds M1 (Designer's M1-test.ts, plus Waiting and a re-ask): 3 rounds saved, relaunched at --max-rounds 2.
describe("past a lowered cap (PR44-rounds M1)", () => {
  test("no grant offered, an honest counter, and askMore refuses", () => {
    expect(capAction(view(3))).toBeNull();
    expect(roundStatus(view(3, { stop: "cap" }), "X")).toBe("3 rounds done. The cap is 2.");
    const c = roundCounter(view(3), 3);
    expect(`${c.lead} · ${c.tag}`).toBe("Round 3 · the cap is 2");
    expect(c.strong).toBeFalsy();
    const s = createSession({ idea: "x", provider: "claude" });
    s.status = "confirm";
    s.rounds = [1, 2, 3].map((n) => ({ n, questions: [], answers: [] })) as any;
    expect(() => askMore(s, 2)).toThrow("That was the last round. Write the plan.");
    expect(s).toMatchObject({ status: "confirm" });
    expect(s.extra).toBeUndefined();
  });

  test("Waiting and a re-ask past a lowered cap never read as the extra round", () => {
    expect(preparing(view(3))).toBe("Preparing round 4 · the cap is 2 · reading your answers");
    const r = roundCounter(view(4, {}, [4]), 4);
    expect(`${r.lead} · ${r.tag}`).toBe("Round 3 · asking again");
    // A granted extra round is still the extra round, and a later round past it is not.
    expect(roundCounter(view(3, { extra: true }), 3)).toEqual({ lead: "Extra round", tag: "last round", strong: true });
    expect(roundCounter(view(4, { extra: true }), 4)).toEqual({ lead: "Round 4", tag: "the cap is 2" });
    expect(capAction(view(3, { extra: true }))).toBeNull();
  });
});

describe("rounds PR 4 copy (#39, PR44 nice-to-haves)", () => {
  test("Send and wrap up shows on rounds 1 to N−1 only, never on round N or the extra round", () => {
    expect(sendAndWrap(view(1), 1)).toBe(true);
    expect(sendAndWrap(view(2), 2)).toBe(false);
    expect(sendAndWrap(view(3, { extra: true }), 3)).toBe(false);
    // A re-ask sits in the round it repeats: below the cap it shows, at the cap it doesn't.
    expect(sendAndWrap(view(2, {}, [2]), 2)).toBe(true);
    expect(sendAndWrap(view(3, {}, [3]), 3)).toBe(false);
    expect(sendAndWrap(view(1, { maxRounds: 1 }), 1)).toBe(false);
  });

  test("an extra round with nothing to ask names it", () => {
    expect(roundStatus(view(2, { extra: true, stop: "empty" }), "Claude Code")).toBe("Extra round · Claude Code has nothing left to ask.");
    expect(roundStatus(view(1, { stop: "empty" }), "Claude Code")).toBe("Round 1 of 2 · Claude Code has nothing left to ask.");
  });

  test("the re-ask sub line (REASK-SUB)", () => {
    expect(COPY.reaskSub).toBe("You reopened these, or something they depend on changed.");
  });
});
