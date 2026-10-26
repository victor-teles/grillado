import { findDecisionBlocks } from "../src/core/decision-block.ts";
import { describe, expect, test } from "bun:test";
import os from "node:os";
import { extractCandidate } from "../src/core/extract.ts";
import { findBanned } from "../src/core/filter.ts";
import { nextRound, synthesize } from "../src/core/engine.ts";
import { promptFragments } from "../src/core/prompts.ts";
import { createAdapters } from "../src/core/providers/adapters.ts";
import type { ProviderAdapter, ProviderEvent, ProviderId, RunRequest } from "../src/core/providers/types.ts";
import {
  type Answer,
  type Session,
  OTHER_OPTION,
  UNKNOWN_OPTION,
  createSession,
  currentRound,
  keepGoing,
  reopen,
  startSynthesis,
  submitAnswers,
  wrapUp,
} from "../src/core/session.ts";
import { fakeBinDir, fakeEnv } from "./helpers.ts";

/** In-process fake: replies come from a script; records every request. */
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
      yield { type: "progress", label: "Thinking" };
      const next = replies.shift();
      if (next && typeof next === "object" && "error" in (next as any)) {
        yield { type: "error", code: (next as any).error, message: "nope" };
        return;
      }
      yield { type: "result", raw: next };
    },
  };
}

const opts = () => ({ cwd: os.tmpdir(), timeoutMs: 10_000, signal: new AbortController().signal });
const q = (key: string, dependsOn: string[] = [], options = ["a", "b"]) => ({
  key,
  title: `Question ${key}?`,
  body: "",
  options: options.map((id) => ({ id, label: `Option ${id}`, description: "" })),
  recommendedOptionId: options[0],
  dependsOn,
});
const round = (...questions: ReturnType<typeof q>[]) => ({ type: "ask_round", summary: "s", questions });
const empty = { type: "frontier_empty", summary: "done", questions: [] };
const acceptAll = (s: Session): Answer[] =>
  currentRound(s)!.questions.map((x) => ({ questionId: x.key, optionId: x.recommendedOptionId, accepted_recommendation: true }));

describe("extraction (AC5 fixtures)", () => {
  test("prose-wrapped, fenced, object, truncated", () => {
    expect(extractCandidate('Sure! {"type":"x","a":"}"} hope that helps')).toEqual({ type: "x", a: "}" });
    expect(extractCandidate('```json\n{"a":1}\n```')).toEqual({ a: 1 });
    expect(extractCandidate({ a: 1 })).toEqual({ a: 1 });
    expect(extractCandidate('{"type":"ask_round","questions":[{"key":"sc')).toBeUndefined();
    expect(extractCandidate("no json")).toBeUndefined();
  });
});

describe("validation and repair (AC5–AC7)", () => {
  test("malformed once → repair retry with the error fed back → success", async () => {
    const s = createSession({ idea: "an app", provider: "claude" });
    const a = scripted(["not json at all", round(q("one"))]);
    expect(await nextRound(s, a, opts())).toBe(true);
    expect(a.requests).toHaveLength(2);
    expect(a.requests[1].userPrompt).toContain("Your previous reply was rejected");
    expect(a.requests[1].userPrompt).toContain("no JSON object");
    expect(s.status).toBe("answering");
  });

  test("wrong shape twice → malformed error, no round", async () => {
    const s = createSession({ idea: "an app", provider: "claude" });
    const a = scripted([{ type: "ask_round", questions: "x" }, { nope: true }]);
    expect(await nextRound(s, a, opts())).toBe(false);
    expect(s.error).toMatchObject({ code: "malformed", message: "The agent's reply didn't come through." });
    expect(s.rounds).toHaveLength(0);
  });

  test("AC6: a question depending on another in the same round is rejected", async () => {
    const s = createSession({ idea: "an app", provider: "claude" });
    const a = scripted([round(q("platform"), q("storage", ["platform"])), round(q("platform"))]);
    expect(await nextRound(s, a, opts())).toBe(true);
    expect(a.requests[1].userPrompt).toContain('depends on "platform"');
    expect(currentRound(s)!.questions.map((x) => x.key)).toEqual(["platform"]);
  });

  test("AC7: a plan during the interview is discarded", async () => {
    const s = createSession({ idea: "an app", provider: "claude" });
    const plan = { type: "plan", title: "t", markdown: "m", decisions: [], openDecisions: [] };
    const a = scripted([plan, round(q("one"))]);
    expect(await nextRound(s, a, opts())).toBe(true);
    expect(s.plan).toBeUndefined();
    expect(s.status).toBe("answering");
  });

  test("AC7: synthesis refuses to run before the user confirms", async () => {
    const s = createSession({ idea: "an app", provider: "claude" });
    s.status = "confirm";
    expect(synthesize(s, scripted([]), opts())).rejects.toThrow("confirmation");
  });

  test("AC18: banned text in a reply triggers regeneration", async () => {
    const s = createSession({ idea: "an app", provider: "claude" });
    const leaky = round({ ...q("one"), body: "Per the grill-me approach…" });
    const a = scripted([leaky, round(q("one"))]);
    expect(await nextRound(s, a, opts())).toBe(true);
    expect(a.requests).toHaveLength(2);
    expect(JSON.stringify(s)).not.toContain("grill-me");
  });

  test("AC18: words the user typed themselves are not filtered", () => {
    expect(findBanned("Plan for a grilling recipe app", "A grilling recipe app")).toBeNull();
    expect(findBanned("This is Matt Pocock's method")).toBe("matt pocock");
  });

  test("provider errors are not retried", async () => {
    const s = createSession({ idea: "an app", provider: "claude" });
    const a = scripted([{ error: "auth" }]);
    expect(await nextRound(s, a, opts())).toBe(false);
    expect(a.requests).toHaveLength(1);
    expect(s.error?.code).toBe("auth");
  });

  test("settled keys cannot be re-asked; recommended must be an option", async () => {
    const s = createSession({ idea: "x", provider: "claude" });
    const a = scripted([round(q("one")), round(q("one")), round({ ...q("two"), recommendedOptionId: "zzz" })]);
    await nextRound(s, a, opts());
    submitAnswers(s, 1, acceptAll(s));
    expect(await nextRound(s, a, opts())).toBe(false);
    expect(a.requests.at(-1)!.userPrompt).toContain('"one" is already settled');
    expect(s.error?.code).toBe("malformed");
    const b = scripted([round({ ...q("two"), recommendedOptionId: "zzz" }), round(q("two"))]);
    expect(await nextRound(s, b, opts())).toBe(true);
    expect(b.requests[1].userPrompt).toContain("not one of its option ids");
  });
});

describe("interview loop", () => {
  test("rounds → frontier empty → confirm → plan with citations (AC15, AC16)", async () => {
    const s = createSession({ idea: "A habit tracker", provider: "claude" });
    const a = scripted([
      round(q("scope"), q("platform", [], ["web", "mobile", "cli"])),
      round(q("storage", ["platform"])),
      empty,
    ]);
    await nextRound(s, a, opts());
    expect(currentRound(s)!.n).toBe(1);
    submitAnswers(s, 1, [
      { questionId: "scope", optionId: "a", accepted_recommendation: true },
      { questionId: "platform", optionId: "mobile", accepted_recommendation: true }, // not the recommendation
    ]);
    expect(s.decisions.scope.accepted_recommendation).toBe(true);
    expect(s.decisions.platform.accepted_recommendation).toBe(false);
    await nextRound(s, a, opts());
    expect(a.requests[1].userPrompt).toContain('"key":"platform"');
    submitAnswers(s, 2, [{ questionId: "storage", optionId: OTHER_OPTION, text: "SQLite on device", accepted_recommendation: false }]);
    await nextRound(s, a, opts());
    expect(s.status).toBe("confirm");
    expect(s.plan).toBeUndefined();

    startSynthesis(s);
    const planner = scripted([
      { type: "plan", title: "Habit tracker", markdown: "## Problem\nHabits.", decisions: [{ round: 1, questionId: "scope", statement: "Narrow." }], openDecisions: [] },
    ]);
    const res = await synthesize(s, planner, opts());
    expect(res.ok).toBe(true);
    const md = (res as any).markdown as string;
    // Every answered question is in plan.md as a fenced decision block with its {round, questionId} (AC16).
    const blocks = findDecisionBlocks(md);
    expect(blocks.map((b) => b.parsed.ok && [b.parsed.fields.id, b.parsed.fields.key])).toEqual([
      ["R1·1", "scope"],
      ["R1·2", "platform"],
      ["R2·1", "storage"],
    ]);
    expect(md).toContain("answer: SQLite on device");
    expect(md).toContain("kept_suggestion: true");
    // The model's statement for a decision becomes its note; uncited decisions go under "More decisions".
    expect(md).toContain("note: Narrow.");
    expect(md).toContain("## More decisions");
  });

  test("plan citing a decision that does not exist is repaired", async () => {
    const s = createSession({ idea: "x", provider: "claude" });
    await nextRound(s, scripted([round(q("one"))]), opts());
    submitAnswers(s, 1, acceptAll(s));
    s.status = "confirm";
    startSynthesis(s);
    const bad = { type: "plan", title: "t", markdown: "m", decisions: [{ round: 4, questionId: "ghost", statement: "x" }], openDecisions: [] };
    const good = { ...bad, decisions: [{ round: 1, questionId: "one", statement: "x" }] };
    const p = scripted([bad, good]);
    expect((await synthesize(s, p, opts())).ok).toBe(true);
    expect(p.requests[1].userPrompt).toContain("R4:ghost");
  });

  test("reopen drops the decision and its dependents", async () => {
    const s = createSession({ idea: "x", provider: "claude" });
    const a = scripted([round(q("platform")), round(q("storage", ["platform"])), round(q("sync", ["storage"]))]);
    await nextRound(s, a, opts());
    submitAnswers(s, 1, acceptAll(s));
    await nextRound(s, a, opts());
    submitAnswers(s, 2, acceptAll(s));
    await nextRound(s, a, opts());
    expect(reopen(s, "platform").sort()).toEqual(["platform", "storage"]);
    expect(Object.keys(s.decisions)).toEqual([]);
    expect(s.reopened.sort()).toEqual(["platform", "storage"]);
    expect(currentRound(s)).toBeUndefined();
    expect(s.status).toBe("asking");
  });

  test("wrap it up lists the open questions; keep going asks for more", async () => {
    const s = createSession({ idea: "x", provider: "claude" });
    const a = scripted([round(q("one")), round(q("two"), q("three"))]);
    await nextRound(s, a, opts());
    submitAnswers(s, 1, [{ questionId: "one", optionId: UNKNOWN_OPTION, accepted_recommendation: false }]);
    expect(s.decisions.one.kind).toBe("unknown");
    await nextRound(s, a, opts());
    wrapUp(s);
    expect(s.status).toBe("confirm");
    startSynthesis(s);
    const plan = { type: "plan", title: "t", markdown: "body", decisions: [], openDecisions: [] };
    const res = await synthesize(s, scripted([plan]), opts());
    const md = (res as any).markdown as string;
    expect(md).toContain("## Open decisions\n\n```decision\nid: R2·1\nkey: two\nquestion: Question two?\nstatus: open\n```");
    expect(findDecisionBlocks(md).filter((b) => b.parsed.ok && b.parsed.fields.status === "open")).toHaveLength(2);
    s.status = "confirm";
    keepGoing(s);
    expect(s.status as string).toBe("asking");
  });

  test("open decisions lead plan.md: after the intro, before the first section (v1.2 §5)", async () => {
    const s = createSession({ idea: "x", provider: "claude" });
    const a = scripted([round(q("one")), round(q("two"))]);
    await nextRound(s, a, opts());
    submitAnswers(s, 1, acceptAll(s));
    await nextRound(s, a, opts());
    wrapUp(s);
    startSynthesis(s);
    const plan = { type: "plan", title: "t", markdown: "Intro line.\n\n## Scope\n\nCites [R1:one].\n\n## Later\n\nMore.", decisions: [], openDecisions: [] };
    const md = ((await synthesize(s, scripted([plan]), opts())) as any).markdown as string;
    const heads = md.split("\n").filter((l) => /^#{1,2} /.test(l));
    expect(heads).toEqual(["# t", "## Open decisions", "## Scope", "## Later"]);
    expect(md.indexOf("Intro line.")).toBeLessThan(md.indexOf("## Open decisions"));
    expect(md.indexOf("status: open")).toBeLessThan(md.indexOf("key: one"));
  });

  test("answers must cover every question in the round", async () => {
    const s = createSession({ idea: "x", provider: "claude" });
    await nextRound(s, scripted([round(q("one"), q("two"))]), opts());
    expect(() => submitAnswers(s, 1, [{ questionId: "one", optionId: "a", accepted_recommendation: true }])).toThrow("Missing answer");
    expect(() => submitAnswers(s, 2, acceptAll(s))).toThrow("not open");
  });
});

describe("full loop through each real adapter and a fake CLI", () => {
  for (const id of ["claude", "codex", "grok", "pi"] as ProviderId[]) {
    test(id, async () => {
      const env = fakeEnv(fakeBinDir([id]));
      const adapter = createAdapters({ env }).find((x) => x.id === id)!;
      const s = createSession({ idea: "A recipe app", provider: id });
      expect(await nextRound(s, adapter, opts())).toBe(true);
      expect(currentRound(s)!.questions.map((x) => x.key)).toEqual(["scope", "platform"]);
      submitAnswers(s, 1, acceptAll(s));
      expect(await nextRound(s, adapter, opts())).toBe(true);
      expect(currentRound(s)!.questions.map((x) => x.key)).toEqual(["storage"]);
      submitAnswers(s, 2, acceptAll(s));
      await nextRound(s, adapter, opts());
      expect(s.status).toBe("confirm");
      startSynthesis(s);
      const res = await synthesize(s, adapter, opts());
      expect(res.ok).toBe(true);
      expect((res as any).markdown).toContain("[R2:storage]");
    });
  }

  test("fake CLI modes: garbage once, dependent once, early plan once, leak once all recover", async () => {
    for (const mode of ["garbage-once", "truncated-once", "wrong-shape-once", "dependent-once", "plan-early-once", "leak-once"]) {
      const env = fakeEnv(fakeBinDir(["claude"]), { FAKE_MODE: mode });
      const adapter = createAdapters({ env }).find((x) => x.id === "claude")!;
      const s = createSession({ idea: "x", provider: "claude" });
      expect(await nextRound(s, adapter, opts())).toBe(true);
      expect(JSON.stringify(s)).not.toContain("grilling");
    }
  });
});

describe("prompt contents never leave the server (AC17 helper)", () => {
  test("fragments are long enough to be meaningful", () => {
    const f = promptFragments();
    expect(f.length).toBeGreaterThan(5);
    expect(f.every((x) => x.length >= 60)).toBe(true);
  });
});
