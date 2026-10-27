// v1.2 polish §5 (#104): Add to plan — the checks on the agent's one edit, the suggestion it
// becomes, the state the row and card show, and its activity line.
import { describe, expect, test } from "bun:test";
import { type ActivityLine, fold, meta, title } from "../src/core/activity.ts";
import { addPlanState, addPlanSuggestion, checkAddPlan, citeId, citesIn, inPlan } from "../src/core/addplan.ts";
import { addPlanSystemPrompt } from "../src/core/prompts.ts";
import { AddPlanReplySchema } from "../src/core/schema.ts";
import { createSession } from "../src/core/session.ts";

const PLAN = "# List\n\n## Implementation decisions\n- Web first. [R1:platform]\n- Shared by link. [R1:scope, R2:share]\n";

function plated() {
  const s = createSession({ idea: "List", provider: "claude" });
  s.status = "plated";
  s.plan = { title: "List", markdown: PLAN, path: "", openDecisions: [], createdAt: new Date().toISOString() };
  return s;
}

describe("cites", () => {
  test("citeId and citesIn read single and grouped cites", () => {
    expect(citeId(3, "items")).toBe("R3:items");
    expect(citesIn(PLAN)).toEqual(["R1:platform", "R1:scope", "R2:share"]);
  });
  test("inPlan matches the key in any round", () => {
    expect(inPlan(PLAN, "share")).toBe(true);
    expect(inPlan(PLAN, "storage")).toBe(false);
    expect(inPlan("- Local first. [R4:storage]", "storage")).toBe(true);
  });
});

describe("checkAddPlan", () => {
  const cite = "R2:storage";
  test("accepts an edit that adds the decision with its cite and keeps the old ones", () => {
    expect(checkAddPlan(PLAN, { before: "Web first. [R1:platform]", after: "Web first. [R1:platform] Stored locally first. [R2:storage]" }, cite)).toBeNull();
  });
  test("refuses an edit without the decision's cite", () => {
    expect(checkAddPlan(PLAN, { before: "- Web first. [R1:platform]", after: "- Web first, stored locally. [R1:platform]" }, cite)).toContain("[R2:storage]");
  });
  test("refuses an edit that drops a cite it had", () => {
    expect(checkAddPlan(PLAN, { before: "- Shared by link. [R1:scope, R2:share]", after: "- Shared by link, stored locally. [R1:scope, R2:storage]" }, cite)).toContain("[R2:share]");
  });
  test("refuses text that isn't in the plan", () => {
    expect(checkAddPlan(PLAN, { before: "- Not there.", after: "- Not there. [R2:storage]" }, cite)).not.toBeNull();
  });
});

describe("addPlanSuggestion and addPlanState", () => {
  test("the suggestion has no thread and the decision as its source; ready while pending, rest once reviewed", () => {
    const s = plated();
    const x = addPlanSuggestion(s, "storage", { before: "Web first. [R1:platform]", after: "Web first. [R1:platform] Stored locally first. [R2:storage]" })!;
    expect(x.source).toEqual({ kind: "decision", id: "storage" });
    expect(x.threadId).toBe("");
    expect(x.status).toBe("pending");
    const run = { decision: "storage", state: "done" as const, startedAt: "", suggestion: x.id };
    expect(addPlanState(run, "storage", s.suggestions)).toBe("ready");
    expect(addPlanState(run, "platform", s.suggestions)).toBe("rest");
    x.status = "accepted";
    expect(addPlanState(run, "storage", s.suggestions)).toBe("rest");
    x.status = "rejected";
    expect(addPlanState(run, "storage", s.suggestions)).toBe("rest");
  });
  test("running, none, failed, stopped", () => {
    const r = (state: "running" | "done" | "error" | "stopped") => ({ decision: "k", state, startedAt: "" });
    expect(addPlanState(undefined, "k")).toBe("rest");
    expect(addPlanState(r("running"), "k")).toBe("running");
    expect(addPlanState(r("done"), "k")).toBe("none");
    expect(addPlanState(r("error"), "k")).toBe("failed");
    expect(addPlanState(r("stopped"), "k")).toBe("rest");
  });
  test("null when the text has gone from the plan", () => {
    expect(addPlanSuggestion(plated(), "k", { before: "- gone", after: "- gone [R1:k]" })).toBeNull();
  });
});

describe("the reply and the prompt", () => {
  test("place:false needs no edit; place:true carries before/after", () => {
    expect(AddPlanReplySchema.safeParse({ type: "addplan", place: false, before: "", after: "" }).success).toBe(true);
    expect(AddPlanReplySchema.safeParse({ type: "addplan", place: true, before: "a", after: "b" }).success).toBe(true);
    expect(AddPlanReplySchema.safeParse({ type: "apply", place: true }).success).toBe(false);
  });
  test("the system prompt never names the agent", () => {
    expect(addPlanSystemPrompt()).not.toMatch(/claude|codex|grok/i);
  });
});

describe("activity (#104)", () => {
  const at = (m: number) => new Date(Date.UTC(2026, 9, 27, 5, m)).toISOString();
  const lines = (status: "done" | "failed" | "stopped", result?: { suggestions: number }): ActivityLine[] => [
    { v: 1, id: "a1", type: "run.started", kind: "addplan", at: at(0), agent: "claude", target: { decision: "Where does the list live?" } },
    { v: 1, run: "a1", type: "run.ended", status, ms: 4200, at: at(1), ...(result ? { result } : {}) } as ActivityLine,
  ];
  test("titles", () => {
    expect(title(fold(lines("done", { suggestions: 1 }))[0])).toBe("Added a decision to the plan");
    expect(title(fold(lines("failed"))[0])).toBe("Couldn’t add a decision to the plan");
    expect(title(fold(lines("stopped"))[0])).toBe("Stopped adding a decision to the plan");
    expect(title(fold(lines("done", { suggestions: 1 }).slice(0, 1))[0])).toBe("Adding a decision to the plan");
  });
  test("meta names the decision and the outcome", () => {
    const one = meta(fold(lines("done", { suggestions: 1 }))[0], { agent: "Claude Code" });
    expect(one).toContain("for “Where does the list live?”");
    expect(one).toContain("1 suggestion");
    expect(meta(fold(lines("done", { suggestions: 0 }))[0], { agent: "Claude Code" })).toContain("no place found");
  });
});
