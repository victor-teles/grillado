// Round view (Direction A): stacked questions, bottom bar, side panel, waiting and firing up.
import { createContext, useContext, useEffect, useMemo, useState } from "react";
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
import { COPY } from "./copy";
import { preparing, roundCounter } from "./rounds";
import { waitLabel } from "./wait";
import { useMobile, useSince } from "./chrome";
import { ISq } from "./icons";
import { MobileStrip, SidePanel } from "./Tree";
import { type Answer, type DecisionNode, OTHER_OPTION, type Question, type Round, type SessionView, UNKNOWN_OPTION } from "./types";

type Act = (action: string, body?: unknown) => Promise<void>;
/** The value Uai's AgentQuestionOther records. */
const OTHER_VALUE = "other";
export const SEND_FAILED = "The agent didn’t get your answers. They’re still here.";

/** Layout shared by every in-session screen: main column + side panel, mobile strip + sheet. */
export function SessionBody({
  session,
  main,
  sideSub,
  onNode,
  compact,
  previewStale,
  highlight,
  showHeat,
  dim,
  split,
}: {
  session: SessionView;
  main: React.ReactNode;
  sideSub?: string;
  onNode?: (n: DecisionNode) => void;
  compact?: boolean;
  previewStale?: Set<string>;
  highlight?: string;
  showHeat?: boolean;
  dim?: boolean;
  split?: boolean;
}) {
  const [sheet, setSheet] = useState(false);
  const mobile = useMobile();
  useEffect(() => {
    if (!mobile) setSheet(false);
  }, [mobile]);
  return (
    <div className={split ? "split" : "body"}>
      <MobileSheetContext.Provider value={{ open: sheet, toggle: () => setSheet((v) => !v) }}>{main}</MobileSheetContext.Provider>
      <SidePanel
        tree={session.tree}
        sub={sideSub}
        sheetOpen={sheet}
        onCloseSheet={() => setSheet(false)}
        onNode={(n) => {
          setSheet(false);
          onNode?.(n);
        }}
        compact={compact}
        previewStale={previewStale}
        highlight={highlight}
        showHeat={showHeat}
        dim={dim}
      />
    </div>
  );
}
const MobileSheetContext = createContext<{ open: boolean; toggle: () => void }>({ open: false, toggle: () => {} });
export function Strip({ session }: { session: SessionView }) {
  const s = useContext(MobileSheetContext);
  return <MobileStrip tree={session.tree} open={s.open} onToggle={s.toggle} />;
}

function focusCard(questionIndex: number | undefined) {
  if (questionIndex === undefined) return;
  const el = document.querySelectorAll<HTMLElement>("[data-slot=agent-question-item] [data-slot=agent-question-title]")[questionIndex];
  el?.focus();
  el?.scrollIntoView({ block: "nearest" });
}

// ---------------------------------------------------------------- answering

export function RoundView({ session, act, banner }: { session: SessionView; act: Act; banner?: React.ReactNode }) {
  const round = session.rounds.at(-1)!;
  // The question being answered is marked in the tree (v1.2: one --sel row, no glow).
  const [active, setActive] = useState<string | undefined>(round.questions[0]?.key);
  return (
    <SessionBody
      session={session}
      highlight={active}
      onNode={(n) => n.status === "frontier" && focusCard(n.questionIndex)}
      main={<RoundForm key={`${session.id}-${round.n}`} session={session} round={round} act={act} banner={banner} onActive={setActive} />}
    />
  );
}

function RoundForm({ session, round, act, banner, onActive }: { session: SessionView; round: Round; act: Act; banner?: React.ReactNode; onActive: (key: string) => void }) {
  const [status, setStatus] = useState<"asking" | "submitting">("asking");
  // Number-key hints stay hidden until the first number press (v1.2).
  const [keys, setKeys] = useState(false);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!e.metaKey && !e.ctrlKey && !e.altKey && /^[1-9]$/.test(e.key) && !(e.target as HTMLElement | null)?.matches?.("input,textarea")) setKeys(true);
    };
    const onIn = (e: Event) => {
      const key = (e.target as HTMLElement | null)?.closest?.<HTMLElement>("[data-slot=agent-question-item]")?.dataset.key;
      if (key) onActive(key);
    };
    document.addEventListener("keydown", onKey, true);
    document.addEventListener("focusin", onIn);
    document.addEventListener("pointerdown", onIn);
    return () => {
      document.removeEventListener("keydown", onKey, true);
      document.removeEventListener("focusin", onIn);
      document.removeEventListener("pointerdown", onIn);
    };
  }, [onActive]);
  const [error, setError] = useState<string>();
  const n = round.questions.length;
  const labelOf = useMemo(() => new Map(session.tree.nodes.map((x) => [x.id, x.label])), [session.tree]);
  void n;
  const parentOf = useMemo(() => new Map(session.tree.nodes.map((x) => [x.id, x.parentId])), [session.tree]);

  // Keys typed while nothing is focused go to the active card (input works from the first frame).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const a = document.activeElement;
      if (a && a !== document.body) return;
      if (e.metaKey || e.ctrlKey || e.altKey || !/^([1-9]|Enter|ArrowUp|ArrowDown|j|k|J|K|Home|End)$/.test(e.key)) return;
      const form = document;
      const legend =
        form.querySelector<HTMLElement>("[data-slot=agent-question-item][data-active] [data-slot=agent-question-title]") ??
        form.querySelector<HTMLElement>("[data-slot=agent-question-title]");
      if (!legend) return;
      e.preventDefault();
      legend.focus({ preventScroll: true });
      legend.dispatchEvent(new KeyboardEvent("keydown", { key: e.key, bubbles: true, cancelable: true }));
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, []);

  const [values, setValues] = useState<AgentQuestionAnswers>({});
  const submit = async (v: AgentQuestionAnswers, untouched: string[]) => {
    const answers: Answer[] = round.questions.map((q) => {
      const raw = v[q.key];
      const picked = typeof raw === "string" ? raw : q.recommendedOptionId;
      if (picked === OTHER_VALUE) return { questionId: q.key, optionId: OTHER_OPTION, text: String(v[agentQuestionOtherKey(q.key)] ?? "").trim(), accepted_recommendation: false };
      return { questionId: q.key, optionId: picked, accepted_recommendation: untouched.includes(q.key) || picked === q.recommendedOptionId };
    });
    setStatus("submitting");
    setError(undefined);
    try {
      await act("answers", { round: round.n, answers });
    } catch {
      setError(SEND_FAILED);
      setStatus("asking");
    }
  };

  const first = round.n === 1;
  return (
    <AgentQuestion
      className="main"
      layout="stacked"
      variant="card"
      status={status}
      preselectRecommended
      error={error}
      value={values}
      onValueChange={setValues}
      onSubmit={(v, meta) => void submit(v, meta.untouched)}
      submitLabel="Send round"
      data-keys={keys || undefined}
    >
      <div className="scroll">
        <Strip session={session} />
        <div className="col">
          {banner}
          {/* Names the form (role=form, aria-labelledby) and keeps the progress for screen readers;
              the visible intro below is Grillado's. */}
          <AgentQuestionHeader className="sr-only">{null}</AgentQuestionHeader>
          <div className="intro">
            <h1>{n === 1 ? "1 decision is ready" : `${n} decisions are ready`}</h1>
            <RoundCounter session={session} round={round} />
            <p>
              {first ? "The first calls on your idea." : "Each one opened up from something you settled."} Suggested picks are preselected. Change anything you disagree with.
            </p>
          </div>
          <AgentQuestionStack className="cards">
            {round.questions.map((q, i) => {
              const parent = parentOf.get(q.key);
              const openedBy = parent && parent !== session.tree.rootId ? labelOf.get(parent) : q.dependsOn[0] ? labelOf.get(q.dependsOn[0]) : undefined;
              const v = values[q.key];
              const yours = typeof v === "string" && v !== q.recommendedOptionId;
              return <QuestionCard key={q.key} q={q} index={i} openedBy={openedBy} yours={yours} />;
            })}
          </AgentQuestionStack>
        </div>
      </div>
      <AgentQuestionFooter className="bar">
        <span className="spacer" />
        <button type="button" className="btn quiet wrap-btn" data-has-settled={session.tree.counts.settled > 0 || undefined} onClick={() => void act("wrap").catch(() => {})} disabled={status === "submitting"}>
          Wrap it up
        </button>
      </AgentQuestionFooter>
    </AgentQuestion>
  );
}

/** "Round {k} of {N}" under the title, in the slot the waiting status line uses (#36). */
function RoundCounter({ session, round }: { session: SessionView; round: Round }) {
  const c = roundCounter(session, round.n);
  return (
    <p className="rmeta" data-testid="round-counter">
      {c.lead}
      {c.tag ? <span className={c.strong ? "last" : undefined}> · {c.tag}</span> : null}
    </p>
  );
}

function CardHead({ openedBy, yours }: { openedBy?: string; yours: boolean }) {
  return (
    <div className="q-h">
      {openedBy ? <span className="sr-only">Opened by {openedBy}</span> : null}
      {yours ? <span className="yc">Your call</span> : null}
    </div>
  );
}

function QuestionCard({ q, openedBy, yours }: { q: Question; index: number; openedBy?: string; yours: boolean }) {
  return (
    <AgentQuestionItem id={q.key} label={q.label || undefined} required className="q" data-testid="question" data-key={q.key} data-yours={yours || undefined}>
      <AgentQuestionTitle className="q-t">{q.title}</AgentQuestionTitle>
      <CardHead openedBy={openedBy} yours={yours} />
      {q.body ? <AgentQuestionDescription className="q-d">{q.body}</AgentQuestionDescription> : null}
      <AgentQuestionOptions>
        {q.options.map((o) => (
          <AgentQuestionOption key={o.id} value={o.id} label={o.label} description={o.description || undefined} recommended={o.id === q.recommendedOptionId} />
        ))}
        <AgentQuestionOther className="mini" description="" />
        <AgentQuestionOption value={UNKNOWN_OPTION} label="I don’t know" description="The agent picks one and marks it as a risk" className="mini unk" />
      </AgentQuestionOptions>
    </AgentQuestionItem>
  );
}

// ---------------------------------------------------------------- waiting for the agent

export { waitLabel } from "./wait";

/** Static skeleton lines (v1.2: no shimmer): a heading, a line and three option rows. */
export function SkeletonCard({ wide }: { wide?: boolean }) {
  return (
    <div className="sk" aria-hidden="true">
      <i className="h" style={wide ? { width: "62%" } : { width: "48%" }} />
      <i style={{ width: "80%" }} />
      <i className="r" />
      <i className="r" />
      <i className="r" />
    </div>
  );
}

/** One status line under the title. The ember dot is static; no elapsed timer (DECISIONS #21). */
export function StatusLine({ label, dot, onStop, note }: { label: string; dot?: boolean; onStop?: () => void; note?: string }) {
  return (
    <>
    <div className="status" role="status" aria-live="polite" data-has-note={note ? true : undefined}>
      {dot ? <span className="ember" aria-hidden="true" /> : null}
      <span>{label}</span>
      {onStop ? (
        <button type="button" className="btn quiet sm" onClick={onStop}>
          <ISq s={12} />
          Stop
        </button>
      ) : null}
    </div>
    {note ? <p className="meta wait-note" data-testid="wait-note">{note}</p> : null}
    </>
  );
}

/** Between rounds: one status line, static skeletons, the bar confirms what was saved. */
export function WaitingView({ session, act, banner }: { session: SessionView; act: Act; banner?: React.ReactNode }) {
  const last = session.rounds.at(-1);
  const busy = session.busy;
  // From when this turn started, so a Retry after a failure starts at zero (review-pr22 r3 #2).
  const since = busy ? (session.runAt ?? last?.answeredAt ?? session.updatedAt) : undefined;
  const elapsed = useSince(since, busy);
  const saved = last?.answers?.length ?? 0;
  const long = waitLabel(session, elapsed, "");
  const label = long || preparing(session);
  return (
    <SessionBody
      session={session}
      main={
        <div className="main">
          <div className="scroll">
            <Strip session={session} />
            <div className="col">
              {banner}
              <div className="intro">
                <h1>{session.idea.split("\n")[0]}</h1>
                {busy ? <StatusLine label={label} note={COPY.roundWaitNote} onStop={elapsed >= 60 ? () => void act("stop").catch(() => {}) : undefined} /> : null}
              </div>
              {busy ? <SkeletonCard wide /> : null}
            </div>
          </div>
          <div className="bar">
            <div className="in">
              {saved ? (
                <span className="meta" role="status">
                  {saved === 1 ? "1 decision saved" : `${saved} decisions saved`}
                </span>
              ) : null}
              <span className="spacer" />
              <button type="button" className="btn quiet wrap-btn" data-has-settled={session.tree.counts.settled > 0 || undefined} onClick={() => void act("wrap").catch(() => {})}>
                Wrap it up
              </button>
            </div>
          </div>
        </div>
      }
    />
  );
}

// ---------------------------------------------------------------- 2 firing up

export function FiringUp({ session, act, banner }: { session: SessionView; act: Act; banner?: React.ReactNode }) {
  const busy = session.busy;
  const elapsed = useSince(session.runAt ?? session.createdAt, busy);
  const base = elapsed < 6 ? "Sizing up your idea…" : "Finding the first decisions…";
  const label = waitLabel(session, elapsed, base);
  const mobile = useMobile();
  const idea = session.idea.split("\n")[0];
  return (
    <SessionBody
      session={session}
      main={
        <div className="main" style={{ gridTemplateRows: "minmax(0,1fr)" }}>
          <div className="scroll">
            <Strip session={session} />
            <div className="col">
              {banner}
              <div className="intro">
                <h1>{idea}</h1>
                {busy ? <StatusLine dot label={label} note={COPY.roundWaitNote} onStop={elapsed >= 60 ? () => void act("stop").catch(() => {}) : undefined} /> : null}
              </div>
              {busy ? (
                <>
                  <SkeletonCard wide />
                  {mobile ? null : <SkeletonCard />}
                </>
              ) : null}
            </div>
          </div>
        </div>
      }
    />
  );
}
