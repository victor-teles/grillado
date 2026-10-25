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
