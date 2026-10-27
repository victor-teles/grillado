// Item 3 UI logic without a DOM: the selection toolbar's ⌘B/⌘I (#27), how suggestions are drawn,
// thread status rows (#28: all accepted offers Resolve, never resolves), and the wording (#29).
import { describe, expect, test } from "bun:test";
import { CCOPY, author, canApply, fill, minimal, place, rowText, statusRow } from "../web/src/app/comments/model.ts";
import { formatEdit, formatKey } from "../web/src/app/editor/selection.ts";
import type { CommentThread, Suggestion } from "../src/core/comments.ts";

const key = (k: string, o: Partial<{ metaKey: boolean; ctrlKey: boolean; altKey: boolean; shiftKey: boolean }> = {}) => ({ key: k, metaKey: false, ctrlKey: false, altKey: false, shiftKey: false, ...o });
const thread = (over: Partial<CommentThread> = {}): CommentThread => ({ id: "t1", quote: "q", at: 0, createdAt: "", messages: [{ id: "m", by: "agent", text: "ok", at: "" }], ...over });
const sg = (status: Suggestion["status"], id = Math.random().toString(36)): Suggestion => ({ id, threadId: "t1", before: "a", after: "b", at: 0, status });

describe("⌘B / ⌘I (#27)", () => {
  test("⌘B and Ctrl+B are bold, ⌘I is italic; with Alt or Shift they are not", () => {
    expect(formatKey(key("b", { metaKey: true }))).toBe("bold");
    expect(formatKey(key("B", { ctrlKey: true }))).toBe("bold");
    expect(formatKey(key("i", { metaKey: true }))).toBe("italic");
    expect(formatKey(key("b", { metaKey: true, altKey: true }))).toBeNull();
    expect(formatKey(key("i", { ctrlKey: true, shiftKey: true }))).toBeNull();
    expect(formatKey(key("b"))).toBeNull();
  });
  test("bold wraps the selection and keeps the words selected; again unwraps", () => {
    const src = "for my household";
    const a = formatEdit(src, 7, 16, "bold");
    expect(a.text).toBe("for my **household**");
    expect(a.text.slice(a.start, a.end)).toBe("household");
    const b = formatEdit(a.text, a.start, a.end, "bold");
    expect(b.text).toBe(src);
  });
  test("italic stacks on bold", () => {
    const a = formatEdit("x word y", 2, 6, "bold");
    const b = formatEdit(a.text, a.start, a.end, "italic");
    expect(b.text).toBe("x ***word*** y");
  });
});

describe("suggestions in the text", () => {
  test("a pure addition is drawn as an insertion only", () => {
    expect(minimal("Shared shopping list", "Shared shopping list, shared by everyone")).toEqual({ p: 20, del: "", ins: ", shared by everyone" });
  });
  test("a change inside a word shows the whole word", () => {
    expect(minimal("one core flow", "one core flows")).toEqual({ p: 9, del: "flow", ins: "flows" });
  });
  test("place keeps pending ones that still fit, in text order", () => {
    const md = "alpha beta gamma";
    const list: Suggestion[] = [
      { id: "2", threadId: "t", before: "gamma", after: "delta", at: 11, status: "pending" },
      { id: "1", threadId: "t", before: "alpha", after: "omega", at: 0, status: "pending" },
      { id: "3", threadId: "t", before: "zeta", after: "eta", at: 0, status: "pending" },
      { id: "4", threadId: "t", before: "beta", after: "b", at: 6, status: "accepted" },
    ];
    expect(place(md, list).map((p) => p.s.id)).toEqual(["1", "2"]);
  });
});

describe("thread status rows", () => {
  test("all accepted offers Resolve and the thread stays open (#28)", () => {
    const t = thread({ run: { kind: "apply", state: "done", startedAt: "", edits: 2 } });
    const row = statusRow(t, [sg("accepted"), sg("accepted")]);
    expect(row).toEqual({ kind: "accepted", n: 2 });
    expect(rowText(row!)).toBe("2 accepted · in plan.md");
    expect(t.resolved).toBeUndefined();
  });
  test("partial review and counts", () => {
    const row = statusRow(thread(), [sg("accepted"), sg("rejected"), sg("pending")]);
    expect(rowText(row!)).toBe("1 accepted · 1 rejected · 1 to review");
  });
  test("running, stopped, no changes, decision", () => {
    expect(statusRow(thread({ run: { kind: "apply", state: "running", startedAt: "" } }), [])?.kind).toBe("writing");
    // Item 6 §18 H: the running row names the agent.
    expect(fill(rowText(statusRow(thread({ run: { kind: "apply", state: "running", startedAt: "" } }), [])!), "Codex")).toBe("Codex is writing suggestions");
    expect(rowText(statusRow(thread({ run: { kind: "apply", state: "stopped", startedAt: "" } }), [])!)).toBe("Stopped · nothing changed");
    expect(statusRow(thread({ run: { kind: "apply", state: "done", startedAt: "", edits: 0 } }), [])?.kind).toBe("none");
    expect(statusRow(thread({ run: { kind: "apply", state: "done", startedAt: "", decision: "scope" } }), [])).toEqual({ kind: "decision", key: "scope" });
  });
  test("Apply feedback waits for the agent's reply", () => {
    expect(canApply(thread())).toBe(true);
    expect(canApply(thread({ messages: [{ id: "m", by: "you", text: "x", at: "" }] }))).toBe(false);
    expect(canApply(thread({ run: { kind: "reply", state: "running", startedAt: "" } }))).toBe(false);
  });
});

describe("wording", () => {
  test("“Suggestions” everywhere, never “edits” (#29), and the agent is templated", () => {
    const all = [CCOPY.from(1), CCOPY.from(3), CCOPY.ready(2), CCOPY.readyLive(2), CCOPY.notInFile(2), CCOPY.noFit(1), CCOPY.bulk(2, "accepted"), CCOPY.writing, CCOPY.writingLive, CCOPY.emptyBody].join(" ");
    expect(all).not.toMatch(/\bedits?\b/i);
    expect(all).toMatch(/suggestions/);
    expect(fill(CCOPY.from(2), "Codex")).toBe("2 suggestions from Codex");
    expect(Object.values(CCOPY).filter((v) => typeof v === "string").join(" ")).not.toMatch(/Claude|Codex/);
  });
});

describe("comment authors (v1.2 item 1)", () => {
  test("the rail names you, the coding agent over MCP, or the selected agent", () => {
    const m = (by: "you" | "agent" | "coder") => ({ id: "m", by, text: "x", at: "" });
    expect(author(m("you"), "Codex")).toBe("You");
    expect(author(m("coder"), "Codex")).toBe("Coding agent");
    expect(author(m("agent"), "Codex")).toBe("Codex");
  });
});
