// Option previews ("See before you choose"): an option of a question may carry a UI mock, a code
// sketch or a diagram, so the user compares alternatives before choosing. DOM-free: the server
// checks previews before they are kept, and the browser uses the same types and limits.
//
// The preview's source is agent-written and untrusted. Grillado only ever shows it as text, as a
// Mermaid diagram (drawn with securityLevel "strict"), or as markup inside a sandboxed frame with no
// scripts and no network (web/src/app/preview/Preview.tsx).
import { checkMermaid } from "./diagrams.ts";

export type PreviewKind = "ui" | "code" | "diagram";

export interface Preview {
  kind: PreviewKind;
  source: string;
  /** Code sketches: the language, for the fence in the saved plan and the highlighter. */
  lang?: string;
}

/** What the agent's reply carries per option: always present, "none" when the option has no preview. */
export interface RawPreview {
  kind: PreviewKind | "none";
  lang: string;
  source: string;
}

/** "Show me another": the one request in progress or last made, per session. */
export interface AnotherRun {
  /** The question's key. */
  question: string;
  state: "running" | "done" | "error" | "stopped";
  startedAt: string;
  message?: string;
  code?: string;
}

export const NO_PREVIEW: RawPreview = { kind: "none", lang: "", source: "" };

/** Limits per preview, on the source text (UTF-8 bytes; lines for code and diagrams). */
export const PREVIEW_LIMITS: Record<PreviewKind, { bytes: number; lines?: number }> = {
  ui: { bytes: 32 * 1024 },
  code: { bytes: 16 * 1024, lines: 200 },
  diagram: { bytes: 16 * 1024, lines: 150 },
};
/** All previews of one question together. */
export const QUESTION_PREVIEW_BYTES = 256 * 1024;
/** A question holds at most this many options, counting the ones "Show me another" added. */
export const MAX_OPTIONS = 6;

const bytes = (text: string) => new TextEncoder().encode(text).length;
const kib = (n: number) => `${Math.round(n / 1024)} KiB`;

export const hasPreview = (p: RawPreview | Preview | undefined | null): p is Preview =>
  !!p && p.kind !== ("none" as string) && typeof p.source === "string" && p.source.trim().length > 0;

/** Why a preview can't be shown, or null. `kind` is the kind its question uses. */
export function previewIssue(p: RawPreview | Preview, kind: PreviewKind = p.kind as PreviewKind): string | null {
  if (p.kind !== kind) return `use a "${kind}" preview like the other options of the question`;
  const limit = PREVIEW_LIMITS[kind];
  if (!limit) return 'kind must be "ui", "code" or "diagram"';
  const size = bytes(p.source);
  if (size > limit.bytes) return `keep it under ${kib(limit.bytes)} (it is ${kib(size)})`;
  if (limit.lines && p.source.split("\n").length > limit.lines) return `keep it under ${limit.lines} lines`;
  if (kind === "diagram") return checkMermaid(p.source);
  return null;
}

/**
 * Things a UI preview may contain that will not work where it is shown: scripts never run and
 * nothing loads from the network. The preview still renders without them, so this is advice for
 * the repair pass, not a reason to drop it.
 */
export function uiAdvice(source: string): string | null {
  if (/<script\b/i.test(source)) return "ui previews cannot run scripts: use HTML and CSS only";
  if (/<(link|iframe|object|embed|base)\b/i.test(source) || /http-equiv/i.test(source)) return "ui previews cannot load other documents or stylesheets: inline the CSS in a <style> tag";
  if (/(src|href|action)\s*=\s*["']?\s*(https?:)?\/\//i.test(source) || /url\(\s*["']?\s*(https?:)?\/\//i.test(source) || /@import/i.test(source))
    return "ui previews cannot load anything from the network: no external images, fonts or stylesheets";
  return null;
}

interface WithPreview {
  id: string;
  label: string;
  preview?: RawPreview | Preview;
  previewFailed?: boolean;
}

/** The kind a question's previews use: its first option's that has one. */
export function previewKindOf(options: WithPreview[]): PreviewKind | null {
  const first = options.find((o) => hasPreview(o.preview));
  return first ? (first.preview!.kind as PreviewKind) : null;
}

/**
 * What is wrong with a question's previews, for the agent's one repair pass: every option of a
 * question with previews gets one, all of the same kind, each within its limits.
 */
export function questionPreviewIssue(q: { key: string; options: WithPreview[] }): string | null {
  const kind = previewKindOf(q.options);
  if (!kind) return null;
  let total = 0;
  for (const o of q.options) {
    const at = `Question "${q.key}", option "${o.id}"`;
    if (!hasPreview(o.preview)) return `${at}: every option of a question with previews needs a "${kind}" preview, or give none of them one.`;
    const issue = previewIssue(o.preview, kind) ?? (kind === "ui" ? uiAdvice(o.preview.source) : null);
    if (issue) return `${at}: its preview is not usable: ${issue}.`;
    total += bytes(o.preview.source);
  }
  if (total > QUESTION_PREVIEW_BYTES) return `Question "${q.key}": its previews together are over ${kib(QUESTION_PREVIEW_BYTES)}. Make them smaller.`;
  return null;
}

export function previewProblem(questions: { key: string; options: WithPreview[] }[]): string | null {
  for (const q of questions) {
    const issue = questionPreviewIssue(q);
    if (issue) return issue;
  }
  return null;
}

const clean = (p: RawPreview | Preview, kind: PreviewKind): Preview => {
  const lang = kind === "code" ? (p.lang ?? "").trim().toLowerCase().replace(/[^a-z0-9+#.-]/g, "").slice(0, 20) : "";
  return { kind, source: p.source.replace(/\r\n?/g, "\n").replace(/\s+$/, ""), ...(lang ? { lang } : {}) };
};

/**
 * Keep the previews that can be shown and mark the rest (in place). An option whose preview is
 * missing or unusable stays a text option with `previewFailed`, so the question can still be
 * answered. A question none of whose previews is usable becomes a plain text question.
 */
export function settlePreviews(questions: { options: WithPreview[] }[]): void {
  for (const q of questions) {
    const kind = previewKindOf(q.options);
    const usable = kind ? q.options.filter((o) => hasPreview(o.preview) && !previewIssue(o.preview, kind)) : [];
    let total = 0;
    for (const o of q.options) {
      const ok = kind && usable.includes(o) && (total += bytes(o.preview!.source)) <= QUESTION_PREVIEW_BYTES;
      if (ok) {
        o.preview = clean(o.preview!, kind);
        delete o.previewFailed;
      } else {
        delete o.preview;
        if (usable.length) o.previewFailed = true;
        else delete o.previewFailed;
      }
    }
  }
}

/** A fence long enough for the source it wraps. */
function fence(source: string, info: string): string[] {
  const longest = Math.max(2, ...(source.match(/`+/g) ?? []).map((m) => m.length));
  const ticks = "`".repeat(longest + 1);
  return [`${ticks}${info}`, source, ticks];
}

const FENCE_INFO: Record<PreviewKind, (p: Preview) => string> = { ui: () => "html", code: (p) => p.lang ?? "", diagram: () => "mermaid" };

/**
 * "## Chosen previews" for the saved plan: the source of the preview on each option the user
 * chose, as a labeled fenced block (HTML, code with its language, or Mermaid).
 */
export function chosenPreviews(picked: { label: string; answer: string; preview: Preview }[]): string[] {
  if (!picked.length) return [];
  const lines = ["## Chosen previews", ""];
  for (const p of picked) {
    lines.push(`### ${p.label.replace(/\s+/g, " ")}: ${p.answer.replace(/\s+/g, " ")}`, "", ...fence(p.preview.source, FENCE_INFO[p.preview.kind](p.preview)), "");
  }
  lines.pop();
  return lines;
}
