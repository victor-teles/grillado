// "Add to plan" (v1.2 polish item 5, DECISIONS #104): a settled decision that no passage of the plan
// cites yet gets one run that writes it into the text. The run ends in exactly one suggestion (or
// none), with the decision as its source; nothing changes until the user accepts it (#16).
// DOM-free: the server runs it, the browser reads the state.

import { addSuggestions, checkEdits, type CommentState, type EditProposal, type Suggestion } from "./comments.ts";

export interface AddPlanRun {
  /** The decision's key. One decision at a time (PO answer, #104). */
  decision: string;
  state: "running" | "done" | "error" | "stopped";
  startedAt: string;
  ms?: number;
  /** The suggestion it made; a done run without one found no place for the decision. */
  suggestion?: string;
  message?: string;
  /** The failure code, for the activity log's plain reason. */
  code?: string;
}

const CITE_RE = /\[(R\d+:[^\]\s,]+(?:\s*,\s*R\d+:[^\]\s,]+)*)\]/g;

/** "R3:items" for a decision asked in round 3. */
export const citeId = (round: number, key: string) => `R${round}:${key}`;

/** Every cite in a piece of text ("[R1:a, R2:b]" → R1:a, R2:b). */
export function citesIn(text: string): string[] {
  return [...text.matchAll(CITE_RE)].flatMap((m) => m[1].split(/\s*,\s*/));
}

/** Some passage of the plan cites the decision (any round: a re-asked decision keeps its key). */
export function inPlan(md: string, key: string): boolean {
  return citesIn(md).some((c) => c.replace(/^R\d+:/, "") === key);
}

/** The agent's one edit, checked against the plan: it must cite the decision and keep every cite it had. */
export function checkAddPlan(md: string, e: EditProposal, cite: string): string | null {
  const bad = checkEdits(md, [e]);
  if (bad) return bad;
  const after = citesIn(e.after);
  if (!after.includes(cite)) return `\`after\` must cite the decision as [${cite}] right after the text you add`;
  const lost = citesIn(e.before).filter((c) => !after.includes(c));
  if (lost.length) return `keep every citation that was in \`before\`: ${lost.map((c) => `[${c}]`).join(", ")}`;
  return null;
}

/** Place the edit as a suggestion whose source is the decision. Null when its text is gone. */
export function addPlanSuggestion(s: CommentState & { plan?: { markdown: string } }, key: string, e: EditProposal, baseHash?: string): Suggestion | null {
  const { added } = addSuggestions(s, "", [e], 0, baseHash);
  const x = added[0];
  if (!x) return null;
  x.source = { kind: "decision", id: key };
  return x;
}

/** What the row and the card show for a decision (#104). "rest" when there's nothing to say. */
export type AddPlanState = "rest" | "running" | "ready" | "none" | "failed";

export function addPlanState(run: AddPlanRun | undefined, key: string, suggestions: Suggestion[] = []): AddPlanState {
  if (!run || run.decision !== key) return "rest";
  if (run.state === "running") return "running";
  if (run.state === "error") return "failed";
  if (run.state === "stopped") return "rest";
  if (!run.suggestion) return "none";
  // Reviewed (accepted: it's in the plan now; rejected: back to rest).
  return suggestions.some((x) => x.id === run.suggestion && x.status === "pending") ? "ready" : "rest";
}
