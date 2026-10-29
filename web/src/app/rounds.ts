// The round cap as the browser shows it (#33, #36, #37). Mirrors the server's gate in src/core/session.ts.
import { plural } from "./counts.ts";
import type { SessionView } from "./types.ts";

type CapView = Pick<SessionView, "rounds" | "reopened" | "stale" | "maxRounds" | "extra">;

/** Rounds that count toward the cap: re-asks of reopened or stale decisions don't. */
export const counted = (s: Pick<CapView, "rounds">) => s.rounds.filter((r) => !r.reask).length;

/** Decisions sent back to be asked again (reopened or stale), by key. */
export const owedKeys = (s: Pick<CapView, "reopened" | "stale">) => [...new Set([...s.reopened, ...Object.keys(s.stale ?? {})])];

/** The cap plus the one extra round once it's granted (#37). */
const limit = (s: CapView) => s.maxRounds + (s.extra ? 1 : 0);

/** The last allowed round is saved: only owed decisions may still be asked. */
export const capReached = (s: CapView) => counted(s) >= limit(s);

/** The last allowed round is saved and nothing is owed: Keep going would be refused. */
export const atCap = (s: CapView) => capReached(s) && !owedKeys(s).length;

/** Confirm's meta line: it stands in for the last round's agent summary. None after a wrap. */
export function roundStatus(s: CapView & Pick<SessionView, "stop" | "wrappedUp">, agent: string): string | undefined {
  if (s.wrappedUp || !s.stop) return undefined;
  const k = counted(s);
  const n = s.maxRounds;
  if (s.extra && k === n + 1) return "You’ve used the extra round.";
  // Only a relaunch with a lower --max-rounds gets here: re-asks past the cap don't count.
  if (k > limit(s)) return `${k} rounds done. The cap is ${n}.`;
  if (s.stop === "cap") return `Round ${n} of ${n} is done.`;
  return `Round ${k} of ${n} · ${agent} has nothing left to ask.`;
}

/**
 * The counter under a round's title (#36, ROUNDS-REASK): `lead` in muted text, then `tag` (" · last round"
 * in the foreground at 500, or " · asking again" muted). A re-ask never moves k.
 */
export function roundCounter(s: CapView, roundN: number): { lead: string; tag?: string; strong?: boolean } {
  const r = s.rounds.find((x) => x.n === roundN);
  const n = s.maxRounds;
  const upTo = s.rounds.filter((x) => x.n <= roundN && !x.reask).length;
  if (r?.reask) return upTo > n ? { lead: "Extra round", tag: "asking again" } : { lead: `Round ${upTo} of ${n}`, tag: "asking again" };
  if (upTo > n) return { lead: "Extra round", tag: "last round", strong: true };
  if (upTo === n) return { lead: `Round ${n} of ${n}`, tag: "last round", strong: true };
  return { lead: `Round ${upTo} of ${n}` };
}

/** Waiting for the next round (#36, #37, ROUNDS-REASK). */
export function preparing(s: CapView): string {
  if (owedKeys(s).length) return "Asking again · reading your answers";
  const k = counted(s) + 1;
  if (k > s.maxRounds) return "Preparing the extra round · reading your answers";
  return `Preparing round ${k} of ${s.maxRounds} · reading your answers`;
}

/** Confirm's second button at the cap (#37, PR43 review): the extra round, or the owed decisions by name. */
export function capAction(s: CapView & Pick<SessionView, "decisions">): { label: string; action: "ask-more" | "keep-going" } | null {
  if (!capReached(s)) return null;
  const owed = owedKeys(s);
  if (owed.length === 1) {
    const k = owed[0];
    const d = s.stale?.[k] ?? s.decisions[k];
    return { label: `Ask ${d?.label || d?.title || k} again`, action: "keep-going" };
  }
  if (owed.length) return { label: `Ask ${owed.length} again`, action: "keep-going" };
  return s.extra ? null : { label: "Ask 1 more round", action: "ask-more" };
}

/** Confirm's line under the title when nothing is left open; it counts what was sent back, as the header does. */
export const settledLine = (settled: number, owed: number) => `${plural(settled, "decision")} settled, ${owed ? `${owed} to ask again` : "nothing open"}.`;
