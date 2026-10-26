// Item 4's slash menu without a DOM: ranking (handoff §3), the trigger, templates and fields.
import { describe, expect, test } from "bun:test";
import { fillUserDecisions, findDecisionBlocks } from "../src/core/decision-block.ts";
import { buildRoundPrompt } from "../src/core/engine.ts";
import { type Session, createSession, validateRound } from "../src/core/session.ts";
import { commands, editFields, expand, insertion, rank, slashQuery, tabStops } from "../web/src/app/editor/slash.ts";

const cmds = commands("Codex", true);
const labels = (q: string) => rank(cmds, q).map((h) => h.cmd.label);

describe("ranking", () => {
  test("empty query lists everything in group order", () => {
    expect(labels("")).toEqual(["Decision", "Question", "Flowchart", "State diagram", "Diagram by Codex", "Callout", "Code", "Diff", "Table", "Tabs", "Heading", "Bulleted list", "Checklist"]);
  });
  test("/dia: a direct insert beats the agent row, which beats an alias", () => {
    expect(labels("dia").slice(0, 3)).toEqual(["State diagram", "Diagram by Codex", "Flowchart"]);
  });
  test("/ta: ties keep list order", () => {
    expect(labels("ta").slice(0, 2)).toEqual(["Table", "Tabs"]);
  });
  test("/qs: subsequence", () => {
    expect(labels("qs")).toEqual(["Question"]);
    expect(rank(cmds, "qs")[0].hit).toEqual([0, 3]);
  });
  test("/warn: alias match, shown after the label, inserts the warning callout", () => {
    const [h] = rank(cmds, "warn");
    expect(h.cmd.label).toBe("Callout");
    expect(h.alias).toBe("warning");
    expect(expand(h.cmd.id, h.alias).text).toBe("> [!WARNING]\n> Text");
  });
  test("/xyz: nothing", () => {
    expect(labels("xyz")).toEqual([]);
  });
  test("at most 8 rows with a query; the agent name is data", () => {
    expect(rank(cmds, "e").length).toBeLessThanOrEqual(8);
    expect(commands("Claude Code", true).find((c) => c.agent)?.desc).toStartWith("Claude Code reads this section");
    expect(commands("Codex", false).some((c) => c.agent)).toBe(false);
  });
});

describe("trigger", () => {
  test("a / at line start, or after spaces", () => {
    expect(slashQuery("/", 1)).toEqual({ from: 0, query: "" });
    expect(slashQuery("Text\n  /de", 10)).toEqual({ from: 7, query: "de" });
  });
  test("mid-line, after a letter, with a space, or inside a fence stays text", () => {
    expect(slashQuery("and/or", 4)).toBeNull();
    expect(slashQuery("/de x", 5)).toBeNull();
    expect(slashQuery("```ts\n/x", 8)).toBeNull();
    expect(slashQuery("```ts\nx\n```\n/x", 14)).toEqual({ from: 12, query: "x" });
  });
});

describe("templates and fields", () => {
  test("decision: question then answer", () => {
    const t = expand("decision");
    expect(t.text).toBe("```decision\nquestion: Question\nanswer: Answer\n```");
    expect(t.fields.map((f) => t.text.slice(f.start, f.end))).toEqual(["Question", "Answer"]);
  });
  test("question has an empty answer (open)", () => {
    expect(expand("question").text).toBe("```decision\nquestion: Question\nanswer:\n```");
  });
  test("code: language, then body", () => {
    const t = expand("code");
    expect(t.fields.map((f) => t.text.slice(f.start, f.end))).toEqual(["language", "code"]);
  });
  test("the state diagram's first state is typed once", () => {
    const t = expand("state");
    expect(tabStops(t.fields)).toEqual([0, 2]);
    const typed = t.text.slice(0, t.fields[0].start) + "Draft" + t.text.slice(t.fields[0].end);
    const r = editFields(t.text, typed, t.fields, 0)!;
    expect(r.text).toBe("```mermaid\nstateDiagram-v2\n  [*] --> Draft\n  Draft --> Next state\n```");
    expect(r.text.slice(r.fields[2].start, r.fields[2].end)).toBe("Next state");
  });
  test("typing in a field shifts the later ones; editing outside ends field mode", () => {
    const t = expand("decision");
    const f = t.fields[0];
    const next = t.text.slice(0, f.start) + "Which browsers?" + t.text.slice(f.end);
    const r = editFields(t.text, next, t.fields, 0)!;
    expect(r.text.slice(r.fields[1].start, r.fields[1].end)).toBe("Answer");
    expect(editFields(t.text, `x${t.text}`, t.fields, 0)).toBeNull();
  });
  test("an insert gets its own block, blank lines around it", () => {
    const doc = "Intro\n/ta\nMore";
    const ins = insertion(doc, slashQuery(doc, 9)!, 9, expand("h"));
    const out = doc.slice(0, ins.from) + ins.text + doc.slice(ins.to);
    expect(out).toBe("Intro\n\n## Heading\n\nMore");
    expect(out.slice(ins.fields[0].start, ins.fields[0].end)).toBe("Heading");
  });
});


describe("decisions you add (U ids)", () => {
  const now = "2026-10-26T01:00:00.000Z";
  test("a Decision gets U1, by you and at; a Question is open", () => {
    const md = "Intro\n\n```decision\nquestion: Which browsers?\nanswer: Last two\n```\n\n```decision\nquestion: Offline?\nanswer:\n```\n";
    const out = fillUserDecisions(md, now);
    const [a, b] = findDecisionBlocks(out).map((x) => x.parsed);
    expect(a.ok && a.fields).toMatchObject({ id: "U1", key: "u1", by: "you", answer: "Last two", at: now });
    expect(b.ok && b.fields).toMatchObject({ id: "U2", key: "u2", status: "open" });
    expect(fillUserDecisions(out, now)).toBe(out);
  });
  test("numbering continues after existing U ids and leaves round blocks alone", () => {
    const md = "```decision\nid: R1·1\nkey: scope\nquestion: Q\nanswer: A\n```\n\n```decision\nid: U3\nkey: u3\nquestion: Q\nanswer: A\n```\n\n```decision\nquestion: New\nanswer: Yes\n```";
    const out = fillUserDecisions(md, now);
    expect(out.startsWith("```decision\nid: R1·1\nkey: scope\nquestion: Q\nanswer: A\n```")).toBe(true);
    expect(findDecisionBlocks(out)[2].parsed).toMatchObject({ ok: true, fields: { id: "U4" } });
  });
});

// PO answer on #5: a U question is asked word for word; an answer you gave first is final.
describe("your own questions in the next round", () => {
  const plan = [
    "# Plan",
    "```decision\nid: U1\nkey: u1\nquestion: Which browsers do we support?\nanswer:\nby: you\nstatus: open\n```",
    "```decision\nid: U2\nkey: u2\nquestion: Keep data local first?\nanswer: Yes, offline first\nby: you\nstatus: open\n```",
  ].join("\n\n");
  const session = () => {
    const s = createSession({ idea: "an app", provider: "claude" });
    s.plan = { title: "Plan", markdown: plan } as Session["plan"];
    return s;
  };
  const ask = (key: string, title: string) => ({
    type: "ask_round" as const,
    summary: "s",
    upcoming: [] as never[],
    questions: [{ key, label: "Browsers", title, body: "Context.", options: [{ id: "a", label: "A", description: "" }], recommendedOptionId: "a", dependsOn: [] as string[] }],
  });
  test("the prompt lists the open one to ask verbatim and the answered one as final", () => {
    const p = buildRoundPrompt(session());
    const state = JSON.parse(/<state>(.*)<\/state>/.exec(p)![1]);
    expect(state.userQuestions).toEqual([{ key: "u1", question: "Which browsers do we support?" }]);
    expect(state.userDecisions).toEqual([{ key: "u2", question: "Keep data local first?", answer: "Yes, offline first" }]);
    expect(p).toContain("word for word");
    expect(p).toContain("never ask them again");
    expect(p).toContain("offer to change it");
  });
  test("a reworded U question is sent back; the exact words pass", () => {
    const s = session();
    expect(validateRound(s, ask("u1", "What browsers should we support?"))).toContain("word for word");
    expect(validateRound(s, ask("u1", "Which browsers do we support?"))).toBeNull();
  });
  test("a U question you already answered is never asked", () => {
    expect(validateRound(session(), ask("u2", "Keep data local first?"))).toContain("answer is final");
  });
});
