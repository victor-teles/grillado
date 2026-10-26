// Rendered selection → plan source range. DOM-free so it can be unit-tested.
//
// The rich view drops Markdown marks (**, `, [R1:key] citations shown as "R1·2" chips), so a
// selection's text isn't a slice of the source. Match its words against the block's source,
// allowing marks and citations between and inside words, and take the match nearest where the
// selection sits in the block.

const MARK = "[*_~`]*";
const GAP = String.raw`(?:\s|[*_~\x60]|\[R\d+:[^\]]*\]|\]\([^)]*\)|\[|\n\s*(?:[-*]|\d+\.|#{1,4})\s+)+`;
const esc = (c: string) => c.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** Selected text without the citation chips' labels ("R1·2"). */
export function cleanSelection(text: string): string {
  return text.replace(/R\d+·[\d?]+/g, " ").replace(/\s+/g, " ").trim();
}

/**
 * `[start, end)` in `raw` (a block's source) of the rendered `selected` text, nearest `hint`
 * (an estimated offset into `raw`), or null when it can't be found.
 */
export function sourceRange(raw: string, selected: string, hint: number): [number, number] | null {
  const words = cleanSelection(selected).split(" ").filter(Boolean);
  if (!words.length) return null;
  const pattern = words.map((w) => [...w].map(esc).join(MARK)).join(GAP);
  let best: [number, number] | null = null;
  for (const m of raw.matchAll(new RegExp(pattern, "g"))) {
    const r: [number, number] = [m.index!, m.index! + m[0].length];
    if (!best || Math.abs(r[0] - hint) < Math.abs(best[0] - hint)) best = r;
  }
  return best;
}

export type Format = "bold" | "italic" | "strike" | "code";
const WRAP: Record<Format, string> = { bold: "**", italic: "*", strike: "~~", code: "`" };

/** Wrap `[start, end)` of `source` in a Markdown mark, or unwrap it when it's already wrapped. */
export function toggleFormat(source: string, start: number, end: number, f: Format): string {
  const w = WRAP[f];
  const inner = source.slice(start, end);
  if (source.slice(start - w.length, start) === w && source.slice(end, end + w.length) === w && (f !== "italic" || source[start - 2] !== "*"))
    return source.slice(0, start - w.length) + inner + source.slice(end + w.length);
  if (inner.startsWith(w) && inner.endsWith(w) && inner.length > 2 * w.length) return source.slice(0, start) + inner.slice(w.length, -w.length) + source.slice(end);
  return `${source.slice(0, start)}${w}${inner}${w}${source.slice(end)}`;
}

/** ⌘B / ⌘I in the block and Markdown editors: the new text, with the same words still selected. */
export function formatEdit(source: string, start: number, end: number, f: Format): { text: string; start: number; end: number } {
  const text = toggleFormat(source, start, end, f);
  const w = WRAP[f].length;
  const inner = source.slice(start, end).replace(/^[*~`]+|[*~`]+$/g, "");
  const at = text.indexOf(inner, Math.max(0, start - w));
  return at < 0 ? { text, start, end } : { text, start: at, end: at + inner.length };
}

/** The format a key press asks for (⌘B bold, ⌘I italic; Ctrl on Windows / Linux), or null. */
export function formatKey(e: { key: string; metaKey: boolean; ctrlKey: boolean; altKey: boolean; shiftKey: boolean }): Format | null {
  if (!(e.metaKey || e.ctrlKey) || e.altKey || e.shiftKey) return null;
  const k = e.key.toLowerCase();
  return k === "b" ? "bold" : k === "i" ? "italic" : null;
}
