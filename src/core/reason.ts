import type { FailureCode } from "./classify.ts";

/** The message a session carries after the user pressed Stop; the UI keys its own card on it, never on wording it re-types. */
export const STOPPED = "Stopped. Retry when you’re ready.";
/** What builds before #26 stored on Stop (straight '); sessions stopped there still reopen as stopped. @offscreen: only matched, never shown. */
export const STOPPED_BEFORE_26 = "Stopped. Retry when you're ready.";

/** True when this error is the user's own Stop, not the agent failing. */
export function isStopped(error: { code?: string | null; message?: string | null } | null | undefined): boolean {
  return !!error && failureCode(error.code) === "unknown" && (error.message === STOPPED || error.message === STOPPED_BEFORE_26);
}

const CODES: readonly FailureCode[] = ["auth", "rate_limit", "timeout", "not_found", "malformed", "unknown"];
/** Older activity entries stored their own short words for two codes; they still read the same. */
const OLDER: Record<string, FailureCode> = { rate: "rate_limit", missing: "not_found" };

/** Any failure code a run, an import or a stored entry carries, as one of classify.ts's codes. */
export function failureCode(code: string | null | undefined): FailureCode {
  if (!code) return "unknown";
  return (CODES as readonly string[]).includes(code) ? (code as FailureCode) : (OLDER[code] ?? "unknown");
}

/**
 * Plain words for why the agent failed (AC17: never the raw text). The one mapping every feature
 * uses: Activity, the diagrams bar, Found's imports, and the log the MCP tools return.
 */
export function reasonText(code: string | null | undefined, agent: string): string {
  switch (failureCode(code)) {
    case "rate_limit":
      return `${agent} hit its usage limit`;
    case "auth":
      return `${agent} isn’t signed in`;
    case "timeout":
      return `${agent} is running slow`;
    case "not_found":
      return `${agent} isn’t installed`;
    case "malformed":
      return `${agent}’s reply didn’t come through`;
    case "unknown":
      return `${agent} couldn’t finish this`;
  }
}
