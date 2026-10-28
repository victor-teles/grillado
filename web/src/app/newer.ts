import type { SessionView } from "./types.ts";

/** The later of two snapshots of one session; one without a number counts as new. */
export function newer(cur: SessionView, next: SessionView): SessionView {
  return cur.rev !== undefined && next.rev !== undefined && next.rev < cur.rev ? cur : next;
}
