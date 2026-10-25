import { promptFragments } from "./prompts.ts";

/** Names that must never surface in the UI, network responses, or exported plans (AC17/AC18). */
export const BANNED_TERMS = ["grill-me", "grilling", "matt pocock", "mattpocock"];

const normalize = (s: string) => s.toLowerCase().replace(/\s+/g, " ");

/**
 * Returns the first banned term or prompt fragment found in `text`, or null.
 * Terms the user typed themselves (idea, context, answers) are exempt, so an idea like
 * "an app for grilling recipes" doesn't trip the filter.
 */
export function findBanned(text: string, userText = ""): string | null {
  const hay = normalize(text);
  const exempt = normalize(userText);
  for (const term of BANNED_TERMS) {
    if (hay.includes(term) && !exempt.includes(term)) return term;
  }
  for (const fragment of promptFragments()) {
    const f = normalize(fragment);
    if (hay.includes(f)) return "instructions";
  }
  return null;
}

/** Last-resort scrub for text we didn't generate (CLI error output) before it reaches the browser. */
export function redact(text: string, userText = ""): string {
  let out = text;
  for (const term of BANNED_TERMS) {
    if (normalize(userText).includes(term)) continue;
    out = out.replace(new RegExp(term.replace(/[-\s]/g, "[-\\s]?"), "gi"), "[redacted]");
  }
  for (const fragment of promptFragments()) out = out.split(fragment).join("[redacted]");
  return out;
}
