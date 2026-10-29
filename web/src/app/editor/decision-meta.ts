// Who answered a decision block and when (item 2 handoff §2.1), for the card's meta line and the tab rows.
import { overrides } from "../../../../src/core/decision-block.ts";
import { COPY, fmt } from "../copy.ts";

const WHEN = new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });

type Who = { by?: "you" | "agent"; at?: string; kept_suggestion?: boolean; note?: string };

/** An Overridden note is your call, whatever the block's kept_suggestion says (PR46 M2). */
const kept = (f: Who) => !!f.kept_suggestion && !overrides(f.note);

/**
 * "You, Oct 25, 5:14 PM" / "You kept the suggestion, …" / "Picked by {agent}, …" from `by:`,
 * `kept_suggestion:` and `at:`; "Changed just now · was {old}" right after a change here.
 * null when the block carries neither who nor when.
 */
export function whoLine(f: Who, agent: string, opts: { was?: string; format?: (d: Date) => string } = {}): string | null {
  if (opts.was !== undefined) return fmt(COPY.changedWas, { was: opts.was });
  const format = opts.format ?? ((d: Date) => WHEN.format(d));
  const t = f.at ? new Date(f.at) : null;
  const when = t && !Number.isNaN(t.getTime()) ? format(t) : "";
  if (!f.by && !when) return null;
  const who = f.by === "agent" ? fmt(COPY.pickedBy, { agent }) : kept(f) ? COPY.youKept : COPY.you;
  return when ? `${who}, ${when}` : who;
}

/** The rest-state tag after the answer: "Picked by {agent}" (muted) or "Your call" (ember), else none. */
export function restTag(f: Who, agent: string): { kind: "agent" | "yours"; text: string } | null {
  if (f.by === "agent") return { kind: "agent", text: fmt(COPY.pickedBy, { agent }) };
  if (!kept(f)) return { kind: "yours", text: COPY.yourCall };
  return null;
}

// One rule for the plan page and the issue it exports (src/core/issues.ts).
export { noteAdds } from "../../../../src/core/decision-block.ts";

/**
 * The answer a card shows, reads out and tags Current (friction 30): a note that begins "Overridden"
 * is the decision, as in the exported issues; otherwise the recorded answer.
 */
export const cardAnswer = (f: { answer?: string; note?: string }): string | undefined => (overrides(f.note) ? f.note!.trim() : f.answer);
