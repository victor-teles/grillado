// Comments on the plan and the agent's suggested edits (v1.1 Phase 2 §3–4, DECISIONS #13–16).
//
// Both live in the session, never in plan.md (#15): a comment is anchored by the text it was on
// (quote + position) and re-found after edits; a suggestion is `before → after` on one passage,
// and plan.md only changes when the user accepts it (#16). DOM-free: the browser uses `locate`
// and `fenceRanges` too.

export interface CommentMessage {
  id: string;
  by: "you" | "agent";
  text: string;
  at: string;
}

export interface CommentRun {
  kind: "reply" | "apply";
  state: "running" | "done" | "error" | "stopped";
  startedAt: string;
  ms?: number;
  /** Suggestions the apply run produced. */
  edits?: number;
  /** Suggestions dropped because their text changed while the run was going. */
  dropped?: number;
  /** The thread is on a decision block: answers change through the decision, not suggestions (#22). */
  decision?: string;
  message?: string;
}

export interface CommentThread {
  id: string;
  /** The plan source the comment is on. */
  quote: string;
  /** Where the quote was, as a hint when it appears more than once. */
  at: number;
  createdAt: string;
  resolved?: boolean;
  messages: CommentMessage[];
  run?: CommentRun;
}

export type SuggestionStatus = "pending" | "accepted" | "rejected";

export interface Suggestion {
  id: string;
  threadId: string;
  before: string;
  after: string;
  at: number;
  /** Records stay after review, for Undo and the thread's status row ("✓ 2 accepted"). */
  status: SuggestionStatus;
  /** Hash of the plan text the run read when Apply was pressed. */
  baseHash?: string;
}

export interface ReviewUndo {
  action: "accept" | "reject";
  items: Suggestion[];
}

export interface CommentState {
  comments?: CommentThread[];
  suggestions?: Suggestion[];
  reviewUndo?: ReviewUndo;
}

export const MAX_COMMENT = 2000;
export const MAX_QUOTE = 2000;
export const MAX_EDITS = 8;

const newId = () => globalThis.crypto.randomUUID().slice(0, 8);
const now = () => new Date().toISOString();

/** `[start, end)` of every ``` fence (code, mermaid, decision). The agent never edits inside one. */
export function fenceRanges(md: string): [number, number][] {
  const out: [number, number][] = [];
  let offset = 0;
  let open = -1;
  for (const line of md.split("\n")) {
    const end = offset + line.length;
    if (line.startsWith("```")) {
      if (open < 0) open = offset;
      else {
        out.push([open, end]);
        open = -1;
      }
    }
    offset = end + 1;
  }
  if (open >= 0) out.push([open, md.length]);
  return out;
}

/**
 * Where `text` is in `md` now: the occurrence nearest `hint`, or -1. With `prose`, occurrences
 * inside fences don't count.
 */
export function locate(md: string, text: string, hint: number, prose = false): number {
  if (!text) return -1;
  const fences = prose ? fenceRanges(md) : [];
  let best = -1;
  for (let i = md.indexOf(text); i !== -1; i = md.indexOf(text, i + 1)) {
    if (fences.some(([a, b]) => i < b && i + text.length > a)) continue;
    if (best === -1 || Math.abs(i - hint) < Math.abs(best - hint)) best = i;
  }
  return best;
}

function thread(s: CommentState, id: string): CommentThread {
  const t = s.comments?.find((c) => c.id === id);
  if (!t) throw new Error("That comment is gone.");
  return t;
}

export function addComment(s: CommentState & { plan?: { markdown: string } }, input: { quote: unknown; at: unknown; text: unknown }): CommentThread {
  if (!s.plan) throw new Error("There's no plan yet.");
  const quote = typeof input.quote === "string" ? input.quote : "";
  const text = typeof input.text === "string" ? input.text.trim() : "";
  if (!quote.trim() || quote.length > MAX_QUOTE) throw new Error("Select some text in the plan first.");
  if (!text) throw new Error("Write a comment first.");
  const at = locate(s.plan.markdown, quote, Number(input.at) || 0);
  if (at < 0) throw new Error("The text you selected isn't in the plan anymore.");
  const t: CommentThread = { id: newId(), quote, at, createdAt: now(), messages: [{ id: newId(), by: "you", text: text.slice(0, MAX_COMMENT), at: now() }] };
  s.comments = [...(s.comments ?? []), t];
  return t;
}

export function addMessage(s: CommentState, threadId: string, by: CommentMessage["by"], text: string): CommentThread {
  const t = thread(s, threadId);
  const body = text.trim();
  if (!body) throw new Error("Write a reply first.");
  t.messages.push({ id: newId(), by, text: body.slice(0, MAX_COMMENT), at: now() });
  t.resolved = false;
  return t;
}

export function resolveThread(s: CommentState, threadId: string, resolved: boolean): void {
  thread(s, threadId).resolved = resolved;
}

export function startRun(s: CommentState, threadId: string, kind: CommentRun["kind"]): CommentThread {
  const t = thread(s, threadId);
  t.run = { kind, state: "running", startedAt: now() };
  return t;
}

export function finishRun(
  t: CommentThread,
  outcome: { ok: true; edits?: number; dropped?: number; decision?: string } | { ok: false; message: string; stopped?: boolean },
): void {
  if (!t.run) return;
  const ms = Date.now() - Date.parse(t.run.startedAt);
  if (outcome.ok) {
    const { ok: _ok, ...rest } = outcome;
    t.run = { ...t.run, state: "done", ms, ...rest };
  } else t.run = { ...t.run, state: outcome.stopped ? "stopped" : "error", ms, message: outcome.message };
}

/** Pending suggestions, in document order. */
export const pending = (s: CommentState) => (s.suggestions ?? []).filter((x) => x.status === "pending").sort((a, b) => a.at - b.at);

/** The decision block a position sits in, or null. */
export function decisionAt(md: string, at: number): string | null {
  for (const m of md.matchAll(/^```decision\n([\s\S]*?)^```/gm)) {
    if (at >= m.index! && at < m.index! + m[0].length) return /^key:\s*(.+)$/m.exec(m[1])?.[1].trim() ?? "";
  }
  return null;
}

export interface EditProposal {
  before: string;
  after: string;
}

const LINE_MARK = /^(\s*(?:[-*]|\d+\.)\s+|#{1,4}\s+)/;

/** Drop a list or heading marker the agent copied along with the line, so the edit stays inline. */
export function normalizeEdit(e: EditProposal): EditProposal {
  const m = LINE_MARK.exec(e.before);
  if (m && e.after.startsWith(m[1])) return { before: e.before.slice(m[1].length), after: e.after.slice(m[1].length) };
  return e;
}

/** Why a set of proposed edits can't be shown as suggestions, or null. */
export function checkEdits(md: string, edits: EditProposal[]): string | null {
  if (edits.length > MAX_EDITS) return `suggest at most ${MAX_EDITS} edits`;
  const taken: [number, number][] = [];
  for (const raw of edits) {
    const e = normalizeEdit(raw);
    if (!e.before) return "every edit needs the exact text it replaces in `before`";
    if (e.before === e.after) return "an edit must change its text";
    if (/\n/.test(e.before) || /\n/.test(e.after)) return "keep each edit inside one paragraph, list item or heading (no line breaks)";
    if (e.before.length > MAX_QUOTE || e.after.length > MAX_QUOTE) return "keep each edit under 2000 characters";
    const at = locate(md, e.before, 0, true);
    if (at < 0) return `\`before\` must be copied exactly from the plan, outside code and decision blocks: "${e.before.slice(0, 60)}"`;
    if (taken.some(([a, b]) => at < b && at + e.before.length > a)) return "edits must not overlap";
    taken.push([at, at + e.before.length]);
  }
  return null;
}

/**
 * Suggestions from one Apply run, written against the text as it was when Apply was pressed
 * (`baseHash`). They land together, placed in the current text; one whose text changed while the
 * run was going is dropped.
 */
export function addSuggestions(
  s: CommentState & { plan?: { markdown: string } },
  threadId: string,
  edits: EditProposal[],
  hint: number,
  baseHash?: string,
): { added: Suggestion[]; dropped: number } {
  const md = s.plan?.markdown ?? "";
  const placed = edits.map(normalizeEdit).map((e) => ({ e, at: locate(md, e.before, hint, true) }));
  const added: Suggestion[] = placed
    .filter((p) => p.at >= 0)
    .map(({ e, at }) => ({ id: newId(), threadId, before: e.before, after: e.after, at, status: "pending" as const, ...(baseHash ? { baseHash } : {}) }));
  s.suggestions = [...(s.suggestions ?? []), ...added];
  return { added, dropped: placed.length - added.length };
}

/**
 * After a hand edit (§4.7): a pending suggestion whose removal text is gone no longer fits and is
 * dropped; its thread counts it ("1 suggestion no longer fits the text · Ask again").
 */
export function pruneSuggestions(s: CommentState & { plan?: { markdown: string } }): number {
  const md = s.plan?.markdown ?? "";
  let n = 0;
  s.suggestions = (s.suggestions ?? []).filter((x) => {
    if (x.status !== "pending") return true;
    const at = locate(md, x.before, x.at, true);
    if (at >= 0) {
      x.at = at;
      return true;
    }
    n++;
    const t = s.comments?.find((c) => c.id === x.threadId);
    if (t?.run) t.run.dropped = (t.run.dropped ?? 0) + 1;
    return false;
  });
  return n;
}

/** Apply suggestions to the text, last first so earlier positions hold. Ones whose text is gone are skipped. */
function applyAll(md: string, list: Suggestion[], dir: "forward" | "back"): { md: string; done: Suggestion[]; stale: Suggestion[] } {
  const found = list.map((x) => {
    const from = dir === "forward" ? x.before : x.after;
    return { x, from, to: dir === "forward" ? x.after : x.before, i: locate(md, from, x.at, true) };
  });
  const stale = found.filter((f) => f.i < 0).map((f) => f.x);
  let out = md;
  for (const f of found.filter((f) => f.i >= 0).sort((a, b) => b.i - a.i)) out = out.slice(0, f.i) + f.to + out.slice(f.i + f.from.length);
  return { md: out, done: found.filter((f) => f.i >= 0).map((f) => ({ ...f.x, at: f.i })), stale };
}

/**
 * Accept or reject pending suggestions. Accepting writes the new text into `plan.markdown`; the
 * caller saves it to plan.md. Suggestions whose text changed under them are dropped.
 */
export function review(s: CommentState & { plan?: { markdown: string } }, action: "accept" | "reject", ids: unknown): { done: number; stale: number } {
  if (!s.plan) throw new Error("There's no plan yet.");
  const want = new Set(Array.isArray(ids) ? ids.map(String) : []);
  const pick = (s.suggestions ?? []).filter((x) => want.has(x.id) && x.status === "pending");
  if (!pick.length) throw new Error("Those suggestions were already reviewed.");
  if (action === "reject") {
    for (const x of pick) x.status = "rejected";
    s.reviewUndo = { action, items: pick.map((x) => ({ ...x })) };
    return { done: pick.length, stale: 0 };
  }
  const r = applyAll(s.plan.markdown, pick, "forward");
  s.plan.markdown = r.md;
  const done = new Map(r.done.map((x) => [x.id, x]));
  const stale = new Set(r.stale.map((x) => x.id));
  // A suggestion whose text changed under it can't land any more: it's dropped, not forced in.
  s.suggestions = (s.suggestions ?? []).filter((x) => !stale.has(x.id)).map((x) => (done.has(x.id) ? { ...done.get(x.id)!, status: "accepted" as const } : x));
  s.reviewUndo = r.done.length ? { action, items: r.done.map((x) => ({ ...x, status: "accepted" as const })) } : undefined;
  return { done: r.done.length, stale: r.stale.length };
}

/** ⌘Z after an accept or reject: the suggestions come back as they were. */
export function undoReview(s: CommentState & { plan?: { markdown: string } }): { ids: string[] } | null {
  const u = s.reviewUndo;
  if (!u || !s.plan) return null;
  s.reviewUndo = undefined;
  let items = u.items;
  if (u.action === "accept") {
    const r = applyAll(s.plan.markdown, u.items, "back");
    s.plan.markdown = r.md;
    items = r.done;
  }
  const back = new Map(items.map((x) => [x.id, x]));
  s.suggestions = (s.suggestions ?? []).map((x) => (back.has(x.id) ? { ...back.get(x.id)!, status: "pending" as const } : x));
  return items.length ? { ids: items.map((x) => x.id) } : null;
}

/** Plain words of a quote, for the thread's quote bar and prompts: no Markdown marks or citations. */
export function plainQuote(md: string): string {
  return md
    .replace(/\[(R\d+:[^\]]*)\]/g, "")
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
    .replace(/[*_~`]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

/** The heading a position sits under ("Sync"), for "On “Sync”". */
export function sectionAt(md: string, at: number): string {
  let found = "";
  for (const m of md.slice(0, at).matchAll(/^#{1,4}\s+(.+)$/gm)) found = m[1].trim();
  return plainQuote(found);
}
