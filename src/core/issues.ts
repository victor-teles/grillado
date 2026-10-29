// "Send to issues" (v1.3 item 2): a plated plan becomes a parent issue plus one issue per slice of
// work. DOM-free and network-free: this file builds the items, their bodies and what a re-export
// would do; the trackers (src/cli/issues) do the talking, only after the user confirms.

import { planSections } from "./diagrams.ts";
import { blockKey, findDecisionBlocks, noteAdds, overrides } from "./decision-block.ts";
import { textHash } from "./text-hash.ts";
import type { Session } from "./session.ts";

export type Tracker = "github" | "linear";

/** Where the item list came from (the preview's one-line note). */
export type SplitSource = "agent" | "todos" | "stories" | "none";

/** One issue to send. The parent's key is always PARENT_KEY. */
export interface IssueItem {
  key: string;
  title: string;
  /** Markdown as it will be sent, marker included and cut to the tracker's limit. */
  body: string;
  /** Decision keys it covers. */
  covers: string[];
  /** Plan sections it draws on. */
  sections: string[];
  /** The body was cut to fit the tracker. */
  cut?: boolean;
  /** This item's body as earlier builds sent it, when that differs: a child's Covers line led with R·n codes before #28
   *  (review-pr28 must 3), and a parent had no notes before the plan became the source (dogfood friction 18). An issue
   *  sent then still matches, so it isn't "changed" just because the format moved. A body, not a hash: the title can
   *  still be renamed after the item is built. */
  legacyBody?: string;
}

/** A slice proposed by {agent}, before it becomes an item. */
export interface Slice {
  key: string;
  title: string;
  body: string;
  covers: string[];
  sections: string[];
}

/** One linked issue. GitHub: `id` is the database id (what the sub-issues API takes). Linear: the issue id. */
export interface IssueLink {
  id: string;
  number?: number;
  identifier?: string;
  url: string;
  /** Hash of the title and body Grillado last sent, to tell "the plan changed" from "edited in the tracker". */
  contentHash: string;
  /** Created, but attaching it to the parent failed: Retry failed attaches it. */
  unattached?: boolean;
}

/** `session.issues` (spec item 2 "plan.issues"): the plan's links, in session.json. */
export interface PlanIssues {
  tracker: Tracker;
  /** GitHub "owner/repo"; Linear the team id. */
  target: string;
  /** GitHub Enterprise host, when not github.com. */
  host?: string;
  /** Linear team name, for "Team Core". */
  targetName?: string;
  projectId?: string;
  /** Label names (GitHub) or ids (Linear) used on the last run. */
  labels: string[];
  parent?: IssueLink;
  items: Record<string, IssueLink>;
  /** Items whose last attempt failed, with the tracker's reason: Retry failed sends only these. */
  failed?: Record<string, string>;
  exportedAt: string;
}

export const PARENT_KEY = "plan";
/** Bodies over this are cut, ending with a link back to the plan. GitHub's limit; Linear has none documented, so the same. */
export const BODY_LIMIT: Record<Tracker, number> = { github: 65_536, linear: 65_536 };
/** A GitHub parent holds at most 100 sub-issues. */
export const MAX_CHILDREN: Record<Tracker, number> = { github: 100, linear: 250 };
export const MAX_TITLE = 256;

export const TRACKER_NAME: Record<Tracker, string> = { github: "GitHub", linear: "Linear" };

export const marker = (planId: string, key: string) => `<!-- grillado:plan=${planId} item=${key} -->`;
export const markerSearch = (planId: string) => `grillado:plan=${planId}`;
const MARKER_RE = /<!-- grillado:plan=([\w-]+) item=([\w-]+) -->/;

/** The plan id and item key in a body Grillado wrote, or null. */
export function readMarker(body: string): { plan: string; key: string } | null {
  const m = MARKER_RE.exec(body ?? "");
  return m ? { plan: m[1], key: m[2] } : null;
}

/** What a tracker hands back is compared after the same normalising, so line endings never read as an edit. */
export const contentHash = (title: string, body: string) => textHash(`${title.trim()}\n${body.replace(/\r\n/g, "\n").trim()}`);

export const slugKey = (text: string) =>
  text
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[^\w\s-]/g, "")
    .trim()
    .split(/[\s_-]+/)
    .filter(Boolean)
    .slice(0, 6)
    .join("-")
    .slice(0, 48) || "item";

const CITE = /\s?\[R\d+:[^\]\s,]+(?:\s*,\s*R\d+:[^\]\s,]+)*\]/g;

/** Plan text for a tracker: citations and ```decision blocks are Grillado's own; the decisions get their own list. */
export function cleanText(md: string): string {
  return md
    .replace(/^```decision\n[\s\S]*?^```\s*$/gm, "")
    .replace(CITE, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/** A section's text without its heading, by any of the given names (case-insensitive, prefix match). */
export function sectionText(md: string, ...names: string[]): string | null {
  const want = names.map((n) => n.toLowerCase());
  const sec = planSections(md).find((x) => want.some((n) => x.title.trim().toLowerCase().startsWith(n)));
  if (!sec) return null;
  const body = md.slice(sec.start, sec.end).replace(/^## .*\n?/, "");
  const t = cleanText(body);
  return t || null;
}

/** Top-level list items of a section: `- a`, `* a`, `1. a`, `- [ ] a`, continuation lines joined. */
export function bullets(text: string | null): string[] {
  if (!text) return [];
  const out: string[] = [];
  for (const line of text.split("\n")) {
    const m = /^(?:[-*+]|\d+[.)])\s+(?:\[[ xX]\]\s+)?(.*)$/.exec(line);
    if (m) out.push(m[1].trim());
    else if (out.length && /^\s{2,}\S/.test(line)) out[out.length - 1] += ` ${line.trim()}`;
  }
  return out.filter(Boolean);
}

/** The plan's own title. */
export const planTitle = (s: Session) => (s.plan?.title || s.idea.split("\n")[0]).trim().slice(0, MAX_TITLE);

/** Settled decisions, in round order. */
export const resolved = (s: Session) => Object.values(s.decisions).sort((a, b) => a.round - b.round);

/** A settled decision as the plan states it. */
export interface PlanDecision {
  key: string;
  round: number;
  title: string;
  answer: string;
  /** The block's `note:`, when it says more than the answer (noteAdds). Never an override: that is the answer. */
  note?: string;
}

/**
 * The one source for what an export says about its decisions (dogfood friction 18): the plan is what gets edited after
 * it's written, so the answer and note come from its ```decision block. The session's answer only stands in when the
 * plan has no block for that decision (or the block can't be read, or has no answer). Which decisions, their order and
 * their titles stay the session's, so a plan nobody edited exports exactly what it did before.
 * A note that begins "Overridden" is the decision (the plan's own rule, DOGFOOD-1 r2; review-pr29 must 1): it becomes
 * the answer, with no note line, so the parent, every Covers line and the split prompt say the override, never the
 * recorded answer it replaced.
 */
export function planDecisions(s: Session, md: string): PlanDecision[] {
  const blocks = new Map<string, { answer?: string; note?: string }>();
  for (const b of findDecisionBlocks(md)) {
    if (!b.parsed.ok || b.parsed.fields.status === "open") continue;
    const k = blockKey(b.parsed);
    if (k && !blocks.has(k)) blocks.set(k, b.parsed.fields);
  }
  return resolved(s).map((d) => {
    const f = blocks.get(d.key);
    if (f && overrides(f.note)) return { key: d.key, round: d.round, title: d.title.trim(), answer: f.note!.trim() };
    const answer = f?.answer?.trim() || d.answer.trim();
    const note = noteAdds(f?.note, answer) ? f!.note!.trim() : undefined;
    return { key: d.key, round: d.round, title: d.title.trim(), answer, ...(note ? { note } : {}) };
  });
}

// ---------------------------------------------------------------- BIG-1: what goes into the issue bodies
// Victor's answer is option A, the spec's wording (frames d-q-body-a, d-gh-body, d-gh-parentbody). The bodies are
// written only here: option B (A plus the full plan in a closed <details>) or C (minimal) is a swap of these three.

/** The end of every body: where it came from, and the hidden marker that finds it again. */
const footer = (s: Session, key: string) => `\n\nFrom Grillado plan ‘${planTitle(s)}’\n${marker(s.id, key)}\n`;

/**
 * The parent: Problem, Solution, the decisions (question, then answer, then the plan's note on the next line), Out of
 * scope. `notes: false`: the same without the notes, as every parent before the notes was sent, only to recognise those.
 */
function parentText(s: Session, md: string, notes = true): { text: string; sections: string[] } {
  const parts: string[] = [];
  const sections: string[] = [];
  const section = (name: string) => {
    const t = sectionText(md, name);
    if (!t) return;
    parts.push(`## ${name}\n${t}`);
    sections.push(name);
  };
  section("Problem");
  section("Solution");
  const ds = planDecisions(s, md).map((d) => `- **${d.title}** ${d.answer}${notes && d.note ? `\n  _Note:_ ${d.note}` : ""}`);
  if (ds.length) parts.push(`## Decisions\n${ds.join("\n")}`);
  section("Out of scope");
  return { text: parts.join("\n\n") || cleanText(md.replace(/^# .*\n/, "")), sections };
}

/** "R2·2": a decision's id as the plan page showed it before #28 (round, then its place in the round). */
function decisionId(s: Session, key: string): string {
  const r = s.rounds.find((x) => x.questions.some((q) => q.key === key));
  return r ? `R${r.n}·${r.questions.findIndex((q) => q.key === key) + 1}` : "";
}

/** A child: its slice's first paragraph, "**Covers:** question answer" (no internal R·n code), then the rest of the slice.
 *  `legacy`: the same with the R·n codes, as sent before #28, only to recognise those issues. */
function childText(s: Session, ds: Map<string, PlanDecision>, x: Slice, covers: string[], legacy = false): string {
  const [head, ...rest] = (cleanText(x.body) || x.title).split(/\n{2,}/);
  const line = covers.map((k) => `${legacy ? `${decisionId(s, k)} ` : ""}${ds.get(k)!.title} ${ds.get(k)!.answer}`.trim()).join(" · ");
  return [head, line ? `**Covers:** ${line}` : "", ...rest].filter(Boolean).join("\n\n");
}
// ---------------------------------------------------------------- end of BIG-1

/**
 * Fit a body to the tracker: over the limit, the text is cut at a line and ends with a pointer back to
 * the plan (the parent issue for children, the Grillado plan id for the parent). The footer always survives.
 */
export function fitBody(text: string, end: string, limit: number, back: string, where: string): { body: string; cut: boolean } {
  const whole = `${text}${end}`;
  if (whole.length <= limit) return { body: whole, cut: false };
  const note = `\n\n…\n\n_Cut to fit ${where}. The rest is in ${back}._`;
  let room = Math.max(0, limit - end.length - note.length);
  let head = text.slice(0, room);
  const nl = head.lastIndexOf("\n");
  if (nl > room * 0.8) head = head.slice(0, nl);
  // Never leave a lone high surrogate at the cut.
  if (/[\uD800-\uDBFF]$/.test(head)) head = head.slice(0, -1);
  return { body: `${head.trimEnd()}${note}${end}`, cut: true };
}

/** The parent issue: the plan's title, its body (BIG-1, parentText) and where it came from. */
export function parentItem(s: Session, md: string, tracker: Tracker): IssueItem {
  const fit = (text: string) => fitBody(text, footer(s, PARENT_KEY), BODY_LIMIT[tracker], `the Grillado plan “${planTitle(s)}” (${s.id})`, TRACKER_NAME[tracker]);
  const { text, sections } = parentText(s, md);
  const { body, cut } = fit(text);
  const title = planTitle(s);
  // Parents sent before the notes reached the body read unchanged until something else changes (dogfood friction 18).
  const old = fit(parentText(s, md, false).text).body;
  return { key: PARENT_KEY, title, body, covers: resolved(s).map((d) => d.key), sections, ...(cut ? { cut } : {}), ...(old !== body ? { legacyBody: old } : {}) };
}

/**
 * A child: its own text with the decisions it covers (BIG-1, childText). A cut points at the parent issue by name, not by
 * link, so the body (and its hash) doesn't change when the parent is recreated; the tracker links them.
 */
export function childItem(s: Session, x: Slice, tracker: Tracker, ds: Map<string, PlanDecision>): IssueItem {
  const known = new Set(Object.keys(s.decisions));
  const covers = [...new Set(x.covers.filter((k) => known.has(k)))];
  const fit = (text: string) => fitBody(text, footer(s, x.key), BODY_LIMIT[tracker], `the parent issue “${planTitle(s)}”`, TRACKER_NAME[tracker]);
  const { body, cut } = fit(childText(s, ds, x, covers));
  const title = x.title.replace(/\s+/g, " ").trim().slice(0, MAX_TITLE);
  const old = fit(childText(s, ds, x, covers, true)).body;
  return { key: x.key, title, body, covers, sections: x.sections, ...(cut ? { cut } : {}), ...(old !== body ? { legacyBody: old } : {}) };
}

/** Distinct keys: a repeated slug gets -2, -3; never the parent's. */
function uniqueKeys<T extends { key: string }>(xs: T[]): T[] {
  const seen = new Set([PARENT_KEY]);
  return xs.map((x) => {
    let k = slugKey(x.key);
    for (let n = 2; seen.has(k); n++) k = `${slugKey(x.key)}-${n}`;
    seen.add(k);
    return { ...x, key: k };
  });
}

/**
 * The slices without {agent}: an imported plan's to-dos 1:1 (its `## Tasks` checklist), else one per
 * user story, else none (the parent alone).
 */
export function fallbackSlices(s: Session, md: string): { source: SplitSource; slices: Slice[] } {
  const tasks = s.source ? bullets(sectionText(md, "Tasks", "To-dos", "Todos")) : [];
  if (tasks.length) return { source: "todos", slices: uniqueKeys(tasks.map((t) => ({ key: t, title: firstSentence(t), body: t, covers: [], sections: ["Tasks"] }))) };
  const stories = bullets(sectionText(md, "User stories"));
  if (stories.length) return { source: "stories", slices: uniqueKeys(stories.map((t) => ({ key: t, title: firstSentence(t), body: t, covers: coversIn(s, md, t), sections: ["User stories"] }))) };
  return { source: "none", slices: [] };
}

/**
 * Review r5 (PO): a plan with to-dos and no decisions has nothing to slice by, so {agent} groups its to-dos
 * instead (a separate prompt), and the sheet says so.
 */
export function groupsTodos(s: Session, fb: { source: SplitSource }): boolean {
  return fb.source === "todos" && Object.keys(s.decisions).length === 0;
}

/** The to-dos as {agent} sees them: short ids, so a reply can't mistype one. */
export const todoIds = (todos: Slice[]) => todos.map((t, i) => ({ id: `t${i + 1}`, text: t.body }));

export type Group = { key: string; title: string; body: string; todos: string[] };

/**
 * {agent}'s groups checked against the to-dos: each to-do in exactly one group, none missing, repeated or
 * invented, and every group titled and non-empty. No groups at all is valid: the to-dos stay as they are.
 */
export function groupedSlices(todos: Slice[], groups: Group[]): { ok: true; slices: Slice[] } | { ok: false; reason: string } {
  const ids = todoIds(todos);
  const byId = new Map(ids.map((t, i) => [t.id, i]));
  const seen = new Map<string, number>();
  for (const g of groups) for (const id of g.todos) seen.set(id, (seen.get(id) ?? 0) + 1);
  const invented = [...seen.keys()].filter((id) => !byId.has(id));
  if (invented.length) return { ok: false, reason: `Unknown to-do ids: ${invented.join(", ")}. Use only the ids given.` };
  if (!groups.length) return { ok: true, slices: [] };
  const twice = [...seen].filter(([, n]) => n > 1).map(([id]) => id);
  if (twice.length) return { ok: false, reason: `To-dos in more than one slice: ${twice.join(", ")}. Put each to-do in exactly one slice.` };
  const missing = ids.filter((t) => !seen.has(t.id)).map((t) => t.id);
  if (missing.length) return { ok: false, reason: `To-dos in no slice: ${missing.join(", ")}. Put each to-do in exactly one slice.` };
  if (groups.some((g) => !g.title.trim() || !g.todos.length)) return { ok: false, reason: "Every slice needs a title and at least one to-do." };
  return {
    ok: true,
    slices: uniqueKeys(
      groups.map((g) => ({
        key: g.key || g.title,
        title: g.title.trim(),
        body: [g.body.trim(), ...g.todos.map((id) => `- [ ] ${todos[byId.get(id)!].body}`)].filter(Boolean).join("\n"),
        covers: [],
        sections: ["Tasks"],
      })),
    ),
  };
}

/** Clean {agent}'s slices: keys made unique, unknown decisions dropped, empty ones skipped. */
export function agentSlices(s: Session, slices: Slice[]): Slice[] {
  const known = new Set(Object.keys(s.decisions));
  return uniqueKeys(
    slices
      .filter((x) => x.title.trim())
      .map((x) => ({ ...x, key: x.key || x.title, covers: x.covers.filter((k) => known.has(k)) })),
  );
}

/** Decisions cited on a story's line in the plan (before citations are cleaned away). */
function coversIn(s: Session, md: string, story: string): string[] {
  const line = md.split("\n").find((l) => cleanText(l).includes(story.slice(0, 60)));
  if (!line) return [];
  const keys = [...line.matchAll(/R\d+:([^\]\s,]+)/g)].map((m) => m[1]);
  return [...new Set(keys)].filter((k) => k in s.decisions);
}

function firstSentence(t: string): string {
  const one = t.replace(/\*\*/g, "").split(/(?<=[.!?])\s/)[0];
  return (one.length > 120 ? `${one.slice(0, 117).trimEnd()}…` : one).replace(/[.]$/, "");
}

/** All items to send: the parent first, then up to the tracker's cap of children. */
export function buildItems(s: Session, md: string, tracker: Tracker, slices: Slice[]): { items: IssueItem[]; dropped: number } {
  const cap = MAX_CHILDREN[tracker];
  const ds = new Map(planDecisions(s, md).map((d) => [d.key, d]));
  const kids = slices.slice(0, cap).map((x) => childItem(s, x, tracker, ds));
  return { items: [parentItem(s, md, tracker), ...kids], dropped: Math.max(0, slices.length - cap) };
}

// ---------------------------------------------------------------- re-export

export type Change =
  /** Not exported yet. */
  | "new"
  /** Exported and the same as last time. */
  | "unchanged"
  /** The plan changed since the export. */
  | "update"
  /** The plan changed, and so did the issue in the tracker: skipped unless the user picks overwrite (#182). */
  | "edited"
  /** Linked, but the tracker says it's gone: Recreate (#176). */
  | "missing"
  /** Exported, then taken out of the plan: left in the tracker, untouched (#178). */
  | "removed";

export interface Planned {
  key: string;
  change: Change;
  link?: IssueLink;
  /** The last attempt failed (Retry failed). */
  failed?: string;
}

/** The item is what was sent last time: today's text, or (for an issue sent before #28) the same text with R·n codes. */
export const sameAsSent = (it: IssueItem, hash: string) => contentHash(it.title, it.body) === hash || (it.legacyBody !== undefined && contentHash(it.title, it.legacyBody) === hash);

/** What each item would do. `remote` is the tracker's current title/body hash per linked key (null = 404), when checked. */
export function planChanges(items: IssueItem[], issues: PlanIssues | undefined, remote: Record<string, string | null> = {}): Planned[] {
  const links: Record<string, IssueLink> = { ...(issues?.items ?? {}), ...(issues?.parent ? { [PARENT_KEY]: issues.parent } : {}) };
  const out: Planned[] = items.map((it) => {
    const link = links[it.key];
    const failed = issues?.failed?.[it.key];
    if (!link) return { key: it.key, change: "new", ...(failed ? { failed } : {}) };
    if (remote[it.key] === null) return { key: it.key, change: "missing", link };
    if (sameAsSent(it, link.contentHash)) return { key: it.key, change: "unchanged", link };
    const theirs = remote[it.key];
    if (theirs !== undefined && theirs !== link.contentHash) return { key: it.key, change: "edited", link, ...(failed ? { failed } : {}) };
    return { key: it.key, change: "update", link, ...(failed ? { failed } : {}) };
  });
  for (const [key, link] of Object.entries(links)) if (!items.some((it) => it.key === key)) out.push({ key, change: "removed", link });
  return out;
}

/**
 * v1.3 item 2: the plan's tracker links, read-only (MCP get_plan and list_plans, Home's Recent;
 * friction 26). There's no create_issues tool: issues are only created from the browser, after its
 * preview and confirm.
 */
export function issuesOf(s: Session) {
  const i = s.issues;
  if (!i || (!i.parent && !Object.keys(i.items).length)) return null;
  const link = (l: { number?: number; identifier?: string; url: string }) => ({ ...(l.number !== undefined ? { number: l.number } : {}), ...(l.identifier ? { identifier: l.identifier } : {}), url: l.url });
  return {
    tracker: i.tracker,
    target: i.tracker === "linear" ? (i.targetName ?? i.target) : i.target,
    parent: i.parent ? link(i.parent) : null,
    items: Object.fromEntries(Object.entries(i.items).map(([k, l]) => [k, link(l)])),
    exportedAt: i.exportedAt,
  };
}
