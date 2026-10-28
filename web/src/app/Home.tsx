import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { AgentChip, useMobile } from "./chrome";
import { CopyButton } from "./CopyButton";
import { IPlus, IRefresh, IUp } from "./icons";
import type { AppState, ProviderId, ProviderView, SessionSummary } from "./types";
import { fromEditor } from "../../../src/core/editor.ts";
import { sourceLabel } from "../../../src/core/activity.ts";
import { Found } from "./found/Found";
import { useFoundHandoff } from "./found/handoff";

// ---------------------------------------------------------------- 0c no agent

export function NoAgent({ state, onRescan }: { state: AppState; onRescan: () => Promise<void> }) {
  const [scanning, setScanning] = useState(false);
  const [copied, setCopied] = useState(false);
  return (
    <main className="solo">
      <div className="col">
        <h1>No coding agent found</h1>
        <p className="lede">Install one, log in once, then scan again. Grillado checks your PATH and installs nothing for you.</p>
        <ul className="rows" aria-label="Install commands">
          {state.providers.map((p) => (
            <li key={p.id} className="cmdrow">
              <span className="nm">{p.displayName}</span>
              <code title={p.installHint}>{p.installHint}</code>
              <CopyButton kind="icon" text={p.installHint} label={`Copy ${p.displayName} install command`} onCopied={() => setCopied(true)} />
              {p.status === "broken" || p.status === "outdated" ? <span className="why">Found, but not working: {p.reason}</span> : null}
            </li>
          ))}
        </ul>
        <div className="foot">
          <button
            type="button"
            className="btn primary"
            aria-busy={scanning || undefined}
            disabled={scanning}
            onClick={async () => {
              setScanning(true);
              try {
                await onRescan();
              } finally {
                setScanning(false);
              }
            }}
          >
            <IRefresh s={16} />
            {scanning ? "Scanning…" : "Scan again"}
          </button>
          <span className="meta" aria-live="polite">
            {scanning ? "Looking for claude, codex, grok and pi…" : copied ? "Copied" : ""}
          </span>
        </div>
      </div>
    </main>
  );
}

// ---------------------------------------------------------------- 0b choose agent

export function Picker({ state, onPick }: { state: AppState; onPick: (id: ProviderId, remember: boolean) => void }) {
  const ready = state.providers.filter((p) => p.status === "ready");
  const lastUsed = state.remembered ?? state.selected ?? null;
  const [sel, setSel] = useState<ProviderId>(lastUsed && ready.some((p) => p.id === lastUsed) ? lastUsed : ready[0]!.id);
  const [remember, setRemember] = useState(false);
  // Number keys pick a row; the numerals only show after the first number press (as in the round).
  const [keys, setKeys] = useState(false);
  const groupRef = useRef<HTMLDivElement>(null);
  const missing = state.providers.filter((p) => p.status === "missing");
  const broken = state.providers.filter((p) => p.status !== "ready" && p.status !== "missing");
  const onKey = (e: React.KeyboardEvent) => {
    if (e.metaKey || e.ctrlKey || e.altKey) return;
    if ((e.target as HTMLElement).matches("input")) {
      if (e.key !== "Enter") return;
    }
    const n = Number(e.key);
    if (n >= 1 && n <= ready.length) {
      e.preventDefault();
      setKeys(true);
      setSel(ready[n - 1]!.id);
      groupRef.current?.querySelector<HTMLElement>(`[data-id=${ready[n - 1]!.id}]`)?.focus();
    } else if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      if (!(e.target as HTMLElement).closest("[role=radiogroup]")) return;
      e.preventDefault();
      const i = ready.findIndex((p) => p.id === sel) + (e.key === "ArrowDown" ? 1 : -1);
      const p = ready[(i + ready.length) % ready.length]!;
      setSel(p.id);
      groupRef.current?.querySelector<HTMLElement>(`[data-id=${p.id}]`)?.focus();
    } else if (e.key === "Enter" && !(e.target as HTMLElement).closest("button:not([role=radio]),a")) {
      e.preventDefault();
      onPick(sel, remember);
    }
  };
  useEffect(() => {
    groupRef.current?.querySelector<HTMLElement>("[aria-checked=true]")?.focus();
  }, []);
  const names = (ps: ProviderView[]) => (ps.length <= 2 ? ps.map((p) => p.displayName).join(" and ") : `${ps.slice(0, -1).map((p) => p.displayName).join(", ")} and ${ps[ps.length - 1]!.displayName}`);
  return (
    <main className="solo" onKeyDown={onKey}>
      <div className="col">
        <h1 id="picker-title">Which agent should run this?</h1>
        <p className="lede">Grillado runs through a coding agent you already have, with its existing login.</p>
        <div ref={groupRef} className="rows" role="radiogroup" aria-labelledby="picker-title">
          {ready.map((p, i) => (
            <AgentRow key={p.id} p={p} k={keys ? i + 1 : 0} checked={p.id === sel} lastUsed={p.id === lastUsed} onSelect={() => setSel(p.id)} />
          ))}
        </div>
        {missing.length ? (
          <p className="note">
            {names(missing)} {missing.length === 1 ? "isn’t" : "aren’t"} installed.{" "}
            <a href="https://github.com/victor-teles/grillado#readme" target="_blank" rel="noreferrer">
              How to add one
            </a>
          </p>
        ) : null}
        {broken.map((p) => (
          <p key={p.id} className="note">
            {p.displayName} was found, but isn’t working{p.reason ? `: ${p.reason}` : "."}
          </p>
        ))}
        <div className="foot">
          <label className="check">
            <input type="checkbox" checked={remember} onChange={(e) => setRemember(e.target.checked)} />
            Remember my choice
          </label>
          <span className="sp" />
          <button type="button" className="btn primary" onClick={() => onPick(sel, remember)}>
            Continue
            <span className="k" aria-hidden="true">
              ↵
            </span>
          </button>
        </div>
      </div>
    </main>
  );
}

function AgentRow({ p, k, checked, lastUsed, onSelect }: { p: ProviderView; k: number; checked: boolean; lastUsed: boolean; onSelect: () => void }) {
  return (
    <button type="button" role="radio" data-id={p.id} aria-checked={checked} tabIndex={checked ? 0 : -1} className="row" onClick={onSelect}>
      <span className="rd" aria-hidden="true" />
      <span className="nm">
        {p.displayName}
        {p.version ? <span>{p.version}</span> : null}
      </span>
      <span className="tail">
        {lastUsed ? "Last used" : null}
        {k ? (
          <kbd className="n" aria-hidden="true">
            {k}
          </kbd>
        ) : null}
      </span>
    </button>
  );
}

// ---------------------------------------------------------------- 1 landing

const EXAMPLES = [
  "A booking page for my barber shop",
  "A shared shopping list for my flat",
  "Migrate the blog off WordPress",
  "A weekend climbing trip planner",
  "An invoice tool for freelancers",
];

/** Cycles example ideas in the placeholder. Stops once focused or typed in. Reduced motion: plain swaps. */
function usePlaceholder(stopped: boolean) {
  const [text, setText] = useState(EXAMPLES[0]!);
  useEffect(() => {
    if (stopped) return;
    const reduce = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    let i = 0;
    let timer: ReturnType<typeof setTimeout>;
    if (reduce) {
      const t = setInterval(() => setText(EXAMPLES[(i = (i + 1) % EXAMPLES.length)]!), 4000);
      return () => clearInterval(t);
    }
    // type 40 ms/char, hold 1.6 s, delete 18 ms/char
    let shown = EXAMPLES[0]!.length;
    let dir: 1 | -1 = -1;
    const step = () => {
      const full = EXAMPLES[i]!;
      if (dir === -1) {
        shown--;
        if (shown <= 0) {
          i = (i + 1) % EXAMPLES.length;
          dir = 1;
        }
        setText(EXAMPLES[i]!.slice(0, Math.max(shown, 0)));
        timer = setTimeout(step, 18);
      } else {
        shown++;
        setText(full.slice(0, shown));
        if (shown >= full.length) {
          dir = -1;
          timer = setTimeout(step, 1600);
        } else timer = setTimeout(step, 40);
      }
    };
    timer = setTimeout(step, 2400);
    return () => clearTimeout(timer);
  }, [stopped]);
  return text;
}

export function Landing({
  state,
  provider,
  onSwitch,
  onStart,
  onOpen,
}: {
  state: AppState;
  provider?: ProviderView;
  onSwitch?: () => void;
  onStart: (idea: string, context: string) => Promise<void>;
  onOpen: (id: string) => void;
}) {
  const mobile = useMobile();
  const [idea, setIdea] = useState("");
  const handoff = useFoundHandoff(state.sessions);
  const [context, setContext] = useState("");
  const [showContext, setShowContext] = useState(false);
  const [sending, setSending] = useState(false);
  const [focused, setFocused] = useState(false);
  const placeholder = usePlaceholder(focused || idea.length > 0);
  const ta = useRef<HTMLTextAreaElement>(null);
  useEffect(() => {
    const el = ta.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, 240)}px`;
  }, [idea]);
  const start = async () => {
    if (!idea.trim() || sending) return;
    setSending(true);
    try {
      await onStart(idea.trim(), context.trim());
    } finally {
      setSending(false);
    }
  };
  return (
    <main className="solo hero">
      <div className="col">
        <h1 id="idea-label">What are you planning?</h1>
        <p className="lede">
          Describe the idea. The agent asks, you decide,
          {mobile ? " " : <br />}
          and the plan is saved on this computer.
        </p>
        <form
          className="composer"
          data-focus={focused ? "" : undefined}
          onSubmit={(e) => {
            e.preventDefault();
            void start();
          }}
        >
          <textarea
            ref={ta}
            className="tx"
            aria-labelledby="idea-label"
            aria-describedby="idea-keys"
            value={idea}
            rows={2}
            placeholder={placeholder}
            onChange={(e) => setIdea(e.target.value)}
            onFocus={() => setFocused(true)}
            onBlur={() => setFocused(false)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
                e.preventDefault();
                void start();
              }
            }}
            maxLength={4000}
          />
          <span id="idea-keys" className="sr-only">
            Enter starts, Shift+Enter adds a new line.
          </span>
          {showContext ? (
            <div className="ctxbox">
              <textarea aria-label="Context for the agent (optional)" placeholder="Anything the agent should know: constraints, stack, who it's for" value={context} onChange={(e) => setContext(e.target.value)} maxLength={20000} />
            </div>
          ) : null}
          <div className="ar">
            {provider ? <AgentChip provider={provider} onSwitch={onSwitch} /> : null}
            {showContext ? null : (
              <button type="button" className="icon-btn" aria-label="Add context" onClick={() => setShowContext(true)}>
                <IPlus s={16} />
              </button>
            )}
            <button type="submit" className={`go${idea.trim() ? " on" : ""}`} aria-label="Start" disabled={!idea.trim() || sending}>
              <IUp s={16} />
            </button>
          </div>
        </form>
        {/* Found in this project (v1.3 item 1): its one mount point. Q1 (placement) moves only this line. */}
        <Found agent={provider?.displayName ?? "Your agent"} initial={state.found} onOpen={onOpen} {...handoff.found} />
        <Recent sessions={handoff.sessions} dataDir={state.dataDir} onOpen={onOpen} enter={handoff.enter} onEntered={handoff.entered} />
      </div>
    </main>
  );
}

function when(iso: string) {
  const d = new Date(iso);
  const mins = Math.round((Date.now() - d.getTime()) / 60000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins} min ago`;
  const today = new Date();
  if (d.toDateString() === today.toDateString()) return `${Math.round(mins / 60)} h ago`;
  const y = new Date(today);
  y.setDate(today.getDate() - 1);
  if (d.toDateString() === y.toDateString()) return "yesterday";
  return d.toLocaleDateString("en", { month: "short", day: "numeric" });
}

/** Plain text status for a recent session (v1.2: no badges). */
function statusText(s: SessionSummary) {
  if (s.status === "plated") return s.open ? `Wrapped early · ${s.open} open` : "Plated";
  if (s.status === "confirm") return "Confirm";
  if (s.status === "synthesizing") return "Plating";
  return `Round ${Math.max(1, s.rounds)}`;
}

function Recent({
  sessions,
  dataDir,
  onOpen,
  enter,
  onEntered,
}: {
  sessions: SessionSummary[];
  dataDir: string;
  onOpen: (id: string) => void;
  /** A plan that just left Found (v1.3 item 1): its row opens in (220ms ease-out), nothing else moves. */
  enter?: { id: string; focus: boolean } | null;
  onEntered?: () => void;
}) {
  const home = dataDir.replace(/^\/(home|Users)\/[^/]+/, "~");
  const list = useRef<HTMLUListElement>(null);
  useLayoutEffect(() => {
    if (!enter) return;
    const li = list.current?.querySelector<HTMLElement>(`li[data-id="${CSS.escape(enter.id)}"]`);
    if (!li) return;
    onEntered?.();
    if (enter.focus) li.querySelector<HTMLElement>("a")?.focus({ preventScroll: true });
    if (document.documentElement.hasAttribute("data-kbd")) return;
    const still = matchMedia("(prefers-reduced-motion: reduce)").matches;
    const ease = "cubic-bezier(0.23,1,0.32,1)";
    if (still) {
      li.animate([{ opacity: 0 }, { opacity: 1 }], { duration: 160, easing: ease });
      return;
    }
    const h = li.offsetHeight;
    li.style.overflow = "hidden";
    const a = li.animate([{ height: "0px", opacity: 0 }, { height: `${h}px`, opacity: 1 }], { duration: 220, easing: ease });
    a.onfinish = a.oncancel = () => {
      li.style.overflow = "";
    };
  }, [enter, sessions, onEntered]);
  if (!sessions.length)
    return (
      <p className="note empty">
        Sessions are saved in <span className="inline-code">{home}</span>, so you can stop and pick up later.
      </p>
    );
  return (
    <section className="recent" aria-labelledby="recent-title">
      <h2 id="recent-title">Recent</h2>
      <ul ref={list}>
        {sessions.map((s) => (
          <li key={s.id} data-id={s.id}>
            <a
              className="rrow"
              href={`/s/${s.id}`}
              onClick={(e) => {
                e.preventDefault();
                onOpen(s.id);
              }}
            >
              <span className="nm">{s.title || s.idea.split("\n")[0]}</span>
              <span className="meta">
                {s.source ? (
                  // Imported from a source found in the project (v1.3 item 1 §6, #143).
                  <>
                    <span className="src1">From {sourceLabel(s.source.app, s.source.kind).replace(/^Plan file$/, "plan file")}</span> · {statusText(s)} · {when(s.updatedAt)}
                  </>
                ) : s.from !== undefined ? (
                  // Started from an editor over MCP (item 1 §9, DECISIONS #108).
                  <>
                    <span className="src1">{fromEditor(s.from)}</span> · {s.queued ? "waiting for your answers" : `${statusText(s)} · ${when(s.updatedAt)}`}
                  </>
                ) : (
                  <>
                    {statusText(s)} · {when(s.updatedAt)}
                  </>
                )}
              </span>
            </a>
          </li>
        ))}
      </ul>
    </section>
  );
}
