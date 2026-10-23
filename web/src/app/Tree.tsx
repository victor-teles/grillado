// Decision tree (side panel / confirm / plating), heat meter, legend and the mobile strip.
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { IChev, IFlame, IX } from "./icons";
import type { DecisionNode, HeatLevel, TreeState } from "./types";

export const HEAT_WORDS: Record<HeatLevel, string> = { 1: "Warming up", 2: "Taking shape", 3: "Coming together", 4: "Nearly there", 5: "Ready to confirm" };

export function Heat({ tree, compact }: { tree: TreeState; compact?: boolean }) {
  const lv = tree.heat;
  const { settled, open } = tree.counts;
  const word = settled + open === 0 ? HEAT_WORDS[1] : HEAT_WORDS[lv];
  const lit = settled + open === 0 ? 0 : lv;
  if (compact)
    return (
      <span className="mseg" aria-hidden="true">
        {[0, 1, 2, 3, 4].map((i) => (
          <span key={i} style={i < lit ? { background: SEG[i] } : undefined} />
        ))}
      </span>
    );
  return (
    <section className="heat" aria-label="Heat" data-testid="heat" data-level={lit}>
      <div className="heat-top">
        <span className="t">
          <IFlame s={14} />
          Heat
        </span>
        <span className="heat-lv" key={word} aria-live="polite">
          {word}
        </span>
      </div>
      <div className="segs" aria-hidden="true">
        {[0, 1, 2, 3, 4].map((i) => (
          <span key={i} className="seg" data-on={i < lit ? "" : undefined} data-top={i === lit - 1 ? "" : undefined}>
            <i />
            <span className="gl" />
          </span>
        ))}
      </div>
      <div className="heat-c">
        <span>
          <b>{settled}</b> settled
        </span>
        <span>·</span>
        <span>
          <b>{open}</b> open
        </span>
      </div>
    </section>
  );
}
export const SEG = ["oklch(0.8 0.13 80)", "oklch(0.78 0.15 68)", "oklch(0.75 0.16 58)", "oklch(0.7 0.18 45)", "oklch(0.65 0.2 32)"];

export function Legend() {
  return (
    <ul className="legend" aria-label="Legend">
      <li>
        <i className="lg s" aria-hidden="true" />
        Settled
      </li>
      <li>
        <i className="lg f" aria-hidden="true" />
        Open now
      </li>
      <li>
        <i className="lg b" aria-hidden="true" />
        Waiting
      </li>
      <li>
        <i className="lg x" aria-hidden="true" />
        Re-ask
      </li>
    </ul>
  );
}

function subline(n: DecisionNode, isRoot: boolean) {
  if (isRoot) return "Your idea";
  switch (n.status) {
    case "settled":
      return `${n.answer?.label ?? ""}${n.answer?.reopened ? " · reopened" : ""}`;
    case "frontier":
      return "In this round";
    case "stale":
      return `Re-ask · ${n.staleReason ?? "will be asked again"}`;
    case "blocked":
      return n.waitsOn?.length ? `Waits on ${n.waitsOn.join(", ")}` : "Waiting";
    default:
      return "";
  }
}

type EdgePath = { id: string; d: string; kind: "f" | "b" | "s" };

export function DecisionTree({
  tree,
  compact,
  dim,
  previewStale,
  highlight,
  onNode,
  label = "Decision tree",
}: {
  tree: TreeState;
  compact?: boolean;
  dim?: boolean;
  previewStale?: Set<string>;
  highlight?: string;
  onNode?: (n: DecisionNode) => void;
  label?: string;
}) {
  const wrap = useRef<HTMLDivElement>(null);
  const list = useRef<HTMLUListElement>(null);
  const [edges, setEdges] = useState<EdgePath[]>([]);
  const [size, setSize] = useState({ w: 0, h: 0 });
  const [focusId, setFocusId] = useState<string>(tree.rootId);
  const seen = useRef<Set<string> | null>(null);
  const nodes = tree.nodes;
  const byId = useMemo(() => new Map(nodes.map((n) => [n.id, n])), [nodes]);
  // Nodes that weren't there on the previous render sprout in.
  const fresh = useMemo(() => {
    const prev = seen.current;
    const out = new Set<string>();
    if (prev) for (const n of nodes) if (!prev.has(n.id)) out.add(n.id);
    return out;
  }, [nodes]);
  useEffect(() => {
    seen.current = new Set(nodes.map((n) => n.id));
  }, [nodes]);

  useLayoutEffect(() => {
    const ul = list.current;
    if (!ul) return;
    const measure = () => {
      const base = ul.getBoundingClientRect();
      const dot = (id: string) => ul.querySelector<HTMLElement>(`[data-node="${CSS.escape(id)}"] .nd`)?.getBoundingClientRect();
      const out: EdgePath[] = [];
      for (const n of nodes) {
        if (!n.parentId) continue;
        const p = dot(n.parentId);
        const c = dot(n.id);
        if (!p || !c) continue;
        const px = p.left + p.width / 2 - base.left;
        const py = p.bottom - base.top;
        const cx = c.left - base.left - 2;
        const cy = c.top + c.height / 2 - base.top;
        const status = previewStale?.has(n.id) ? "stale" : n.status;
        const kind = status === "frontier" ? "f" : status === "blocked" || status === "stale" ? "b" : "s";
        out.push({ id: n.id, d: `M ${px},${py + 1} V ${cy - 6} Q ${px},${cy} ${px + 6},${cy} H ${cx}`, kind });
      }
      setEdges(out);
      setSize({ w: ul.scrollWidth, h: ul.scrollHeight });
    };
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(ul);
    return () => ro.disconnect();
  }, [nodes, previewStale, compact]);

  const ids = nodes.map((n) => n.id);
  const move = (to: string | undefined) => {
    if (!to) return;
    setFocusId(to);
    list.current?.querySelector<HTMLElement>(`[data-node="${CSS.escape(to)}"]`)?.focus();
  };
  const onKey = (e: React.KeyboardEvent, n: DecisionNode) => {
    const i = ids.indexOf(n.id);
    if (e.key === "ArrowDown") move(ids[i + 1]);
    else if (e.key === "ArrowUp") move(ids[i - 1]);
    else if (e.key === "Home") move(ids[0]);
    else if (e.key === "End") move(ids.at(-1));
    else if (e.key === "ArrowLeft" && n.parentId) move(n.parentId);
    else if ((e.key === "Enter" || e.key === " ") && onNode) onNode(n);
    else return;
    e.preventDefault();
    e.stopPropagation();
  };
  const indent = compact ? 12 : 18;
  let k = 0;
  return (
    <div ref={wrap} className={`tree${compact ? " zo" : ""}${dim ? " dim" : ""}`}>
      <div style={{ position: "relative" }}>
        <svg className="edges" width={size.w} height={size.h} aria-hidden="true">
          {edges.map((e) => (
            <path
              key={e.id}
              d={e.d}
              fill="none"
              strokeWidth={1.5}
              stroke={e.kind === "f" ? "var(--gr-ember)" : "var(--border-strong)"}
              strokeOpacity={e.kind === "f" ? 0.55 : 1}
              strokeDasharray={e.kind === "b" ? "3 3" : undefined}
            />
          ))}
        </svg>
        <ul ref={list} role="tree" aria-label={label}>
          {nodes.map((n) => {
            const isRoot = n.id === tree.rootId;
            const status = previewStale?.has(n.id) ? "stale" : n.status;
            const shown = { ...n, status, staleReason: previewStale?.has(n.id) ? "will be asked again" : n.staleReason };
            const isNew = fresh.has(n.id);
            const sub = subline(shown, isRoot);
            return (
              <li
                key={n.id}
                data-node={n.id}
                role="treeitem"
                aria-level={n.depth + 1}
                tabIndex={focusId === n.id || (!byId.has(focusId) && isRoot) ? 0 : -1}
                className={`node ${isRoot ? "idea" : `st-${status}`}`}
                data-hl={highlight === n.id ? "" : undefined}
                data-new={isNew ? "" : undefined}
                data-preview={previewStale?.has(n.id) ? "" : undefined}
                style={{ marginLeft: n.depth * indent, ...(isNew ? { ["--k" as string]: k++ } : {}) }}
                onKeyDown={(e) => onKey(e, n)}
                onFocus={() => setFocusId(n.id)}
                onClick={() => onNode?.(n)}
              >
                <span className="nd" aria-hidden="true">
                  <span className="gl" />
                  <span className="rg" />
                  <span className="f" />
                </span>
                <span style={{ minWidth: 0 }}>
                  <span className="nl">{n.label}</span>
                  {sub ? (
                    <span className="ns">
                      <span className="sr-only">, </span>
                      {sub}
                    </span>
                  ) : null}
                </span>
                {status === "frontier" && n.questionIndex !== undefined ? (
                  <span className="qt">
                    <span className="sr-only">, </span>Q{n.questionIndex + 1}
                  </span>
                ) : (
                  <span />
                )}
              </li>
            );
          })}
        </ul>
      </div>
    </div>
  );
}

/** Desktop side panel; on mobile the same panel opens as a bottom sheet. */
export function SidePanel({
  tree,
  sub,
  sheetOpen,
  onCloseSheet,
  onNode,
  compact,
  previewStale,
  highlight,
  showHeat = true,
  showLegend = true,
  dim,
}: {
  tree: TreeState;
  sub: string;
  sheetOpen?: boolean;
  onCloseSheet?: () => void;
  onNode?: (n: DecisionNode) => void;
  compact?: boolean;
  previewStale?: Set<string>;
  highlight?: string;
  showHeat?: boolean;
  showLegend?: boolean;
  dim?: boolean;
}) {
  const closeRef = useRef<HTMLButtonElement>(null);
  // An open sheet is a dialog; <aside> can't take role="dialog".
  const SideTag = sheetOpen ? "div" : "aside";
  useEffect(() => {
    if (!sheetOpen) return;
    closeRef.current?.focus();
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onCloseSheet?.();
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [sheetOpen, onCloseSheet]);
  return (
    <>
      {sheetOpen ? <button type="button" className="sheet-scrim only-m" aria-label="Close decisions" tabIndex={-1} onClick={onCloseSheet} /> : null}
      <SideTag
        className="side"
        aria-labelledby="side-title"
        data-sheet={sheetOpen ? "" : undefined}
        role={sheetOpen ? "dialog" : undefined}
        aria-modal={sheetOpen ? true : undefined}
        id="decisions-panel"
      >
        <div className="side-h">
          <h2 id="side-title">Decisions</h2>
          <span style={{ display: "flex", gap: 8, alignItems: "center" }}>
            <span className="sub mono">{sub}</span>
            {sheetOpen ? (
              <button ref={closeRef} type="button" className="ghost x" aria-label="Close" onClick={onCloseSheet}>
                <IX s={14} />
              </button>
            ) : null}
          </span>
        </div>
        {showHeat ? <Heat tree={tree} /> : <span />}
        <DecisionTree tree={tree} compact={compact} onNode={onNode} previewStale={previewStale} highlight={highlight} dim={dim} />
        {showLegend ? <Legend /> : <span />}
      </SideTag>
    </>
  );
}

export function MobileStrip({ tree, open, onToggle }: { tree: TreeState; open: boolean; onToggle: () => void }) {
  const word = HEAT_WORDS[tree.heat];
  const dots = tree.nodes.filter((n) => n.id !== tree.rootId).slice(0, 28);
  return (
    <div className="mstrip only-m">
      <div style={{ minWidth: 0 }}>
        <div className="row1">
          <Heat tree={tree} compact />
          <span className="ember" style={{ fontWeight: 600 }}>
            {word}
          </span>
          <span>
            · {tree.counts.settled} settled · {tree.counts.open} open
          </span>
        </div>
        <div className="mdots" aria-hidden="true">
          {dots.map((n) => (
            <i key={n.id} className={{ settled: "s", frontier: "f", blocked: "b", stale: "x", idea: "s" }[n.status]} />
          ))}
        </div>
      </div>
      <button type="button" className="open" aria-expanded={open} aria-controls="decisions-panel" onClick={onToggle}>
        Decisions
        <IChev s={14} style={{ transform: "rotate(90deg)" }} />
      </button>
    </div>
  );
}
