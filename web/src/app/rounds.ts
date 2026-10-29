// The round cap as the browser shows it (#33). Mirrors the server's gate in src/core/session.ts.
import type { SessionView } from "./types";

type CapView = Pick<SessionView, "rounds" | "reopened" | "stale" | "maxRounds">;

/** The last allowed round is saved and nothing is owed: Keep going would be refused. */
export const atCap = (s: CapView) => s.rounds.length >= s.maxRounds && !s.reopened.length && !Object.keys(s.stale ?? {}).length;

/** Confirm's meta line: it stands in for the last round's agent summary. None after a wrap. */
export function roundStatus(s: CapView & Pick<SessionView, "stop" | "wrappedUp">, agent: string): string | undefined {
  if (s.wrappedUp || !s.stop) return undefined;
  const k = s.rounds.length;
  const n = s.maxRounds;
  if (k > n) return `${k} rounds done. The cap is ${n}.`;
  if (s.stop === "cap") return `Round ${n} of ${n} is done.`;
  return `Round ${k} of ${n} · ${agent} has nothing left to ask.`;
}
