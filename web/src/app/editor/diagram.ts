// Mermaid rendering behind a tiny interface, so the fallback path is unit-testable without a DOM.

export interface MermaidLike {
  initialize(config: Record<string, unknown>): void;
  parse(text: string): Promise<unknown>;
  render(id: string, text: string): Promise<{ svg: string }>;
}

export type DiagramResult = { ok: true; svg: string } | { ok: false; error: string };

/** Mermaid takes hex colours, not var() or oklch: the theme is read from the tokens at render time (§6.2). */
export type ThemeVars = Record<string, string | boolean>;

/** Mermaid's config for Grillado: token theme, Inter 13px, no HTML labels, no ELK (§6.2). */
export function mermaidConfig(theme?: ThemeVars, dark = true): Record<string, unknown> {
  return {
    startOnLoad: false,
    securityLevel: "strict", // mermaid sanitizes labels and drops scripts/links
    theme: theme ? "base" : dark ? "dark" : "default",
    // Flat nodes (§6.2): Mermaid 12's default "neo" look puts a blurred drop shadow on every node,
    // from its own stylesheet inside the SVG, which page CSS can't beat. Classic draws none.
    look: "classic",
    themeVariables: theme ? { ...theme, dropShadow: "none", nodeShadow: false } : theme,
    fontFamily: '"Inter Variable", Inter, sans-serif',
    htmlLabels: false,
    flowchart: { htmlLabels: false, curve: "basis", padding: 8, nodeSpacing: 22, rankSpacing: 28, useMaxWidth: false, diagramPadding: 4 },
    // Mermaid 12 defaults to the ELK layout, which Grillado doesn't ship (EPL-2.0, see
    // THIRD_PARTY_NOTICES.md). Use dagre everywhere and don't let a diagram switch it back.
    layout: "dagre",
    state: { layout: "dagre", useMaxWidth: false, padding: 6 },
    secure: ["secure", "securityLevel", "startOnLoad", "maxTextSize", "suppressErrorRendering", "maxEdges", "layout", "look", "theme", "themeVariables", "htmlLabels"],
  };
}

/** Which token each Mermaid theme variable reads (§6.2). */
export const THEME_TOKENS: Record<string, string> = {
  primaryColor: "--background",
  mainBkg: "--background",
  secondaryColor: "--background",
  tertiaryColor: "--background",
  stateBkg: "--background",
  primaryBorderColor: "--border-strong",
  nodeBorder: "--border-strong",
  primaryTextColor: "--foreground",
  labelTextColor: "--foreground",
  stateLabelColor: "--foreground",
  lineColor: "--muted-foreground",
  transitionColor: "--muted-foreground",
  textColor: "--muted-foreground",
  transitionLabelColor: "--muted-foreground",
  edgeLabelBackground: "--sel",
  background: "--sel",
  compositeBackground: "--sel",
  specialStateColor: "--foreground",
  innerEndBackground: "--foreground",
};

let seq = 0;
// Mermaid keeps one global config, so renders go one at a time.
let queue: Promise<unknown> = Promise.resolve();

/** Render one diagram. Never throws: an invalid diagram comes back as `{ ok: false, error }`. */
export function renderDiagram(code: string, opts: { dark: boolean; theme?: ThemeVars; load: () => Promise<MermaidLike> }): Promise<DiagramResult & { id: string }> {
  const id = `gr-mmd-${++seq}`;
  const run = async (): Promise<DiagramResult & { id: string }> => {
    if (!code.trim()) return { ok: false, error: "Empty diagram.", id };
    try {
      const m = await opts.load();
      m.initialize(mermaidConfig(opts.theme, opts.dark));
      await m.parse(code);
      const { svg } = await m.render(id, code);
      return { ok: true, svg, id };
    } catch (err: any) {
      const msg = String(err?.message ?? err ?? "Invalid diagram");
      return { ok: false, error: msg.split("\n").slice(0, 4).join("\n"), id };
    }
  };
  const p = queue.then(run, run);
  queue = p.catch(() => {});
  return p;
}

const CLOSE: Record<string, string> = { "[": "]", "(": ")", "{": "}" };

/** The diagram type from its first line ("flowchart LR" → flowchart). */
export function diagramType(code: string): string {
  const first = code.split("\n").find((l) => l.trim() && !l.trim().startsWith("%%"))?.trim() ?? "";
  return first.split(/\s+/)[0] || "diagram";
}

/** "Flowchart" / "State diagram" / "Diagram", for labels and headers. */
export function kindName(code: string): string {
  const t = diagramType(code);
  return /^(flowchart|graph)$/.test(t) ? "Flowchart" : /^stateDiagram/.test(t) ? "State diagram" : "Diagram";
}

/** accTitle / accDescr written in the fence (§8). */
export function accOf(code: string): { title: string; descr: string } {
  return {
    title: /^\s*accTitle\s*:\s*(.+)$/m.exec(code)?.[1]?.trim() ?? "",
    descr: /^\s*accDescr\s*:\s*(.+)$/m.exec(code)?.[1]?.trim() ?? "",
  };
}

/** Accessible name for a rendered diagram: "{Flowchart|State diagram}: {accTitle}", or its type and node count. */
export function diagramLabel(code: string, svg: string): string {
  const { title } = accOf(code);
  if (title) return `${kindName(code)}: ${title}`;
  const nodes = (svg.match(/class="[^"]*\bnode\b[^"]*"/g) ?? []).length;
  return `${diagramType(code)} diagram${nodes ? `, ${nodes} ${nodes === 1 ? "node" : "nodes"}` : ""}`;
}

/** The last label text on a line, for "after “Same item?”" in messages. */
const labelOn = (line: string) => /["[({]\s*"?([^"\])}]+?)"?\s*$/.exec(line)?.[1]?.trim();

/**
 * Plain-language version of a Mermaid parse error, with the line it's about (§6.5). Mermaid usually
 * reports the line after an unclosed shape, so look back for the line where the shape opened.
 */
export function explainDiagramError(code: string, raw: string): { line?: number; message: string } {
  const lines = code.split("\n");
  const first = lines.findIndex((l) => l.trim() && !l.trim().startsWith("%%"));
  if (first >= 0 && !/^(flowchart|graph|stateDiagram(-v2)?|sequenceDiagram|classDiagram|erDiagram|gantt|pie|journey|mindmap|timeline|gitGraph|quadrantChart|xychart|block|sankey|requirementDiagram|C4\w*|architecture|packet|kanban|radar|treemap)\b/.test(lines[first].trim()))
    return { line: first + 1, message: `Line ${first + 1}: the diagram type is missing. Start with flowchart TD or stateDiagram-v2.` };
  const reported = Number(/line (\d+)/i.exec(raw)?.[1] ?? "0");
  const upTo = reported > 0 ? Math.min(reported, lines.length) : lines.length;
  for (let i = upTo - 1; i >= 0; i--) {
    const stack: string[] = [];
    for (const c of lines[i].replace(/"[^"]*"/g, "")) {
      if (c in CLOSE) stack.push(CLOSE[c]);
      else if (stack.length && c === stack.at(-1)) stack.pop();
    }
    if (stack.length) {
      const after = labelOn(lines[i]);
      return { line: i + 1, message: `Line ${i + 1}: a shape isn’t closed. Add the missing ${stack.at(-1)}${after ? ` after “${after}”` : " at the end of the label"}.` };
    }
  }
  if (reported > 0) {
    const l = lines[reported - 1] ?? "";
    if (/-->\s*-->|--\s+>|<--|==>>/.test(l.replace(/"[^"]*"/g, "")) || /got '(ARROW|LINK)/i.test(raw)) return { line: reported, message: `Line ${reported}: Mermaid doesn’t know this arrow. Use --> or -.->.` };
    if (/^\s*[a-z]+\s/i.test(l) && /Expecting/.test(raw) && !/[-=.]{2,}/.test(l)) return { line: reported, message: `Line ${reported}: Mermaid doesn’t know “${l.trim().split(/\s+/)[0]}”.` };
    return { line: reported, message: `Mermaid couldn’t read line ${reported}.` };
  }
  return { message: "Mermaid couldn’t read this diagram." };
}

/** Zoom steps in full screen (§7). */
export const ZOOMS = [50, 75, 100, 150, 200, 300];
/** The next step up or down; an off-step value (Fit's 237%) snaps to the step on that side. */
export const zoomStep = (z: number, d: 1 | -1) => (d > 0 ? ZOOMS.find((s) => s > z) ?? ZOOMS.at(-1)! : [...ZOOMS].reverse().find((s) => s < z) ?? ZOOMS[0]);

/** Fit: the whole diagram in the body, never past the last step (300%). */
export const fitPercent = (body: { w: number; h: number }, nat: { w: number; h: number }, pad = 48) =>
  !nat.w || !nat.h || body.w <= pad || body.h <= pad ? null : Math.max(10, Math.min(ZOOMS.at(-1)!, Math.floor(Math.min((body.w - pad) / nat.w, (body.h - pad) / nat.h) * 100)));

/**
 * The sizing rule (§6.3): natural size if it fits the column; else break out to 820; else scale
 * down to the floor; past that (or taller than the max after scaling), crop and offer full screen.
 * Phones and the live preview always fit the width.
 */
export function fitDiagram(nat: { w: number; h: number }, o: { col: number; wide: number; floor?: number; maxH?: number; fit?: boolean }): { scale: number; breakout: boolean; crop: boolean } {
  if (!nat.w) return { scale: 1, breakout: false, crop: false };
  if (o.fit) return { scale: Math.min(1, o.col / nat.w), breakout: false, crop: false };
  if (nat.w <= o.col) return { scale: 1, breakout: false, crop: nat.h > (o.maxH ?? 480) };
  const floor = o.floor ?? 0.85;
  let scale = Math.min(1, o.wide / nat.w);
  let crop = false;
  if (scale < floor) {
    scale = floor;
    crop = true;
  }
  if (nat.h * scale > (o.maxH ?? 480)) crop = true;
  return { scale, breakout: true, crop };
}
