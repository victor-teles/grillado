// Item 3, DOM-free: where threads and suggestions sit in the current text, and what each
// thread's status row says. Unit-tested in test/comments-ui.test.ts.
import { findSuggestion, minimal, plainQuote, refind, threadSection } from "../../../../src/core/comments.ts";
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
  /** The thread ⋯ menu (v1.2 polish §2, DECISIONS #98–101). */
  more: (anchor: string) => `More actions for comment on “${anchor}”`,
  sheetTitle: (anchor: string) => `Comment on “${anchor}”`,
  copyLink: "Copy link to comment",
  del: "Delete",
  deleted: "Comment deleted",
  restored: "Comment restored",
  copied: "Link to comment copied",
  noClipboard: (url: string) => `Couldn’t reach the clipboard. The link is ${url}`,
  resolvedToast: "Comment resolved",
  gone: "That comment was deleted",
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

export { minimal };

/** Pending suggestions placed in `md` (document order); ones whose text is gone are left out. */
export function place(md: string, list: Suggestion[]): Placed[] {
  const out: Placed[] = [];
  for (const s of list) {
    if (s.status !== "pending") continue;
    if (s.kind === "diagram") {
      const at = findSuggestion(md, s, s.before);
      if (at >= 0) out.push({ s, start: at, end: at + s.before.length, after: s.after, block: true });
      continue;
    }
    const at = findSuggestion(md, s, s.before);
    if (at < 0) continue;
    const m = minimal(s.before, s.after);
    out.push({ s, start: at + m.p, end: at + m.p + m.del.length, after: m.ins });
  }
  return out.sort((a, b) => a.start - b.start);
}

/** Where a thread's quote is now, in its own section, or null (the "text changed" state, §3.6, #114). */
export function anchorOf(md: string, t: CommentThread): { start: number; end: number } | null {
  const at = refind(md, t);
  return at < 0 ? null : { start: at, end: at + t.quote.length };
}

/**
 * While a single accept is held (#102) the text isn't written yet, so nothing re-finds: an anchor
 * on its own thread's suggestion just takes in the insertion once the deletion has left (phase "ok"),
 * which is where the write puts it. Nothing moves when the write lands.
 */
export function heldAnchor(r: { start: number; end: number } | null, t: CommentThread, placed: Placed[], phases: Record<string, string>): { start: number; end: number } | null {
  if (!r) return r;
  const p = placed.find((x) => x.s.threadId === t.id && phases[x.s.id] === "ok" && !x.block && (x.start === x.end ? x.start > r.start && x.start < r.end : x.start < r.end && x.end > r.start));
  return p ? { start: Math.min(r.start, p.start), end: Math.max(r.end, p.end) } : r;
}

/** "On {section}": where the anchor is now, or the section it was made in once its text is gone. */
export const sectionOf = (md: string, t: CommentThread) => threadSection(md, t) || "the plan";
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
