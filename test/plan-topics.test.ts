// Every open line of a plan can be asked about (the writer's own open lines included), and an
// Out of scope line can be brought into the plan. Both go back to the interview by a key made from the text.
import { describe, expect, test } from "bun:test";
import os from "node:os";
import { buildRoundPrompt, buildSynthesisPrompt, synthesize } from "../src/core/engine.ts";
import { outOfScopeItems, planOpenNow, unaskedPlanItems } from "../src/core/floor.ts";
import type { ProviderAdapter, ProviderEvent, RunRequest } from "../src/core/providers/types.ts";
import { type Session, applyRound, createSession, resumePlan, scopeIn, setPlan, stopAtCap, submitAnswers } from "../src/core/session.ts";
import { planCounts } from "../web/src/app/counts.ts";

const q = (key: string, label = key) => ({
  key,
  label,
  title: `Question ${key}?`,
  body: "",
  options: [{ id: "a", label: "Option a", description: "" }, { id: "b", label: "Option b", description: "" }],
  recommendedOptionId: "a",
  dependsOn: [],
});
const ask = (s: Session, keys: string[], max = 2) => applyRound(s, { type: "ask_round", summary: "s", questions: keys.map((k) => q(k)), upcoming: [] } as any, max);
const answerAll = (s: Session) => {
  const r = s.rounds.at(-1)!;
  submitAnswers(s, r.n, r.questions.map((x) => ({ questionId: x.key, optionId: "a", accepted_recommendation: true })));
};
const SCOPE = "## Out of scope\n\n- Dedicated retry controls.\n- Offline mode.\n\n## Assumptions and open decisions\n\n- None.";
function writer(openDecisions: string[]): ProviderAdapter {
  return {
    id: "claude",
    displayName: "Claude Code",
    bin: "fake",
    installHint: "n/a",
    loginHint: "n/a",
    async detect() {
      return { status: "ready", version: "1", path: "/fake" };
    },
    async *run(_req: RunRequest): AsyncIterable<ProviderEvent> {
      yield { type: "result", raw: { type: "plan", title: "Plan", markdown: `## Problem\n\nText.\n\n${SCOPE}`, decisions: [], openDecisions, steps: [{ title: "Build it", done: "It runs." }] } };
    },
  };
}
const LIMITS = "Recover the exact size limits approved in round 2; the state does not include them.";
/** Two answered rounds at the cap, then a plan whose writer listed `open` as open lines of its own. */
async function plated(open: string[] = []): Promise<Session> {
  const s = createSession({ idea: "x", provider: "claude" });
  ask(s, ["platform"]);
  answerAll(s);
  ask(s, ["storage"]);
  answerAll(s);
  stopAtCap(s);
  s.status = "synthesizing";
  const out = await synthesize(s, writer(open), { cwd: os.tmpdir(), timeoutMs: 10_000, signal: new AbortController().signal }, 2);
  if (!out.ok) throw new Error("no plan");
  setPlan(s, { title: "Plan", markdown: out.markdown, path: "/tmp/plan.md", openDecisions: out.open });
  return s;
}

describe("an open line the writer listed can be asked about", () => {
  test("it is counted open and offered as a topic with a key of its own", async () => {
    const s = await plated([LIMITS]);
    const md = s.plan!.markdown;
    expect(planOpenNow(s, md)).toEqual([LIMITS]);
    expect(planCounts(JSON.parse(JSON.stringify(s)), md).open).toBe(1);
    const items = unaskedPlanItems(s, md);
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ label: LIMITS, asked: false, topic: true });
    expect(items[0].key).toMatch(/^open-[0-9a-f]{8}$/);
    // Every counted open item has a way to be answered.
    expect(items.length + planCounts(JSON.parse(JSON.stringify(s)), md).openKeys.length).toBe(planCounts(JSON.parse(JSON.stringify(s)), md).open);
  });

  test("Answer remaining questions sends it to the agent, past the cap, and its answer is a decision", async () => {
    const s = await plated([LIMITS]);
    const [item] = unaskedPlanItems(s, s.plan!.markdown);
    resumePlan(s);
    expect(s.status).toBe("asking");
    expect(s.reopened).toEqual([item.key]);
    expect(s.topics).toEqual([{ key: item.key, label: LIMITS, kind: "open" }]);
    const prompt = buildRoundPrompt(s, 2);
    expect(prompt).toContain(`"pendingQuestions":[{"key":"${item.key}","label":"${LIMITS}"}]`);
    expect(prompt).toContain("give that question a short label of its own");
    expect(prompt).not.toContain("wasOutOfScope");
    ask(s, [item.key, "unrequested"]);
    expect(s.rounds.at(-1)?.questions.map((x) => x.key)).toEqual([item.key]);
    expect(s.rounds.at(-1)?.reask).toBe(true);
    answerAll(s);
    expect(s.decisions[item.key].answer).toBe("Option a");
    // Asked once: the agent is not sent the topic again.
    expect(buildRoundPrompt(s, 2)).not.toContain("pendingQuestions");
  });

  test("a line the writer lists again after it was answered gets a new key, so it can be asked again", async () => {
    const s = await plated([LIMITS]);
    const [first] = unaskedPlanItems(s, s.plan!.markdown);
    resumePlan(s);
    ask(s, [first.key]);
    answerAll(s);
    s.status = "plated";
    const [again] = unaskedPlanItems(s, s.plan!.markdown);
    expect(again.key).toBe(`${first.key}-2`);
  });

  test("a line taken out of the plan is no longer open or resumable", async () => {
    const s = await plated([LIMITS]);
    s.plan!.markdown = s.plan!.markdown.replace(`- ${LIMITS}\n`, "");
    expect(unaskedPlanItems(s, s.plan!.markdown)).toEqual([]);
    expect(() => resumePlan(s)).toThrow("There are no remaining topics to ask about.");
  });
});

describe("an Out of scope line can be brought into the plan", () => {
  test("the lines of the section are read as written", () => {
    expect(outOfScopeItems(`# T\n\n${SCOPE}`)).toEqual(["Dedicated retry controls.", "Offline mode."]);
    expect(outOfScopeItems("## Out of scope\n1. One\n2. Two\n\nText\n## Next\n- Three")).toEqual(["One", "Two"]);
    expect(outOfScopeItems("## Problem\n\n- Not this")).toEqual([]);
  });

  test("the agent is asked how it should work, and the writer is told it is in scope once answered", async () => {
    const s = await plated();
    const md = s.plan!.markdown;
    const topic = scopeIn(s, "Offline mode.");
    expect(topic.key).toMatch(/^scope-[0-9a-f]{8}$/);
    expect(s.status).toBe("asking");
    expect(s.plan!.markdown).toBe(md);
    expect(s.reopened).toEqual([topic.key]);
    const prompt = buildRoundPrompt(s, 2);
    expect(prompt).toContain(`{"key":"${topic.key}","label":"Offline mode.","wasOutOfScope":true}`);
    expect(prompt).toContain("the user now wants it in");
    // Not answered yet: the writer isn't told anything.
    expect(buildSynthesisPrompt(s)).not.toContain("nowInScope");
    ask(s, [topic.key]);
    answerAll(s);
    const synth = buildSynthesisPrompt(s);
    expect(synth).toContain('"nowInScope":["Offline mode."]');
    expect(synth).toContain("don't list them under Out of scope");
  });

  test("only a line that is in the section, on a written plan with nothing waiting", async () => {
    const s = await plated();
    expect(() => scopeIn(s, "Something else")).toThrow("Out of scope section");
    expect(() => scopeIn(s, "")).toThrow("Out of scope section");
    expect(s.status).toBe("plated");
    s.status = "confirm";
    expect(() => scopeIn(s, "Offline mode.")).toThrow("Finish writing the plan first.");
  });
});
