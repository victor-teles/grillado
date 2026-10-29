// The round cap as the browser shows it (#33). Mirrors the server's gate in src/core/session.ts.
import type { SessionView } from "./types.ts";

type CapView = Pick<SessionView, "rounds" | "reopened" | "stale" | "maxRounds">;

/** Rounds that count toward the cap: re-asks of reopened or stale decisions don't. */
export const counted = (s: Pick<CapView, "rounds">) => s.rounds.filter((r) => !r.reask).length;

/** The last allowed round is saved and nothing is owed: Keep going would be refused. */
export const atCap = (s: CapView) => counted(s) >= s.maxRounds && !s.reopened.length && !Object.keys(s.stale ?? {}).length;

/** Confirm's meta line: it stands in for the last round's agent summary. None after a wrap. */
export function roundStatus(s: CapView & Pick<SessionView, "stop" | "wrappedUp">, agent: string): string | undefined {
  if (s.wrappedUp || !s.stop) return undefined;
  const k = counted(s);
  const n = s.maxRounds;
  // Only a relaunch with a lower --max-rounds gets here: re-asks past the cap don't count.
  if (k > n) return `${k} rounds done. The cap is ${n}.`;
  if (s.stop === "cap") return `Round ${n} of ${n} is done.`;
  return `Round ${k} of ${n} · ${agent} has nothing left to ask.`;
}
