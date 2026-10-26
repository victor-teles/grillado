import { Dialog } from "radix-ui";
import { IAlert, IEdit, IMax, IMinus, IPlus, IX } from "../icons";
import { useMobile } from "../chrome";
import { useEffect, useId, useLayoutEffect, useRef, useState } from "react";
import { describeDiagram } from "../../../../src/core/diagrams.ts";
import { type DiagramResult, type MermaidLike, type ThemeVars, THEME_TOKENS, ZOOMS, accOf, diagramLabel, explainDiagramError, fitDiagram, kindName, renderDiagram, zoomStep } from "./diagram";

// Mermaid is ~1 MB of JS, so it's only fetched when a diagram is near the viewport (§6.4).
let mermaid: Promise<MermaidLike> | null = null;
const loadMermaid = () => (mermaid ??= import("mermaid").then((m) => m.default as unknown as MermaidLike));

/** A token as hex, through a canvas pixel: Mermaid can't read var() or oklch (§6.2). */
function hexOf(token: string): string {
  const el = document.createElement("i");
  el.style.color = `var(${token})`;
  document.body.appendChild(el);
  const col = getComputedStyle(el).color;
  el.remove();
  const c = document.createElement("canvas");
  c.width = c.height = 1;
  const x = c.getContext("2d");
  if (!x) return "#888888";
  x.fillStyle = col;
  x.fillRect(0, 0, 1, 1);
  const d = x.getImageData(0, 0, 1, 1).data;
  return "#" + [d[0], d[1], d[2]].map((n) => n.toString(16).padStart(2, "0")).join("");
}

function readTheme(): { dark: boolean; vars: ThemeVars } {
  const dark = !document.documentElement.classList.contains("light");
  const vars: ThemeVars = { darkMode: dark, fontFamily: '"Inter Variable", Inter, sans-serif', fontSize: "13px" };
  const seen = new Map<string, string>();
  for (const [k, t] of Object.entries(THEME_TOKENS)) {
    if (!seen.has(t)) seen.set(t, hexOf(t));
    vars[k] = seen.get(t)!;
  }
  return { dark, vars };
}

/** The theme, re-read when light/dark flips: every diagram re-renders with new variables (no transition). */
function useTheme() {
  const [t, setT] = useState(readTheme);
  useEffect(() => {
    const obs = new MutationObserver(() =>
      setT((prev) => {
        const next = readTheme();
        return next.dark === prev.dark && JSON.stringify(next.vars) === JSON.stringify(prev.vars) ? prev : next;
      }),
    );
    obs.observe(document.documentElement, { attributes: true, attributeFilter: ["class"] });
    return () => obs.disconnect();
  }, []);
  return t;
}

/** True once the element is within 600px of the viewport. */
function useNear(ref: React.RefObject<HTMLElement | null>) {
  const [near, setNear] = useState(typeof IntersectionObserver === "undefined");
  useEffect(() => {
    if (near || !ref.current) return;
    const r = ref.current.getBoundingClientRect();
    if (r.bottom > -600 && r.top < innerHeight + 600 && (r.width || r.height)) return setNear(true);
    const io = new IntersectionObserver((es) => es.some((e) => e.isIntersecting) && setNear(true), { rootMargin: "600px" });
    io.observe(ref.current);
    return () => io.disconnect();
  }, [near, ref]);
  return near;
}

/** Renders `code` (debounced by `delay`), keeping the last version that worked. `now` bumps force a draw. */
function useRender(code: string, o: { active: boolean; delay: number; now?: number }) {
  const theme = useTheme();
  const [res, setRes] = useState<DiagramResult | null>(null);
  const last = useRef<{ svg: string; code: string } | null>(null);
  const nowSeen = useRef(o.now);
  useEffect(() => {
    if (!o.active) return;
    let live = true;
    const forced = o.now !== nowSeen.current;
    nowSeen.current = o.now;
    const t = setTimeout(
      () => {
        renderDiagram(code, { dark: theme.dark, theme: theme.vars, load: loadMermaid }).then((r) => {
          // Mermaid leaves a scratch node behind when a render fails.
          document.getElementById(`d${r.id}`)?.remove();
          if (!live) return;
          if (r.ok) last.current = { svg: r.svg, code };
          setRes(r);
        });
      },
      forced || res === null ? 0 : o.delay,
    );
    return () => {
      live = false;
      clearTimeout(t);
    };
  }, [code, theme, o.active, o.now]); // eslint-disable-line react-hooks/exhaustive-deps
  return { res, last: res?.ok ? { svg: res.svg, code } : last.current };
}

/** Puts Mermaid's SVG in `host`, labels it (§8) and sizes it (§6.3). Returns the natural size. */
function mountSvg(host: HTMLElement, svg: string, code: string) {
  host.innerHTML = svg; // Mermaid output is sanitized (securityLevel: "strict").
  const s = host.querySelector("svg");
  if (!s) return { w: 0, h: 0, s: null };
  s.setAttribute("role", "img");
  s.setAttribute("aria-label", diagramLabel(code, svg));
  s.removeAttribute("style");
  const vb = s.viewBox?.baseVal;
  return { w: vb?.width || s.getBoundingClientRect().width, h: vb?.height || s.getBoundingClientRect().height, s };
}

function Svg({ svg, code, fit, onFit, zoom }: { svg: string; code: string; fit?: "column" | "width"; zoom?: number; onFit?: (f: { breakout: boolean; crop: boolean }) => void }) {
  const ref = useRef<HTMLDivElement>(null);
  const [w, setW] = useState(0);
  useLayoutEffect(() => {
    const host = ref.current;
    if (!host) return;
    const { w: nw, h: nh, s } = mountSvg(host, svg, code);
    if (!s) return;
    let scale = 1;
    if (zoom) scale = zoom / 100;
    else {
      const fig = host.closest<HTMLElement>(".mm5,.sgb5,.rmb,.lp5") ?? host.parentElement!;
      const pad = 36;
      const col = (fig.parentElement?.clientWidth ?? fig.clientWidth) - pad;
      const doc = host.closest<HTMLElement>(".doc")?.clientWidth ?? col + pad;
      const f = fitDiagram({ w: nw, h: nh }, { col, wide: Math.min(col + 160, doc - pad), fit: fit === "width" });
      scale = f.scale;
      onFit?.({ breakout: f.breakout && doc - pad > col + 20, crop: f.crop });
    }
    s.style.width = `${nw * scale}px`;
    s.style.height = `${nh * scale}px`;
  }, [svg, code, zoom, fit, w]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    if (zoom) return;
    const on = () => setW(innerWidth);
    addEventListener("resize", on);
    return () => removeEventListener("resize", on);
  }, [zoom]);
  return <div className="mmw" ref={ref} />;
}

/** Four still bars joined by lines: the size of a diagram, no shimmer (§6.4). */
function Placeholder({ text = "Loading diagram…" }: { text?: string }) {
  return (
    <div className="ph5" aria-busy="true">
      <div className="phb" aria-hidden="true">
        <span style={{ width: 96 }} />
        <i />
        <span style={{ width: 120 }} />
        <i />
        <span style={{ width: 88 }} />
        <i />
        <span style={{ width: 104 }} />
      </div>
      <div className="ph5-t">{text}</div>
    </div>
  );
}

/** 8 lines of a broken source, the bad line tinted and always shown (§6.5). */
function Source({ code, bad }: { code: string; bad?: number }) {
  const lines = code.split("\n");
  const from = bad && bad > 8 ? Math.min(bad - 4, lines.length - 8) : 0;
  return (
    <div className="src5 ro">
      {from > 0 ? <div className="more5">{from} lines above</div> : null}
      {lines.slice(from, from + 8).map((l, j) => {
        const n = from + j + 1;
        return (
          <div key={n} className={bad === n ? "bad" : undefined}>
            <span className="ln">{n}</span>
            <span className={`tx${bad === n ? " errl" : ""}`}>{l || " "}</span>
          </div>
        );
      })}
      {lines.length > from + 8 ? <div className="more5">{lines.length - from - 8} more lines</div> : null}
    </div>
  );
}

function useSaid(text: string) {
  const [said, setSaid] = useState("");
  useEffect(() => {
    const t = setTimeout(() => setSaid(text), 1000);
    return () => clearTimeout(t);
  }, [text]);
  return said;
}

/**
 * A ```mermaid block in the rich view (§6). A tab stop: Enter edits the source, F opens full
 * screen. Wide diagrams break out to 820px, then scale to the floor, then crop with a bar.
 * Styling hooks: `figure.mm5[data-state=loading|ok|error]`, `.brk`, `.crop`, `.ovb`, `.err5`, `.tapz`.
 */
export function Diagram({ code, onEdit, bare = false }: { code: string; onEdit?: () => void; bare?: boolean }) {
  const mobile = useMobile();
  const ref = useRef<HTMLElement>(null);
  const near = useNear(ref);
  const { res, last } = useRender(code, { active: near, delay: 120 });
  const [fitState, setFit] = useState({ breakout: false, crop: false });
  const [full, setFull] = useState(false);
  const [details, setDetails] = useState(false);
  const hint = useId();
  const { title } = accOf(code);
  const explained = res && !res.ok ? explainDiagramError(code, res.error) : null;
  const said = useSaid(explained ? `This diagram can't be drawn. ${explained.message}` : "");
  const state = res === null ? "loading" : res.ok ? "ok" : "error";
  const ok = res?.ok ? res.svg : null;

  const body =
    res === null ? (
      <Placeholder />
    ) : ok ? (
      <Svg svg={ok} code={code} fit={mobile ? "width" : "column"} onFit={(f) => (f.breakout !== fitState.breakout || f.crop !== fitState.crop) && setFit(f)} />
    ) : (
      <div className="err5">
        <div className="eh">
          <IAlert s={16} />
          <div>
            <b>This diagram can't be drawn</b>
            <span>{explained?.message}</span>
          </div>
          {onEdit ? (
            <button type="button" className="btn soft sm" onClick={(e) => (e.stopPropagation(), onEdit())}>
              <IEdit s={14} />
              Edit source
            </button>
          ) : null}
        </div>
        <Source code={code} bad={explained?.line} />
        <button type="button" className="btn quiet sm mmd-dt" aria-expanded={details} onClick={(e) => (e.stopPropagation(), setDetails(!details))}>
          Details
        </button>
        {details && res && !res.ok ? <pre className="mmd-det">{res.error}</pre> : null}
      </div>
    );
  if (bare)
    return (
      <div className="mmb5" ref={ref as React.RefObject<HTMLDivElement>}>
        {body}
      </div>
    );
  const openFull = () => ok && setFull(true);
  return (
    <figure
      ref={ref}
      className={`mmd mm5${fitState.breakout && ok && !mobile ? " brk" : ""}${fitState.crop && ok && !mobile ? " crop" : ""}`}
      data-state={state}
      data-testid="diagram"
      tabIndex={ok ? 0 : undefined}
      aria-roledescription={ok ? "diagram" : undefined}
      aria-label={ok ? `${kindName(code)}${title ? `: ${title}` : ""}` : undefined}
      aria-describedby={ok ? hint : undefined}
      aria-busy={res === null || undefined}
      onClick={
        mobile && ok
          ? (e) => {
              e.stopPropagation();
              openFull();
            }
          : undefined
      }
      onKeyDown={(e) => {
        if (e.target !== e.currentTarget || e.metaKey || e.ctrlKey || e.altKey) return;
        if (e.key === "Enter" && onEdit) {
          e.preventDefault();
          e.stopPropagation();
          onEdit();
        } else if (e.key.toLowerCase() === "f" && ok) {
          e.preventDefault();
          openFull();
        }
      }}
    >
      {body}
      {ok && title ? <figcaption>{title}</figcaption> : null}
      {ok ? (
        <div className="ovb">
          <span>Showing part of this diagram</span>
          <button type="button" className="btn quiet sm" onClick={(e) => (e.stopPropagation(), openFull())}>
            <IMax s={14} />
            Open full screen
          </button>
        </div>
      ) : null}
      {ok ? (
        <span id={hint} className="sr-only">
          {onEdit ? "Enter edits the source. " : ""}F opens full screen.
        </span>
      ) : null}
      <span className="sr-only" role="status">
        {said}
      </span>
      {ok && mobile ? (
        <button type="button" className="tapz" onClick={(e) => (e.stopPropagation(), openFull())}>
          <IMax s={12} />
          Tap to zoom
        </button>
      ) : ok ? (
        <div className="mmd-f act">
          {onEdit ? (
            <button type="button" className="icon-btn" aria-label="Edit source" title="Edit source" tabIndex={-1} onClick={(e) => (e.stopPropagation(), onEdit())}>
              <IEdit s={16} />
            </button>
          ) : null}
          <button type="button" className="icon-btn" aria-label="Full screen" title="Full screen" tabIndex={-1} onClick={(e) => (e.stopPropagation(), openFull())}>
            <IMax s={16} />
          </button>
        </div>
      ) : null}
      {full && ok && last ? (
        <FullScreen
          code={code}
          svg={ok}
          mobile={mobile}
          onEdit={onEdit}
          onClose={() => {
            setFull(false);
            requestAnimationFrame(() => ref.current?.focus());
          }}
        />
      ) : null}
    </figure>
  );
}

/**
 * Full screen (§7): Diagram | Text, zoom 50–300% in steps, drag/arrows to pan, + − 0, Esc closes
 * and returns focus to the figure. The SVG is resized at each zoom (crisp, not a CSS scale).
 */
export function FullScreen({ code, svg, mobile, onEdit, onClose }: { code: string; svg: string; mobile: boolean; onEdit?: () => void; onClose: () => void }) {
  const [view, setView] = useState<"diagram" | "text">("diagram");
  const body = useRef<HTMLDivElement>(null);
  const nat = useRef({ w: 0, h: 0 });
  const [zoom, setZoom] = useState(mobile ? 100 : 150);
  const [pan, setPan] = useState({ x: 0, y: 0 });
  const fitZoom = () => {
    const b = body.current;
    const { w, h } = nat.current;
    if (!b || !w) return 100;
    return Math.max(10, Math.floor(Math.min((b.clientWidth - 48) / w, (b.clientHeight - 48) / h) * 100));
  };
  // Opens at 150% on desktop, or Fit when Fit is smaller; 100% on phones.
  useLayoutEffect(() => {
    const host = document.createElement("div");
    host.style.cssText = "position:absolute;visibility:hidden";
    document.body.appendChild(host);
    const { w, h } = mountSvg(host, svg, code);
    host.remove();
    nat.current = { w, h };
    if (!mobile) setZoom((z) => Math.min(z, fitZoom()));
  }, [svg]); // eslint-disable-line react-hooks/exhaustive-deps
  const step = (d: 1 | -1) => setZoom((z) => zoomStep(z, d));
  const fit = () => {
    setZoom(fitZoom());
    setPan({ x: 0, y: 0 });
  };
  const drag = useRef<{ x: number; y: number; px: number; py: number } | null>(null);
  const d = describeDiagram(code);
  const { title, descr } = accOf(code);
  const kind = kindName(code);
  const isState = d.kind === "state";
  const counts = isState
    ? `State diagram · ${d.shapes.length} ${d.shapes.length === 1 ? "state" : "states"}, ${d.edges.length} ${d.edges.length === 1 ? "transition" : "transitions"}`
    : `${kind} · ${d.shapes.length} ${d.shapes.length === 1 ? "shape" : "shapes"}, ${d.edges.length} ${d.edges.length === 1 ? "arrow" : "arrows"}`;
  return (
    <Dialog.Root open onOpenChange={(o) => !o && onClose()}>
      <Dialog.Portal>
        <Dialog.Overlay className="scrim fsx" onClick={(e) => e.stopPropagation()} />
        <Dialog.Content
          className={`fs5${mobile ? " m" : ""}`}
          aria-describedby={undefined}
          onCloseAutoFocus={(e) => e.preventDefault()}
          onClick={(e) => e.stopPropagation()}
          onKeyDown={(e) => {
            if (view !== "diagram" || (e.target as HTMLElement).closest("button,[role=radio]")) {
              if (!(e.key === "+" || e.key === "=" || e.key === "-" || e.key === "0")) return;
            }
            const k = e.key;
            if (k === "+" || k === "=") step(1);
            else if (k === "-") step(-1);
            else if (k === "0") fit();
            else if (k.startsWith("Arrow") && view === "diagram") {
              const dx = k === "ArrowLeft" ? 40 : k === "ArrowRight" ? -40 : 0;
              const dy = k === "ArrowUp" ? 40 : k === "ArrowDown" ? -40 : 0;
              setPan((p) => ({ x: p.x + dx, y: p.y + dy }));
            } else return;
            e.preventDefault();
          }}
        >
          <div className="fh">
            <Dialog.Title asChild>
              <b>{title || kind}</b>
            </Dialog.Title>
            <div className="seg2" role="radiogroup" aria-label="View">
              {(["diagram", "text"] as const).map((v) => (
                <button key={v} type="button" role="radio" aria-checked={view === v} onClick={() => setView(v)}>
                  {v === "diagram" ? "Diagram" : "Text"}
                </button>
              ))}
            </div>
            <span className="sp" />
            {view === "diagram" && !mobile ? <Zoom zoom={zoom} step={step} fit={fit} /> : null}
            {onEdit && !mobile ? (
              <button
                type="button"
                className="btn quiet sm"
                onClick={() => {
                  onClose();
                  onEdit();
                }}
              >
                <IEdit s={14} />
                Edit source
              </button>
            ) : null}
            <Dialog.Close asChild>
              <button type="button" className="icon-btn" aria-label="Close full screen">
                <IX s={18} />
              </button>
            </Dialog.Close>
          </div>
          {view === "diagram" ? (
            <div
              ref={body}
              className="fsb"
              data-testid="fs-body"
              tabIndex={0}
              role="group"
              aria-label={`${kind}${title ? `: ${title}` : ""}, ${zoom}%`}
              onPointerDown={(e) => {
                drag.current = { x: e.clientX, y: e.clientY, px: pan.x, py: pan.y };
                e.currentTarget.setPointerCapture?.(e.pointerId);
              }}
              onPointerMove={(e) => {
                const g = drag.current;
                if (g) setPan({ x: g.px + e.clientX - g.x, y: g.py + e.clientY - g.y });
              }}
              onPointerUp={() => (drag.current = null)}
              onWheel={(e) => {
                if (!(e.metaKey || e.ctrlKey)) return;
                e.preventDefault();
                step(e.deltaY < 0 ? 1 : -1);
              }}
            >
              <div className="pan5" style={{ transform: `translate(${pan.x}px, ${pan.y}px)` }}>
                <Svg svg={svg} code={code} zoom={zoom} />
              </div>
            </div>
          ) : (
            <div className="fsb tv" data-testid="fs-text">
              <div className="tvc">
                {descr ? <p className="ds">{descr}</p> : null}
                <h4>{counts}</h4>
                <ol>
                  {d.edges.map((x, i) => (
                    <li key={i}>
                      <span>{x.from}</span>
                      {x.label ? <span className="ar">· {x.label}</span> : null}
                      <span className="ar">→</span>
                      <span>{x.to}</span>
                    </li>
                  ))}
                </ol>
              </div>
            </div>
          )}
          {mobile ? (
            <div className="mzb">{view === "diagram" ? <Zoom zoom={zoom} step={step} fit={fit} /> : <span />}</div>
          ) : (
            <div className="fhint" aria-hidden="true">
              <span>Drag to pan</span>
              <span>
                <span className="kb4">⌘</span>scroll or pinch to zoom
              </span>
              <span>
                <span className="kb4">0</span>fit
              </span>
              <span>
                <span className="kb4">Esc</span>close
              </span>
            </div>
          )}
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

function Zoom({ zoom, step, fit }: { zoom: number; step: (d: 1 | -1) => void; fit: () => void }) {
  return (
    <div className="zg" role="group" aria-label="Zoom">
      <button type="button" className="icon-btn" aria-label="Zoom out" aria-keyshortcuts="-" disabled={zoom <= ZOOMS[0]} onClick={() => step(-1)}>
        <IMinus s={16} />
      </button>
      <span className="zv" aria-live="polite">
        {zoom}%
      </span>
      <button type="button" className="icon-btn" aria-label="Zoom in" aria-keyshortcuts="+" disabled={zoom >= ZOOMS.at(-1)!} onClick={() => step(1)}>
        <IPlus s={16} />
      </button>
      <button type="button" className="btn quiet sm" aria-keyshortcuts="0" onClick={fit}>
        Fit
      </button>
    </div>
  );
}

/**
 * The live preview under a diagram's block editor (§9): redraws 300ms after typing (or at once
 * with `now`), swaps in one frame, waits 1s before showing an error, then dims the last good
 * version to 38% with "Last version that worked".
 */
export function LivePreview({ code, now, onError }: { code: string; now: number; onError?: (e: { line?: number; message: string; raw: string } | null) => void }) {
  const { res, last } = useRender(code, { active: true, delay: 300, now });
  const [late, setLate] = useState<DiagramResult | null>(null);
  useEffect(() => {
    if (res && !res.ok) {
      const t = setTimeout(() => setLate(res), 1000);
      return () => clearTimeout(t);
    }
    setLate(res);
  }, [res]);
  const bad = late && !late.ok ? late : null;
  useEffect(() => {
    onError?.(bad ? { ...explainDiagramError(code, bad.error), raw: bad.error } : null);
  }, [bad?.error]); // eslint-disable-line react-hooks/exhaustive-deps
  return (
    <div className={`lp5${bad ? " dim" : ""}`} data-testid="live-preview">
      <div className="lbl">{bad && last ? "Last version that worked" : "Preview"}</div>
      {last ? <Svg svg={last.svg} code={last.code} fit="width" /> : res === null ? <Placeholder text="Drawing…" /> : <div className="lp5-none">Nothing to show yet</div>}
    </div>
  );
}
