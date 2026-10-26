// Mermaid rendering behind a tiny interface, so the fallback path is unit-testable without a DOM.

export interface MermaidLike {
  initialize(config: Record<string, unknown>): void;
  parse(text: string): Promise<unknown>;
  render(id: string, text: string): Promise<{ svg: string }>;
}

export type DiagramResult = { ok: true; svg: string } | { ok: false; error: string };

let seq = 0;

/** Render one diagram. Never throws: an invalid diagram comes back as `{ ok: false, error }`. */
export async function renderDiagram(code: string, opts: { dark: boolean; load: () => Promise<MermaidLike> }): Promise<DiagramResult & { id: string }> {
  const id = `gr-mmd-${++seq}`;
  if (!code.trim()) return { ok: false, error: "Empty diagram.", id };
  try {
    const m = await opts.load();
    m.initialize({
      startOnLoad: false,
      securityLevel: "strict", // mermaid sanitizes labels and drops scripts/links
      theme: opts.dark ? "dark" : "default",
      fontFamily: "inherit",
      // Mermaid 12 defaults to the ELK layout, which Grillado doesn't ship (EPL-2.0, see
      // THIRD_PARTY_NOTICES.md). Use dagre everywhere and don't let a diagram switch it back.
      layout: "dagre",
      state: { layout: "dagre" },
      secure: ["secure", "securityLevel", "startOnLoad", "maxTextSize", "suppressErrorRendering", "maxEdges", "layout"],
    });
    await m.parse(code);
    const { svg } = await m.render(id, code);
    return { ok: true, svg, id };
  } catch (err: any) {
    const msg = String(err?.message ?? err ?? "Invalid diagram");
    return { ok: false, error: msg.split("\n").slice(0, 4).join("\n"), id };
  }
}

const CLOSE: Record<string, string> = { "[": "]", "(": ")", "{": "}" };

/** The diagram type from its first line ("flowchart LR" → flowchart). */
export function diagramType(code: string): string {
  const first = code.split("\n").find((l) => l.trim() && !l.trim().startsWith("%%"))?.trim() ?? "";
  return first.split(/\s+/)[0] || "diagram";
}

/** Accessible name for a rendered diagram: its type and how many nodes it draws. */
export function diagramLabel(code: string, svg: string): string {
  const nodes = (svg.match(/class="[^"]*\bnode\b[^"]*"/g) ?? []).length;
  return `${diagramType(code)} diagram${nodes ? `, ${nodes} ${nodes === 1 ? "node" : "nodes"}` : ""}`;
}

/**
 * Plain-language version of a Mermaid parse error, with the line it's about. Mermaid usually
 * reports the line after an unclosed shape, so look back for the line where the shape opened.
 */
export function explainDiagramError(code: string, raw: string): { line?: number; message: string } {
  const lines = code.split("\n");
  const reported = Number(/line (\d+)/i.exec(raw)?.[1] ?? "0");
  const upTo = reported > 0 ? Math.min(reported, lines.length) : lines.length;
  for (let i = upTo - 1; i >= 0; i--) {
    const stack: string[] = [];
    for (const c of lines[i].replace(/"[^"]*"/g, "")) {
      if (c in CLOSE) stack.push(CLOSE[c]);
      else if (stack.length && c === stack.at(-1)) stack.pop();
    }
    if (stack.length) return { line: i + 1, message: `Line ${i + 1}: a shape isn't closed. Add the missing ${stack.at(-1)} at the end of the label.` };
  }
  if (reported > 0) return { line: reported, message: `Line ${reported}: Mermaid can't read this line.` };
  return { message: "Mermaid can't read this diagram." };
}
