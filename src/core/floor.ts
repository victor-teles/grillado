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
