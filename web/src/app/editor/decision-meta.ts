// Who answered a decision block and when (spec v1.1 backlog item 2), for the card's meta line.
import { COPY, fmt } from "../copy.ts";

const WHEN = new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });

/** "Answered by you · Oct 25, 10:14 PM" from a block's `by:` and `at:`; null when it carries neither. */
export function answeredLine(f: { by?: "you" | "agent"; at?: string }, agent: string, format: (d: Date) => string = (d) => WHEN.format(d)): string | null {
  const who = f.by === "agent" ? agent : "you";
  const t = f.at ? new Date(f.at) : null;
  const when = t && !Number.isNaN(t.getTime()) ? format(t) : "";
  if (!f.by && !when) return null;
  return when ? fmt(COPY.answered, { who, when }) : fmt(COPY.answeredBy, { who });
}
