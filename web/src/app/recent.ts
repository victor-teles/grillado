// A Recent row's status line on Home (v1.2: plain text, no badges).
import type { SessionSummary } from "./types.ts";

/** "Issues #31", "Issues ENG-12", or "4 issues" with no parent (friction 26). */
export function issuesText(i: SessionSummary["issues"]): string | undefined {
  if (!i) return undefined;
  if (i.parent) return `Issues ${i.parent.identifier ?? `#${i.parent.number}`}`;
  const n = Object.keys(i.items).length;
  return n ? `${n} ${n === 1 ? "issue" : "issues"}` : undefined;
}

/** Plain text status for a recent session (v1.2: no badges). An export leads, so a capped line never hides it (review of #43). */
export function statusText(s: SessionSummary) {
  const issues = issuesText(s.issues);
  return issues ? `${issues} · ${stage(s)}` : stage(s);
}

function stage(s: SessionSummary) {
  if (s.status === "plated") return s.open ? `Wrapped early · ${s.open} open` : "Plated";
  if (s.status === "confirm") return "Confirm";
  if (s.status === "synthesizing") return "Plating";
  return `Round ${Math.max(1, s.rounds)}`;
}
