import { useEffect, useState } from "react";
import { type DiagramResult, type MermaidLike, renderDiagram } from "./diagram";

// Mermaid is ~1 MB of JS, so it's only fetched when a plan actually has a diagram.
let mermaid: Promise<MermaidLike> | null = null;
const loadMermaid = () => (mermaid ??= import("mermaid").then((m) => m.default as unknown as MermaidLike));

function useDark() {
  const read = () => !document.documentElement.classList.contains("light");
  const [dark, setDark] = useState(read);
  useEffect(() => {
    const obs = new MutationObserver(() => setDark(read()));
    obs.observe(document.documentElement, { attributes: true, attributeFilter: ["class"] });
    return () => obs.disconnect();
  }, []);
  return dark;
}

/**
 * A ```mermaid block. Re-renders (debounced) whenever the code or theme changes; an invalid
 * diagram shows its error and source instead of breaking the document.
 * Styling hooks: `.mmd[data-state=loading|ok|error]`, `.mmd-svg`, `.mmd-err`.
 */
export function Diagram({ code }: { code: string }) {
  const dark = useDark();
  const [res, setRes] = useState<DiagramResult | null>(null);
  useEffect(() => {
    let live = true;
    const t = setTimeout(() => {
      renderDiagram(code, { dark, load: loadMermaid }).then((r) => {
        // Mermaid leaves a scratch node behind when a render fails.
        document.getElementById(`d${r.id}`)?.remove();
        if (live) setRes(r);
      });
    }, 120);
    return () => {
      live = false;
      clearTimeout(t);
    };
  }, [code, dark]);

  const state = res === null ? "loading" : res.ok ? "ok" : "error";
  return (
    <figure className="mmd" data-state={state} data-testid="diagram">
      {res?.ok ? (
        // Mermaid output is sanitized (securityLevel: "strict").
        <div className="mmd-svg" role="img" aria-label="Diagram" dangerouslySetInnerHTML={{ __html: res.svg }} />
      ) : (
        <>
          {res && !res.ok ? (
            <figcaption className="mmd-err">
              <strong>Diagram can't be drawn.</strong> {res.error}
            </figcaption>
          ) : null}
          <pre>
            <code>{code}</code>
          </pre>
        </>
      )}
    </figure>
  );
}
