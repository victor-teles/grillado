// "Send to issues" (v1.3 item 2): a plated plan becomes a parent issue plus one issue per slice of
// work. DOM-free and network-free: this file builds the items, their bodies and what a re-export
// would do; the trackers (src/cli/issues) do the talking, only after the user confirms.

import { planSections } from "./diagrams.ts";
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

/** "R2·2": a decision's id as the plan page shows it (round, then its place in the round). */
export function decisionId(s: Session, key: string): string {
  const r = s.rounds.find((x) => x.questions.some((q) => q.key === key));
  return r ? `R${r.n}·${r.questions.findIndex((q) => q.key === key) + 1}` : "";
}

// ---------------------------------------------------------------- BIG-1: what goes into the issue bodies
// Victor's answer is option A, the spec's wording (frames d-q-body-a, d-gh-body, d-gh-parentbody). The bodies are
// written only here: option B (A plus the full plan in a closed <details>) or C (minimal) is a swap of these three.

/** The end of every body: where it came from, and the hidden marker that finds it again. */
const footer = (s: Session, key: string) => `\n\nFrom Grillado plan '${planTitle(s)}'\n${marker(s.id, key)}\n`;

/** The parent: Problem, Solution, the decisions (question, then answer), Out of scope. */
function parentText(s: Session, md: string): { text: string; sections: string[] } {
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
  const ds = resolved(s).map((d) => `- **${d.title.trim()}** ${d.answer.trim()}`);
  if (ds.length) parts.push(`## Decisions\n${ds.join("\n")}`);
  section("Out of scope");
  return { text: parts.join("\n\n") || cleanText(md.replace(/^# .*\n/, "")), sections };
}

/** A child: its slice's first paragraph, "**Covers:** R2·2 question answer", then the rest of the slice. */
function childText(s: Session, x: Slice, covers: string[]): string {
  const [head, ...rest] = (cleanText(x.body) || x.title).split(/\n{2,}/);
  const line = covers.map((k) => `${decisionId(s, k)} ${s.decisions[k].title.trim()} ${s.decisions[k].answer.trim()}`.trim()).join(" · ");
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
  const { text, sections } = parentText(s, md);
  const { body, cut } = fitBody(text, footer(s, PARENT_KEY), BODY_LIMIT[tracker], `the Grillado plan “${planTitle(s)}” (${s.id})`, TRACKER_NAME[tracker]);
  return { key: PARENT_KEY, title: planTitle(s), body, covers: resolved(s).map((d) => d.key), sections, ...(cut ? { cut } : {}) };
}

/**
 * A child: its own text with the decisions it covers (BIG-1, childText). A cut points at the parent issue by name, not by
 * link, so the body (and its hash) doesn't change when the parent is recreated; the tracker links them.
 */
export function childItem(s: Session, x: Slice, tracker: Tracker): IssueItem {
  const known = new Set(Object.keys(s.decisions));
  const covers = [...new Set(x.covers.filter((k) => known.has(k)))];
  const text = childText(s, x, covers);
  const { body, cut } = fitBody(text, footer(s, x.key), BODY_LIMIT[tracker], `the parent issue “${planTitle(s)}”`, TRACKER_NAME[tracker]);
  return { key: x.key, title: x.title.replace(/\s+/g, " ").trim().slice(0, MAX_TITLE), body, covers, sections: x.sections, ...(cut ? { cut } : {}) };
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
  const kids = slices.slice(0, cap).map((x) => childItem(s, x, tracker));
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

/** What each item would do. `remote` is the tracker's current title/body hash per linked key (null = 404), when checked. */
export function planChanges(items: IssueItem[], issues: PlanIssues | undefined, remote: Record<string, string | null> = {}): Planned[] {
  const links: Record<string, IssueLink> = { ...(issues?.items ?? {}), ...(issues?.parent ? { [PARENT_KEY]: issues.parent } : {}) };
  const out: Planned[] = items.map((it) => {
    const link = links[it.key];
    const failed = issues?.failed?.[it.key];
    if (!link) return { key: it.key, change: "new", ...(failed ? { failed } : {}) };
    if (remote[it.key] === null) return { key: it.key, change: "missing", link };
    const mine = contentHash(it.title, it.body);
    if (mine === link.contentHash) return { key: it.key, change: "unchanged", link };
    const theirs = remote[it.key];
    if (theirs !== undefined && theirs !== link.contentHash) return { key: it.key, change: "edited", link, ...(failed ? { failed } : {}) };
    return { key: it.key, change: "update", link, ...(failed ? { failed } : {}) };
  });
  for (const [key, link] of Object.entries(links)) if (!items.some((it) => it.key === key)) out.push({ key, change: "removed", link });
  return out;
}

