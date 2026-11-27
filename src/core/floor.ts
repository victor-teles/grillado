// The open floor (#40): everything the plan has to list as open when the interview stops.
// One set drives Confirm's title and Still open rows, the side count, the plan's open section,
// plan.openDecisions and MCP get_plan, so they agree.

import { textHash } from "./text-hash.ts";

interface FloorRound {
  questions: { key: string; title: string; label?: string }[];
  upcoming?: { key: string; label: string }[];
  answers?: unknown[];
}

export interface FloorItem {
  key: string;
  label: string;
  title: string;
  /** False for an upcoming item no round asked; true for a question left unanswered by a wrap. */
  asked: boolean;
  /** A line of the plan's text with no queued decision behind it: asked by its own key, made from the text. */
  topic?: true;
}

/**
 * The unanswered questions of an open round (a wrap mid-round), then the union of every round's
 * upcoming items that no round asked and nobody decided, in the order they first showed up.
 */
export function openFloor(s: { rounds: FloorRound[]; decisions: Record<string, unknown> }): FloorItem[] {
  const last = s.rounds.at(-1);
  const out: FloorItem[] = (last && !last.answers ? last.questions : [])
    .filter((q) => !s.decisions[q.key])
    .map((q) => ({ key: q.key, label: q.label || q.title, title: q.title, asked: true }));
  const asked = new Set(s.rounds.flatMap((r) => r.questions.map((q) => q.key)));
  // An agent may ask a queued item under another key; the same short name is the same decision.
  const askedLabels = new Set(s.rounds.flatMap((r) => r.questions.map((q) => norm(q.label))).filter(Boolean));
  const seen = new Set(out.map((x) => x.key));
  for (const r of s.rounds)
    for (const u of r.upcoming ?? []) {
      if (asked.has(u.key) || askedLabels.has(norm(u.label)) || s.decisions[u.key] || seen.has(u.key)) continue;
      seen.add(u.key);
      out.push({ key: u.key, label: u.label, title: u.label, asked: false });
    }
  return out;
}

const norm = (label: string | undefined) => (label ?? "").trim().toLowerCase();

export type StopReason = "wrap" | "extra" | "cap" | "agent";

/** How the interview actually stopped, read when the plan is written. A wrap undone by Keep going isn't one. */
export function stopReason(s: { wrappedUp: boolean; extra?: boolean; stop?: "cap" | "empty" }): StopReason | undefined {
  if (s.wrappedUp) return "wrap";
  if (s.extra && s.stop) return "extra";
  if (s.stop === "cap") return "cap";
  if (s.stop === "empty") return "agent";
  return undefined;
}

/** The four committed reason lines (plan copy table). */
export function reasonLine(r: StopReason, max: number, agent: string): string {
  if (r === "wrap") return "The interview stopped early because you chose to wrap up.";
  if (r === "extra") return "The interview stopped after the extra round.";
  if (r === "cap") return `The interview stopped at the round cap, after round ${max} of ${max}.`;
  return `The interview stopped before the cap because ${agent} had nothing left to ask.`;
}

/** The line Grillado appends for a floor item the written plan left out. */
export const notAskedLine = (label: string) => `- ${label}: not asked before the interview stopped.`;

interface PlanOpenSession {
  rounds: FloorRound[];
  decisions: Record<string, unknown>;
  plan?: { openDecisions: string[]; listed?: string[] } | null;
}

const BLOCK = /^```decision\n([\s\S]*?)^```/gm;
const field = (body: string, k: string) => new RegExp(`^${k}:\\s*(.*)$`, "m").exec(body)?.[1]?.trim();

/** The text of the plan's "## Open decisions" section with its decision blocks taken out; "" with no section. */
export function openSectionText(md: string): string {
  const m = /^##\s+Open decisions\s*$/im.exec(md);
  if (!m) return "";
  const rest = md.slice(m.index + m[0].length);
  const end = rest.search(/^##\s/m);
  return (end < 0 ? rest : rest.slice(0, end)).replace(BLOCK, "");
}

/**
 * What the plan lists as open right now (M1, PR46): the question of every `status: open` block nobody
 * answered, then each stored item that isn't an asked question (the writer's own items and Grillado's
 * not-asked lines) while its text is still in the Open decisions section.
 *
 * The one source for the open count (PR46 r3): the plan text plus `plan.listed`, the writer's list as
 * written, which nothing changes afterwards. So an item whose line goes away and comes back counts again.
 * The plan page, the sessions list and MCP get_plan call this at read time on the text they show;
 * plan.openDecisions is only its saved copy (older sessions without `listed` fall back to it).
 */
export function planOpenNow(s: PlanOpenSession, md: string): string[] {
  const { blocks, listed } = openParts(s, md);
  return [...new Set([...blocks, ...listed])];
}

/** planOpenNow in its two kinds: open decision blocks (answered in place), and lines of the Open decisions section. */
function openParts(s: PlanOpenSession, md: string): { blocks: string[]; listed: string[] } {
  const blocks: string[] = [];
  const blockQuestions = new Set<string>();
  for (const m of md.matchAll(BLOCK)) {
    const q = field(m[1], "question");
    if (q) blockQuestions.add(q);
    const key = field(m[1], "key");
    if (key && /^status:\s*open\s*$/m.test(m[1]) && !s.decisions[key]) blocks.push(q || key);
  }
  const asked = new Set(s.rounds.flatMap((r) => r.questions.map((q) => q.title)));
  const section = openSectionText(md).toLowerCase();
  const listed: string[] = [];
  for (const o of s.plan?.listed ?? s.plan?.openDecisions ?? []) {
    if (asked.has(o) || blockQuestions.has(o)) continue;
    if (section.includes(o.toLowerCase())) listed.push(o);
  }
  return { blocks, listed };
}

/** A key for a topic that has only its text: stable for that text, and never one already asked or decided. */
export function topicKey(s: { rounds: FloorRound[]; decisions: Record<string, unknown> }, prefix: "open" | "scope", text: string): string {
  const base = `${prefix}-${textHash(text.trim().toLowerCase())}`;
  const taken = new Set([...Object.keys(s.decisions), ...s.rounds.flatMap((r) => r.questions.map((q) => q.key))]);
  let key = base;
  for (let n = 2; taken.has(key); n++) key = `${base}-${n}`;
  return key;
}

/**
 * Everything the plan lists as open that no question covers yet, so it can still be asked: queued topics
 * the interview never reached, then the writer's own open lines (which have no key until they're asked).
 * With the open decision blocks, this is the whole open count: nothing is counted that can't be answered.
 */
export function unaskedPlanItems(s: PlanOpenSession, md: string): FloorItem[] {
  const { listed } = openParts(s, md);
  const lower = listed.map((label) => label.toLowerCase());
  const queued = openFloor(s).filter((item) => !item.asked && lower.some((label) => label.includes(item.label.toLowerCase())));
  const own = [...new Set(listed)]
    .filter((label) => !queued.some((item) => label.toLowerCase().includes(item.label.toLowerCase())))
    .map((label): FloorItem => ({ key: topicKey(s, "open", label), label, title: label, asked: false, topic: true }));
  return [...queued, ...own];
}

/** The list items under the plan's "## Out of scope" heading, as written (no list marker). */
export function outOfScopeItems(md: string): string[] {
  const m = /^##[ \t]+Out of scope[ \t]*$/im.exec(md);
  if (!m) return [];
  const rest = md.slice(m.index + m[0].length);
  const end = rest.search(/^##\s/m);
  const out: string[] = [];
  for (const line of (end < 0 ? rest : rest.slice(0, end)).split("\n")) {
    const item = /^\s*(?:[-*]|\d+\.)\s+(.*)$/.exec(line.replace(/\r$/, ""));
    if (item?.[1].trim()) out.push(item[1].trim());
  }
  return out;
}

/**
 * Refresh plan.openDecisions, the saved copy, from the plan text (after any write to it). A session saved
 * before `listed` existed gets it once from openDecisions, before that list is first overwritten.
 * Returns whether anything changed.
 */
export function syncPlanOpen(s: PlanOpenSession & { plan?: { openDecisions: string[]; listed?: string[]; markdown: string } | null }): boolean {
  if (!s.plan) return false;
  const backfill = !s.plan.listed;
  if (backfill) s.plan.listed = [...s.plan.openDecisions];
  const next = planOpenNow(s, s.plan.markdown);
  const same = next.length === s.plan.openDecisions.length && next.every((o, i) => o === s.plan!.openDecisions[i]);
  s.plan.openDecisions = next;
  return backfill || !same;
}

const REASON = /^The interview stopped (?:early because you chose to wrap up|at the round cap, after round \d+ of \d+|after the extra round|before the cap because .+ had nothing left to ask)\.\n(?:\n)?/m;

/** The Open decisions section split out of the plan: [before it and its heading, the section, the rest]. */
function splitOpen(md: string): [string, string, string] | null {
  const m = /^##[ \t]+Open decisions[ \t]*$/im.exec(md);
  if (!m) return null;
  const rest = md.slice(m.index + m[0].length);
  const end = rest.search(/^##\s/m);
  return [md.slice(0, m.index + m[0].length), end < 0 ? rest : rest.slice(0, end), end < 0 ? "" : rest.slice(end)];
}

/** The reason line in the Open decisions section, if there is one. */
export function reasonLineIn(md: string): string | undefined {
  return REASON.exec(splitOpen(md)?.[1] ?? "")?.[0].trim();
}

/** With nothing left open, the reason line explains nothing (N1, PR46): take it out of the section. */
export function dropReasonLine(md: string): string {
  const p = splitOpen(md);
  return p ? p[0] + p[1].replace(REASON, "") + p[2] : md;
}

/** Put a dropped reason line back at the top of the section (Undo of the review that dropped it, N5). */
export function putReasonLine(md: string, line: string): string {
  const p = splitOpen(md);
  if (!p || reasonLineIn(md)) return md;
  return `${p[0]}\n\n${line}\n\n${p[1].replace(/^\n+/, "")}${p[2]}`;
}
