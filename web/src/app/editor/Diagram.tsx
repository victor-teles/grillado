import { IEdit } from "../icons";
import { useEffect, useRef, useState } from "react";
import { type DiagramResult, type MermaidLike, diagramLabel, explainDiagramError, renderDiagram } from "./diagram";

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
 * A ```mermaid block. Re-renders (debounced) whenever the code or theme changes. When the code
 * stops parsing, the last version that worked stays (dimmed) with a plain-language error.
 * Styling hooks: `.mmd[data-state=loading|ok|error]`, `.mmd-svg`, `.mmd-last`, `.mmd-tag`,
 * `.mmd-err`, `.mmd-det`, `.mmd-f` (footer), `.mmd-ph` (placeholder).
 */
export function Diagram({ code, onEdit }: { code: string; onEdit?: () => void }) {
  const dark = useDark();
  const [res, setRes] = useState<DiagramResult | null>(null);
  const [details, setDetails] = useState(false);
  const last = useRef<{ svg: string; label: string } | null>(null);
  // The error bar is a status region; wait a second so it doesn't chatter while typing.
  const [said, setSaid] = useState("");
  useEffect(() => {
    let live = true;
    const t = setTimeout(() => {
      renderDiagram(code, { dark, load: loadMermaid }).then((r) => {
        // Mermaid leaves a scratch node behind when a render fails.
        document.getElementById(`d${r.id}`)?.remove();
        if (!live) return;
        if (r.ok) last.current = { svg: r.svg, label: diagramLabel(code, r.svg) };
        setRes(r);
      });
    }, 120);
    return () => {
      live = false;
      clearTimeout(t);
    };
  }, [code, dark]);
  const explained = res && !res.ok ? explainDiagramError(code, res.error) : null;
  useEffect(() => {
    const t = setTimeout(() => setSaid(explained ? `Diagram can't be drawn. ${explained.message}` : ""), 1000);
    return () => clearTimeout(t);
  }, [explained?.message]); // eslint-disable-line react-hooks/exhaustive-deps

  const state = res === null ? "loading" : res.ok ? "ok" : "error";
  const shown = res?.ok ? { svg: res.svg, label: diagramLabel(code, res.svg) } : last.current;
  return (
    <figure className="mmd" data-state={state} data-testid="diagram">
      {res === null && !shown ? (
        <div className="mmd-ph">Drawing the diagram…</div>
      ) : shown ? (
        <div className={res?.ok ? "mmd-wrap" : "mmd-wrap mmd-last"}>
          {/* Mermaid output is sanitized (securityLevel: "strict"). */}
          <div className="mmd-svg" role="img" aria-label={shown.label} dangerouslySetInnerHTML={{ __html: shown.svg }} />
          {res && !res.ok ? <span className="mmd-tag">Last version that worked</span> : null}
        </div>
      ) : (
        <pre>
          <code>{code}</code>
        </pre>
      )}
      {res && !res.ok ? (
        <figcaption className="mmd-err" data-line={explained?.line}>
          <span className="t">Diagram can't be drawn.</span> {explained?.message}{" "}
          <button type="button" className="btn quiet sm" aria-expanded={details} onClick={() => setDetails(!details)}>
            Details
          </button>
          {details ? <pre className="mmd-det">{res.error}</pre> : null}
        </figcaption>
      ) : null}
      <span className="sr-only" role="status">
        {said}
      </span>
      {onEdit ? (
        <div className="mmd-f">
          <button
            type="button"
            className="icon-btn"
            aria-label="Edit source"
            title="Edit source"
            onClick={(e) => {
              e.stopPropagation();
              onEdit();
            }}
          >
            <IEdit s={16} />
          </button>
        </div>
      ) : null}
    </figure>
  );
}
