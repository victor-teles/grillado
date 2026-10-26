import { type RefObject, useEffect, useLayoutEffect, useRef, useState } from "react";
import { IAlert } from "../icons";

export type MermaidErr = { line?: number; message: string; raw: string };

/** The editor's error bar (§9): the message, Details, announced. Outside the preview, so it shows in Source and Preview. */
export function MermaidError({ id, err }: { id: string; err: MermaidErr }) {
  const [det, setDet] = useState(false);
  return (
    <div className="merr" id={id} role="status" onMouseDown={(e) => e.preventDefault()}>
      <IAlert s={16} />
      <span>{err.message}</span>
      <button type="button" className="btn quiet sm" aria-expanded={det} onClick={() => setDet(!det)}>
        Details
      </button>
      {det ? <pre className="mmd-det">{err.raw}</pre> : null}
    </div>
  );
}

/**
 * Mobile diagram editing (item 5 §11): a Source | Preview switch in the accessory row instead of the
 * preview under the source. Preview drops the keyboard and shows the live preview; Source brings the
 * keyboard back where you were. Tapping or tabbing out, Esc and Done still finish (normal save path).
 */
export type SourceView = "source" | "preview";

export function useSourcePreview(on: boolean, root: RefObject<HTMLElement | null>, ta: RefObject<HTMLTextAreaElement | null>, finish: (refocus: boolean) => void) {
  const [view, setView] = useState<SourceView>("source");
  // Set before focus moves, so the textarea's blur (it gets hidden) doesn't finish the edit.
  const pv = useRef(false);
  const moved = useRef(false);
  const cur: SourceView = on ? view : "source";
  pv.current = cur === "preview";
  const fin = useRef(finish);
  fin.current = finish;
  const set = (v: SourceView) => {
    if (v === cur) return;
    moved.current = true;
    pv.current = v === "preview";
    if (v === "preview") root.current?.querySelector<HTMLElement>(".mseg [data-v=preview]")?.focus({ preventScroll: true });
    setView(v);
  };
  useLayoutEffect(() => {
    if (!moved.current) return;
    if (cur === "source") ta.current?.focus({ preventScroll: true });
    else root.current?.scrollIntoView({ block: "start" });
  }, [cur]); // eslint-disable-line react-hooks/exhaustive-deps
  // Focus on our own controls (the switch, Done) keeps the edit open; leaving them finishes it.
  const ours = useRef(false);
  useEffect(() => {
    if (!on) return;
    const inside = (t: EventTarget | null) => !!t && !!root.current?.contains(t as Node);
    const focus = (e: FocusEvent) => {
      if (inside(e.target)) ours.current = e.target !== ta.current;
      else if (ours.current || pv.current) fin.current(false);
    };
    const down = (e: PointerEvent) => {
      if (!inside(e.target) && (ours.current || pv.current)) fin.current(false);
    };
    const key = (e: KeyboardEvent) => {
      if (e.key !== "Escape" || !(ours.current || pv.current)) return;
      e.preventDefault();
      e.stopPropagation();
      fin.current(true);
    };
    document.addEventListener("focusin", focus, true);
    document.addEventListener("pointerdown", down, true);
    document.addEventListener("keydown", key, true);
    return () => {
      document.removeEventListener("focusin", focus, true);
      document.removeEventListener("pointerdown", down, true);
      document.removeEventListener("keydown", key, true);
    };
  }, [on]); // eslint-disable-line react-hooks/exhaustive-deps
  /** The textarea's blur shouldn't finish: Preview hid it, or focus went to the switch or Done. */
  const keeps = (to: EventTarget | null) => pv.current || (!!to && !!(to as Element).closest?.(".acc4") && !!root.current?.contains(to as Node));
  return { view: cur, set, keeps };
}

/** The segmented switch (uai ToggleGroup look, `.seg2`): one tab stop, ←/→ move between the two. */
export function SourcePreviewSwitch({ view, onView }: { view: SourceView; onView: (v: SourceView) => void }) {
  const opts: [SourceView, string][] = [
    ["source", "Source"],
    ["preview", "Preview"],
  ];
  return (
    <div className="seg2 mseg" role="radiogroup" aria-label="Show">
      {opts.map(([v, label]) => (
        <button
          key={v}
          type="button"
          role="radio"
          data-v={v}
          aria-checked={view === v}
          tabIndex={view === v ? 0 : -1}
          onClick={() => onView(v)}
          onKeyDown={(e) => {
            if (!["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown"].includes(e.key)) return;
            e.preventDefault();
            const next = view === "source" ? "preview" : "source";
            onView(next);
            (e.currentTarget.parentElement?.querySelector(`[data-v=${next}]`) as HTMLElement | null)?.focus();
          }}
        >
          {label}
        </button>
      ))}
    </div>
  );
}

/** Pixels the on-screen keyboard covers at the bottom of the layout viewport (mobile). */
export function useKeyboardDock(on: boolean) {
  const [px, setPx] = useState(0);
  useEffect(() => {
    const vv = window.visualViewport;
    if (!on || !vv) return;
    const update = () => setPx(Math.max(0, window.innerHeight - (vv.height + vv.offsetTop)));
    update();
    vv.addEventListener("resize", update);
    vv.addEventListener("scroll", update);
    return () => {
      vv.removeEventListener("resize", update);
      vv.removeEventListener("scroll", update);
    };
  }, [on]);
  return px;
}
