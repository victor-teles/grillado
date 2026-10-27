// v1.2 polish §2 (#99): deleting a comment thread, its Undo, and the tombstone that keeps another
// process's copy of the session from bringing it back.
import { describe, expect, test } from "bun:test";
import { addComment, addMessage, addSuggestions, adoptThreads, deleteThread, restoreThread } from "../src/core/comments.ts";
import { createSession } from "../src/core/session.ts";

const PLAN = "# App\n\n## Problem\nFamilies lose recipes in group chats.\n\n## Scope\nWeb first, then iOS.\n";

function plated() {
  const s = createSession({ idea: "App", provider: "claude" });
  s.status = "plated";
  s.plan = { title: "App", markdown: PLAN, path: "", openDecisions: [], createdAt: new Date().toISOString() };
  return s;
}

describe("deleteThread / restoreThread", () => {
  test("delete takes the thread and its pending suggestions; restore puts both back in place", () => {
    const s = plated();
    const a = addComment(s, { quote: "lose recipes", at: PLAN.indexOf("lose recipes"), text: "Why?" });
    const b = addComment(s, { quote: "Web first", at: PLAN.indexOf("Web first"), text: "And Android?" });
    const c = addComment(s, { quote: "then iOS", at: PLAN.indexOf("then iOS"), text: "When?" });
    addMessage(s, b.id, "agent", "Later.");
    addSuggestions(s, b.id, [{ before: "Web first", after: "Web and Android first" }], b.at);
    addSuggestions(s, a.id, [{ before: "lose recipes", after: "lose recipes they cooked" }], a.at);
    deleteThread(s, b.id);
    expect(s.comments!.map((t) => t.id)).toEqual([a.id, c.id]);
    expect(s.suggestions!.map((x) => x.threadId)).toEqual([a.id]);
    expect(s.deletedThreads).toEqual([b.id]);
    const back = restoreThread(s, b.id);
    expect(back.messages.map((m) => m.text)).toEqual(["And Android?", "Later."]);
    expect(s.comments!.map((t) => t.id)).toEqual([a.id, b.id, c.id]);
    expect(s.suggestions!.filter((x) => x.threadId === b.id && x.status === "pending")).toHaveLength(1);
    expect(s.deletedThreads).toEqual([]);
    expect(s.threadUndo).toBeUndefined();
  });

  test("restore only undoes the last delete", () => {
    const s = plated();
    const a = addComment(s, { quote: "lose recipes", at: PLAN.indexOf("lose recipes"), text: "Why?" });
    const b = addComment(s, { quote: "Web first", at: PLAN.indexOf("Web first"), text: "Android?" });
    deleteThread(s, a.id);
    deleteThread(s, b.id);
    expect(() => restoreThread(s, a.id)).toThrow("Nothing to undo.");
    restoreThread(s, b.id);
    expect(() => restoreThread(s, b.id)).toThrow("Nothing to undo.");
  });

  test("a deleted thread is never adopted back from another copy of the session", () => {
    const s = plated();
    const a = addComment(s, { quote: "lose recipes", at: PLAN.indexOf("lose recipes"), text: "Why?" });
    const disk = structuredClone(s);
    deleteThread(s, a.id);
    expect(adoptThreads(s, disk)).toBe(0);
    expect(s.comments).toEqual([]);
    // ...and the other way round: a copy that deleted it doesn't feed it to one that still has it.
    const other = structuredClone(s);
    const stale = structuredClone(disk);
    expect(adoptThreads(stale, other)).toBe(0);
    // Once restored, a stale copy that still has it adds nothing twice.
    restoreThread(s, a.id);
    expect(adoptThreads(s, disk)).toBe(0);
    expect(s.comments!.map((t) => t.id)).toEqual([a.id]);
  });
});
