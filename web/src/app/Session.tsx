import { Download, Square } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import {
  AgentQuestion,
  type AgentQuestionAnswers,
  AgentQuestionDescription,
  AgentQuestionFooter,
  AgentQuestionHeader,
  AgentQuestionItem,
  AgentQuestionItems,
  AgentQuestionOption,
  AgentQuestionOptions,
  AgentQuestionOther,
  AgentQuestionTitle,
  agentQuestionOtherKey,
} from "@/components/ui/uai/agent-question";
import {
  StatusBanner,
  StatusBannerAction,
  StatusBannerActions,
  StatusBannerContent,
  StatusBannerDescription,
  StatusBannerTitle,
} from "@/components/ui/uai/status-banner";
import { Thinking, ThinkingTrigger } from "@/components/ui/uai/thinking";
import { CopyButton } from "./CopyButton";
import { Markdown } from "./Markdown";
import { type Answer, type AppState, type Decision, OTHER_OPTION, type Round, type SessionView, UNKNOWN_OPTION } from "./types";

type Act = (action: string, body?: unknown) => Promise<void>;

export function SessionScreen({ session, app, act }: { session: SessionView; app: AppState; act: Act }) {
  const round = session.rounds.at(-1);
  const openRound = round && !round.answers ? round : undefined;
  const decisions = Object.values(session.decisions).sort((a, b) => a.round - b.round);
  const working = session.busy;
  const failed = !working && session.error && (session.status === "asking" || session.status === "synthesizing");
  const stalled = !working && !session.error && (session.status === "asking" || session.status === "synthesizing");

  return (
    <div className="grid gap-6">
      <header className="grid gap-2">
        <Stages status={session.status} />
        <h2 className="text-xl font-semibold break-words">{session.idea}</h2>
        <Progress settled={decisions.length} open={openRound?.questions.length ?? 0} rounds={session.rounds.length} />
      </header>

      {working ? <Working session={session} onStop={() => act("stop")} /> : null}
      {failed || stalled ? <ProblemBanner session={session} app={app} act={act} /> : null}

      {session.status === "answering" && openRound ? (
        <RoundCard key={`${session.id}-${openRound.n}`} round={openRound} onSubmit={(answers) => act("answers", { round: openRound.n, answers })} />
      ) : null}

      {session.status === "answering" || (session.status === "asking" && !session.error) ? (
        <div className="flex flex-wrap items-center gap-3">
          <Button type="button" variant="secondary" onClick={() => act("wrap")} disabled={!decisions.length && !openRound}>
            Wrap it up
          </Button>
          <span className="text-[12px] text-subtle-foreground">Stop asking and plate what we have. Open questions get listed in the plan.</span>
        </div>
      ) : null}

      {session.status === "confirm" && !working ? <ConfirmGate session={session} decisions={decisions} act={act} /> : null}
      {session.status === "plated" && session.plan ? <PlanView session={session} decisions={decisions} act={act} /> : null}

      {decisions.length && session.status !== "confirm" && session.status !== "plated" ? (
        <DecisionList session={session} decisions={decisions} act={act} canReopen={!working && session.status === "answering"} />
      ) : null}
    </div>
  );
}

const STAGES = [
  { id: "idea", label: "Idea" },
  { id: "grill", label: "On the grill" },
  { id: "confirm", label: "Confirm" },
  { id: "plan", label: "Plated" },
];

function Stages({ status }: { status: SessionView["status"] }) {
  const current = status === "confirm" ? 2 : status === "synthesizing" || status === "plated" ? 3 : 1;
  return (
    <ol aria-label="Progress" className="flex flex-wrap items-center gap-2 text-[12px] text-subtle-foreground">
      {STAGES.map((s, i) => (
        <li key={s.id} aria-current={i === current ? "step" : undefined} className={i === current ? "font-medium text-foreground" : ""}>
          {i > 0 ? <span aria-hidden="true" className="mr-2">→</span> : null}
          {s.label}
        </li>
      ))}
    </ol>
  );
}

function Progress({ settled, open, rounds }: { settled: number; open: number; rounds: number }) {
  return (
    <p className="text-[13px] text-muted-foreground tabular-nums" data-testid="progress">
      Round {Math.max(rounds, 1)} · {settled} settled · {open} open
    </p>
  );
}

function useElapsed(active: boolean) {
  const [seconds, setSeconds] = useState(0);
  useEffect(() => {
    if (!active) return setSeconds(0);
    const start = Date.now();
    const t = setInterval(() => setSeconds(Math.floor((Date.now() - start) / 1000)), 1000);
    return () => clearInterval(t);
  }, [active]);
  return seconds;
}

function Working({ session, onStop }: { session: SessionView; onStop: () => void }) {
  const elapsed = useElapsed(true);
  const first = session.rounds.length === 0;
  const plating = session.status === "synthesizing";
  let title = plating ? "Plating your plan…" : first ? "Sizing up your idea…" : "Reading your answers…";
  if (session.progress === "Taking another pass") title = "Taking another pass…";
  if (elapsed >= 15) title = "Still cooking…";
  const summary = plating ? "Turning your decisions into a plan." : first ? "Finding the first decisions." : "Working out what to ask next.";
  return (
    <div className="grid gap-2" role="status" aria-live="polite">
      <Thinking variant="card" status="thinking" defaultOpen={false}>
        <ThinkingTrigger title={title} summary={summary} />
      </Thinking>
      {elapsed >= 60 ? (
        <Button type="button" variant="secondary" size="sm" className="justify-self-start" onClick={onStop}>
          <Square aria-hidden="true" /> Stop
        </Button>
      ) : null}
    </div>
  );
}

function ProblemBanner({ session, app, act }: { session: SessionView; app: AppState; act: Act }) {
  const provider = app.providers.find((p) => p.id === session.provider);
  const name = provider?.displayName ?? session.provider;
  const others = app.providers.filter((p) => p.status === "ready" && p.id !== session.provider);
  const code = session.error?.code ?? "unknown";
  const copy = {
    auth: { tone: "warning" as const, title: `Log in to ${name}`, body: `${provider?.loginHint ?? "Log in with the agent's own command"}, then retry. Your answers are saved.`, retry: "I've logged in, retry" },
    rate_limit: { tone: "warning" as const, title: `${name} hit its limit`, body: "Your answers are saved. Try again in a bit, or switch agents.", retry: "Retry" },
    timeout: { tone: "warning" as const, title: `${name} took too long`, body: "Nothing came back in time. Your answers are saved.", retry: "Retry" },
    not_found: { tone: "error" as const, title: `${name} isn't available`, body: "The command couldn't be started. Your answers are saved.", retry: "Retry" },
    malformed: { tone: "error" as const, title: "The agent's reply didn't come through.", body: "Your answers are saved.", retry: "Retry" },
    unknown: { tone: "error" as const, title: session.error?.message || "Something went wrong.", body: "Your answers are saved.", retry: "Retry" },
  }[code];
  return (
    <StatusBanner tone={copy.tone} variant="tinted" role="alert" data-testid="problem" data-code={code}>
      <StatusBannerContent>
        <StatusBannerTitle>{copy.title}</StatusBannerTitle>
        <StatusBannerDescription>{copy.body}</StatusBannerDescription>
        {code !== "unknown" && session.error?.message && code !== "malformed" ? (
          <StatusBannerDescription className="text-subtle-foreground">{session.error.message}</StatusBannerDescription>
        ) : null}
      </StatusBannerContent>
      <StatusBannerActions>
        <StatusBannerAction onClick={() => act("retry")}>{copy.retry}</StatusBannerAction>
        {others.map((p) => (
          <StatusBannerAction
            key={p.id}
            onClick={async () => {
              await act("provider", { id: p.id });
              await act("retry");
            }}
          >
            Switch to {p.displayName}
          </StatusBannerAction>
        ))}
      </StatusBannerActions>
    </StatusBanner>
  );
}

function RoundCard({ round, onSubmit }: { round: Round; onSubmit: (answers: Answer[]) => Promise<void> }) {
  const ref = useRef<HTMLElement | null>(null);
  const defaults = useMemo<AgentQuestionAnswers>(() => Object.fromEntries(round.questions.map((q) => [q.key, q.recommendedOptionId])), [round]);
  useEffect(() => {
    // Focus the preselected option so number keys and Enter work right away (AC15).
    const t = setTimeout(() => ref.current?.querySelector<HTMLElement>("fieldset:not([hidden]) [role=radio][data-state=checked]")?.focus(), 50);
    return () => clearTimeout(t);
  }, []);
  return (
    <div className="grid gap-2">
      {round.summary ? <p className="text-[13px] text-muted-foreground">{round.summary}</p> : null}
      <AgentQuestion
        ref={ref}
        aria-label={`Round ${round.n}`}
        defaultValue={defaults}
        onSubmit={(values) => {
          const answers: Answer[] = round.questions.map((q) => {
            const v = values[q.key];
            const picked = typeof v === "string" ? v : q.recommendedOptionId;
            if (picked === "other") {
              return { questionId: q.key, optionId: OTHER_OPTION, text: String(values[agentQuestionOtherKey(q.key)] ?? ""), accepted_recommendation: false };
            }
            return { questionId: q.key, optionId: picked, accepted_recommendation: picked === q.recommendedOptionId };
          });
          return onSubmit(answers);
        }}
      >
        <AgentQuestionHeader />
        <AgentQuestionItems>
          {round.questions.map((q) => (
            <AgentQuestionItem key={q.key} id={q.key} required>
              <AgentQuestionTitle>{q.title}</AgentQuestionTitle>
              {q.body ? <AgentQuestionDescription>{q.body}</AgentQuestionDescription> : null}
              <AgentQuestionOptions>
                {q.options.map((o) => (
                  <AgentQuestionOption key={o.id} value={o.id} label={o.label} description={o.description || undefined} recommended={o.id === q.recommendedOptionId} />
                ))}
                <AgentQuestionOption value={UNKNOWN_OPTION} label="I don't know" description="Pick a sensible default and note it" />
                <AgentQuestionOther />
              </AgentQuestionOptions>
            </AgentQuestionItem>
          ))}
        </AgentQuestionItems>
        <AgentQuestionFooter />
      </AgentQuestion>
    </div>
  );
}

function ReopenButton({ session, d, act, disabled }: { session: SessionView; d: Decision; act: Act; disabled?: boolean }) {
  const [asking, setAsking] = useState(false);
  const dependents = useMemo(() => dependentsOf(session, d.key), [session, d.key]);
  if (!asking)
    return (
      <Button type="button" variant="ghost" size="sm" disabled={disabled} onClick={() => setAsking(true)} aria-label={`Reopen: ${d.title}`}>
        Reopen
      </Button>
    );
  return (
    <span className="flex flex-wrap items-center gap-2 text-[12px]" role="group" aria-label={`Reopen ${d.title}?`}>
      <span>{dependents.length ? `Also reopens: ${dependents.map((k) => session.decisions[k]?.title ?? k).join(", ")}` : "Ask this again?"}</span>
      <Button type="button" size="sm" autoFocus onClick={() => act("reopen", { key: d.key })}>
        Reopen
      </Button>
      <Button type="button" size="sm" variant="ghost" onClick={() => setAsking(false)}>
        Cancel
      </Button>
    </span>
  );
}

function dependentsOf(s: SessionView, key: string): string[] {
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

function DecisionRows({ session, decisions, act, canReopen }: { session: SessionView; decisions: Decision[]; act: Act; canReopen: boolean }) {
  return (
    <dl className="grid gap-1.5">
      {decisions.map((d) => (
        <div key={d.key} className="grid gap-0.5 rounded-lg border bg-card px-3 py-2">
          <dt className="text-[12px] text-subtle-foreground">
            R{d.round} · {d.title}
          </dt>
          <dd className="m-0 flex flex-wrap items-center justify-between gap-2">
            <span className="font-medium">
              {d.answer}
              {d.accepted_recommendation ? <span className="ml-2 text-[11px] font-normal text-subtle-foreground">recommended</span> : null}
            </span>
            {canReopen ? <ReopenButton session={session} d={d} act={act} /> : null}
          </dd>
        </div>
      ))}
    </dl>
  );
}

function DecisionList(props: { session: SessionView; decisions: Decision[]; act: Act; canReopen: boolean }) {
  return (
    <section aria-labelledby="decided-title" className="grid gap-2">
      <h3 id="decided-title" className="text-sm font-medium text-muted-foreground">
        Decided so far
      </h3>
      <DecisionRows {...props} />
    </section>
  );
}

function ConfirmGate({ session, decisions, act }: { session: SessionView; decisions: Decision[]; act: Act }) {
  const open = session.rounds.at(-1)?.answers ? [] : (session.rounds.at(-1)?.questions ?? []);
  return (
    <section aria-labelledby="confirm-title" className="grid gap-4 rounded-2xl border bg-card p-5">
      <div>
        <h3 id="confirm-title" className="text-lg font-semibold">
          Is it done?
        </h3>
        <p className="text-muted-foreground">
          {session.wrappedUp ? "We stopped early. " : "Every branch is settled. "}
          Check the decisions, reopen anything that feels off, then plate it.
        </p>
      </div>
      <DecisionRows session={session} decisions={decisions} act={act} canReopen />
      {open.length ? (
        <div className="rounded-lg border border-dashed p-3 text-[13px]">
          <p className="font-medium">Still raw (will be listed as open decisions):</p>
          <ul className="list-disc pl-5">
            {open.map((q) => (
              <li key={q.key}>{q.title}</li>
            ))}
          </ul>
        </div>
      ) : null}
      <div className="flex flex-wrap gap-2">
        <Button type="button" onClick={() => act("confirm")}>
          Yes, plate it
        </Button>
        <Button type="button" variant="secondary" onClick={() => act("keep-going")}>
          Keep going
        </Button>
      </div>
    </section>
  );
}

function PlanView({ session, decisions, act }: { session: SessionView; decisions: Decision[]; act: Act }) {
  const plan = session.plan!;
  return (
    <section aria-labelledby="plan-title" className="grid gap-4">
      <div className="flex flex-wrap items-center justify-between gap-3 rounded-2xl border bg-card p-4">
        <div className="grid min-w-0">
          <h3 id="plan-title" className="text-lg font-semibold">
            Plated: {decisions.length} decisions{plan.openDecisions.length ? `, ${plan.openDecisions.length} open` : ""}
          </h3>
          <p className="text-[12px] break-all text-subtle-foreground">
            Saved to <code data-testid="plan-path">{plan.path}</code>
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          <CopyButton text={plan.markdown} label="Copy Markdown" />
          <Button asChild variant="secondary" size="sm">
            <a href={`/api/sessions/${session.id}/plan.md`} download>
              <Download aria-hidden="true" /> Download .md
            </a>
          </Button>
          <CopyButton text={plan.path} label="Copy file path" />
        </div>
      </div>
      <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_280px]">
        <article className="rounded-2xl border bg-card p-5" data-testid="plan">
          <Markdown source={plan.markdown} />
        </article>
        <aside aria-label="Decisions" className="grid content-start gap-2">
          <h4 className="text-sm font-medium text-muted-foreground">Decisions</h4>
          <DecisionRows session={session} decisions={decisions} act={act} canReopen />
        </aside>
      </div>
    </section>
  );
}
