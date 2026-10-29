// In-session screens: dispatcher, problem banners, confirm (+ reopen dialogs), plating.
import { failureCode, isStopped, reasonText } from "../../../src/core/reason.ts";
import { useEffect, useMemo, useRef, useState } from "react";
import { useMobile, useSince } from "./chrome";
import { CopyButton } from "./CopyButton";
import { COPY, fmt } from "./copy";
import { confirmCounts, countText, plural, stillOpen } from "./counts";
import { IAlert, IClock, IKey, ITerm } from "./icons";
import { PlanView } from "./Plan";
import { atCap, roundStatus } from "./rounds";
import { FiringUp, RoundView, SessionBody, StatusLine, Strip, WaitingView } from "./Round";
import type { AppState, Decision, DecisionNode, SessionView, TreeState } from "./types";

export type Act = (action: string, body?: unknown) => Promise<void>;
const quiet = (p: Promise<void>) => void p.catch(() => {});

export function SessionScreen({ session, app, act, onSwitch }: { session: SessionView; app: AppState; act: Act; onSwitch: () => void }) {
  const banner = session.error && !session.busy ? <ProblemBanner session={session} app={app} act={act} onSwitch={onSwitch} /> : null;
  switch (session.status) {
    case "asking":
      // A changed decision is being re-asked: the plan stays up, read-only and marked (Q2).
      if (session.plan?.waiting?.length) return <PlanView session={session} act={act} agentName={agentName(app, session)} agentNameOf={(id) => app.providers.find((p) => p.id === id)?.displayName ?? id} mcp={app.mcp} banner={banner} />;
      return session.rounds.length === 0 ? <FiringUp session={session} act={act} banner={banner} /> : <WaitingView session={session} act={act} banner={banner} />;
    case "answering":
      return <RoundView session={session} act={act} banner={banner} />;
    case "confirm":
      return <Confirm session={session} act={act} agent={agentName(app, session)} />;
    case "synthesizing":
      return <Plating session={session} act={act} banner={banner} />;
    case "plated":
      return <PlanView session={session} act={act} agentName={agentName(app, session)} agentNameOf={(id) => app.providers.find((p) => p.id === id)?.displayName ?? id} mcp={app.mcp} />;
    default:
      return null;
  }
}

/** The session's agent as the UI names it (its display name; the id when it's unknown). */
export const agentName = (app: AppState, s: SessionView) => app.providers.find((p) => p.id === s.provider)?.displayName ?? s.provider;

// ---------------------------------------------------------------- banners

function Cmds({ text }: { text: string }) {
  // "Run `codex login` in a terminal" → inline code with a 14px copy button, still one sentence (v1.2 review).
  return (
    <>
      {text.split(/(`[^`]+`)/g).map((part, i) =>
        part.startsWith("`") ? (
          <span key={i} className="inl-cmd">
            <code>{part.slice(1, -1)}</code>
            <CopyButton kind="inline" text={part.slice(1, -1)} label={`Copy ${part.slice(1, -1)}`} />
          </span>
        ) : (
          <span key={i}>{part}</span>
        ),
      )}
    </>
  );
}

export function ProblemBanner({ session, app, act, onSwitch }: { session: SessionView; app: AppState; act: Act; onSwitch: () => void }) {
  const provider = app.providers.find((p) => p.id === session.provider);
  const name = provider?.displayName ?? session.provider;
  const others = app.providers.filter((p) => p.status === "ready" && p.id !== session.provider);
  // The shared normalisation (core/reason.ts), so any code the server sends picks a card.
  const code = failureCode(session.error?.code);
  const retry = () => quiet(act("retry"));
  const sw = others.length ? (
    <button type="button" className="btn quiet" onClick={onSwitch}>
      Switch agent
    </button>
  ) : null;
  const copy = {
    // One sentence, no title line (PR #2 review): "To keep going, log in to {agent}: run `claude` …, then come back (…)."
    auth: {
      icon: <IKey s={16} />,
      title: "",
      body: authSentence(name, provider?.loginHint ?? "Log in with the agent’s own command"),
      retry: "I’ve logged in, retry",
    },
    rate_limit: { icon: <IClock s={16} />, title: `${name} needs a short break`, body: "It hit its usage limit. Try again in a few minutes, or switch agents.", retry: "Retry" },
    // Slow, not failed (Grok 1.0.70 rounds run for minutes): the clock icon and the quiet tone, like a usage limit.
    timeout: { icon: <IClock s={16} />, title: fmt(COPY.timeoutTitle, { agent: name }), body: COPY.timeoutBody, retry: "Retry" },
    malformed: { icon: <IAlert s={16} />, title: "The agent’s reply didn’t come through", body: "We tried twice. Your answers are saved.", retry: "Retry" },
    // Like a missing gh (#165): say it isn't installed and how to install it (review-pr22 #3).
    not_found: {
      icon: <ITerm s={16} />,
      title: reasonText("not_found", name),
      body: `Grillado runs your own ${name}. Install it, then retry. Your answers are kept.`,
      // The command gets its own row, a well that wraps between words, so a long one (Grok's curl) never runs off a phone (review-pr22 r3 #1, r4 #1).
      cmd: provider?.installHint,
      retry: "Retry",
    },
    unknown: { icon: <IAlert s={16} />, title: "Can’t reach the agent", body: session.error?.message || "Grillado keeps your answers and retries when you ask.", retry: "Retry" },
  }[code];
  // The user's own Stop is not a failure: its own quiet card, keyed on the shared STOPPED message (review-pr26 r2 must 2).
  const stopped = isStopped(session.error);
  if (stopped) Object.assign(copy, { icon: <IClock s={16} />, title: fmt(COPY.stoppedTitle, { agent: name }), body: COPY.stoppedBody, retry: "Retry" });
  // A run that fails leaves focus on the page (its Send or Stop is gone): put it on Retry, unless the user is elsewhere (review-pr26 #4).
  const retryRef = useRef<HTMLButtonElement>(null);
  const errAt = session.error ? `${code}:${session.error.message ?? ""}` : "";
  useEffect(() => {
    const here = document.activeElement;
    if (errAt && (!here || here === document.body)) retryRef.current?.focus();
  }, [errAt]);
  // v1.2: one neutral surface; the tone is only on the icon (warning-ink, muted for a rate limit).
  const tone = stopped || code === "rate_limit" || code === "timeout" ? "info" : "warn";
  return (
    // The card's own width decides the layout (a container query): beside the side rail at tablet widths it's narrow too (review-pr22 r4 N1).
    <div className="bnq">
      <div className="banner" data-tone={tone} role="alert" data-testid="problem" data-code={code} data-stopped={stopped ? true : undefined}>
        <span className="ic" aria-hidden="true">
          {copy.icon}
        </span>
        <div>
          {copy.title ? <p className="t">{copy.title}</p> : null}
          <p>{copy.body}</p>
          {"cmd" in copy && copy.cmd ? <CopyButton kind="well" text={copy.cmd} label={`Copy ${copy.cmd}`} /> : null}
        </div>
        <div className="acts">
          {code === "auth" ? null : sw}
          <button type="button" className="btn primary" ref={retryRef} onClick={retry}>
            {copy.retry}
          </button>
        </div>
      </div>
    </div>
  );
}

/** COPY.authBanner with the agent's login hint as inline commands ("Run `claude` …" → "run `claude` …"). */
function authSentence(agent: string, hint: string) {
  const [before, after] = COPY.authBanner.replace("{agent}", agent).split("{how}");
  return (
    <>
      {before}
      <Cmds text={hint.charAt(0).toLowerCase() + hint.slice(1)} />
      {after}
    </>
  );
}

// ---------------------------------------------------------------- dialogs

export function Dialog({ labelId, descId, onClose, children, role = "dialog" }: { labelId: string; descId?: string; onClose: () => void; children: React.ReactNode; role?: "dialog" | "alertdialog" }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const back = document.activeElement as HTMLElement | null;
    const el = ref.current;
    (el?.querySelector<HTMLElement>("[data-autofocus]") ?? el?.querySelector<HTMLElement>("button"))?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        onClose();
      } else if (e.key === "Tab" && el) {
        const f = [...el.querySelectorAll<HTMLElement>("button:not([disabled]),a[href],input,[tabindex='0']")];
        if (!f.length) return;
        const i = f.indexOf(document.activeElement as HTMLElement);
        if (e.shiftKey && i <= 0) {
          e.preventDefault();
          f.at(-1)?.focus();
        } else if (!e.shiftKey && i === f.length - 1) {
          e.preventDefault();
          f[0].focus();
        }
      }
    };
    document.addEventListener("keydown", onKey, true);
    return () => {
      document.removeEventListener("keydown", onKey, true);
      back?.focus?.();
    };
  }, [onClose]);
  return (
    <div className="scrim" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div ref={ref} className="dialog" role={role} aria-modal="true" aria-labelledby={labelId} aria-describedby={descId}>
        {children}
      </div>
    </div>
  );
}

export function dependentsOf(s: SessionView, key: string): string[] {
  const out = new Set<string>();
  let frontier = [key];
  while (frontier.length) {
    const next: string[] = [];
    for (const d of Object.values(s.decisions)) {
      if (out.has(d.key) || d.key === key) continue;
      if (d.dependsOn.some((k) => frontier.includes(k))) {
        out.add(d.key);
        next.push(d.key);
      }
    }
    frontier = next;
  }
  return [...out];
}

const nameOf = (d: Decision) => d.label || d.title;

export function ReopenDialog({ session, d, act, onClose, onPreview }: { session: SessionView; d: Decision; act: Act; onClose: () => void; onPreview?: (keys: string[] | null) => void }) {
  const deps = useMemo(() => dependentsOf(session, d.key), [session, d.key]);
  useEffect(() => {
    onPreview?.([d.key, ...deps]);
    return () => onPreview?.(null);
  }, [d.key, deps, onPreview]);
  const name = nameOf(d);
  const depNames = deps.map((k) => (session.decisions[k] ? nameOf(session.decisions[k]) : k));
  return (
    <Dialog labelId="ro-t" descId="ro-d" onClose={onClose} role="alertdialog">
      <h2 id="ro-t">Reopen “{name}”?</h2>
      <p id="ro-d">
        You’ll pick it again in the next round.
        {depNames.length ? (
          <>
            {" "}
            {depNames.length === 1 ? "This decision depends on it, so it’ll be asked again too: " : "These decisions depend on it, so they’ll be asked again too: "}
            {depNames.map((d, i) => (
              <span key={d}>
                {i ? (i === depNames.length - 1 ? " and " : ", ") : null}
                <b>{d}</b>
              </span>
            ))}
            .
          </>
        ) : null}{" "}
        Everything else stays settled.
      </p>
      <div className="foot">
        <button type="button" className="btn quiet" data-autofocus onClick={onClose}>
          Cancel
        </button>
        <button
          type="button"
          className="btn primary"
          onClick={() => {
            onClose();
            quiet(act("reopen", { key: d.key }));
          }}
        >
          Reopen {name}
        </button>
      </div>
    </Dialog>
  );
}

// ---------------------------------------------------------------- 4 confirm

/** Settled decisions grouped by their top-level branch, in tree order. */
export function groupDecisions(session: SessionView): { title: string; items: Decision[] }[] {
  const tree = session.tree;
  const byId = new Map(tree.nodes.map((n) => [n.id, n]));
  const top = (n: DecisionNode): DecisionNode => {
    let cur = n;
    while (cur.parentId && cur.parentId !== tree.rootId && byId.get(cur.parentId)) cur = byId.get(cur.parentId)!;
    return cur;
  };
  const groups = new Map<string, { title: string; items: Decision[] }>();
  const seen = new Set<string>();
  for (const n of tree.nodes) {
    const d = session.decisions[n.id];
    if (!d) continue;
    const t = top(n);
    const g = groups.get(t.id) ?? { title: t.label, items: [] };
    g.items.push(d);
    groups.set(t.id, g);
    seen.add(d.key);
  }
  const rest = Object.values(session.decisions).filter((d) => !seen.has(d.key));
  if (rest.length) groups.set("__rest", { title: "Other", items: rest });
  return [...groups.values()];
}

const SHOW = 6;

function Confirm({ session, act, agent }: { session: SessionView; act: Act; agent: string }) {
  const mobile = useMobile();
  const [reopening, setReopening] = useState<Decision | null>(null);
  const [more, setMore] = useState(false);
  const [preview, setPreview] = useState<Set<string> | undefined>();
  const onPreview = useMemo(() => (keys: string[] | null) => setPreview(keys ? new Set(keys) : undefined), []);
  const all = groupDecisions(session).flatMap((g) => g.items);
  const n = all.length;
  const plate = () => quiet(act("confirm"));
  // The same open set the plan will list (counts.ts), so this screen and the plan agree.
  const open = stillOpen(session).map((q) => ({ id: q.key, label: q.label || q.title }));
  const early = open.length > 0;
  const cc = confirmCounts(session);
  const counts = countText(cc);
  const status = roundStatus(session, agent);
  // Long lists fold after six rows; group headings only on an early wrap (v1.2).
  const fold = all.length > SHOW + 2 && !more;
  const shown = fold ? all.slice(0, SHOW) : all;
  const row = (d: Decision) => (
    <div className="dr" key={d.key}>
      <dt className="k" title={nameOf(d)}>{nameOf(d)}</dt>
      <dd className="v">
        {/* The answer truncates; the tag never does (demo finding nice-to-have 1). */}
        <span className="va" title={d.answer}>{d.answer}</span>
        {!d.accepted_recommendation ? <span className="yc">Your call</span> : null}
      </dd>
      <dd className="re">
        <button type="button" className="btn quiet sm" aria-label={`Reopen ${nameOf(d)}`} onClick={() => setReopening(d)}>
          Reopen
        </button>
      </dd>
    </div>
  );
  const actions = (
    <>
      <button type="button" className="btn primary" autoFocus={!mobile} onClick={plate}>
        Yes, plate it
        <span className="k" aria-hidden="true">
          ↵
        </span>
      </button>
      {/* Only below the cap (#33): at the cap the server refuses another round. */}
      {atCap(session) ? null : (
        <button type="button" className="btn quiet" aria-label="Keep going on a branch" onClick={() => quiet(act("keep-going"))}>
          {mobile ? "Keep going" : "Keep going on a branch"}
        </button>
      )}
    </>
  );
  return (
    <SessionBody
      session={session}
      compact
      // Same source as the title and the plan it will write (item 2 §4); the tree's own count includes upcoming nodes.
      sideSub={early ? `${cc.resolved} settled · ${cc.open} open` : undefined}
      previewStale={preview}
      main={
        <div className="main" style={{ gridTemplateRows: mobile ? "minmax(0,1fr) auto" : "minmax(0,1fr)" }}>
          <div className="scroll">
            <Strip session={session} />
            <section className="col appr" aria-labelledby="confirm-title">
              <div className="intro">
                {/* Victor, v1.2 review: an early wrap asks the real question; no kicker above the title (C6). */}
                <h1 id="confirm-title">{early ? `Wrap up with ${open.length} still open?` : "Is it done?"}</h1>
                {status ? (
                  <p className="rmeta" data-testid="round-status">
                    {status}
                  </p>
                ) : null}
                <p>
                  {early ? `${counts.confirm}. The plan will list ${open.length === 1 ? "it" : "them"} as open decisions.` : `${plural(n, "decision")} settled, nothing open.`} Read them over before the plan gets written.
                </p>
                {session.agentNote ? (
                  <p className="agent-note" data-testid="agent-note">
                    {session.agentNote}
                  </p>
                ) : null}
              </div>
              <div className="dl">
                {early ? (
                  <>
                    <h2 id="grp-open">Still open</h2>
                    <dl aria-labelledby="grp-open">
                      {open.map((x) => (
                        <div className="dr" key={x.id}>
                          <dt className="k">{x.label}</dt>
                          <dd className="v open">Open · listed in the plan</dd>
                        </div>
                      ))}
                    </dl>
                    <h2 id="grp-settled">Settled</h2>
                  </>
                ) : null}
                <dl aria-labelledby={early ? "grp-settled" : undefined}>{shown.map(row)}</dl>
                {fold ? (
                  <button type="button" className="btn quiet sm more" onClick={() => setMore(true)}>
                    Show {all.length - SHOW} more
                  </button>
                ) : null}
              </div>
              {mobile ? null : <div className="stickfoot">{actions}</div>}
            </section>
          </div>
          {mobile ? <div className="pinned">{actions}</div> : null}
          {reopening ? <ReopenDialog session={session} d={reopening} act={act} onClose={() => setReopening(null)} onPreview={onPreview} /> : null}
        </div>
      }
    />
  );
}

// ---------------------------------------------------------------- 5 plating

function Plating({ session, act, banner }: { session: SessionView; act: Act; banner?: React.ReactNode }) {
  const busy = session.busy;
  const elapsed = useSince(session.runAt ?? session.updatedAt, busy);
  const groups = groupDecisions(session);
  const n = Object.keys(session.decisions).length;
  const base = `Plating your plan from ${n} ${n === 1 ? "decision" : "decisions"}…`;
  const label = elapsed >= 15 ? "Still writing the plan…" : base;
  return (
    <SessionBody
      session={session}
      compact
      dim
      showHeat={false}
      main={
        <div className="main" style={{ gridTemplateRows: "minmax(0,1fr)" }}>
          <div className="scroll">
            <Strip session={session} />
            <div className="col">
              {banner}
              {busy ? <StatusLine label={label} note={COPY.platingWaitNote} onStop={elapsed >= 60 ? () => quiet(act("stop")) : undefined} /> : null}
              <article className="plate" aria-label="Plan draft">
                <h1>{session.idea.split("\n")[0]}</h1>
                {groups.map((g) => (
                  <section key={g.title}>
                    <h2>{g.title}</h2>
                    <p>{g.items.map((d) => (nameOf(d) === g.title ? `${d.answer}.` : `${nameOf(d)}: ${d.answer}.`)).join(" ")}</p>
                  </section>
                ))}
                {busy ? (
                  <div className="sk" aria-hidden="true">
                    <i style={{ width: "62%" }} />
                    <i />
                    <i style={{ width: "90%" }} />
                    <i style={{ width: "76%" }} />
                  </div>
                ) : null}
              </article>
            </div>
          </div>
        </div>
      }
    />
  );
}
export type { TreeState };
