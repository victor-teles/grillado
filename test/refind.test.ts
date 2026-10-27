// #114: a comment is re-found by quote + position inside its own section; its own accepted
// suggestion takes it along, anything else that removes its text leaves it "text changed".
import { describe, expect, test } from "bun:test";
import { addComment, addSuggestions, headingAt, pruneSuggestions, refind, review, sectionSpans, settleThreads, threadSection, undoReview } from "../src/core/comments.ts";
import { createSession } from "../src/core/session.ts";
import { anchorOf, heldAnchor, place, sectionOf } from "../web/src/app/comments/model.ts";

const PLAN = `# Plan: Shared shopping list for my household

## Problem
Shared shopping list for families, so nobody buys milk twice. A shared shopping list is the core.

## Implementation decisions
- Yes, one core flow
- Web app

\`\`\`decision
key: scope
question: Shared shopping list?
answer: Yes
\`\`\`

## Problem
Shared shopping list again, in a second section with the same heading.
`;

function plated(md = PLAN) {
  const s = createSession({ idea: "Shopping list", provider: "claude" });
  s.status = "plated";
  s.plan = { title: "Plan", markdown: md, path: "", openDecisions: [], createdAt: new Date().toISOString() };
  return s;
}
const at = (needle: string, from = 0) => PLAN.indexOf(needle, from);
const QUOTE = "Shared shopping list";

describe("sections", () => {
  test("split at headings outside fences, with the text before the first heading as \"\"", () => {
    const sp = sectionSpans(PLAN);
    expect(sp.map((x) => x.title)).toEqual(["", "Plan: Shared shopping list for my household", "Problem", "Implementation decisions", "Problem"]);
    expect(sp[2].start).toBe(at("## Problem"));
    expect(sp[2].end).toBe(at("## Implementation"));
    expect(sp.at(-1)!.end).toBe(PLAN.length);
  });
  test("a comment stores the heading it was made under", () => {
    const s = plated();
    const t = addComment(s, { quote: QUOTE, at: at("Shared shopping list for families"), text: "Who shares it?" });
    expect(t.section).toBe("Problem");
    expect(headingAt(PLAN, 0)).toBe("Plan: Shared shopping list for my household");
  });
});

describe("refind", () => {
  const t = { quote: QUOTE, at: at("Shared shopping list for families"), section: "Problem" };
  test("finds the match nearest the stored position in the same section", () => {
    expect(refind(PLAN, t)).toBe(t.at);
    // Text added above shifts it; it still lands on the first Problem match, not the title's.
    const md = PLAN.replace("## Problem\n", "## Problem\nA new line here.\n");
    expect(refind(md, t)).toBe(md.indexOf("Shared shopping list for families"));
  });
  test("prefers the nearer of two matches in the section", () => {
    const later = { ...t, quote: "hared shopping list", at: at("shared shopping list is") + 1 };
    expect(refind(PLAN, later)).toBe(at("shared shopping list is") + 1);
  });
  test("never jumps to the title, a fence or another section once the text is gone (the #11 repro)", () => {
    const md = PLAN.replace("Shared shopping list for families", "One list the whole household shares for families");
    expect(md.includes(QUOTE)).toBe(true); // still in the H1, the decision and the second Problem
    expect(refind(md, t)).toBe(-1);
  });
  test("a heading used twice: the one nearest the stored position", () => {
    const second = { quote: QUOTE, at: at("Shared shopping list again"), section: "Problem" };
    expect(refind(PLAN, second)).toBe(second.at);
    const md = PLAN.replace("Shared shopping list again", "Again");
    expect(refind(md, second)).toBe(-1);
  });
  test("a renamed heading: the section at the stored position stands in", () => {
    const w = { quote: "Web app", at: at("Web app"), section: "Implementation decisions" };
    const md = PLAN.replace("## Implementation decisions", "## How we build it");
    expect(refind(md, w)).toBe(md.indexOf("Web app"));
  });
  test("older threads without a section use the section at their position", () => {
    expect(refind(PLAN, { quote: QUOTE, at: at("Shared shopping list for families") })).toBe(t.at);
    const md = PLAN.replace("Shared shopping list for families", "Lists for families");
    expect(refind(md, { quote: QUOTE, at: t.at })).toBe(-1);
  });
  test("a comment on the title stays on the title", () => {
    const h = { quote: QUOTE, at: at(QUOTE), section: "Plan: Shared shopping list for my household" };
    expect(refind(PLAN, h)).toBe(at(QUOTE));
  });
  test("the browser's anchor and label use the same rule", () => {
    const th = { id: "c1", quote: QUOTE, at: t.at, section: "Problem", createdAt: "", messages: [] };
    const md = PLAN.replace("Shared shopping list for families", "One list for families");
    expect(anchorOf(PLAN, th)).toEqual({ start: t.at, end: t.at + QUOTE.length });
    expect(anchorOf(md, th)).toBeNull();
    // Detached, it's still "On Problem".
    expect(sectionOf(md, th)).toBe("Problem");
    expect(threadSection(md, th)).toBe("Problem");
  });
  test("settleThreads moves each thread's hint to where its quote is now, and leaves a lost one alone", () => {
    const s = plated();
    const a = addComment(s, { quote: QUOTE, at: t.at, text: "x" });
    const b = addComment(s, { quote: "Web app", at: at("Web app"), text: "y" });
    s.plan!.markdown = PLAN.replace("## Problem\n", "## Problem\nMore.\n").replace("- Web app", "- Native app");
    settleThreads(s);
    expect(a.at).toBe(t.at + 6);
    expect(b.at).toBe(at("Web app"));
  });
});

describe("an accepted suggestion and the comment on its text", () => {
  function setup(after: string, quote = QUOTE, before = "Shared shopping list for families") {
    const s = plated();
    const th = addComment(s, { quote, at: at(quote === QUOTE ? "Shared shopping list for families" : quote), text: "Say who shares it" });
    const { added } = addSuggestions(s, th.id, [{ before, after }], th.at);
    return { s, th, x: added[0] };
  }
  test("its own suggestion rewrites the quote: the comment follows the inserted text", () => {
    const { s, th, x } = setup("One list the whole household shares for families");
    review(s, "accept", [x.id]);
    const md = s.plan!.markdown;
    expect(md.slice(th.at, th.at + th.quote.length)).toBe(th.quote);
    expect(th.quote).toBe("One list the whole household shares");
    expect(refind(md, th)).toBe(md.indexOf("One list the whole household shares"));
    expect(th.section).toBe("Problem");
    expect(threadSection(md, th)).toBe("Problem");
  });
  test("the quote's untouched words stay in the new anchor", () => {
    const { s, th, x } = setup("Shared grocery list for families");
    review(s, "accept", [x.id]);
    expect(th.quote).toBe("Shared grocery list");
  });
  test("an addition after the quote leaves it where it is", () => {
    const { s, th, x } = setup("Shared shopping list, shared by everyone at home, for families");
    review(s, "accept", [x.id]);
    expect(th.quote).toBe(QUOTE);
    expect(refind(s.plan!.markdown, th)).toBe(at("Shared shopping list for families"));
  });
  test("positions shifted by an earlier accepted suggestion still land on the inserted text", () => {
    const s = plated();
    const th = addComment(s, { quote: "Web app", at: at("Web app"), text: "Which?" });
    const { added } = addSuggestions(s, th.id, [{ before: "Shared shopping list for families", after: "Lists" }, { before: "Web app", after: "A web app on every phone" }], th.at);
    review(s, "accept", added.map((x) => x.id));
    expect(th.quote).toBe("A web app on every phone");
    expect(s.plan!.markdown.slice(th.at, th.at + th.quote.length)).toBe(th.quote);
  });
  test("a suggestion that only deletes the quote leaves the comment detached", () => {
    const { s, th, x } = setup(" for families");
    review(s, "accept", [x.id]);
    expect(refind(s.plan!.markdown, th)).toBe(-1);
    expect(threadSection(s.plan!.markdown, th)).toBe("Problem");
  });
  test("another thread's suggestion removing the text detaches it, and it doesn't follow", () => {
    const s = plated();
    const th = addComment(s, { quote: QUOTE, at: at("Shared shopping list for families"), text: "a" });
    const other = addComment(s, { quote: "families", at: at("families"), text: "b" });
    const { added } = addSuggestions(s, other.id, [{ before: "Shared shopping list for families", after: "One list for families" }], other.at);
    review(s, "accept", [added[0].id]);
    expect(th.quote).toBe(QUOTE);
    expect(refind(s.plan!.markdown, th)).toBe(-1);
    expect(refind(s.plan!.markdown, other)).toBeGreaterThan(0);
  });
  test("Undo puts the comment back on the text it was on", () => {
    const { s, th, x } = setup("One list the whole household shares for families");
    const was = { quote: th.quote, at: th.at };
    review(s, "accept", [x.id]);
    undoReview(s);
    expect(s.plan!.markdown).toBe(PLAN);
    expect({ quote: th.quote, at: th.at }).toEqual(was);
  });
  test("during the hold the anchor only takes in the insertion; nothing is re-found until the write", () => {
    const { s, th, x } = setup("Shared grocery list for families");
    const placed = place(PLAN, s.suggestions!);
    const r = anchorOf(PLAN, th)!;
    expect(heldAnchor(r, th, placed, {})).toEqual(r);
    expect(heldAnchor(r, th, placed, { [x.id]: "out" })).toEqual(r);
    const p = placed[0];
    expect(heldAnchor(r, th, placed, { [x.id]: "ok" })).toEqual({ start: r.start, end: Math.max(r.end, p.end) });
  });
});

describe("a pending suggestion keeps to its section too", () => {
  test("its text gone from its section: it no longer fits, rather than landing on the title", () => {
    const s = plated();
    const th = addComment(s, { quote: QUOTE, at: at("Shared shopping list for families"), text: "a" });
    const { added } = addSuggestions(s, th.id, [{ before: QUOTE, after: "One list" }], th.at);
    expect(added[0].under).toBe("Problem");
    s.plan!.markdown = PLAN.replace("Shared shopping list for families", "Lists for families");
    expect(place(s.plan!.markdown, s.suggestions!)).toEqual([]);
    expect(pruneSuggestions(s)).toBe(1);
    expect(s.suggestions).toEqual([]);
  });
  test("text added above it: it's re-found in its section, and accepting writes there", () => {
    const s = plated();
    const th = addComment(s, { quote: QUOTE, at: at("Shared shopping list for families"), text: "a" });
    const { added } = addSuggestions(s, th.id, [{ before: QUOTE, after: "One list" }], th.at);
    s.plan!.markdown = PLAN.replace("## Problem\n", "## Problem\nNew line.\n");
    expect(pruneSuggestions(s)).toBe(0);
    review(s, "accept", [added[0].id]);
    expect(s.plan!.markdown.startsWith("# Plan: Shared shopping list")).toBe(true);
    expect(s.plan!.markdown).toContain("New line.\nOne list for families");
  });
});
