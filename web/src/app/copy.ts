// UI copy that names the agent or carries counts, as templates (v1.1 §5b). Fill them with
// `fmt`; never build these sentences by concatenation, and never write an agent's name in code.
export const COPY = {
  openLead: "Answer here or in the plan. {agent} can fold your answers into the plan text later.",
  decisionsLead: "Every answer from this session. Change one here or in the plan, and anything that depends on it is asked again.",
  reasking: "Saved. {agent} will ask {questions} again, then update the {n} that mention these answers.",
  external: "plan.md now says “{to}” instead of “{from}”, so {list} will be asked again once you confirm.",
  savedQuestion: "Saved “{question}”",
  pickedBy: "Picked by {agent}",
  you: "You",
  youKept: "You kept the suggestion",
  yourCall: "Your call",
  changedWas: "Changed just now · was {was}",
  ownOpen: "Open · {agent} asks it in the next round",
  addedByYou: "Added by you",
  authBanner: "To keep going, log in to {agent}: {how}, then come back (your answers are saved).",
  agentChip: "Agent: {agent}",
  resolvedNewest: "Newest first",
  resolvedRounds: "Rounds {first}–{last}",
  // Long runs (Grok CLI 1.0.70 rounds take minutes). For every agent: any of them can be slow on a big session.
  roundWaitNote: "Rounds can take a few minutes.",
  timeoutTitle: "{agent} is running slow",
  timeoutBody: "Nothing came back in time. Your answers are saved.",
} as const;

/** Fill `{name}` slots. Unknown slots are left as they are so a missing value is visible, not silent. */
export function fmt(template: string, vars: Record<string, string | number>): string {
  return template.replace(/\{(\w+)\}/g, (m, k: string) => (k in vars ? String(vars[k]) : m));
}

/** Two-letter avatar for an agent name: initials of two words, else its first two letters. */
export function monogram(name: string): string {
  const words = name.trim().split(/\s+/).filter(Boolean);
  const letters = words.length >= 2 ? words[0][0] + words[1][0] : (words[0] ?? "?").slice(0, 2);
  return letters.toUpperCase();
}
