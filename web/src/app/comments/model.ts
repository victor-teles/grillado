// Item 3, DOM-free: where threads and suggestions sit in the current text, and what each
// thread's status row says. Unit-tested in test/comments-ui.test.ts.
import { locate, plainQuote, sectionAt } from "../../../../src/core/comments.ts";
import type { CommentThread, Suggestion } from "../types.ts";
import { editorName } from "../../../../src/core/editor.ts";

export const fill = (t: string, agent: string) => t.replace(/\{agent\}/g, agent);

/** The UI's copy for item 3. "Suggestions" everywhere (#29); the agent name is always templated. */
export const CCOPY = {
  placeholder: "Comment or ask {agent}…",
  emptyTitle: "No comments yet",
  emptyBody: "Select text in the plan and press Comment, or ⌘⌥M. {agent} replies, and can turn what you asked into suggestions.",
  replying: "{agent} replying",
  replied: "{agent} replied",
  couldntReply: "Couldn't reply",
  writing: "{agent} is writing suggestions",
  writingLive: "{agent} is writing suggestions",
  waiting: "Waiting for the current run",
  applying: "Applying…",
  stoppedApply: "Stopped · nothing changed",
  couldntApply: "Couldn't write suggestions",
  noChanges: "No changes needed",
  viaDecision: "Answers change in their decision block",
  lost: "The text this was on changed, so it is no longer marked in the plan. {agent} still sees the quote.",
  noFit: (n: number) => `${n} ${n === 1 ? "suggestion no longer fits" : "suggestions no longer fit"} the text`,
  from: (n: number) => `${n} ${n === 1 ? "suggestion" : "suggestions"} from {agent}`,
  ready: (n: number) => `${n} ${n === 1 ? "suggestion" : "suggestions"} ready`,
  readyLive: (n: number) => `${n} ${n === 1 ? "suggestion" : "suggestions"} from {agent} ready`,
  notInFile: (n: number) => `${n} ${n === 1 ? "suggestion is" : "suggestions are"} not in plan.md`,
  toReview: (n: number) => `${n} to review`,
  bulk: (n: number, a: "accepted" | "rejected") => `${n} ${n === 1 ? "suggestion" : "suggestions"} ${a}`,
  rtfHint: "Switch to Rich to comment",
  /** After the editor's name on a comment sent over `grillado mcp` (v1.2 item 1 §9, DECISIONS #107). */
  fromEditor: "from your editor",
};

/** Who wrote a thread message, as the rail labels it. */
export const author = (m: CommentThread["messages"][number], agent: string) => (m.by === "you" ? "You" : m.by === "coder" ? editorName(m.client) : agent);

export interface Placed {
  s: Suggestion;
  start: number;
  end: number;
  after: string;
  /** A diagram (item 5): a whole block after `end` (insert) or in place of `start..end` (replace). */
  block?: boolean;
}

/** Trim what a suggestion keeps on both sides, so a pure addition shows as an insertion only. */
export function minimal(before: string, after: string): { p: number; del: string; ins: string } {
  const w = (c: string | undefined) => !!c && /\w/.test(c);
  let p = 0;
  while (p < before.length && p < after.length && before[p] === after[p]) p++;
  // A change that starts inside a word shows the whole word: "flow" → "flows", not "s".
  while (p > 0 && w(before[p - 1]) && (w(before[p]) || w(after[p]))) p--;
  let q = 0;
  while (q < before.length - p && q < after.length - p && before[before.length - 1 - q] === after[after.length - 1 - q]) q++;
  while (q > 0 && w(before[before.length - q]) && (w(before[before.length - q - 1]) || w(after[after.length - q - 1]))) q--;
  return { p, del: before.slice(p, before.length - q), ins: after.slice(p, after.length - q) };
}

/** Pending suggestions placed in `md` (document order); ones whose text is gone are left out. */
export function place(md: string, list: Suggestion[]): Placed[] {
  const out: Placed[] = [];
  for (const s of list) {
    if (s.status !== "pending") continue;
    if (s.kind === "diagram") {
      const at = locate(md, s.before, s.at, false);
      if (at >= 0) out.push({ s, start: at, end: at + s.before.length, after: s.after, block: true });
      continue;
    }
    const at = locate(md, s.before, s.at, true);
    if (at < 0) continue;
    const m = minimal(s.before, s.after);
    out.push({ s, start: at + m.p, end: at + m.p + m.del.length, after: m.ins });
  }
  return out.sort((a, b) => a.start - b.start);
}

/** Where a thread's quote is now, or null (the "text changed" state, §3.6). */
export function anchorOf(md: string, t: CommentThread): { start: number; end: number } | null {
  const at = locate(md, t.quote, t.at);
  return at < 0 ? null : { start: at, end: at + t.quote.length };
}

export const sectionOf = (md: string, t: CommentThread) => sectionAt(md, anchorOf(md, t)?.start ?? t.at) || "the plan";
export { plainQuote };

export type Row =
  | { kind: "writing" }
  | { kind: "stopped" }
  | { kind: "failed" }
  | { kind: "none" }
  | { kind: "decision"; key: string }
  | { kind: "ready"; n: number }
  | { kind: "partial"; accepted: number; rejected: number; left: number }
  | { kind: "accepted"; n: number }
  | { kind: "done"; accepted: number; rejected: number };

/** The thread's status row (§3.2). All accepted offers Resolve; it never resolves by itself (#28). */
export function statusRow(t: CommentThread, list: Suggestion[]): Row | null {
  const r = t.run;
  if (r?.kind === "apply" && r.state === "running") return { kind: "writing" };
  if (r?.kind === "apply" && r.state === "stopped") return { kind: "stopped" };
  if (r?.kind === "apply" && r.state === "error") return { kind: "failed" };
  const mine = list.filter((s) => s.threadId === t.id);
  const left = mine.filter((s) => s.status === "pending").length;
  const accepted = mine.filter((s) => s.status === "accepted").length;
  const rejected = mine.filter((s) => s.status === "rejected").length;
  if (!mine.length) {
    if (r?.kind === "apply" && r.state === "done") return r.decision ? { kind: "decision", key: r.decision } : { kind: "none" };
    return null;
  }
  if (left && !accepted && !rejected) return { kind: "ready", n: left };
  if (left) return { kind: "partial", accepted, rejected, left };
  if (!rejected) return { kind: "accepted", n: accepted };
  return { kind: "done", accepted, rejected };
}

export function rowText(row: Row): string {
  switch (row.kind) {
    case "writing":
      return CCOPY.writing;
    case "stopped":
      return CCOPY.stoppedApply;
    case "failed":
      return CCOPY.couldntApply;
    case "none":
      return CCOPY.noChanges;
    case "decision":
      return CCOPY.viaDecision;
    case "ready":
      return CCOPY.ready(row.n);
    case "partial":
      return [row.accepted ? `${row.accepted} accepted` : "", row.rejected ? `${row.rejected} rejected` : "", CCOPY.toReview(row.left)].filter(Boolean).join(" · ");
    case "accepted":
      return `${row.n} accepted · in plan.md`;
    case "done":
      return `${row.accepted} accepted · ${row.rejected} rejected`;
  }
}

/** Apply feedback is offered under the newest agent message once nothing is running (§3.3). */
export function canApply(t: CommentThread): boolean {
  const last = t.messages[t.messages.length - 1];
  return !!last && last.by === "agent" && t.run?.state !== "running";
}
