export type FailureCode = "auth" | "rate_limit" | "timeout" | "not_found" | "malformed" | "unknown";

const AUTH =
  /not (logged|signed) in|please (run )?\/?login|\blog ?in\b|unauthori[sz]ed|\b401\b|\b403\b|authenticat|api[_ -]?key|credential|(access|user|auth|bearer|third-party user) token|subscription access|forbidden/i;
const RATE =
  /rate[_ -]?limit|\b429\b|quota|usage limit|too many requests|overloaded|capacity|credit balance|exceeded your/i;

/** Classify a failed CLI run from its exit code, stderr, and any JSON error text (AC8). */
export function classifyFailure(input: { exitCode?: number | null; stderr?: string; message?: string }): FailureCode {
  const text = `${input.message ?? ""}\n${input.stderr ?? ""}`;
  if (RATE.test(text)) return "rate_limit";
  if (AUTH.test(text)) return "auth";
  return "unknown";
}

/** Short, readable reason from noisy CLI output. */
export function summarizeError(text: string, max = 400): string {
  const lines = text
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean)
    .filter((l) => !/^Reconnecting\.\.\./i.test(l));
  const interesting = lines.filter((l) => /error|fail|denied|unauthori|not (logged|signed)|limit|quota/i.test(l));
  const pick = (interesting.length ? interesting : lines).slice(-3).join(" · ");
  return pick.length > max ? `${pick.slice(0, max)}…` : pick || "The agent exited without a reply.";
}
