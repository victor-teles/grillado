import { Power } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { ApiError, api, subscribe } from "./api";
import { Composer, NoAgent, Picker, RecentSessions } from "./Home";
import { SessionScreen } from "./Session";
import type { AppState, ProviderId, SessionView } from "./types";

const sessionIdFromPath = () => /^\/s\/([\w-]+)$/.exec(location.pathname)?.[1] ?? null;

export function App() {
  const [app, setApp] = useState<AppState | null>(null);
  const [sessionId, setSessionId] = useState<string | null>(sessionIdFromPath());
  const [session, setSession] = useState<SessionView | null>(null);
  const [down, setDown] = useState(false);
  const [locked, setLocked] = useState(false);
  const [notice, setNotice] = useState("");
  const [picking, setPicking] = useState(false);

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
    if (locked) return;
    return subscribe(
      (e) => {
        if (e.type === "app") void refreshApp();
        else if (e.type === "session") setSession((cur) => (cur && cur.id === e.session.id ? e.session : cur));
        else if (e.type === "progress") setSession((cur) => (cur && cur.id === e.sessionId ? { ...cur, progress: e.label } : cur));
      },
      () => setDown(true),
    );
  }, [locked, refreshApp]);

  useEffect(() => {
    if (!sessionId) return setSession(null);
    api.session(sessionId).then(setSession, (err) => {
      setNotice(err instanceof Error ? err.message : "Couldn't open that session.");
      go(null);
    });
  }, [sessionId]);

  const go = (id: string | null) => {
    history.pushState(null, "", id ? `/s/${id}` : "/");
    setSessionId(id);
    if (!id) void refreshApp();
  };

  const act = useCallback(
    async (action: string, body?: unknown) => {
      if (!session) return;
      try {
        setNotice("");
        setSession(await api.action(session.id, action, body));
      } catch (err) {
        setNotice(err instanceof Error ? err.message : "That didn't work.");
        throw err;
      }
    },
    [session],
  );

  if (down) return <Stopped />;
  if (locked)
    return (
      <Shell>
        <p role="alert">Open the link printed in your terminal to use this Grillado window.</p>
      </Shell>
    );
  if (!app) return <Shell>{null}</Shell>;

  const ready = app.providers.filter((p) => p.status === "ready");
  const selected = app.providers.find((p) => p.id === (session?.provider ?? app.selected));
  const pick = async (id: ProviderId, remember: boolean) => {
    setApp(await api.selectProvider(id, remember));
    if (session && session.provider !== id) await act("provider", { id }).catch(() => {});
    setPicking(false);
  };

  let body: React.ReactNode;
  if (!ready.length && !session) body = <NoAgent state={app} onRescan={async () => setApp(await api.rescan())} />;
  else if (picking || (app.needsPicker && !session)) body = <Picker state={app} onPick={pick} />;
  else if (session) body = <SessionScreen session={session} app={app} act={(a, b) => act(a, b).catch(() => {})} />;
  else
    body = (
      <div className="grid gap-10">
        <Composer
          onStart={async (idea, context) => {
            const s = await api.createSession(idea, context);
            setSession(s);
            go(s.id);
          }}
        />
        <RecentSessions sessions={app.sessions} onOpen={go} />
      </div>
    );

  return (
    <Shell
      header={
        <>
          {selected && ready.length ? (
            <Button
              type="button"
              variant="secondary"
              size="sm"
              className="rounded-full"
              aria-label={`Agent: ${selected.displayName}. Switch agent`}
              onClick={() => setPicking((v) => !v)}
              disabled={ready.length < 2 || session?.busy}
            >
              <span aria-hidden="true" className="size-2 rounded-full bg-success" />
              {selected.displayName}
            </Button>
          ) : null}
          <Button
            type="button"
            variant="ghost"
            size="sm"
            onClick={async () => {
              await api.quit().catch(() => {});
              setDown(true);
            }}
          >
            <Power aria-hidden="true" /> Quit
          </Button>
        </>
      }
      onHome={session ? () => go(null) : undefined}
    >
      {notice ? (
        <p role="alert" className="mb-4 rounded-lg border border-dashed p-3 text-sm">
          {notice}
        </p>
      ) : null}
      {body}
    </Shell>
  );
}

function Shell({ children, header, onHome }: { children: React.ReactNode; header?: React.ReactNode; onHome?: () => void }) {
  return (
    <div className="min-h-dvh bg-background text-foreground">
      <header className="mx-auto flex max-w-4xl items-center justify-between gap-3 px-5 py-4">
        <h1 className="text-lg font-semibold tracking-tight">
          {onHome ? (
            <a
              href="/"
              onClick={(e) => {
                e.preventDefault();
                onHome();
              }}
              className="focus-visible:outline-2 focus-visible:outline-ring"
            >
              Grillado
            </a>
          ) : (
            "Grillado"
          )}
        </h1>
        <div className="flex items-center gap-2">{header}</div>
      </header>
      <main className="mx-auto max-w-4xl px-5 pb-16">{children}</main>
    </div>
  );
}

function Stopped() {
  return (
    <Shell>
      <section role="status" className="grid gap-2 rounded-2xl border bg-card p-6">
        <h2 className="text-xl font-semibold">Grillado was stopped</h2>
        <p className="text-muted-foreground">
          Run <code className="rounded bg-muted px-1">npx grillado</code> to continue. Your session is saved.
        </p>
      </section>
    </Shell>
  );
}
