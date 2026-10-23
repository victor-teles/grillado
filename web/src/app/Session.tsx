// In-session screens: dispatcher, problem banners, confirm (+ reopen dialogs), plating.
import { useEffect, useMemo, useRef, useState } from "react";
import { clock, useMobile, useSince } from "./chrome";
import { CopyButton } from "./CopyButton";
import { IAlert, IBranch, ICheck, IClock, IKey, IPlate, ISq, IUndo, IWifi } from "./icons";
import { PlanView } from "./Plan";
import { FiringUp, RoundView, SessionBody, SkeletonCard, Strip, WaitingView, waitLabel } from "./Round";
import type { AppState, Decision, DecisionNode, SessionView, TreeState } from "./types";

export type Act = (action: string, body?: unknown) => Promise<void>;
const quiet = (p: Promise<void>) => void p.catch(() => {});

export function SessionScreen({ session, app, act, onSwitch }: { session: SessionView; app: AppState; act: Act; onSwitch: () => void }) {
  const banner = session.error && !session.busy ? <ProblemBanner session={session} app={app} act={act} onSwitch={onSwitch} /> : null;
  switch (session.status) {
    case "asking":
      return session.rounds.length === 0 ? <FiringUp session={session} act={act} banner={banner} /> : <WaitingView session={session} act={act} banner={banner} />;
    case "answering":
      return <RoundView session={session} act={act} banner={banner} />;
    case "confirm":
      return <Confirm session={session} act={act} />;
    case "synthesizing":
      return <Plating session={session} act={act} banner={banner} />;
    case "plated":
      return <PlanView session={session} act={act} />;
    default:
      return null;
  }
}

// ---------------------------------------------------------------- banners

function Cmds({ text }: { text: string }) {
  // "Run `codex login` in a terminal" → copyable command chips.
  return (
    <>
      {text.split(/(`[^`]+`)/g).map((part, i) =>
        part.startsWith("`") ? <CopyButton key={i} kind="cmd" text={part.slice(1, -1)} label={`Copy ${part.slice(1, -1)}`} /> : <span key={i}>{part}</span>,
      )}
    </>
  );
}

export function ProblemBanner({ session, app, act, onSwitch }: { session: SessionView; app: AppState; act: Act; onSwitch: () => void }) {
  const provider = app.providers.find((p) => p.id === session.provider);
  const name = provider?.displayName ?? session.provider;
  const others = app.providers.filter((p) => p.status === "ready" && p.id !== session.provider);
  const code = session.error?.code ?? "unknown";
  const retry = () => quiet(act("retry"));
  const sw = others.length ? (
    <button type="button" className="pill secondary sm" onClick={onSwitch}>
      Switch agent
    </button>
  ) : null;
  const copy = {
    auth: {
      tone: "warn",
      icon: <IKey s={16} />,
      title: `Log in to ${name} to continue`,
      body: (
        <>
          <Cmds text={provider?.loginHint ?? "Log in with the agent's own command"} />, then come back.
        </>
      ),
      retry: "I've logged in, retry",
    },
    rate_limit: { tone: "info", icon: <IClock s={16} />, title: `${name} needs a short break`, body: "It hit its usage limit. Try again in a few minutes, or switch agents.", retry: "Retry" },
    timeout: { tone: "info", icon: <IAlert s={16} />, title: "The agent's reply didn't come through", body: "Nothing came back in time. Your answers are saved.", retry: "Retry" },
    malformed: { tone: "info", icon: <IAlert s={16} />, title: "The agent's reply didn't come through", body: "We tried twice. Your answers are saved.", retry: "Retry" },
    not_found: { tone: "err", icon: <IWifi s={16} />, title: `Can't reach ${name}`, body: "The command couldn't be started. Grillado keeps your answers and retries when you ask.", retry: "Retry" },
    unknown: { tone: "err", icon: <IAlert s={16} />, title: "Can't reach the agent", body: session.error?.message || "Grillado keeps your answers and retries when you ask.", retry: "Retry" },
  }[code];
  return (
    <div className={`banner ${copy.tone}`} role="alert" data-testid="problem" data-code={code}>
      <span className="ic" aria-hidden="true">
        {copy.icon}
      </span>
      <div>
        <div className="t">{copy.title}</div>
        <div className="s">{copy.body}</div>
      </div>
      <div className="acts">
        {code === "auth" ? (
          <span className="fb sm">
            <ICheck s={12} />
            Your answers are saved
          </span>
        ) : (
          sw
        )}
        <button type="button" className={`pill ${code === "auth" ? "primary" : "secondary"} sm`} onClick={retry}>
          {copy.retry}
        </button>
      </div>
    </div>
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
      <div ref={ref} className="dlg" role={role} aria-modal="true" aria-labelledby={labelId} aria-describedby={descId}>
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
  return (
    <Dialog labelId="ro-t" descId="ro-d" onClose={onClose} role="alertdialog">
      <h3 id="ro-t">Reopen “{name}”?</h3>
      <p id="ro-d">{deps.length ? "You'll pick it again in the next round. These decisions depend on it, so they'll be asked again too:" : "You'll pick it again in the next round."}</p>
      {deps.length ? (
        <ul className="deps">
          {deps.map((k) => (
            <li key={k}>
              <span className="hatch" aria-hidden="true" />
              {session.decisions[k] ? nameOf(session.decisions[k]) : k}
            </li>
          ))}
        </ul>
      ) : null}
      <p>Everything else stays settled.</p>
      <div className="ft">
        <button type="button" className="pill secondary" data-autofocus onClick={onClose}>
          Cancel
        </button>
        <button
          type="button"
          className="pill primary"
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

function ReopenPicker({ decisions, onPick, onClose }: { decisions: Decision[]; onPick: (d: Decision) => void; onClose: () => void }) {
  return (
    <Dialog labelId="rp-t" onClose={onClose}>
      <h3 id="rp-t">Reopen a decision</h3>
      <p>Pick one to answer again in the next round.</p>
      <ul className="pick">
        {decisions.map((d) => (
          <li key={d.key}>
            <button type="button" onClick={() => onPick(d)}>
              <span>{nameOf(d)}</span>
              <span className="a">{d.answer}</span>
            </button>
          </li>
        ))}
      </ul>
      <div className="ft">
        <button type="button" className="pill secondary" onClick={onClose}>
          Cancel
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

function Confirm({ session, act }: { session: SessionView; act: Act }) {
  const mobile = useMobile();
  const [reopening, setReopening] = useState<Decision | null>(null);
  const [picking, setPicking] = useState(false);
  const [preview, setPreview] = useState<Set<string> | undefined>();
  const onPreview = useMemo(() => (keys: string[] | null) => setPreview(keys ? new Set(keys) : undefined), []);
  const groups = groupDecisions(session);
  const all = groups.flatMap((g) => g.items);
  const n = all.length;
  const minutes = clock(Math.max(0, Math.floor((Date.parse(session.updatedAt) - Date.parse(session.createdAt)) / 1000)));
  const plate = () => quiet(act("confirm"));
  const open = session.tree.nodes.filter((x) => x.id !== session.tree.rootId && x.status !== "settled");
  const early = open.length > 0;
  return (
    <SessionBody
      session={session}
      sideSub="whole plan"
      compact
      previewStale={preview}
      main={
        <div className="main" style={{ gridTemplateRows: mobile ? "minmax(0,1fr) auto" : "minmax(0,1fr)" }}>
          <div className="scroll">
            <div className="col" style={{ maxWidth: 640 }}>
              <Strip session={session} />
              <div className="intro" style={{ gap: 6 }}>
                <div className="eb">
                  {early ? <span className="badge2 warn">Wrapping up early</span> : <span className="badge2 ok"><ICheck s={12} />Nothing left open</span>}
                  after {session.rounds.length} {session.rounds.length === 1 ? "round" : "rounds"} · {minutes} elapsed
                </div>
              </div>
              <section className="card2 appr" aria-labelledby="confirm-title">
                <div className="hd">
                  <span className={`ic${early ? " warn" : ""}`} aria-hidden="true">
                    <ICheck s={16} />
                  </span>
                  <div>
                    <h1 id="confirm-title">Is it done?</h1>
                    <p>
                      {n} {n === 1 ? "decision" : "decisions"} settled,{" "}
                      {early ? `${open.length} still open. The plan will list ${open.length === 1 ? "it" : "them"} as open decisions.` : "nothing open."} Read them over before the plan gets
                      written.
                    </p>
                  </div>
                </div>
                <div className="dl">
                  {early ? (
                    <section aria-labelledby="grp-open">
                      <h2 className="g" id="grp-open">
                        Still open
                      </h2>
                      <dl style={{ margin: 0 }}>
                        {open.map((x) => (
                          <div className="row open-q" key={x.id}>
                            <dt>{x.label}</dt>
                            <dd>
                              <span className="ans">Open · listed in the plan</span>
                            </dd>
                          </div>
                        ))}
                      </dl>
                    </section>
                  ) : null}
                  {groups.map((g, gi) => (
                    <section key={g.title} aria-labelledby={`grp-${gi}`}>
                      <h2 className="g" id={`grp-${gi}`}>
                        {g.title}
                      </h2>
                      <dl style={{ margin: 0 }}>
                        {g.items.map((d) => (
                          <div className="row" key={d.key}>
                            <dt>{nameOf(d)}</dt>
                            <dd>
                              <span className="ans">
                                {d.answer}
                                {!d.accepted_recommendation ? <span className="sub" style={{ fontWeight: 450 }}> · your call</span> : null}
                              </span>
                              <button type="button" className="ro" aria-label={`Reopen ${nameOf(d)}`} onClick={() => setReopening(d)}>
                                <IUndo s={12} />
                                Reopen
                              </button>
                            </dd>
                          </div>
                        ))}
                      </dl>
                    </section>
                  ))}
                </div>
                {mobile ? null : (
                  <div className="ft">
                    <button type="button" className="pill primary" autoFocus onClick={plate}>
                      Yes, plate it <kbd>↵</kbd>
                    </button>
                    <button type="button" className="pill secondary" onClick={() => setPicking(true)} disabled={!n}>
                      Reopen a decision
                    </button>
                    <span className="spacer" />
                    <button type="button" className="pill ghost2" onClick={() => quiet(act("keep-going"))}>
                      <IBranch s={14} />
                      Keep going on a branch
                    </button>
                  </div>
                )}
              </section>
            </div>
          </div>
          {mobile ? (
            <div className="mbar">
              <button type="button" className="pill primary" style={{ flex: 1 }} onClick={plate}>
                Yes, plate it
              </button>
              <button type="button" className="pill secondary" onClick={() => setPicking(true)} disabled={!n}>
                Reopen…
              </button>
              <button type="button" className="pill ghost2" onClick={() => quiet(act("keep-going"))}>
                Keep going
              </button>
            </div>
          ) : null}
          {picking ? (
            <ReopenPicker
              decisions={all}
              onClose={() => setPicking(false)}
              onPick={(d) => {
                setPicking(false);
                setReopening(d);
              }}
            />
          ) : null}
          {reopening ? <ReopenDialog session={session} d={reopening} act={act} onClose={() => setReopening(null)} onPreview={onPreview} /> : null}
        </div>
      }
    />
  );
}

// ---------------------------------------------------------------- 5 plating

function Plating({ session, act, banner }: { session: SessionView; act: Act; banner?: React.ReactNode }) {
  const busy = session.busy;
  const elapsed = useSince(session.updatedAt, busy);
  const groups = groupDecisions(session);
  const n = Object.keys(session.decisions).length;
  const base = `Plating your plan from ${n} ${n === 1 ? "decision" : "decisions"}…`;
  const long = elapsed >= 15;
  const label = elapsed >= 60 ? "Still writing the plan. This one is taking a while" : long ? "Still writing the plan" : base;
  void waitLabel;
  return (
    <SessionBody
      session={session}
      sideSub={`${n} settled`}
      compact
      dim
      showHeat={false}
      showLegend={false}
      main={
        <div className="main" style={{ gridTemplateRows: "minmax(0,1fr)" }}>
          <div className="scroll">
            <div className="col" style={{ maxWidth: 720, gap: 14 }}>
              <Strip session={session} />
              {banner}
              {busy ? (
                <div className="waiting" role="status" aria-live="polite">
                  <div className="row">
                    {long ? (
                      <span className="rs">
                        <span className="dots" aria-hidden="true">
                          <i />
                          <i />
                          <i />
                        </span>
                        <span className="shimmer">{label}</span>
                        <span className="det mono">{clock(elapsed)}</span>
                      </span>
                    ) : (
                      <span className="thinking">
                        <span className="fl" aria-hidden="true">
                          <IPlate s={18} />
                        </span>
                        <span className="shimmer">{label}</span>
                      </span>
                    )}
                    {elapsed >= 60 ? (
                      <button type="button" className="pill secondary sm" onClick={() => quiet(act("stop"))}>
                        <ISq s={12} />
                        Stop
                      </button>
                    ) : null}
                  </div>
                </div>
              ) : null}
              <article className="card2 plating-doc" aria-label="Plan draft" style={{ padding: "24px 28px", display: "grid", gap: 16 }}>
                <h1 style={{ fontSize: 22, lineHeight: "28px", fontWeight: 650, letterSpacing: "-.02em", margin: 0 }}>{session.idea.split("\n")[0]}</h1>
                {groups.map((g, gi) => (
                  <section key={g.title} className="psec" style={{ display: "grid", gap: 8, ["--k" as string]: gi }}>
                    <h2 style={{ fontSize: 13, fontWeight: 600, margin: 0, color: "var(--muted-foreground)" }}>{g.title}</h2>
                    <ul style={{ display: "flex", flexWrap: "wrap", gap: 6, listStyle: "none", margin: 0, padding: 0 }}>
                      {g.items.map((d, i) => (
                        <li key={d.key} className="chip" style={{ ["--k" as string]: gi * 3 + i }}>
                          <span className="ck" aria-hidden="true">
                            <ICheck s={12} />
                          </span>
                          <span className="k">{nameOf(d)}</span>
                          {d.answer}
                        </li>
                      ))}
                    </ul>
                  </section>
                ))}
                {busy ? (
                  <div aria-hidden="true" style={{ display: "grid", gap: 8 }}>
                    <span className="sk" style={{ width: "40%", height: 12 }} />
                    <span className="sk" style={{ width: "92%" }} />
                    <span className="sk" style={{ width: "84%" }} />
                    <span className="sk" style={{ width: "66%" }} />
                  </div>
                ) : null}
              </article>
              {busy && !groups.length ? <SkeletonCard /> : null}
            </div>
          </div>
        </div>
      }
    />
  );
}
export type { TreeState };
