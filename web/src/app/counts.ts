// One source for every decision count on a screen (item 2 handoff §4): the plan's title meta,
// the Decisions tab, the save status, the "Open decisions" heading and the early-wrap confirm.
// total = resolved + open, so "Decisions 18 · 2 open" means 16 resolved and 2 still open.
import { type FloorItem, openFloor } from "../../../src/core/floor.ts";
import type { SessionView } from "./types.ts";

export interface Counts {
  resolved: number;
  open: number;
  total: number;
}

const count = (resolved: number, open: number): Counts => ({ resolved, open, total: resolved + open });

/** Open decision blocks in plan.md that nobody answered since (wrapped up early). */
export function openKeysIn(session: SessionView, md: string): string[] {
  const keys: string[] = [];
  for (const m of md.matchAll(/^```decision\n([\s\S]*?)^```/gm)) {
    const key = /^key:\s*(.+)$/m.exec(m[1])?.[1]?.trim();
    if (key && /^status:\s*open\s*$/m.test(m[1]) && !session.decisions[key]) keys.push(key);
  }
  return keys;
}

/** Decisions you added yourself (U ids, item 4) and answered in the plan text. */
export function ownAnsweredIn(session: SessionView, md: string): string[] {
  const keys: string[] = [];
  for (const m of md.matchAll(/^```decision\n([\s\S]*?)^```/gm)) {
    const key = /^key:\s*(u\d+)\s*$/m.exec(m[1])?.[1];
    if (key && /^id:\s*U\d+\s*$/m.test(m[1]) && /^answer:\s*\S/m.test(m[1]) && !/^status:\s*open\s*$/m.test(m[1]) && !session.decisions[key]) keys.push(key);
  }
  return keys;
}

/** Open items the agent listed in prose that aren't questions we asked. */
export function extraOpen(session: SessionView): string[] {
  const asked = (t: string) => session.rounds.some((r) => r.questions.some((q) => q.title === t));
  return [...new Set(session.plan?.openDecisions ?? [])].filter((t) => !asked(t));
}

/** Counts for the plan screen. */
export function planCounts(session: SessionView, md: string): Counts & { openKeys: string[] } {
  const openKeys = openKeysIn(session, md);
  const resolved = Object.keys(session.decisions).length + ownAnsweredIn(session, md).length;
  return { ...count(resolved, openKeys.length + extraOpen(session).length), openKeys };
}

/**
 * What the plan will list as open if it's written now (#40): the open round's unanswered questions
 * plus every upcoming item no round asked. The plan's open section is built from the same floor.
 */
export function stillOpen(session: SessionView): FloorItem[] {
  return openFloor(session);
}

/** Counts for the confirm screen, matching what the plan will show once it's written. */
export function confirmCounts(session: SessionView): Counts {
  return count(Object.keys(session.decisions).length, stillOpen(session).length);
}

export const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/** Every surface's text, so a test can check they agree. */
export function countText(c: Counts, mobile = false) {
  const tab = c.open ? (mobile ? `Decisions · ${c.open} open` : `Decisions ${c.total} · ${c.open} open`) : `Decisions ${c.total}`;
  return {
    tab,
    tabName: c.open ? `Decisions, ${c.total}, ${c.open} open` : `Decisions, ${c.total}`,
    titleMeta: `${plural(c.total, "decision")}${c.open ? ` · ${c.open} open` : ""}`,
    openHeading: c.open,
    status: c.open ? `${c.open} open` : "",
    confirm: `${plural(c.resolved, "decision")} settled, ${c.open} still open`,
  };
}
