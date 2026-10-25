import { useEffect, useRef, useState } from "react";
import { AgentChip, monogram, useMobile } from "./chrome";
import { CopyButton } from "./CopyButton";
import { ICheck, IChev, IFlame, IPlate, IRefresh, ITerm, IUp } from "./icons";
import type { AppState, ProviderId, ProviderView, SessionSummary } from "./types";

// ---------------------------------------------------------------- 0c no agent

export function NoAgent({ state, onRescan }: { state: AppState; onRescan: () => Promise<void> }) {
  const [scanning, setScanning] = useState(false);
  const [copied, setCopied] = useState(false);
  return (
    <main className="page">
      <div className="center">
        <span className="tile" aria-hidden="true">
          <ITerm s={24} />
        </span>
        <h1 className="h1">No coding agent found</h1>
        <p className="lead">Grillado runs on the coding agent you already use. Install one, log in once, then scan again.</p>
        <ul className="card2" style={{ width: "min(600px,100%)", marginTop: 28, padding: 8, display: "grid", gap: 6, listStyle: "none" }} aria-label="Install commands">
          {state.providers.map((p) => (
            <li key={p.id} className="inst">
              <span className="n">{p.displayName}</span>
              <code>{p.installHint}</code>
              <CopyButton kind="icon" text={p.installHint} label={`Copy ${p.displayName} install command`} onCopied={() => setCopied(true)} />
              {p.status === "broken" || p.status === "outdated" ? <span className="why">Found, but not working: {p.reason}</span> : null}
            </li>
          ))}
        </ul>
        <div style={{ marginTop: 20, display: "flex", gap: 12, alignItems: "center", flexDirection: "column" }}>
          {scanning ? (
            <span className="rs" role="status">
              <span className="shimmer">Looking for claude, codex, grok and pi…</span>
            </span>
          ) : (
            <button
              type="button"
              className="pill primary solo"
              onClick={async () => {
                setScanning(true);
                try {
                  await onRescan();
                } finally {
                  setScanning(false);
                }
              }}
            >
              <IRefresh s={14} />
              Scan again
            </button>
          )}
          <span aria-live="polite">
            {copied ? (
              <span className="fb">
                <ICheck s={14} />
                Copied
              </span>
            ) : (
              <span className="hint" style={{ margin: 0 }}>
                We check your PATH. Nothing is installed for you.
              </span>
            )}
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
  const groupRef = useRef<HTMLDivElement>(null);
  const order = [...ready, ...state.providers.filter((p) => p.status !== "ready")];
  const onKey = (e: React.KeyboardEvent) => {
    if (e.metaKey || e.ctrlKey || e.altKey) return;
    if ((e.target as HTMLElement).matches("input")) {
      if (e.key !== "Enter") return;
    }
    const n = Number(e.key);
    if (n >= 1 && n <= ready.length) {
      e.preventDefault();
      setSel(ready[n - 1]!.id);
      groupRef.current?.querySelector<HTMLElement>(`[data-id=${ready[n - 1]!.id}]`)?.focus();
    } else if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      if (!(e.target as HTMLElement).closest("[role=radiogroup]")) return;
      e.preventDefault();
      const i = ready.findIndex((p) => p.id === sel) + (e.key === "ArrowDown" ? 1 : -1);
      const p = ready[(i + ready.length) % ready.length]!;
      setSel(p.id);
      groupRef.current?.querySelector<HTMLElement>(`[data-id=${p.id}]`)?.focus();
    } else if (e.key === "Enter" && !(e.target as HTMLElement).closest("button:not([role=radio])")) {
      e.preventDefault();
      onPick(sel, remember);
    }
  };
  useEffect(() => {
    groupRef.current?.querySelector<HTMLElement>("[aria-checked=true]")?.focus();
  }, []);
  return (
    <main className="page" onKeyDown={onKey}>
      <div className="center">
        <div className="eyebrow" style={{ marginBottom: 12 }}>
          {ready.length} agents ready on this computer
        </div>
        <h1 className="h1" id="picker-title">
          Which agent should run this?
        </h1>
        <p className="lead">Grillado works through a coding agent you already have. It uses your existing login, so there's nothing new to sign in to.</p>
        <div ref={groupRef} className="card2" style={{ width: "min(520px,100%)", marginTop: 28, padding: 8, display: "grid", gap: 6 }} role="radiogroup" aria-labelledby="picker-title">
          {order.map((p) => (
            <AgentRow key={p.id} p={p} k={ready.indexOf(p) + 1} checked={p.id === sel} lastUsed={p.id === lastUsed} onSelect={() => setSel(p.id)} />
          ))}
        </div>
        <div style={{ width: "min(520px,100%)", display: "flex", alignItems: "center", justifyContent: "space-between", marginTop: 14, gap: 12, flexWrap: "wrap" }}>
          <label className="cbx-l">
            <input type="checkbox" checked={remember} onChange={(e) => setRemember(e.target.checked)} />
            Remember my choice
          </label>
          <button type="button" className="pill primary" onClick={() => onPick(sel, remember)}>
            Continue <kbd>↵</kbd>
          </button>
        </div>
        <p className="hint" style={{ marginTop: 18 }}>
          {ready.slice(0, 9).map((_, i) => (
            <kbd key={i}>{i + 1}</kbd>
          ))}{" "}
          choose · switch any time from the header
        </p>
      </div>
    </main>
  );
}

function AgentRow({ p, k, checked, lastUsed, onSelect }: { p: ProviderView; k: number; checked: boolean; lastUsed: boolean; onSelect: () => void }) {
  const off = p.status !== "ready";
  const detail = off ? (p.status === "missing" ? "Not installed" : `Found, but not working${p.reason ? `: ${p.reason}` : ""}`) : "Uses your existing login";
  return (
    <button type="button" role="radio" data-id={p.id} aria-checked={checked} disabled={off} tabIndex={checked ? 0 : -1} className="ag" onClick={onSelect}>
      <span className="mono3" aria-hidden="true">
        {monogram(p.displayName)}
      </span>
      <span style={{ minWidth: 0 }}>
        <span className="n">
          {p.displayName}
          {p.version ? (
            <span className="mono sub" style={{ fontSize: 11.5, fontWeight: 400 }}>
              {p.version}
            </span>
          ) : null}
          {lastUsed && !off ? <span className="rec">Last used</span> : null}
        </span>
        <span className="d">
          {off ? null : <ICheck s={12} />}
          {detail}
        </span>
      </span>
      <span className="r">{off ? null : <kbd aria-hidden="true">{k}</kbd>}</span>
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
    <main className="page">
      <div className="center" style={mobile ? undefined : { paddingTop: 96 }}>
        <span className="eyebrow" style={{ marginBottom: 14 }}>
          <IFlame s={14} />
          Plan anything with your coding agent
        </span>
        <h1 className="h1 xl" id="idea-label">
          What are you planning?
        </h1>
        <p className="lead">Describe the idea. The agent asks the questions, you make the calls, and you leave with a plan saved on this computer.</p>
        <form
          className="composer"
          onSubmit={(e) => {
            e.preventDefault();
            void start();
          }}
        >
          <textarea
            ref={ta}
            aria-labelledby="idea-label"
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
          {showContext ? (
            <div className="ctxbox">
              <textarea aria-label="Context for the agent (optional)" placeholder="Anything the agent should know: constraints, stack, who it's for" value={context} onChange={(e) => setContext(e.target.value)} maxLength={20000} />
            </div>
          ) : null}
          <div className="row">
            {provider ? <AgentChip provider={provider} compact={mobile} onSwitch={onSwitch} /> : null}
            {mobile ? null : (
              <span className="hint" style={{ margin: "0 0 0 4px" }}>
                <kbd>↵</kbd> start · <kbd>⇧</kbd>
                <kbd>↵</kbd> new line
              </span>
            )}
            {showContext ? null : (
              <button type="button" className="ctx" onClick={() => setShowContext(true)}>
                + Context
              </button>
            )}
            <button type="submit" className="send" aria-label="Start" disabled={!idea.trim() || sending}>
              <IUp s={18} />
            </button>
          </div>
        </form>
        <Recent sessions={state.sessions} dataDir={state.dataDir} onOpen={onOpen} mobile={mobile} />
      </div>
    </main>
  );
}

function when(iso: string) {
  const d = new Date(iso);
  const mins = Math.round((Date.now() - d.getTime()) / 60000);
  if (mins < 1) return "Just now";
  if (mins < 60) return `${mins} min ago`;
  const today = new Date();
  if (d.toDateString() === today.toDateString()) return `${Math.round(mins / 60)} h ago`;
  const y = new Date(today);
  y.setDate(today.getDate() - 1);
  if (d.toDateString() === y.toDateString()) return "Yesterday";
  return d.toLocaleDateString("en", { month: "short", day: "numeric" });
}

function StatusBadge({ s }: { s: SessionSummary }) {
  if (s.status === "plated")
    return s.open ? (
      <span className="badge2 proto">Wrapped early · {s.open} open</span>
    ) : (
      <span className="badge2 ok">
        <ICheck s={12} />
        Plated
      </span>
    );
  if (s.status === "confirm") return <span className="badge2">Confirm</span>;
  if (s.status === "synthesizing") return <span className="badge2">Plating</span>;
  return (
    <span className="badge2 heat">
      <span className="dot" aria-hidden="true" />
      On the grill · round {Math.max(1, s.rounds)}
    </span>
  );
}

function Recent({ sessions, dataDir, onOpen, mobile }: { sessions: SessionSummary[]; dataDir: string; onOpen: (id: string) => void; mobile: boolean }) {
  const home = dataDir.replace(/^\/(home|Users)\/[^/]+/, "~");
  if (!sessions.length)
    return (
      <div className="list empty-list">
        <span className="tile" style={{ marginBottom: 12, width: 40, height: 40 }} aria-hidden="true">
          <IPlate s={20} />
        </span>
        <div style={{ fontSize: 14, fontWeight: 600 }}>No sessions yet</div>
        <div className="sub" style={{ fontSize: 12.5, marginTop: 4, maxWidth: 360 }}>
          Each session is saved on this computer in <span className="code">{home}</span>, so you can stop and pick up where you left off.
        </div>
      </div>
    );
  return (
    <section className="list" aria-labelledby="recent-title">
      <h2>
        <span id="recent-title">Recent</span>
        {mobile ? null : (
          <span className="sub" style={{ fontWeight: 400 }}>
            Saved in {home}
          </span>
        )}
      </h2>
      <ul>
        {sessions.map((s) => (
          <li key={s.id}>
            <a
              className="li"
              href={`/s/${s.id}`}
              onClick={(e) => {
                e.preventDefault();
                onOpen(s.id);
              }}
            >
              <span className="t">{s.idea.split("\n")[0]}</span>
              <span className="meta">
                <StatusBadge s={s} />
                <span className="m">{when(s.updatedAt)}</span>
              </span>
              <span className="sub chev" aria-hidden="true">
                <IChev s={14} />
              </span>
            </a>
          </li>
        ))}
      </ul>
    </section>
  );
}
