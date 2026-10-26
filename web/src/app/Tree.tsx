// Decision tree (rail / confirm / plating), heat meter and the mobile strip (v1.2: no legend, no edges, no glow).
import { useEffect, useMemo, useRef, useState } from "react";
import { IChev, IX } from "./icons";
import type { DecisionNode, HeatLevel, TreeState } from "./types";

export const HEAT_WORDS: Record<HeatLevel, string> = { 1: "Warming up", 2: "Taking shape", 3: "Coming together", 4: "Nearly there", 5: "Ready to confirm" };

/** "7 settled · 2 open", or "none yet" before the first decision. */
export function countsLine(tree: TreeState) {
  const { settled, open } = tree.counts;
  return settled + open === 0 ? "none yet" : `${settled} settled · ${open} open`;
}

export function Heat({ tree, compact }: { tree: TreeState; compact?: boolean }) {
  const lv = tree.heat;
  const { settled, open } = tree.counts;
  const word = settled + open === 0 ? HEAT_WORDS[1] : HEAT_WORDS[lv];
  // Before anything is settled the first segment still shows the fire is lit (v1.2 frame s-firing).
  const lit = settled + open === 0 ? 1 : lv;
  const segs = (
    <span className="seg" aria-hidden="true">
      {[0, 1, 2, 3, 4].map((i) => (
        <i key={i} className={i < lit ? "on" : undefined} />
      ))}
    </span>
  );
  if (compact) return segs;
  return (
    <section className="heat" aria-label="Heat" data-testid="heat" data-level={settled + open === 0 ? 0 : lv}>
      <span className="lv" aria-live="polite">
        {word}
      </span>
      {segs}
    </section>
  );
}

function answerText(n: DecisionNode, isRoot: boolean) {
  if (isRoot) return "";
  switch (n.status) {
    case "settled":
      return n.answer?.label ?? "";
    case "stale":
      return "Re-ask";
    default:
      return "";
  }
}
/** Status words a sighted user reads from the dot; spoken after the label. */
function srStatus(n: DecisionNode, isRoot: boolean) {
  if (isRoot) return "your idea";
  switch (n.status) {
    case "settled":
      return n.answer?.reopened ? "reopened" : "";
    case "frontier":
      return n.questionIndex !== undefined ? `in this round, question ${n.questionIndex + 1}` : "in this round";
    case "stale":
      return n.staleReason ?? "will be asked again";
    case "blocked":
      return n.waitsOn?.length ? `waits on ${n.waitsOn.join(", ")}` : "waiting";
    default:
      return "";
  }
}

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
  const list = useRef<HTMLUListElement>(null);
  const [focusId, setFocusId] = useState<string>(tree.rootId);
  const nodes = tree.nodes;
  const byId = useMemo(() => new Map(nodes.map((n) => [n.id, n])), [nodes]);

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
  return (
    <div className={`tree${compact ? " zo" : ""}${dim ? " dim" : ""}`}>
      <ul ref={list} role="tree" aria-label={label}>
        {nodes.map((n) => {
          const isRoot = n.id === tree.rootId;
          const status = previewStale?.has(n.id) ? "stale" : n.status;
          const shown = { ...n, status, staleReason: previewStale?.has(n.id) ? "will be asked again" : n.staleReason };
          const an = answerText(shown, isRoot);
          const sr = srStatus(shown, isRoot);
          return (
            <li
              key={n.id}
              data-node={n.id}
              role="treeitem"
              aria-level={n.depth + 1}
              aria-selected={highlight === n.id ? true : undefined}
              tabIndex={focusId === n.id || (!byId.has(focusId) && isRoot) ? 0 : -1}
              className={`tn ${isRoot ? "idea" : `st-${status}`}`}
              data-hl={highlight === n.id ? "" : undefined}
              data-preview={previewStale?.has(n.id) ? "" : undefined}
              style={{ ["--d" as string]: n.depth }}
              onKeyDown={(e) => onKey(e, n)}
              onFocus={() => setFocusId(n.id)}
              onClick={() => onNode?.(n)}
            >
              <span className="dot" aria-hidden="true" />
              <span className="lb">{n.label}</span>
              {an ? (
                <span className="an">
                  <span className="sr-only">, </span>
                  {an}
                </span>
              ) : null}
              {sr ? <span className="sr-only">, {sr}</span> : null}
            </li>
          );
        })}
      </ul>
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
  dim,
}: {
  tree: TreeState;
  sub?: string;
  sheetOpen?: boolean;
  onCloseSheet?: () => void;
  onNode?: (n: DecisionNode) => void;
  compact?: boolean;
  previewStale?: Set<string>;
  highlight?: string;
  showHeat?: boolean;
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
        className="rail"
        aria-labelledby="side-title"
        data-sheet={sheetOpen ? "" : undefined}
        role={sheetOpen ? "dialog" : undefined}
        aria-modal={sheetOpen ? true : undefined}
        id="decisions-panel"
      >
        {sheetOpen ? <span className="grab" aria-hidden="true" /> : null}
        <div className="rail-h">
          <h2 id="side-title">Decisions</h2>
          <span className="meta" data-testid="side-sub">
            {sub ?? countsLine(tree)}
          </span>
          {sheetOpen ? (
            <button ref={closeRef} type="button" className="icon-btn x" aria-label="Close" onClick={onCloseSheet}>
              <IX s={16} />
            </button>
          ) : null}
        </div>
        {showHeat ? <Heat tree={tree} /> : null}
        <DecisionTree tree={tree} compact={compact} onNode={onNode} previewStale={previewStale} highlight={highlight} dim={dim} />
      </SideTag>
    </>
  );
}

export function MobileStrip({ tree, open, onToggle }: { tree: TreeState; open: boolean; onToggle: () => void }) {
  const { settled, open: nOpen } = tree.counts;
  const word = settled + nOpen === 0 ? HEAT_WORDS[1] : HEAT_WORDS[tree.heat];
  return (
    <button type="button" className="mstrip only-m" aria-expanded={open} aria-controls="decisions-panel" onClick={onToggle}>
      <span className="lv">{word}</span>
      <Heat tree={tree} compact />
      <span className="c">
        <span className="sr-only">Decisions, </span>
        {countsLine(tree)}
        <IChev s={14} />
      </span>
    </button>
  );
}
