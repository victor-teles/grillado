// A phone action sheet (v1.2 polish §2 and §6): a role=dialog sheet with a caption title and 48px
// rows. Focus stays in it, Escape, the scrim, a downward drag and Back close it.
// Styling hooks: .pscrim .psheet .grab .mt .mi(.del).
import { type ReactNode, useEffect, useId, useRef, useState } from "react";

export function ActionSheet({ title, rows, onClose }: { title: string; rows: { label: string; icon: ReactNode; run: () => void; del?: boolean }[]; onClose: (refocus: boolean) => void }) {
  const ref = useRef<HTMLDivElement>(null);
  const tid = useId();
  const closed = useRef(false);
  const close = useRef(onClose);
  close.current = onClose;
  // Back closes it: the sheet holds one history entry, which any other way of closing gives back.
  useEffect(() => {
    history.pushState({ grilladoSheet: true }, "", location.href);
    const pop = () => {
      closed.current = true;
      close.current(true);
    };
    addEventListener("popstate", pop);
    ref.current?.querySelector<HTMLElement>("button")?.focus();
    return () => {
      removeEventListener("popstate", pop);
      if (!closed.current && history.state?.grilladoSheet) history.back();
    };
  }, []);
  const end = (refocus: boolean) => {
    if (closed.current) return;
    close.current(refocus);
  };
  const drag = useRef<{ y: number; id: number } | null>(null);
  const [dy, setDy] = useState(0);
  return (
    <>
      <div className="pscrim" onClick={() => end(true)} />
      <div
        ref={ref}
        className="psheet"
        role="dialog"
        aria-modal="true"
        aria-labelledby={tid}
        style={dy ? { translate: `0 ${dy}px` } : undefined}
        onKeyDown={(e) => {
          if (e.key === "Escape") {
            e.preventDefault();
            e.stopPropagation();
            return end(true);
          }
          if (e.key !== "Tab") return;
          // Focus stays in the sheet.
          const all = [...(ref.current?.querySelectorAll<HTMLElement>("button") ?? [])];
          const i = all.indexOf(document.activeElement as HTMLElement);
          e.preventDefault();
          all[(i + (e.shiftKey ? -1 : 1) + all.length) % all.length]?.focus();
        }}
        onPointerDown={(e) => {
          drag.current = { y: e.clientY, id: e.pointerId };
        }}
        onPointerMove={(e) => {
          if (drag.current?.id === e.pointerId) setDy(Math.max(0, e.clientY - drag.current.y));
        }}
        onPointerUp={(e) => {
          const d = drag.current && drag.current.id === e.pointerId ? e.clientY - drag.current.y : 0;
          drag.current = null;
          setDy(0);
          if (d > 60) end(true);
        }}
        onPointerCancel={() => ((drag.current = null), setDy(0))}
      >
        <div className="grab" />
        <div className="mt" id={tid}>
          {title}
        </div>
        {rows.map((r) => (
          <button
            key={r.label}
            type="button"
            className={`mi${r.del ? " del" : ""}`}
            onClick={() => {
              end(false);
              r.run();
            }}
          >
            {r.icon}
            {r.label}
          </button>
        ))}
      </div>
    </>
  );
}
