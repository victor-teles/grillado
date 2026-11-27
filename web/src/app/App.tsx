import { useCallback, useEffect, useRef, useState } from "react";
import { ApiError, api, subscribe } from "./api";
import { Header, useMobile, useTheme } from "./chrome";
import { CopyButton } from "./CopyButton";
import { setReplyText } from "./comments/stream";
import { Landing, NoAgent, Picker } from "./Home";
import { IPlug } from "./icons";
import { UCOPY, UseInEditor } from "./mcp/UseInEditor";
import type { PlanSeed } from "./Plan";
import { SessionScreen } from "./Session";
import type { AppState, ProviderId, SessionView } from "./types";
import { newer } from "./newer";
import { COPY, fmt } from "./copy";
import { openAsks } from "./build/Build";

const sessionIdFromPath = () => /^\/s\/([\w-]+)$/.exec(location.pathname)?.[1] ?? null;
const stepOf = (s: SessionView) => (s.status === "confirm" ? 2 : s.status === "synthesizing" || s.status === "plated" ? 3 : 1);

function ProjectSources({ context, reads }: { context: SessionView["projectContext"]; reads?: { name: string; root: string } }) {
  if (!context && !reads) return null;
  const count = context?.sources.length ?? 0;
  const plans = `${count} project ${count === 1 ? "plan" : "plans"}`;
  // Plan 002: one disclosure for both kinds of project context, "Reads grillado · 3 plans".
  const summary = reads ? `Reads ${reads.name}${count ? ` · ${count} ${count === 1 ? "plan" : "plans"}` : ""}` : `Using ${plans}`;
  return (
    <details className="project-sources" data-testid="project-context">
      <summary>{summary}</summary>
      <ul>
        {reads ? (
          <li>
            Reads files in <code title={reads.root}>{reads.root}</code> to ask and write the plan. It can’t change them.
          </li>
        ) : null}
        {(context?.sources ?? []).map((source) => (
          <li key={source.path}>
            <code>{source.path}</code>
            {source.truncated ? " (excerpt)" : null}
          </li>
        ))}
        {context?.truncated ? <li>More project context was omitted by the snapshot limits.</li> : null}
      </ul>
    </details>
  );
}

export function App() {
  const [app, setApp] = useState<AppState | null>(null);
  const [sessionId, setSessionId] = useState<string | null>(sessionIdFromPath());
  const [session, setSession] = useState<SessionView | null>(null);
  const [down, setDown] = useState(false);
  const [locked, setLocked] = useState(false);
  const [notice, setNotice] = useState("");
  const [picking, setPicking] = useState(false);
  // A line of a plan that starts a new one: Home's composer opens filled in, and the user sends it.
  const [seed, setSeed] = useState<PlanSeed | null>(null);
  const [theme, toggleTheme] = useTheme();
  const mobile = useMobile();
  // Plan-to-build loop: a coding agent waiting on an answer shows in the tab's title, whatever plan it is in.
  const waiting = (app?.sessions ?? []).reduce((n, x) => n + (x.id === session?.id ? 0 : (x.asks ?? 0)), 0) + openAsks(session?.build).length;
  useEffect(() => {
    document.title = waiting ? `${fmt(COPY.titleWaiting, { n: String(waiting) })} · Grillado` : "Grillado";
  }, [waiting]);
  // v1.2 item 1: "Use in your editor" on Home (desktop header button; phones: More sheet row).
  const [ue, setUe] = useState(false);
  const ueBtn = useRef<HTMLButtonElement>(null);
  const moreBtn = useRef<HTMLButtonElement>(null);

  const refreshApp = useCallback(async () => {
    try {
      setApp(await api.state());
    } catch (err) {
      if (err instanceof ApiError && err.status === 401) setLocked(true);
      else if (err instanceof ApiError && err.status === 0) setDown(true);
    }
  }, []);

  useEffect(() => {
    void refreshApp();
    const onPop = () => setSessionId(sessionIdFromPath());
    window.addEventListener("popstate", onPop);
    return () => window.removeEventListener("popstate", onPop);
  }, [refreshApp]);

  useEffect(() => {
    if (locked || down) return;
    return subscribe(
      (e) => {
        if (e.type === "app") void refreshApp();
        else if (e.type === "session") setSession((cur) => (cur && cur.id === e.session.id ? newer(cur, e.session) : cur));
        else if (e.type === "progress") setSession((cur) => (cur && cur.id === e.sessionId ? { ...cur, progress: e.label } : cur));
        else if (e.type === "reading") setSession((cur) => (cur && cur.id === e.sessionId && cur.busy ? { ...cur, reading: e.reading } : cur));
        // Not React state: the streaming message appends it itself (#97).
        else if (e.type === "reply-text") setReplyText(e.threadId, e.text);
      },
      () => setDown(true),
    );
  }, [locked, down, refreshApp]);

  useEffect(() => {
    if (!sessionId) return setSession(null);
    // Guarded like pushes and action replies: under load this reply can land after the round's pushed events,
    // and taking it as is would put the page back to "Still cooking…" with nothing left to push (pr26 follow-up 5).
    api.session(sessionId).then((next) => setSession((cur) => (cur && cur.id === next.id ? newer(cur, next) : next)), (err) => {
      setNotice(err instanceof Error ? err.message : "Couldn’t open that session.");
      go(null);
    });
  }, [sessionId]);

  const go = (id: string | null) => {
    history.pushState(null, "", id ? `/s/${id}` : "/");
    setSessionId(id);
    setPicking(false);
    // The seed is for the next visit to Home only.
    if (id) setSeed(null);
    if (!id) void refreshApp();
  };

  const act = useCallback(
    async (action: string, body?: unknown) => {
      if (!session) return;
      try {
        setNotice("");
        // The reply can land after a pushed update it predates (a run that fails at once, review-pr22 #3).
        const next = await api.action(session.id, action, body);
        setSession((cur) => (cur && cur.id === next.id ? newer(cur, next) : next));
      } catch (err) {
        // Round submits show their own error in the bar.
        if (action !== "answers") setNotice(err instanceof Error ? err.message : "That didn’t work.");
        throw err;
      }
    },
    [session],
  );

  const quit = async () => {
    await api.quit().catch(() => {});
    setDown(true);
  };

  if (down) return <Stopped theme={theme} onTheme={toggleTheme} />;
  if (locked)
    return (
      <div className="gr-app">
        <Header onQuit={quit} theme={theme} onTheme={toggleTheme} />
        <main className="solo">
          <div className="col">
            <h1>This window isn’t connected</h1>
            <p className="lede" role="alert">
              Open the link printed in your terminal to use this Grillado window.
            </p>
          </div>
        </main>
      </div>
    );
  if (!app)
    return (
      <div className="gr-app">
        <Header onQuit={quit} theme={theme} onTheme={toggleTheme} />
        <main className="solo" aria-busy="true" />
      </div>
    );

  const ready = app.providers.filter((p) => p.status === "ready");
  const provider = app.providers.find((p) => p.id === (session?.provider ?? app.selected));
  // The header name always opens the picker when the agent is idle (▾, v1.2), even with one agent found.
  const canSwitch = ready.length > 0 && !session?.busy;
  const onSwitch = canSwitch ? () => setPicking(true) : undefined;
  const pick = async (id: ProviderId, remember: boolean) => {
    setApp(await api.selectProvider(id, remember));
    if (session && session.provider !== id) await act("provider", { id }).catch(() => {});
    setPicking(false);
  };

  let body: React.ReactNode;
  let showAgent = true;
  let home = false;
  if (sessionId && !session && !picking) {
    // A session URL whose GET is still in flight (a reload, a link): an empty, busy session frame, never Home,
    // the picker or "no agent" for a frame first (review-pr27 nice 1).
    showAgent = false;
    body = <main className="smain" aria-busy="true" data-testid="session-loading" />;
  } else if (!ready.length && !session) {
    showAgent = false;
    body = <NoAgent state={app} onRescan={async () => setApp(await api.rescan())} />;
  } else if (picking || (app.needsPicker && !session)) {
    showAgent = false;
    body = <Picker state={app} onPick={pick} />;
  } else if (session)
    body = (
      <main className="smain">
        <SessionScreen
          session={session}
          app={app}
          act={act}
          onSwitch={() => setPicking(true)}
          onNewPlan={(next) => {
            go(null);
            setSeed(next);
          }}
        />
      </main>
    );
  else {
    home = true;
    body = (
      <Landing
        key={seed ? `seed-${seed.idea}` : "home"}
        seed={seed ?? undefined}
        state={app}
        provider={provider}
        onSwitch={onSwitch}
        onStart={async (idea, context, read) => {
          const s = await api.createSession(idea, context, read);
          setSession((cur) => (cur && cur.id === s.id ? newer(cur, s) : s));
          go(s.id);
        }}
        onOpen={go}
      />
    );
  }
  const ueEntry = home ? (
    <button ref={ueBtn} type="button" className="btn quiet ue-entry" aria-haspopup="dialog" aria-expanded={ue} onClick={() => setUe((x) => !x)}>
      <IPlug s={14} />
      {UCOPY.title}
    </button>
  ) : null;

  const wrappable = session && (session.status === "answering" || session.status === "asking") && !picking;
  return (
    <div className="gr-app">
      <Header
        step={session && !picking ? stepOf(session) : undefined}
        title={session ? session.idea.split("\n")[0] : undefined}
        afterTitle={session && !picking ? <ProjectSources context={session.projectContext} reads={session.codeRead && session.readRoot ? { name: session.readRoot.split(/[\\/]/).filter(Boolean).at(-1) ?? session.readRoot, root: session.readRoot } : undefined} /> : undefined}
        // v1.2: no agent in the header before a session; the composer shows it.
        provider={showAgent && session && ready.length ? provider : undefined}
        onSwitch={onSwitch}
        onHome={session || picking ? () => (picking && session ? setPicking(false) : go(null)) : undefined}
        onWrap={wrappable ? () => void act("wrap").catch(() => {}) : undefined}
        onQuit={quit}
        theme={theme}
        onTheme={toggleTheme}
        extra={ueEntry}
        onEditor={home ? () => setUe(true) : undefined}
        moreRef={moreBtn}
      />
      {notice ? (
        <p role="alert" className="notice gr-notice">
          {notice}
        </p>
      ) : null}
      {body}
      {ue && home ? (
        <UseInEditor
          launch={app.mcp}
          agent={app.selected}
          mobile={mobile}
          anchor={mobile ? moreBtn : ueBtn}
          onClose={(focus) => {
            setUe(false);
            const back = mobile ? moreBtn : ueBtn;
            if (focus) back.current?.focus();
          }}
        />
      ) : null}
    </div>
  );
}

function Stopped({ theme, onTheme }: { theme: "dark" | "light"; onTheme: () => void }) {
  const [hint, setHint] = useState("This tab reconnects on its own when Grillado is running again.");
  useEffect(() => {
    const t = setInterval(async () => {
      try {
        await api.state();
        location.reload();
      } catch (err) {
        if (err instanceof ApiError && err.status === 401) setHint("Grillado is running again. Open the new link from your terminal.");
      }
    }, 3000);
    return () => clearInterval(t);
  }, []);
  return (
    <div className="gr-app">
      <Header theme={theme} onTheme={onTheme} />
      <main className="solo">
        <div className="col">
          <h1>Grillado stopped</h1>
          <p className="lede">Your session is saved. Run this in a terminal to continue where you left off.</p>
          <CopyButton kind="cmd" text="npx grillado" label="Copy npx grillado" />
          <p className="note" role="status">
            {hint}
          </p>
        </div>
      </main>
    </div>
  );
}
