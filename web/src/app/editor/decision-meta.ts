// Who answered a decision block and when (item 2 handoff §2.1), for the card's meta line and the tab rows.
import { COPY, fmt } from "../copy.ts";

const WHEN = new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });

type Who = { by?: "you" | "agent"; at?: string; kept_suggestion?: boolean };

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
  const who = f.by === "agent" ? fmt(COPY.pickedBy, { agent }) : f.kept_suggestion ? COPY.youKept : COPY.you;
  return when ? `${who}, ${when}` : who;
}

/** The rest-state tag after the answer: "Picked by {agent}" (muted) or "Your call" (ember), else none. */
export function restTag(f: Who, agent: string): { kind: "agent" | "yours"; text: string } | null {
  if (f.by === "agent") return { kind: "agent", text: fmt(COPY.pickedBy, { agent }) };
  if (!f.kept_suggestion) return { kind: "yours", text: COPY.yourCall };
  return null;
}

const norm = (v: string) =>
  v
    .replace(/^\s*decided:\s*/i, "")
    .replace(/[.!\s]+$/, "")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();

/** A note worth showing: not just the answer said again ("Decided: Yes, one core flow."). */
export function noteAdds(note: string | undefined, answer: string | undefined): boolean {
  return !!note?.trim() && norm(note) !== norm(answer ?? "");
}
