// The plan-to-build loop in the plan view: the Build tab (the plan's steps, the coding agent's
// progress on them, what it asked) and the ask cards pinned above the plan while an agent waits.
//
// The user edits the steps here (title, done check, order, add, remove) and reopens one the agent
// marked done. Only the user answers an ask; the card is the round's question card, so number keys
// and Enter work the same way.
import { useEffect, useId, useRef, useState } from "react";
import {
  AgentQuestion,
  type AgentQuestionAnswers,
  AgentQuestionDescription,
  AgentQuestionFooter,
  AgentQuestionHeader,
  AgentQuestionItem,
  AgentQuestionOption,
  AgentQuestionOptions,
  AgentQuestionOther,
  AgentQuestionStack,
  AgentQuestionTitle,
  agentQuestionOtherKey,
} from "@/components/ui/uai/agent-question";
import { COPY, fmt } from "../copy";
import { ICheck, IDown, IEdit, IPlus, IUndo, IX } from "../icons";
import type { BuildAsk, BuildState, BuildStep, SessionView } from "../types";

type Act = (action: string, body?: unknown) => Promise<void>;

export const openAsks = (b: BuildState | undefined) => (b?.asks ?? []).filter((a) => a.state === "open");
const stepNo = (b: BuildState, key: string | undefined) => (key ? b.steps.findIndex((s) => s.key === key) + 1 : 0);

// ---------------------------------------------------------------- the ask card

function AskCard({ ask, build, act }: { ask: BuildAsk; build: BuildState; act: Act }) {
  const [status, setStatus] = useState<"asking" | "submitting">("asking");
  const [error, setError] = useState<string>();
  const [values, setValues] = useState<AgentQuestionAnswers>({});
  const n = stepNo(build, ask.step);
  const submit = async (v: AgentQuestionAnswers) => {
    const raw = v[ask.key];
    const picked = typeof raw === "string" ? raw : ask.recommended;
    const text = picked === "other" ? String(v[agentQuestionOtherKey(ask.key)] ?? "").trim() : undefined;
    setStatus("submitting");
    setError(undefined);
    try {
      await act("build", { op: "answer", key: ask.key, ...(text !== undefined ? { text } : { optionId: picked }) });
    } catch {
      setError(COPY.askFailed);
      setStatus("asking");
    }
  };
  return (
    <AgentQuestion
      className="askc"
      layout="stacked"
      variant="card"
      status={status}
      preselectRecommended={!!ask.recommended}
      error={error}
      value={values}
      onValueChange={setValues}
      onSubmit={(v) => void submit(v)}
      submitLabel={COPY.askSend}
      data-testid="ask-card"
      data-ask={ask.key}
    >
      <AgentQuestionHeader className="sr-only">{null}</AgentQuestionHeader>
      <p className="ask-tag">
        <span className="dot" aria-hidden="true" />
        {COPY.askWaiting}
        {n ? <span className="at"> · {fmt(COPY.askAt, { n: String(n), of: String(build.steps.length) })}</span> : null}
      </p>
      <AgentQuestionStack className="cards">
        <AgentQuestionItem id={ask.key} required className="q" data-key={ask.key}>
          <AgentQuestionTitle className="q-t">{ask.title}</AgentQuestionTitle>
          {ask.body ? <AgentQuestionDescription className="q-d">{ask.body}</AgentQuestionDescription> : null}
          <AgentQuestionOptions>
            {ask.options.map((o) => (
              <AgentQuestionOption key={o.id} value={o.id} label={o.label} description={o.description || undefined} recommended={o.id === ask.recommended} />
            ))}
            <AgentQuestionOther className="mini" description="" />
          </AgentQuestionOptions>
        </AgentQuestionItem>
      </AgentQuestionStack>
      {/* A child of its own replaces the component's key hints; the button sits at the right. */}
      <AgentQuestionFooter className="ask-foot">
        <span className="spacer" />
      </AgentQuestionFooter>
    </AgentQuestion>
  );
}

/** The coding agent's open asks, pinned above the plan. Keys typed with nothing focused go to the first one. */
export function AskCards({ session, act }: { session: SessionView; act: Act }) {
  const asks = openAsks(session.build);
  const any = asks.length > 0;
  useEffect(() => {
    if (!any) return;
    const onKey = (e: KeyboardEvent) => {
      const a = document.activeElement;
      if (a && a !== document.body) return;
      if (e.metaKey || e.ctrlKey || e.altKey || !/^([1-9]|Enter)$/.test(e.key)) return;
      const title = document.querySelector<HTMLElement>("[data-testid=ask-card] [data-slot=agent-question-title]");
      if (!title) return;
      e.preventDefault();
      title.focus({ preventScroll: true });
      title.dispatchEvent(new KeyboardEvent("keydown", { key: e.key, bubbles: true, cancelable: true }));
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [any]);
  if (!any || !session.build) return null;
  return (
    <section className="asks" aria-label={COPY.askWaiting} data-testid="asks">
      {asks.map((a) => (
        <AskCard key={a.key} ask={a} build={session.build!} act={act} />
      ))}
    </section>
  );
}

// ---------------------------------------------------------------- the Build tab

const STATUS: Record<BuildStep["status"], string> = { todo: COPY.stepTodo, started: COPY.stepStarted, done: COPY.stepDone };

function StepForm({ title, done, onSave, onCancel, save }: { title: string; done: string; onSave: (title: string, done: string) => Promise<void>; onCancel?: () => void; save: string }) {
  const [t, setT] = useState(title);
  const [d, setD] = useState(done);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const tid = useId();
  const did = useId();
  const go = async () => {
    if (busy || !t.trim()) return;
    setBusy(true);
    setError("");
    try {
      await onSave(t.trim(), d.trim());
      if (!onCancel) {
        setT("");
        setD("");
      }
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };
  const keys = (e: React.KeyboardEvent) => {
    if (e.key === "Enter") {
      e.preventDefault();
      void go();
    } else if (e.key === "Escape" && onCancel) {
      e.preventDefault();
      onCancel();
    }
  };
  return (
    <div className="bform">
      <label htmlFor={tid}>{COPY.stepTitle}</label>
      <input id={tid} value={t} maxLength={160} autoFocus={!!onCancel} onChange={(e) => setT(e.target.value)} onKeyDown={keys} data-testid="step-title" />
      <label htmlFor={did}>{COPY.stepCheck}</label>
      <input id={did} value={d} maxLength={400} onChange={(e) => setD(e.target.value)} onKeyDown={keys} data-testid="step-check" />
      <div className="bform-acts">
        <button type="button" className="btn soft sm" disabled={busy || !t.trim()} onClick={() => void go()} data-testid="step-save">
          {save}
        </button>
        {onCancel ? (
          <button type="button" className="btn quiet sm" onClick={onCancel}>
            {COPY.stepCancel}
          </button>
        ) : null}
      </div>
      {error ? (
        <p className="err" role="alert">
          {error}
        </p>
      ) : null}
    </div>
  );
}

export function BuildTab({ session, act }: { session: SessionView; act: Act }) {
  const b: BuildState = session.build ?? { rev: 1, seq: 0, steps: [], asks: [], log: [] };
  const [editing, setEditing] = useState<string | null>(null);
  const [said, setSaid] = useState("");
  const [error, setError] = useState("");
  // After a move the step is another DOM position: put focus back on the button that moved it.
  const refocus = useRef<{ key: string; by: -1 | 1 } | null>(null);
  const list = useRef<HTMLOListElement>(null);
  useEffect(() => {
    const f = refocus.current;
    if (!f) return;
    refocus.current = null;
    const row = list.current?.querySelector<HTMLElement>(`[data-step="${CSS.escape(f.key)}"]`);
    const btn = row?.querySelector<HTMLButtonElement>(`[data-move="${f.by}"]:not(:disabled)`) ?? row?.querySelector<HTMLButtonElement>("[data-move]:not(:disabled)");
    btn?.focus();
  }, [b.steps]);
  const run = async (body: Record<string, unknown>, say?: string) => {
    setError("");
    try {
      await act("build", body);
      if (say) setSaid(say);
    } catch (err) {
      setError((err as Error).message);
    }
  };
  const move = (s: BuildStep, i: number, by: -1 | 1) => {
    refocus.current = { key: s.key, by };
    void run({ op: "move", step: s.key, by }, fmt(COPY.stepMoved, { at: String(i + 1 + by), n: String(b.steps.length) }));
  };
  const done = b.steps.filter((s) => s.status === "done").length;
  return (
    <div className="btab" data-testid="build-tab">
      <header className="btab-h">
        <h1>{COPY.buildTab}</h1>
        <p className="meta" data-testid="build-meta">
          {b.steps.length ? `${fmt(COPY.buildProgress, { done: String(done), n: String(b.steps.length) })} · ` : ""}
          {fmt(COPY.buildRev, { rev: String(b.rev) })}
        </p>
      </header>
      <p className="sub">{b.steps.length ? COPY.buildHint : COPY.buildNone}</p>
      {error ? (
        <p className="err" role="alert">
          {error}
        </p>
      ) : null}
      <ol className="bsteps" ref={list}>
        {b.steps.map((s, i) => (
          <li
            key={s.key}
            className="bstep"
            data-step={s.key}
            data-status={s.status}
            data-testid="build-step"
            onKeyDown={(e) => {
              // Alt+↑ / Alt+↓ on anything in the row moves the step.
              if (!e.altKey || (e.key !== "ArrowUp" && e.key !== "ArrowDown")) return;
              const by = e.key === "ArrowUp" ? -1 : 1;
              if (i + by < 0 || i + by >= b.steps.length) return;
              e.preventDefault();
              move(s, i, by);
            }}
          >
            <span className="bmark" data-status={s.status} title={STATUS[s.status]}>
              {s.status === "done" ? <ICheck s={12} /> : null}
              <span className="sr-only">{STATUS[s.status]}</span>
            </span>
            {editing === s.key ? (
              <StepForm
                title={s.title}
                done={s.done}
                save={COPY.stepSave}
                onCancel={() => setEditing(null)}
                onSave={async (title, check) => {
                  await act("build", { op: "edit", step: s.key, title, done: check });
                  setEditing(null);
                }}
              />
            ) : (
              <div className="bbody">
                <p className="bt">
                  <span className="bn">{i + 1}.</span> {s.title}
                  {s.status === "started" ? <span className="btag">{COPY.stepStarted}</span> : null}
                </p>
                {s.done ? (
                  <p className="bd">
                    <span>{COPY.stepDoneWhen}:</span> {s.done}
                  </p>
                ) : null}
                {s.verified ? (
                  <p className="bd">
                    <span>{COPY.stepVerified}:</span> {s.verified}
                  </p>
                ) : null}
                {s.deviation ? (
                  <p className="bd dev">
                    <span>{COPY.stepDeviation}:</span> {s.deviation}
                  </p>
                ) : null}
              </div>
            )}
            {editing === s.key ? null : (
              <div className="bacts">
                {s.status !== "todo" ? (
                  <button type="button" className="btn quiet sm" onClick={() => void run({ op: "reopen", step: s.key }, COPY.stepReopened)} data-testid="step-reopen">
                    <IUndo s={14} />
                    {COPY.stepReopen}
                  </button>
                ) : null}
                <button type="button" className="icon-btn" aria-label={`${COPY.stepEdit}: ${s.title}`} title={COPY.stepEdit} onClick={() => setEditing(s.key)} data-testid="step-edit">
                  <IEdit s={14} />
                </button>
                <button type="button" className="icon-btn" aria-label={`${COPY.stepUp}: ${s.title}`} title={`${COPY.stepUp} (Alt+↑)`} disabled={i === 0} data-move="-1" onClick={() => move(s, i, -1)} data-testid="step-up">
                  <span className="flip">
                    <IDown s={14} />
                  </span>
                </button>
                <button type="button" className="icon-btn" aria-label={`${COPY.stepDown}: ${s.title}`} title={`${COPY.stepDown} (Alt+↓)`} disabled={i === b.steps.length - 1} data-move="1" onClick={() => move(s, i, 1)} data-testid="step-down">
                  <IDown s={14} />
                </button>
                <button type="button" className="icon-btn" aria-label={`${COPY.stepRemove}: ${s.title}`} title={COPY.stepRemove} onClick={() => void run({ op: "remove", step: s.key }, COPY.stepRemoved)} data-testid="step-remove">
                  <IX s={14} />
                </button>
              </div>
            )}
          </li>
        ))}
      </ol>
      <details className="badd" data-testid="step-add" open={!b.steps.length || undefined}>
        <summary>
          <IPlus s={14} />
          {COPY.stepAdd}
        </summary>
        <StepForm title="" done="" save={COPY.stepAdd} onSave={(title, check) => act("build", { op: "add", title, done: check })} />
      </details>
      {b.asks.length ? (
        <section className="basks" aria-label={COPY.asksTitle}>
          <h2>{COPY.asksTitle}</h2>
          <ul>
            {b.asks.map((a) => (
              <li key={a.key} data-state={a.state} data-testid="build-ask">
                <p className="bt">{a.title}</p>
                <p className="bd">
                  {a.state === "answered" ? fmt(COPY.askAnswered, { answer: a.answer ?? "" }) : a.state === "withdrawn" ? COPY.askWithdrawn : COPY.askOpen}
                  {stepNo(b, a.step) ? ` · ${fmt(COPY.askAt, { n: String(stepNo(b, a.step)), of: String(b.steps.length) })}` : ""}
                </p>
              </li>
            ))}
          </ul>
        </section>
      ) : null}
      <span className="sr-only" aria-live="polite">
        {said}
      </span>
    </div>
  );
}
