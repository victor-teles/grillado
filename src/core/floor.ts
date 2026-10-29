// The open floor (#40): everything the plan has to list as open when the interview stops.
// One set drives Confirm's title and Still open rows, the side count, the plan's open section,
// plan.openDecisions and MCP get_plan, so they agree.

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
  const seen = new Set(out.map((x) => x.key));
  for (const r of s.rounds)
    for (const u of r.upcoming ?? []) {
      if (asked.has(u.key) || s.decisions[u.key] || seen.has(u.key)) continue;
      seen.add(u.key);
      out.push({ key: u.key, label: u.label, title: u.label, asked: false });
    }
  return out;
}

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
  plan?: { openDecisions: string[] } | null;
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
 * not-asked lines) while its text is still in the Open decisions section. plan.openDecisions, the plan
 * page, the sessions list and MCP get_plan all count this list, recomputed after every plan write.
 */
export function planOpenNow(s: PlanOpenSession, md: string): string[] {
  const out: string[] = [];
  const blockQuestions = new Set<string>();
  for (const m of md.matchAll(BLOCK)) {
    const q = field(m[1], "question");
    if (q) blockQuestions.add(q);
    const key = field(m[1], "key");
    if (key && /^status:\s*open\s*$/m.test(m[1]) && !s.decisions[key]) out.push(q || key);
  }
  const asked = new Set(s.rounds.flatMap((r) => r.questions.map((q) => q.title)));
  const section = openSectionText(md).toLowerCase();
  for (const o of s.plan?.openDecisions ?? []) {
    if (asked.has(o) || blockQuestions.has(o)) continue;
    if (section.includes(o.toLowerCase())) out.push(o);
  }
  return [...new Set(out)];
}

/** Recompute plan.openDecisions from the plan text (after any write to it). */
export function syncPlanOpen(s: PlanOpenSession & { plan?: { openDecisions: string[]; markdown: string } | null }): void {
  if (s.plan) s.plan.openDecisions = planOpenNow(s, s.plan.markdown);
}

/** With nothing left open, the reason line explains nothing (N1, PR46): take it out of the section. */
export function dropReasonLine(md: string): string {
  const m = /^##\s+Open decisions\s*$/im.exec(md);
  if (!m) return md;
  const head = md.slice(0, m.index + m[0].length);
  const rest = md.slice(m.index + m[0].length);
  const end = rest.search(/^##\s/m);
  const sec = end < 0 ? rest : rest.slice(0, end);
  const tail = end < 0 ? "" : rest.slice(end);
  return head + sec.replace(/^The interview stopped (?:early because you chose to wrap up|at the round cap, after round \d+ of \d+|after the extra round|before the cap because .+ had nothing left to ask)\.\n(?:\n)?/m, "") + tail;
}
