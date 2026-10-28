// Comments on the plan and the agent's suggested edits (v1.1 Phase 2 §3–4, DECISIONS #13–16).
//
// Both live in the session, never in plan.md (#15): a comment is anchored by the text it was on
// (quote + position) and re-found after edits; a suggestion is `before → after` on one passage,
// and plan.md only changes when the user accepts it (#16). DOM-free: the browser uses `locate`
// and `fenceRanges` too.

export interface CommentMessage {
  id: string;
  /** "coder": the coding agent the user builds with, over `grillado mcp` (v1.2 item 1). */
  by: "you" | "agent" | "coder";
  /** For "coder": the MCP client's own name (e.g. "claude-code"), when it sent one. */
  client?: string;
  text: string;
  at: string;
  /** The agent's reply was stopped while it streamed: this is what it had written (#97). */
  stopped?: boolean;
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
  /** A reply's text so far while it streams, and what it had written when it failed (#97). */
  partial?: string;
}

export interface CommentThread {
  id: string;
  /** The plan source the comment is on. */
  quote: string;
  /** Where the quote was, as a hint when it appears more than once. */
  at: number;
  /**
   * The heading the quote was under when the comment was made ("" before the first heading). Re-finding
   * stays inside that section: it never jumps to another one or to the title (#114). Older threads
   * don't have it and use the section at `at`.
   */
  section?: string;
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
  /** A whole block from "Add diagrams" (item 5): a Mermaid fence added after `before`, or replacing it. */
  kind?: "diagram";
  /** The H2 section it is for. */
  section?: string;
  replace?: boolean;
  /** The activity-log run that wrote it (item 6), so its chip and its review link back. */
  run?: string;
  /** A text suggestion: the heading its text was under when it was written. It's only ever looked for there (#114). */
  under?: string;
  /** "Add to plan" (#104): the decision it writes into the text. Such a suggestion has no thread. */
  source?: { kind: "decision"; id: string };
}

export interface ReviewUndo {
  action: "accept" | "reject";
  items: Suggestion[];
  /** Threads that followed an accepted suggestion onto its text (#114), as they were before. */
  anchors?: { id: string; quote: string; at: number }[];
}

export interface CommentState {
  comments?: CommentThread[];
  suggestions?: Suggestion[];
  reviewUndo?: ReviewUndo;
  /** The latest "Add diagrams" run (item 5). */
  diagramRun?: import("./diagrams.ts").DiagramRun;
  /** The latest "Add to plan" run (#104). */
  addPlanRun?: import("./addplan.ts").AddPlanRun;
  /** Threads deleted here (#99): another process's copy of the session never brings them back. */
  deletedThreads?: string[];
  /** The last deleted thread, for its Undo (#99): where it was, and the pending suggestions that went with it. */
  threadUndo?: ThreadUndo;
}

export interface ThreadUndo {
  thread: CommentThread;
  index: number;
  suggestions: Suggestion[];
}

export const MAX_COMMENT = 2000;
export const MAX_QUOTE = 2000;
export const MAX_EDITS = 8;

const newId = () => globalThis.crypto.randomUUID().slice(0, 8);
export const newSuggestionId = newId;
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

/** The plan's sections: each heading (outside fences) to the next one, and the text before the first ("" title). */
export function sectionSpans(md: string): { title: string; start: number; end: number }[] {
  const fences = fenceRanges(md);
  const heads: { title: string; start: number }[] = [];
  for (const m of md.matchAll(/^#{1,6}\s+(.+)$/gm)) if (!fences.some(([a, b]) => m.index! >= a && m.index! < b)) heads.push({ title: m[1].trim(), start: m.index! });
  const out = [{ title: "", start: 0, end: heads[0]?.start ?? md.length }];
  heads.forEach((h, i) => out.push({ ...h, end: heads[i + 1]?.start ?? md.length }));
  return out;
}

/** The heading a position is under, as `section` stores it. */
export const headingAt = (md: string, at: number) => sectionSpans(md).findLast((x) => x.start <= at)?.title ?? "";

/**
 * The section a thread's quote is looked for in: the one with its heading nearest `at` (or around it).
 * If that heading is gone (renamed), the section at `at` stands in for it.
 */
function spanOf(md: string, at: number, section: string | undefined) {
  const spans = sectionSpans(md);
  const here = spans.findLast((x) => x.start <= at) ?? spans[0];
  if (section === undefined || here.title === section) return here;
  const dist = (x: { start: number; end: number }) => (at < x.start ? x.start - at : at >= x.end ? at - x.end + 1 : 0);
  return spans.filter((x) => x.title === section).sort((x, y) => dist(x) - dist(y))[0] ?? here;
}

/**
 * Where a thread's quote is now (#114): the occurrence nearest its stored position inside its own
 * section, or -1 (the "text changed" state). Never a match in another section or the title.
 */
export function refind(md: string, t: Pick<CommentThread, "quote" | "at" | "section">, prose = false): number {
  if (!t.quote) return -1;
  const sp = spanOf(md, t.at, t.section);
  const fences = prose ? fenceRanges(md) : [];
  let best = -1;
  // A match starts in the section (a quote may run on past its end, across a heading).
  for (let i = md.indexOf(t.quote, sp.start); i !== -1 && i < sp.end; i = md.indexOf(t.quote, i + 1)) {
    if (fences.some(([a, b]) => i < b && i + t.quote.length > a)) continue;
    if (best === -1 || Math.abs(i - t.at) < Math.abs(best - t.at)) best = i;
  }
  return best;
}

/**
 * Where a suggestion's text (`before`, or `after` once accepted) is now. A text suggestion keeps to
 * its section like a comment does: its passage gone, it no longer fits, rather than landing on the
 * same words in the title (#114). A diagram is a whole fence and is found anywhere.
 */
export function findSuggestion(md: string, x: Suggestion, text: string): number {
  return x.kind === "diagram" ? locate(md, text, x.at, false) : refind(md, { quote: text, at: x.at, section: x.under }, true);
}

/** The section a thread is "On": where its anchor is now, or the one it was made in once its text is gone. */
export function threadSection(md: string, t: Pick<CommentThread, "quote" | "at" | "section">): string {
  const at = refind(md, t);
  return at >= 0 || t.section === undefined ? sectionAt(md, at >= 0 ? at : t.at) : plainQuote(t.section);
}

/** After the plan changed: each thread's position follows its quote, so the hint stays near it. */
export function settleThreads(s: CommentState & { plan?: { markdown: string } }): void {
  const md = s.plan?.markdown;
  if (md === undefined) return;
  for (const t of s.comments ?? []) {
    const at = refind(md, t);
    if (at >= 0) t.at = at;
  }
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

/**
 * A thread's own suggestion (Apply feedback) that rewrites its quoted text and is accepted takes the
 * comment with it (#114): the anchor becomes the quote's untouched words plus the inserted text, in
 * the same section. `done` holds positions in `old`; `md` is the text after them all. Returns the
 * threads as they were, for Undo. A suggestion that only deletes the quote leaves it "text changed".
 */
function followAccepted(s: CommentState, old: string, md: string, done: Suggestion[]): ReviewUndo["anchors"] {
  const moved: NonNullable<ReviewUndo["anchors"]> = [];
  const shift = (pos: number) => done.filter((y) => y.at + y.before.length <= pos).reduce((n, y) => n + y.after.length - y.before.length, 0);
  for (const t of s.comments ?? []) {
    const qs = refind(old, t);
    if (qs < 0) continue;
    const qe = qs + t.quote.length;
    for (const x of done) {
      if (x.threadId !== t.id || x.kind === "diagram") continue;
      const m = minimal(x.before, x.after);
      const cs = x.at + m.p;
      const ce = cs + m.del.length;
      const hits = cs === ce ? cs > qs && cs < qe : cs < qe && ce > qs;
      if (!hits) continue;
      const start = Math.min(qs, cs);
      const from = start + shift(start);
      const quote = md.slice(from, from + Math.max(qe, ce) - start + m.ins.length - m.del.length);
      if (!quote.trim()) break;
      moved.push({ id: t.id, quote: t.quote, at: t.at });
      t.quote = quote;
      t.at = from;
      break;
    }
  }
  return moved.length ? moved : undefined;
}

function thread(s: CommentState, id: string): CommentThread {
  const t = s.comments?.find((c) => c.id === id);
  if (!t) throw new Error("That comment is gone.");
  return t;
}

export function addComment(s: CommentState & { plan?: { markdown: string } }, input: { quote: unknown; at: unknown; text: unknown }): CommentThread {
  if (!s.plan) throw new Error("There’s no plan yet.");
  const quote = typeof input.quote === "string" ? input.quote : "";
  const text = typeof input.text === "string" ? input.text.trim() : "";
  if (!quote.trim() || quote.length > MAX_QUOTE) throw new Error("Select some text in the plan first.");
  if (!text) throw new Error("Write a comment first.");
  const at = locate(s.plan.markdown, quote, Number(input.at) || 0);
  if (at < 0) throw new Error("The text you selected isn’t in the plan anymore.");
  const t: CommentThread = { id: newId(), quote, at, section: headingAt(s.plan.markdown, Math.max(0, at)), createdAt: now(), messages: [{ id: newId(), by: "you", text: text.slice(0, MAX_COMMENT), at: now() }] };
  s.comments = [...(s.comments ?? []), t];
  return t;
}

/** A comment from the coding agent over MCP: same anchoring rules as the user's. */
export function addCoderComment(s: CommentState & { plan?: { markdown: string } }, input: { quote: unknown; text: unknown; client?: string }): CommentThread {
  const t = addComment(s, { quote: input.quote, at: 0, text: input.text });
  t.messages[0].by = "coder";
  if (input.client) t.messages[0].client = input.client.slice(0, 80);
  return t;
}

/** Threads in `other` that `s` doesn't have yet (written by another process) are added to `s`. Returns how many. */
export function adoptThreads(s: CommentState, other: CommentState): number {
  const have = new Set([...(s.comments ?? []).map((t) => t.id), ...(s.deletedThreads ?? []), ...(other.deletedThreads ?? [])]);
  const extra = (other.comments ?? []).filter((t) => !have.has(t.id));
  if (extra.length) s.comments = [...(s.comments ?? []), ...extra];
  return extra.length;
}

export function addMessage(s: CommentState, threadId: string, by: CommentMessage["by"], text: string, extra: { stopped?: boolean } = {}): CommentThread {
  const t = thread(s, threadId);
  const body = text.trim();
  if (!body) throw new Error("Write a reply first.");
  t.messages.push({ id: newId(), by, text: body.slice(0, MAX_COMMENT), at: now(), ...(extra.stopped ? { stopped: true } : {}) });
  t.resolved = false;
  return t;
}

export function resolveThread(s: CommentState, threadId: string, resolved: boolean): void {
  thread(s, threadId).resolved = resolved;
}

/**
 * Delete a thread (#99): no confirm, so it can be undone. The thread, its replies and its pending
 * suggestions go; accepted and rejected records stay (they're history, and Undo of a review needs them).
 */
export function deleteThread(s: CommentState, threadId: string): void {
  const t = thread(s, threadId);
  const index = s.comments!.indexOf(t);
  const mine = (x: Suggestion) => x.threadId === t.id && x.status === "pending";
  s.threadUndo = { thread: t, index, suggestions: (s.suggestions ?? []).filter(mine) };
  s.comments = s.comments!.filter((x) => x !== t);
  s.suggestions = (s.suggestions ?? []).filter((x) => !mine(x));
  s.deletedThreads = [...(s.deletedThreads ?? []).filter((id) => id !== t.id), t.id];
}

/** Undo the last delete: the thread comes back where it was, with its replies and suggestions. */
export function restoreThread(s: CommentState, threadId: string): CommentThread {
  const u = s.threadUndo;
  if (!u || u.thread.id !== threadId) throw new Error("Nothing to undo.");
  const list = [...(s.comments ?? [])];
  list.splice(Math.min(u.index, list.length), 0, u.thread);
  s.comments = list;
  s.suggestions = [...(s.suggestions ?? []), ...u.suggestions];
  s.deletedThreads = (s.deletedThreads ?? []).filter((id) => id !== threadId);
  delete s.threadUndo;
  return u.thread;
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
    .map(({ e, at }) => ({ id: newId(), threadId, before: e.before, after: e.after, at, under: headingAt(md, at), status: "pending" as const, ...(baseHash ? { baseHash } : {}) }));
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
    const at = findSuggestion(md, x, x.before);
    if (at >= 0) {
      x.at = at;
      return true;
    }
    n++;
    const t = s.comments?.find((c) => c.id === x.threadId);
    if (t?.run) t.run.dropped = (t.run.dropped ?? 0) + 1;
    if (x.kind === "diagram" && s.diagramRun) s.diagramRun.skipped++;
    return false;
  });
  return n;
}

/** Apply suggestions to the text, last first so earlier positions hold. Ones whose text is gone are skipped. */
function applyAll(md: string, list: Suggestion[], dir: "forward" | "back"): { md: string; done: Suggestion[]; stale: Suggestion[] } {
  const found = list.map((x) => {
    const from = dir === "forward" ? x.before : x.after;
    return { x, from, to: dir === "forward" ? x.after : x.before, i: findSuggestion(md, x, from) };
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
  if (!s.plan) throw new Error("There’s no plan yet.");
  const want = new Set(Array.isArray(ids) ? ids.map(String) : []);
  const pick = (s.suggestions ?? []).filter((x) => want.has(x.id) && x.status === "pending");
  if (!pick.length) throw new Error("Those suggestions were already reviewed.");
  if (action === "reject") {
    for (const x of pick) x.status = "rejected";
    s.reviewUndo = { action, items: pick.map((x) => ({ ...x })) };
    return { done: pick.length, stale: 0 };
  }
  const old = s.plan.markdown;
  const r = applyAll(old, pick, "forward");
  s.plan.markdown = r.md;
  const anchors = followAccepted(s, old, r.md, r.done);
  const done = new Map(r.done.map((x) => [x.id, x]));
  const stale = new Set(r.stale.map((x) => x.id));
  // A suggestion whose text changed under it can't land any more: it's dropped, not forced in.
  s.suggestions = (s.suggestions ?? []).filter((x) => !stale.has(x.id)).map((x) => (done.has(x.id) ? { ...done.get(x.id)!, status: "accepted" as const } : x));
  s.reviewUndo = r.done.length ? { action, items: r.done.map((x) => ({ ...x, status: "accepted" as const })), ...(anchors ? { anchors } : {}) } : undefined;
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
    // A comment that followed the accepted text goes back onto the text it was on.
    for (const a of u.anchors ?? []) {
      const t = s.comments?.find((c) => c.id === a.id);
      if (t) Object.assign(t, { quote: a.quote, at: a.at });
    }
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
