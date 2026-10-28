// The status line while the agent works (no JSX, so tests import it directly).
export function waitLabel(session: { progress?: string | null }, elapsed: number, base: string) {
  // From 15 s it's "Still cooking…" and stays so: the note under it already says rounds can take minutes (review-pr26 r2 must 1).
  if (session.progress === "Taking another pass") return elapsed >= 60 ? "Still cooking…" : "Taking another pass…";
  if (elapsed >= 15) return "Still cooking…";
  return base;
}
