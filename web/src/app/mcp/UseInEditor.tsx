// v1.2 item 1: "Use in your editor". A popover (desktop) or bottom sheet (phones) with an Editor
// switch and one copy-ready setup per editor (handoff §1–§8, DECISIONS #88–95). It makes no
// requests: the editor starts `grillado mcp` itself, so there is no connected / not running state.
//
// Styling hooks: .ue (.pop5 | .csheet) .uh .ud .sw[role=tablist] .step .sl .well pre .k1 .cbtn .sn .alt
//   .copy-inl .ask .rq .err1 .kb1
import { type RefObject, useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from "react";
import { COPIED_MS, CopyButton, selectText } from "../CopyButton";
import { IAlert, IX } from "../icons";
import type { McpLaunch, ProviderId } from "../types";
import { EDITOR_KEYS, type EditorKey, LAST_EDITOR, defaultEditor, highlight, setups } from "./setup";

export const UCOPY = {
  title: "Use in your editor",
  menu: "Use in your editor…",
  desc: "Connect once. Your coding agent can then read your plans and decisions, start a new plan and leave comments. It runs on this computer, even when Grillado is closed.",
  notes: {
    claude: ["It adds Grillado to Claude Code for every project. Type ", "/mcp", " in Claude Code to check it’s there."],
    cursor: ["That file covers every project. If it already has ", '"mcpServers"', ", add just the ", '"grillado"', " entry."],
    codex: ["The Codex CLI, IDE extension and app all read this file. Type ", "/mcp", " in Codex to check it’s there."],
  } as Record<EditorKey, string[]>,
  ask: "Then ask {editor}",
  request: "Build the Grillado plan “{title}”.",
  homeAsk: "To build one of your Grillado plans, or to plan a new idea in Grillado. New ideas open here so you can answer the questions.",
  failLead: "Couldn’t reach the clipboard. The {what} is selected, so ",
  failPhone: "long-press it and choose Copy.",
};

const isMac = () => /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent);
const fill = (t: string, v: Record<string, string>) => t.replace(/\{(\w+)\}/g, (m, k: string) => v[k] ?? m);

/** Odd parts of a note are code. */
function Note({ parts }: { parts: string[] }) {
  return <>{parts.map((p, i) => (i % 2 ? <code key={i}>{p}</code> : p))}</>;
}

export function UseInEditor(p: {
  launch: McpLaunch;
  /** The agent in use (§7). */
  agent: ProviderId | null | undefined;
  /** From a plan: its title, for "Build the Grillado plan …". From Home: undefined. */
  planTitle?: string;
  mobile: boolean;
  anchor: RefObject<HTMLElement | null>;
  /** focus: true when focus should go back to the trigger (Esc, Close, sheet dismissals). */
  onClose: (focus: boolean) => void;
}) {
  const all = useMemo(() => setups(p.launch), [p.launch]);
  const [tab, setTab] = useState<EditorKey>(() => {
    let stored: string | null = null;
    try {
      stored = localStorage.getItem(LAST_EDITOR);
    } catch {}
    return defaultEditor(p.agent, stored);
  });
  const e = all[tab];
  const [fail, setFail] = useState<string | null>(null);
  const [live, setLive] = useState("");
  const liveT = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const ref = useRef<HTMLDivElement>(null);
  const preRef = useRef<HTMLPreElement>(null);
  const altRef = useRef<HTMLElement>(null);
  const reqRef = useRef<HTMLSpanElement>(null);
  const titleId = useId();
  const panelId = useId();
  const tabId = (k: EditorKey) => `${panelId}-${k}`;
  const [pos, setPos] = useState<{ top: number; right: number } | null>(null);

  // Placed before the first paint, so the popover is never shown in the wrong spot.
  useLayoutEffect(() => {
    const r = p.anchor.current?.getBoundingClientRect();
    if (r && !p.mobile) setPos({ top: r.bottom + 6, right: Math.max(12, innerWidth - r.right) });
    return () => clearTimeout(liveT.current);
  }, []); // eslint-disable-line react-hooks/exhaustive-deps
  // §8: focus goes to the selected tab once the popover is visible (a hidden element can't take focus).
  const shown = p.mobile || !!pos;
  useEffect(() => {
    if (!shown) return;
    const f = requestAnimationFrame(() => ref.current?.querySelector<HTMLElement>('[role=tab][aria-selected="true"]')?.focus());
    return () => cancelAnimationFrame(f);
  }, [shown]);
  useEffect(() => {
    if (p.mobile) return;
    // Clicking outside closes without moving focus (§8).
    const down = (ev: PointerEvent) => {
      const t = ev.target as Node;
      if (!ref.current?.contains(t) && !p.anchor.current?.contains(t)) p.onClose(false);
    };
    document.addEventListener("pointerdown", down);
    return () => document.removeEventListener("pointerdown", down);
  }, [p.mobile]); // eslint-disable-line react-hooks/exhaustive-deps

  const pick = (k: EditorKey, focus = false) => {
    setTab(k);
    setFail(null);
    try {
      localStorage.setItem(LAST_EDITOR, k);
    } catch {}
    // Every tab is already rendered, so focus can move now (roving tabindex, §8).
    if (focus) document.getElementById(tabId(k))?.focus();
  };
  const copied = (msg: string) => {
    setFail(null);
    setLive(msg);
    clearTimeout(liveT.current);
    liveT.current = setTimeout(() => setLive(""), COPIED_MS);
  };
  const failed = (what: string, el: Element | null) => {
    setLive("");
    selectText(el);
    setFail(what);
  };

  const keys = (ev: React.KeyboardEvent) => {
    if (ev.key === "Escape") {
      ev.preventDefault();
      ev.stopPropagation();
      p.onClose(true);
      return;
    }
    if (ev.key !== "Tab") return;
    // §8: selected tab → Copy → (Codex "Or run") → request copy → Close → back to the tab.
    const root = ref.current;
    const order = ['[role=tab][aria-selected="true"]', ".cbtn", ".alt button", ".rq button", ".uh .icon-btn"]
      .map((q) => root?.querySelector<HTMLElement>(q))
      .filter((el): el is HTMLElement => !!el);
    if (!order.length) return;
    ev.preventDefault();
    const i = order.indexOf(document.activeElement as HTMLElement);
    const n = i < 0 ? 0 : (i + (ev.shiftKey ? -1 : 1) + order.length) % order.length;
    order[n].focus();
  };
  const tabKeys = (ev: React.KeyboardEvent, i: number) => {
    let n = -1;
    if (ev.key === "ArrowRight") n = (i + 1) % EDITOR_KEYS.length;
    else if (ev.key === "ArrowLeft") n = (i - 1 + EDITOR_KEYS.length) % EDITOR_KEYS.length;
    else if (ev.key === "Home") n = 0;
    else if (ev.key === "End") n = EDITOR_KEYS.length - 1;
    if (n < 0) return;
    ev.preventDefault();
    pick(EDITOR_KEYS[n], true);
  };

  const label = `Copy the ${e.name} ${e.what}`;
  const doneMsg = `Copied the ${e.name} ${e.what}`;
  const mainCopy = p.mobile ? (
    <CopyButton
      key={`m-${tab}`}
      text={e.code}
      icon
      tone="soft"
      className="mcopy"
      label={e.what === "command" ? "Copy command" : "Copy config"}
      // The visible words lead the name, so the label stays in the name (WCAG 2.5.3).
      ariaLabel={`${e.what === "command" ? "Copy command" : "Copy config"} for ${e.name}`}
      onCopied={() => copied(doneMsg)}
      onFailed={() => failed(e.what, preRef.current)}
    />
  ) : (
    <CopyButton key={`d-${tab}`} text={e.code} icon tone="quiet" label="Copy" ariaLabel={label} onCopied={() => copied(doneMsg)} onFailed={() => failed(e.what, preRef.current)} />
  );
  const request = p.planTitle !== undefined ? fill(UCOPY.request, { title: p.planTitle }) : "";
  const body = (
    <>
      <p className="ud">{UCOPY.desc}</p>
      <div className="seg2 sw" role="tablist" aria-label="Editor">
        {EDITOR_KEYS.map((k, i) => (
          <button
            key={k}
            type="button"
            role="tab"
            id={tabId(k)}
            aria-selected={k === tab}
            aria-controls={panelId}
            tabIndex={k === tab ? 0 : -1}
            onClick={() => pick(k)}
            onKeyDown={(ev) => tabKeys(ev, i)}
          >
            {all[k].name}
          </button>
        ))}
      </div>
      <div className="step" role="tabpanel" id={panelId} aria-labelledby={tabId(tab)}>
        <span className="sl">
          {e.where.lead}
          {e.where.path ? (
            <>
              {" "}
              <code>{e.where.path}</code>
            </>
          ) : null}
        </span>
        <div className="well">
          <pre ref={preRef} data-testid="ue-code">
            {highlight(e.code).map((x, i) => (x.key ? <span key={i} className="k1">{x.text}</span> : x.text))}
          </pre>
          {p.mobile ? null : mainCopy}
        </div>
        {p.mobile ? mainCopy : null}
        {fail ? (
          <p className="err1" role="status">
            <IAlert s={14} />
            <span>
              {fill(UCOPY.failLead, { what: fail })}
              {p.mobile ? (
                UCOPY.failPhone
              ) : (
                <>
                  press <span className="kb1">{isMac() ? "⌘C" : "Ctrl+C"}</span>.
                </>
              )}
            </span>
          </p>
        ) : null}
        {e.alt ? (
          <p className="sn alt">
            <span>
              Or run <code ref={altRef}>{e.alt}</code>
            </span>
            <CopyButton
              kind="inline"
              text={e.alt}
              label="Copy the codex mcp add command"
              onCopied={() => copied("Copied the codex mcp add command")}
              onFailed={() => failed("command", altRef.current)}
            />
          </p>
        ) : null}
        <p className="sn">
          <Note parts={UCOPY.notes[tab]} />
        </p>
      </div>
      <div className="ask">
        <span className="sl">{fill(UCOPY.ask, { editor: e.name })}</span>
        {p.planTitle !== undefined ? (
          <div className="rq">
            <span ref={reqRef}>{request}</span>
            <CopyButton kind="icon" text={request} label="Copy the request" onCopied={() => copied("Copied the request")} onFailed={() => failed("request", reqRef.current)} />
          </div>
        ) : (
          <p className="sn">{UCOPY.homeAsk}</p>
        )}
      </div>
      <span className="sr-only" role="status" aria-live="polite">
        {live}
      </span>
    </>
  );
  const close = (
    <button type="button" className="icon-btn" aria-label="Close" onClick={() => p.onClose(true)}>
      <IX s={p.mobile ? 18 : 16} />
    </button>
  );
  if (p.mobile) return <Sheet titleId={titleId} sheetRef={ref} onKeyDown={keys} onClose={() => p.onClose(true)} close={close} body={body} />;
  return (
    <div
      ref={ref}
      className="pop5 ue"
      role="dialog"
      aria-labelledby={titleId}
      data-testid="use-in-editor"
      style={pos ? { top: pos.top, right: pos.right } : { visibility: "hidden" }}
      onKeyDown={keys}
    >
      <div className="uh">
        <b id={titleId}>{UCOPY.title}</b>
        {close}
      </div>
      {body}
    </div>
  );
}

/** Phones: the same content in a bottom sheet; Close, a scrim tap or a swipe down closes it (§8). */
function Sheet(p: { titleId: string; sheetRef: RefObject<HTMLDivElement | null>; onKeyDown: (e: React.KeyboardEvent) => void; onClose: () => void; close: React.ReactNode; body: React.ReactNode }) {
  const y0 = useRef<number | null>(null);
  const [dy, setDy] = useState(0);
  const start = (e: React.TouchEvent) => {
    y0.current = e.touches[0].clientY;
  };
  const move = (e: React.TouchEvent) => {
    if (y0.current === null) return;
    setDy(Math.max(0, e.touches[0].clientY - y0.current));
  };
  const end = () => {
    if (dy > 80) p.onClose();
    y0.current = null;
    setDy(0);
  };
  return (
    <>
      <div className="cscrim" onClick={p.onClose} />
      <div
        ref={p.sheetRef}
        className="csheet ue"
        role="dialog"
        aria-modal="true"
        aria-labelledby={p.titleId}
        data-testid="use-in-editor"
        style={dy ? { transform: `translateY(${dy}px)`, transition: "none" } : undefined}
        onKeyDown={p.onKeyDown}
      >
        <div className="grab" onTouchStart={start} onTouchMove={move} onTouchEnd={end} />
        <div className="uh sh" onTouchStart={start} onTouchMove={move} onTouchEnd={end}>
          <b id={p.titleId}>{UCOPY.title}</b>
          {p.close}
        </div>
        <div className="ub">{p.body}</div>
      </div>
    </>
  );
}
