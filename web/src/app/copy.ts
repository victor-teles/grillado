// UI copy that names the agent or carries counts, as templates (v1.1 §5b). Fill them with
// `fmt`; never build these sentences by concatenation, and never write an agent's name in code.
export const COPY = {
  openLead: "Answer here or in the plan. {agent} can fold your answers into the plan text later.",
  decisionsLead: "Every answer from this session. Change one in the plan; what depends on it is asked again.",
  waiting: "Asking again: {list}. {agent} is writing the next questions; the plan is read-only until then.",
  agentChip: "Agent: {agent}",
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
