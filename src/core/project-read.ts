// Read access to the project (plan 002): what the agent may read, and how Grillado checks every
// path the agent names before it is stored, shown or written into a plan. Pure: file-system checks
// come in as a function (`exists`), so this module has no node:fs.

/** A fact the agent read from the project and so did not ask. It always names at least one source. */
export interface Finding {
  id: string;
  round: number;
  label: string;
  fact: string;
  paths: string[];
}

/** One file a question is based on, with a short note (shown on its card). */
export interface Evidence {
  path: string;
  note: string;
}

/** One existing file the plan's work changes or builds on (rendered as "In your code"). */
export interface Touch {
  path: string;
  why: string;
}

/** Most findings a session keeps: the oldest stay, a later duplicate is skipped. */
export const MAX_FINDINGS = 40;

/**
 * Files never shown, never accepted as a source, and denied to the agent where its CLI takes path
 * rules (Claude Code, Grok). Glob-like: `*` matches within one path segment.
 */
export const SENSITIVE_FILES = [".env", ".env.*", "*.pem", "*.key", "id_rsa*", "id_ed25519*", "secrets.*", "credentials*"];

const segmentRegex = (glob: string) => new RegExp(`^${glob.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, "[^/]*")}$`, "i");
const SENSITIVE = SENSITIVE_FILES.map(segmentRegex);

/** A path (relative, POSIX) that is sensitive: any segment matches the list, or it is inside `.git`. */
export function isSensitive(rel: string): boolean {
  const parts = rel.split("/");
  if (parts.includes(".git")) return true;
  return parts.some((p) => SENSITIVE.some((r) => r.test(p)));
}

/** Claude Code deny rules for the sensitive list, for `--disallowedTools`. */
export function claudeDenyRules(): string[] {
  return [...SENSITIVE_FILES.map((f) => `Read(**/${f})`), "Read(**/.git/**)"];
}

/** Grok deny rules: every MCP tool call, and reading or searching the sensitive files. */
export function grokDenyRules(): string[] {
  return ["MCPTool", ...SENSITIVE_FILES.flatMap((f) => [`Read(**/${f})`, `Grep(**/${f})`]), "Read(**/.git/**)"];
}

/**
 * The path the agent named, as a clean POSIX path relative to `root`, or null when it can't be
 * trusted: empty, a `..` segment, a home path, absolute outside `root`, or sensitive. `root` is the
 * read root as an absolute POSIX path. Existence and symlinks are checked by the caller's `exists`.
 */
export function relativePath(raw: string, root: string): string | null {
  let p = String(raw ?? "").trim().replace(/\\/g, "/");
  if (!p || p.length > 300 || p.startsWith("~") || p.includes("\0")) return null;
  const base = root.replace(/\\/g, "/").replace(/\/+$/, "");
  if (p.startsWith("/") || /^[a-z]:\//i.test(p)) {
    // Windows paths compare without case; POSIX ones exactly.
    const [a, b] = /^[a-z]:\//i.test(p) ? [p.toLowerCase(), base.toLowerCase()] : [p, base];
    if (a !== b && !a.startsWith(`${b}/`)) return null;
    p = p.slice(base.length);
  }
  const parts = p.split("/").filter((x) => x && x !== ".");
  if (!parts.length || parts.includes("..")) return null;
  const rel = parts.join("/");
  return isSensitive(rel) ? null : rel;
}

/** Turns a path the agent named into a checked relative path, or null. Built once per run by the CLI. */
export type PathCheck = (raw: string) => string | null;

/** Evidence with checked paths, duplicates dropped, at most `max`. */
export function checkEvidence(list: Evidence[] | undefined, check: PathCheck, max = 4): Evidence[] {
  const out: Evidence[] = [];
  for (const e of list ?? []) {
    const path = check(e.path);
    if (!path || out.some((x) => x.path === path)) continue;
    out.push({ path, note: e.note.trim() });
    if (out.length === max) break;
  }
  return out;
}

/** Touched files with checked paths, duplicates dropped. */
export function checkTouches(list: Touch[] | undefined, check: PathCheck): Touch[] {
  const out: Touch[] = [];
  for (const t of list ?? []) {
    const path = check(t.path);
    if (!path || out.some((x) => x.path === path)) continue;
    out.push({ path, why: t.why.trim() });
  }
  return out;
}

const sameFinding = (a: { label: string; fact: string }, b: { label: string; fact: string }) =>
  a.label.trim().toLowerCase() === b.label.trim().toLowerCase() && a.fact.trim().toLowerCase() === b.fact.trim().toLowerCase();

/**
 * This round's findings with checked paths, added to the session's. A finding left with no valid
 * path is dropped (a finding without a source is not a finding); one already known is skipped.
 * Returns the new list and the findings this round added.
 */
export function mergeFindings(
  existing: Finding[] | undefined,
  incoming: { label: string; fact: string; paths: string[] }[] | undefined,
  round: number,
  check: PathCheck,
): { all: Finding[]; added: Finding[] } {
  const all = [...(existing ?? [])];
  const added: Finding[] = [];
  for (const f of incoming ?? []) {
    if (all.length >= MAX_FINDINGS) break;
    const label = f.label.trim();
    const fact = f.fact.trim();
    if (!label || !fact) continue;
    const paths = [...new Set(f.paths.map(check).filter((p): p is string => !!p))].slice(0, 3);
    if (!paths.length || all.some((x) => sameFinding(x, f))) continue;
    const finding = { id: `f${round}-${added.length + 1}`, round, label, fact, paths };
    all.push(finding);
    added.push(finding);
  }
  return { all, added };
}
