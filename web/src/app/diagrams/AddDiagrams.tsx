// Item 5: Add diagrams. The ⋯ entry and its popover (sheet on phones), the run bar in the review
// bar's slot, the inline "drawing" row, the nothing-drawn toast and the failure bar (§2–4).
// Styling hooks: .pop5 .ask5 .ck5 .in5 .run5 .bad5 .drw .
import { type ReactNode, type RefObject, useEffect, useId, useMemo, useRef, useState } from "react";
import { DropdownMenuItem, DropdownMenuSeparator } from "@/components/ui/dropdown-menu";
import { type DiagramKind, DIAGRAM_KINDS, planSections, suggestedCode } from "../../../../src/core/diagrams.ts";
import { reasonText } from "../../../../src/core/reason.ts";
import { openActivity } from "../activity/Activity";
import { api } from "../api";
import type { PlanDraft } from "../editor/PlanEditor";
import type { MermaidLike } from "../editor/diagram";
import { IAlert, ICheck, IShape, ISq, IX } from "../icons";
import type { SessionView } from "../types";

const MOD = /Mac|iPhone|iPad/.test(globalThis.navigator?.platform ?? "") ? "⌘" : "Ctrl+";
const KIND_LABEL: Record<DiagramKind, string> = { flowchart: "Flowcharts", state: "State diagrams" };
const fill = (t: string, agent: string) => t.replace(/\{agent\}/g, agent);

export const DCOPY = {
  menu: "Add diagrams…",
  busy: "{agent} is already adding diagrams",
  title: "Add diagrams",
  desc: "{agent} suggests flowcharts and state diagrams where they make the plan clearer. Nothing changes until you accept them.",
  hasDiagram: "Has a diagram",
  oneKind: "At least one kind",
  focus: "Anything to focus on?",
  focusPh: "e.g. what happens offline",
  note: "At most one diagram per section. {agent} skips sections a diagram wouldn't help.",
  running: "{agent} is adding diagrams",
  count: (d: number, n: number) => `${d} of ${n} ${n === 1 ? "section" : "sections"}`,
  drawing: (s: string) => `{agent} is drawing a diagram for “${s}”`,
  arrived: (s: string) => `Diagram added for ${s}`,
  none: "No diagrams: {agent} found nothing a diagram would make clearer",
  nothing: "Nothing was changed",
  stopped: "Stopped",
};

let mermaid: Promise<MermaidLike> | null = null;
const loadMermaid = () => (mermaid ??= import("mermaid").then((m) => m.default as unknown as MermaidLike));

export function useDiagrams(o: { session: SessionView; draft: PlanDraft; agentName: string; mobile: boolean; enabled: boolean; moreRef: RefObject<HTMLButtonElement | null>; setNote: (t: string) => void }) {
  const { session, draft, agentName, mobile } = o;
  const A = (t: string) => fill(t, agentName);
  const run = session.diagramRun;
  const drawing = !!session.drawing;
  const [open, setOpen] = useState(false);
  const [live, setLive] = useState("");
  const [dismissed, setDismissed] = useState<string | null>(null);

  const post = async (body: Record<string, unknown>) => {
    try {
      await draft.flush();
      await api.action(session.id, "diagrams", body);
      return true;
    } catch (e) {
      o.setNote(String((e as Error).message));
      return false;
    }
  };

  // The browser draws with real Mermaid: a suggestion it can't parse never shows (counts as skipped, #40).
  const checked = useRef(new Set<string>());
  useEffect(() => {
    for (const s of session.suggestions ?? []) {
      if (s.kind !== "diagram" || s.status !== "pending" || checked.current.has(s.id)) continue;
      checked.current.add(s.id);
      void loadMermaid()
        .then((m) => m.parse(suggestedCode(s)))
        .catch((err) => {
          if (/addHook|chunk|import/i.test(String(err?.message ?? err))) return;
          void api.action(session.id, "suggestions", { op: "drop", id: s.id }).catch(() => {});
        });
    }
  }, [session.suggestions, session.id]);

  // Announcements (debounced 1s, §8): start, each arrival, stop, end.
  const prev = useRef<{ key?: string; added: number; state?: string }>({ added: 0 });
  useEffect(() => {
    if (!run) return;
    const p = prev.current;
    let msg = "";
    if (p.key !== run.startedAt) msg = run.state === "running" ? A(DCOPY.running) : "";
    else if (run.added > p.added) msg = DCOPY.arrived(run.sections[run.done - 1] ?? "");
    else if (p.state === "running" && run.state !== "running")
      msg = run.state === "stopped" ? DCOPY.stopped : run.state === "error" ? A(reasonText(run.code, "{agent}")) : run.added ? `${run.added} ${run.added === 1 ? "diagram" : "diagrams"} from ${agentName} ready` : A(DCOPY.none);
    prev.current = { key: run.startedAt, added: run.added, state: run.state };
    if (!msg) return;
    const t = setTimeout(() => setLive(msg), 1000);
    return () => clearTimeout(t);
  }, [run?.startedAt, run?.added, run?.state]); // eslint-disable-line react-hooks/exhaustive-deps

  // ⌘K opens the popover (§2): there is no command palette in Grillado yet.
  useEffect(() => {
    const on = (e: KeyboardEvent) => {
      if (!(e.metaKey || e.ctrlKey) || e.key.toLowerCase() !== "k" || e.shiftKey || e.altKey) return;
      const t = e.target as HTMLElement | null;
      if (t?.closest("input,textarea,[contenteditable=true],.cm-editor")) return;
      if (!o.enabled || drawing) return;
      e.preventDefault();
      setOpen(true);
    };
    document.addEventListener("keydown", on);
    return () => document.removeEventListener("keydown", on);
  }, [o.enabled, drawing]);

  const menuItem = o.enabled ? (
    <>
      <DropdownMenuItem
        disabled={drawing}
        onSelect={() => setTimeout(() => setOpen(true), 0)}
        aria-describedby={drawing ? "dg-busy" : undefined}
        title={drawing ? A(DCOPY.busy) : undefined}
      >
        <IShape s={16} />
        {DCOPY.menu}
        {drawing ? (
          <span id="dg-busy" className="sr-only">
            {A(DCOPY.busy)}
          </span>
        ) : null}
      </DropdownMenuItem>
      <DropdownMenuSeparator />
    </>
  ) : null;

  const popover = open ? (
    <Ask
      md={draft.text}
      agentName={agentName}
      mobile={mobile}
      anchor={o.moreRef}
      onClose={() => {
        setOpen(false);
        requestAnimationFrame(() => o.moreRef.current?.focus());
      }}
      onSubmit={async (sections, kinds, focus) => {
        if (await post({ op: "start", sections, kinds, focus })) {
          setOpen(false);
          requestAnimationFrame(() => o.moreRef.current?.focus());
        }
      }}
    />
  ) : null;

  // The section being drawn gets a muted row at its end (§4).
  const sections = useMemo(() => planSections(draft.text), [draft.text]);
  const cur = drawing && run?.current ? sections.find((s) => s.title === run.current) : undefined;
  const inserts = cur
    ? [
        {
          key: "drawing",
          at: cur.anchorAt + cur.anchor.length,
          node: (
            <div className="drw arun" role="status" data-testid="diagram-drawing">
              {A(DCOPY.drawing(cur.title))}
            </div>
          ),
        },
      ]
    : [];

  const runKey = run?.startedAt ?? "";
  const failed = !drawing && run?.state === "error" && dismissed !== runKey;
  const none = !drawing && run?.state === "done" && run.added === 0 && dismissed !== runKey;
  useEffect(() => {
    if (!none) return;
    const t = setTimeout(() => setDismissed(runKey), 8000);
    return () => clearTimeout(t);
  }, [none, runKey]);

  let bar: ReactNode = null;
  if (drawing && run) {
    const count = DCOPY.count(run.done, run.sections.length);
    bar = mobile ? (
      <div className="mbar run5" role="status" data-testid="diagram-run">
        <div className="r1">
          <i className="live" aria-hidden="true" />
          <button type="button" className="tolog" onClick={() => openActivity({ kind: "diagrams" })}>
            <b>{A(DCOPY.running)}</b>
          </button>
          <span className="dt">{count}</span>
          <button type="button" className="btn quiet" onClick={() => void post({ op: "stop" })}>
            <ISq s={14} />
            Stop
          </button>
        </div>
      </div>
    ) : (
      <div className="review run5" role="status" data-testid="diagram-run">
        <i className="live" aria-hidden="true" />
        <button type="button" className="lb5 tolog" title="Open in Activity" onClick={() => openActivity({ kind: "diagrams" })}>
          {A(DCOPY.running)}
        </button>
        <span className="dt">{count}</span>
        <button type="button" className="btn quiet" onClick={() => void post({ op: "stop" })}>
          <ISq s={14} />
          Stop
        </button>
      </div>
    );
  } else if (failed) {
    const why = (
      <button type="button" className="lb5 tolog" title="Open in Activity" onClick={() => openActivity({ kind: "diagrams" })}>
        {A(reasonText(run?.code, "{agent}"))}
      </button>
    );
    const left = <span className="dt">{run?.added ? `${run.added} ${run.added === 1 ? "suggestion" : "suggestions"} kept` : DCOPY.nothing}</span>;
    const acts = (
      <>
        <button type="button" className="btn quiet" onClick={() => setDismissed(runKey)}>
          Dismiss
        </button>
        <button type="button" className="btn primary" onClick={() => void post({ op: "retry" })}>
          Try again
        </button>
      </>
    );
    // On a phone the reason gets the whole first row and the two buttons a row of their own (review-pr22 #2).
    bar = mobile ? (
      <div className="mbar run5 bad5" role="alert" data-testid="diagram-failed">
        <div className="r1">
          <span className="fi">
            <IAlert s={16} />
          </span>
          <span className="t5">
            {why}
            {left}
          </span>
        </div>
        <div className="r2">{acts}</div>
      </div>
    ) : (
      <div className="review run5 bad5" role="alert" data-testid="diagram-failed">
        <span className="fi">
          <IAlert s={16} />
        </span>
        {why}
        {left}
        {acts}
      </div>
    );
  } else if (none) {
    bar = (
      <div className="toast" role="status" data-testid="diagram-none">
        <ICheck s={16} />
        <span>{A(DCOPY.none)}</span>
        <button type="button" className="btn quiet" onClick={() => setDismissed(runKey)}>
          Dismiss
        </button>
      </div>
    );
  }

  return {
    menuItem,
    popover,
    open,
    bar: (
      <>
        {bar}
        <span className="sr-only" role="status" aria-live="polite">
          {live}
        </span>
      </>
    ),
    // The run bar and the failure bar take the review bar's slot.
    hideReviewBar: drawing || failed,
    inserts,
    onAgentDiagram: o.enabled ? (at: number) => void post({ op: "one", at, kinds: DIAGRAM_KINDS }) : undefined,
  };
}

function Ask(p: {
  md: string;
  agentName: string;
  mobile: boolean;
  anchor: RefObject<HTMLButtonElement | null>;
  onClose: () => void;
  onSubmit: (sections: string[], kinds: DiagramKind[], focus: string) => void;
}) {
  const A = (t: string) => fill(t, p.agentName);
  const sections = useMemo(() => planSections(p.md), [p.md]);
  const [picked, setPicked] = useState(() => new Set(sections.filter((s) => !s.diagram).map((s) => s.title)));
  const [kinds, setKinds] = useState<Set<DiagramKind>>(() => new Set(DIAGRAM_KINDS));
  const [focus, setFocus] = useState("");
  const [busy, setBusy] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const titleId = useId();
  const oneKind = useId();
  const [pos, setPos] = useState<{ top: number; right: number } | null>(null);
  useEffect(() => {
    const r = p.anchor.current?.getBoundingClientRect();
    if (r && !p.mobile) setPos({ top: r.bottom + 6, right: innerWidth - r.right });
    // Opening focuses the first checked section.
    const t = setTimeout(() => (ref.current?.querySelector<HTMLInputElement>("input[type=checkbox]:checked") ?? ref.current?.querySelector<HTMLElement>("input,button"))?.focus(), 30);
    return () => clearTimeout(t);
  }, []); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    if (p.mobile) return;
    const down = (e: PointerEvent) => {
      const t = e.target as Node;
      if (!ref.current?.contains(t) && !p.anchor.current?.contains(t)) p.onClose();
    };
    document.addEventListener("pointerdown", down);
    return () => document.removeEventListener("pointerdown", down);
  }, [p.mobile]); // eslint-disable-line react-hooks/exhaustive-deps
  const toggle = (t: string) => {
    const n = new Set(picked);
    if (n.has(t)) n.delete(t);
    else n.add(t);
    setPicked(n);
  };
  const toggleKind = (k: DiagramKind) => {
    const n = new Set(kinds);
    if (n.has(k)) {
      if (n.size === 1) return; // at least one kind stays checked
      n.delete(k);
    } else n.add(k);
    setKinds(n);
  };
  const can = picked.size > 0 && !busy;
  const submit = async () => {
    if (!can) return;
    setBusy(true);
    await p.onSubmit(
      sections.filter((s) => picked.has(s.title)).map((s) => s.title),
      DIAGRAM_KINDS.filter((k) => kinds.has(k)),
      focus.trim(),
    );
    setBusy(false);
  };
  const body = (
    <>
      <div className="grp" role="group" aria-label="Sections">
        <div className="gl">
          <span aria-hidden="true">Sections</span>
          <button type="button" className="lnk" onClick={() => setPicked(new Set())}>
            Clear all
          </button>
        </div>
        {sections.length ? (
          sections.map((s) => (
            <label key={s.start} className="ck5">
              <input type="checkbox" className="sr-only" checked={picked.has(s.title)} onChange={() => toggle(s.title)} />
              <span className={`box${picked.has(s.title) ? " on" : ""}`} aria-hidden="true">
                {picked.has(s.title) ? <ICheck s={12} /> : null}
              </span>
              <span className="l">{s.title}</span>
              {s.diagram ? <span className="tag">{DCOPY.hasDiagram}</span> : null}
            </label>
          ))
        ) : (
          <p className="nt">The plan has no sections (## headings) yet.</p>
        )}
      </div>
      <div className="grp" role="group" aria-label="Kinds">
        <div className="gl" aria-hidden="true">
          Kinds
        </div>
        <div className="kinds">
          {DIAGRAM_KINDS.map((k) => (
            <label key={k} className="ck5">
              <input
                type="checkbox"
                className="sr-only"
                checked={kinds.has(k)}
                onChange={() => toggleKind(k)}
                aria-describedby={kinds.size === 1 && kinds.has(k) ? oneKind : undefined}
              />
              <span className={`box${kinds.has(k) ? " on" : ""}`} aria-hidden="true">
                {kinds.has(k) ? <ICheck s={12} /> : null}
              </span>
              <span className="l">{KIND_LABEL[k]}</span>
            </label>
          ))}
        </div>
        <span id={oneKind} className="sr-only">
          {DCOPY.oneKind}
        </span>
      </div>
      <label className="grp">
        <span className="gl">
          <span>
            {DCOPY.focus}
            <span className="optl">Optional</span>
          </span>
        </span>
        <input className="in5" value={focus} maxLength={300} placeholder={DCOPY.focusPh} onChange={(e) => setFocus(e.target.value)} />
      </label>
      <p className="nt">{A(DCOPY.note)}</p>
    </>
  );
  const foot = (
    <div className="af">
      {p.mobile ? null : (
        <button type="button" className="btn quiet" onClick={p.onClose}>
          Cancel
        </button>
      )}
      <button type="button" className="btn primary" disabled={!can} aria-keyshortcuts="Meta+Enter" onClick={() => void submit()}>
        Add diagrams{p.mobile ? null : <span className="kb">{MOD}↵</span>}
      </button>
    </div>
  );
  const keys = (e: React.KeyboardEvent) => {
    if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      p.onClose();
    } else if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
      e.preventDefault();
      void submit();
    } else if (e.key === "Enter" && (e.target as HTMLElement).classList.contains("in5")) e.preventDefault();
  };
  if (p.mobile)
    return (
      <>
        <div className="cscrim" onClick={p.onClose} />
        <div ref={ref} className="sheet ask5 csheet" role="dialog" aria-modal="true" aria-labelledby={titleId} data-testid="add-diagrams" onKeyDown={keys}>
          <div className="grab" />
          <div className="sh">
            <b id={titleId}>{DCOPY.title}</b>
            <button type="button" className="icon-btn" aria-label="Close" onClick={p.onClose}>
              <IX s={18} />
            </button>
          </div>
          <div className="ab">
            <p className="ds">{A(DCOPY.desc)}</p>
            {body}
          </div>
          {foot}
        </div>
      </>
    );
  return (
    <div
      ref={ref}
      className="pop5 ask5"
      role="dialog"
      aria-labelledby={titleId}
      data-testid="add-diagrams"
      style={pos ? { top: pos.top, right: pos.right } : { visibility: "hidden" }}
      onKeyDown={keys}
    >
      <div className="ah">
        <b id={titleId}>{DCOPY.title}</b>
        <button type="button" className="icon-btn" aria-label="Close" onClick={p.onClose}>
          <IX s={16} />
        </button>
      </div>
      <p className="ds">{A(DCOPY.desc)}</p>
      {body}
      {foot}
    </div>
  );
}
