// Markdown → top-level blocks with source offsets. DOM-free so it can be unit-tested.
//
// The plan's raw Markdown is the only source of truth. The rich view renders these blocks and
// edits one block by splicing its source slice back in, so text the renderer doesn't understand
// (raw `[R1:id]` citations, odd spacing, HTML, tables) is never re-serialized and can't be lost.

export type Block =
  | { kind: "heading"; start: number; end: number; raw: string; level: number; text: string }
  | { kind: "list"; start: number; end: number; raw: string; ordered: boolean; first: number; items: string[] }
  | { kind: "fence"; start: number; end: number; raw: string; lang: string; body: string }
  | { kind: "para"; start: number; end: number; raw: string; text: string };

const LIST = /^\s*([-*]|\d+\.)\s+/;
const HEADING = /^(#{1,4})\s+(.*)$/;
const BREAKS_PARA = /^(#{1,4}\s|```|\s*([-*]|\d+\.)\s)/;

interface Line {
  text: string; // without the line break (and without a trailing \r)
  start: number;
  end: number; // offset just past `text` (before \r\n / \n)
}

function lines(source: string): Line[] {
  const out: Line[] = [];
  let start = 0;
  for (;;) {
    const nl = source.indexOf("\n", start);
    const stop = nl === -1 ? source.length : nl;
    const end = stop > start && source[stop - 1] === "\r" ? stop - 1 : stop;
    out.push({ text: source.slice(start, end), start, end });
    if (nl === -1) return out;
    start = nl + 1;
  }
}

export function parseBlocks(source: string): Block[] {
  const ls = lines(source);
  const blocks: Block[] = [];
  let i = 0;
  const span = (a: number, b: number) => ({ start: ls[a].start, end: ls[b].end, raw: source.slice(ls[a].start, ls[b].end) });
  while (i < ls.length) {
    const line = ls[i].text;
    if (!line.trim()) {
      i++;
      continue;
    }
    if (line.startsWith("```")) {
      const a = i++;
      while (i < ls.length && !ls[i].text.startsWith("```")) i++;
      const b = Math.min(i, ls.length - 1); // unclosed fence runs to the end
      const closed = i < ls.length;
      blocks.push({
        kind: "fence",
        ...span(a, b),
        lang: line.slice(3).trim().split(/\s+/)[0] ?? "",
        body: ls
          .slice(a + 1, closed ? b : b + 1)
          .map((l) => l.text)
          .join("\n"),
      });
      i = b + 1;
      continue;
    }
    const h = HEADING.exec(line);
    if (h) {
      blocks.push({ kind: "heading", ...span(i, i), level: h[1].length, text: h[2] });
      i++;
      continue;
    }
    if (LIST.test(line)) {
      const a = i;
      while (i < ls.length && LIST.test(ls[i].text)) i++;
      const items = ls.slice(a, i).map((l) => l.text.replace(LIST, ""));
      const ordered = /^\s*\d+\./.test(line);
      blocks.push({ kind: "list", ...span(a, i - 1), ordered, first: ordered ? Number(/\d+/.exec(line)![0]) : 1, items });
      continue;
    }
    const a = i;
    while (i < ls.length && ls[i].text.trim() && !BREAKS_PARA.test(ls[i].text)) i++;
    if (i === a) i++; // defensive: never stall
    blocks.push({
      kind: "para",
      ...span(a, i - 1),
      text: ls
        .slice(a, i)
        .map((l) => l.text)
        .join(" "),
    });
  }
  return blocks;
}

/** Replace `[start, end)` of `source` with `text`. Everything outside the range is kept byte for byte. */
export function splice(source: string, start: number, end: number, text: string): string {
  return source.slice(0, start) + text + source.slice(end);
}

/** `[R1:key]` and `[R1:a, R2:b]` citations, in source order. Used to check none were lost. */
export function citations(source: string): string[] {
  const out: string[] = [];
  for (const m of source.matchAll(/\[(R\d+:[^\]\s,]+(?:\s*,\s*R\d+:[^\]\s,]+)*)\]/g)) out.push(...m[1].split(/\s*,\s*/));
  return out;
}

const CITES = /\[(R\d+:[^\]\s,]+(?:\s*,\s*R\d+:[^\]\s,]+)*)\]/g;

/** Decision keys cited in a piece of text ("[R1:a, R2:b]" → a, b). */
export function citedKeys(text: string): string[] {
  const out: string[] = [];
  for (const m of text.matchAll(CITES)) for (const r of m[1].split(/\s*,\s*/)) out.push(r.replace(/^R\d+:/, ""));
  return out;
}

/**
 * Split paragraph text into sentences, keeping every character (the parts join back to the
 * input). Splits after . ! ? followed by space, never inside `code` or a [cite].
 */
export function sentences(text: string): string[] {
  const out: string[] = [];
  let from = 0;
  let code = false;
  let bracket = 0;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (c === "`") code = !code;
    else if (!code && c === "[") bracket++;
    else if (!code && c === "]") bracket = Math.max(0, bracket - 1);
    else if (!code && !bracket && (c === "." || c === "!" || c === "?") && /\s/.test(text[i + 1] ?? "")) {
      let j = i + 1;
      while (j < text.length && /\s/.test(text[j])) j++;
      out.push(text.slice(from, j));
      from = j;
      i = j - 1;
    }
  }
  if (from < text.length) out.push(text.slice(from));
  return out;
}

export interface Passage {
  /** DOM id of the passage in the rich view. */
  id: string;
  keys: string[];
}

export const passageId = (blockStart: number, i: number) => `psg-${blockStart}-${i}`;

/** Every sentence or list item that cites a decision, in document order (v1.1 §3 "context"). */
export function passages(md: string): Passage[] {
  const out: Passage[] = [];
  for (const b of parseBlocks(md)) {
    const parts = b.kind === "para" ? sentences(b.text) : b.kind === "list" ? b.items : [];
    parts.forEach((t, i) => {
      const keys = citedKeys(t);
      if (keys.length) out.push({ id: passageId(b.start, i), keys });
    });
  }
  return out;
}
