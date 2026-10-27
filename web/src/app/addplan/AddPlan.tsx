// "Add to plan" (v1.2 polish item 5, #104): the button on a decision no passage cites yet, and the
// line under its answer while the one run is going and after it ends. The Decisions row and the
// DecisionCard both use these; the run itself lives in the session (`addPlanRun`).
import { type ReactNode, useEffect, useId, useRef, useState } from "react";
import { type AddPlanState, addPlanState } from "../../../../src/core/addplan.ts";
import { fmt } from "../copy";
import { ICircleAlert } from "../icons";
import type { SessionView } from "../types";

export const APCOPY = {
  add: "Add to plan",
  busy: "{agent} is busy",
  running: "{agent} writing it into the plan",
  ready: "1 suggestion to review",
  none: "{agent} found no place for it",
  failed: "Couldn’t add it",
  stop: "Stop",
  review: "Review",
  retry: "Try again",
  liveRunning: "Writing it into the plan",
  liveReady: "1 suggestion to review",
  liveNone: "No place found",
  liveFailed: "Couldn’t add it",
} as const;

type Act = (action: string, body?: unknown) => Promise<void>;

export interface AddPlan {
  state: AddPlanState;
  /** Another run is going (any kind): the button is disabled with "{agent} is busy". */
  busy: boolean;
  start: () => void;
  stop: () => void;
  retry: () => void;
  /** The suggestion it made, for Review. */
  suggestion?: string;
}

/** Any run that holds the plan: the interview, Apply feedback, Add diagrams, or Add to plan itself. */
export const runBusy = (s: SessionView) => !!(s.busy || s.applying || s.drawing || s.adding);

export function addPlanFor(session: SessionView, key: string, act: Act): AddPlan {
  const run = session.addPlanRun;
  const state = addPlanState(run, key, session.suggestions);
  const go = (body: unknown) => void act("addplan", body).catch(() => {});
  return {
    state,
    busy: runBusy(session),
    start: () => go({ op: "start", key }),
    stop: () => go({ op: "stop" }),
    retry: () => go({ op: "retry" }),
    suggestion: state === "ready" ? run?.suggestion : undefined,
  };
}

/**
 * The quiet "Add to plan" button. Never blue (#104). Disabled while any run is busy, with a tip
 * that says why; aria-disabled so it can still be focused and the tip read. Hidden by visibility
 * (not removed) in every state but rest, so the row's columns don't move.
 */
export function AddPlanButton({ ap, agentName, className, tabIndex, label, onDone }: { ap: AddPlan; agentName: string; className: string; tabIndex?: number; label: string; onDone?: () => void }) {
  const tip = useId();
  const off = ap.busy && ap.state === "rest";
  return (
    <span className="apb" style={ap.state === "rest" ? undefined : { visibility: "hidden" }} data-busy={off ? "" : undefined}>
      <button
        type="button"
        className={className}
        tabIndex={tabIndex}
        aria-label={label}
        aria-disabled={off || undefined}
        aria-describedby={off ? tip : undefined}
        onClick={(e) => {
          e.stopPropagation();
          if (off || ap.state !== "rest") return;
          ap.start();
          onDone?.();
        }}
      >
        {APCOPY.add}
      </button>
      {off ? (
        <span className="tip6 aptip" id={tip} role="tooltip">
          {fmt(APCOPY.busy, { agent: agentName })}
        </span>
      ) : null}
    </span>
  );
}

/** The line under the answer for running, ready, none and failed. Null at rest. */
export function AddPlanLine({ ap, agentName, onReview, tabIndex }: { ap: AddPlan; agentName: string; onReview: (id: string) => void; tabIndex?: number }) {
  const A = (t: string) => fmt(t, { agent: agentName });
  const link = (text: string, on: () => void, name: string): ReactNode => (
    <button
      type="button"
      className="lnk"
      tabIndex={tabIndex}
      aria-label={name}
      onClick={(e) => {
        e.stopPropagation();
        on();
      }}
    >
      {text}
    </button>
  );
  switch (ap.state) {
    case "running":
      return (
        <span className="apl" data-ap="running">
          <span className="dot" aria-hidden="true" />
          <span>{A(APCOPY.running)}</span>
          {link(APCOPY.stop, ap.stop, "Stop adding it to the plan")}
        </span>
      );
    case "ready":
      return (
        <span className="apl" data-ap="ready">
          <span className="t">{APCOPY.ready}</span>
          {link(APCOPY.review, () => ap.suggestion && onReview(ap.suggestion), "Review the suggestion")}
        </span>
      );
    case "none":
      return (
        <span className="apl" data-ap="none">
          <span>{A(APCOPY.none)}</span>
          {link(APCOPY.retry, ap.retry, "Try again to add it to the plan")}
        </span>
      );
    case "failed":
      return (
        <span className="apl" data-ap="failed">
          <span className="err" aria-hidden="true">
            <ICircleAlert s={12} />
          </span>
          <span className="t">{APCOPY.failed}</span>
          {link(APCOPY.retry, ap.retry, "Try again to add it to the plan")}
        </span>
      );
    default:
      return null;
  }
}

/**
 * The polite live region (#104): "Writing it into the plan", then "1 suggestion to review", "No
 * place found" or "Couldn't add it". Only what happens while the page is open; Stop says nothing.
 */
export function AddPlanLive({ session }: { session: SessionView }) {
  const run = session.addPlanRun;
  const [say, setSay] = useState("");
  const seen = useRef<string | null>(null);
  const k = run ? `${run.startedAt}:${run.state}` : "";
  useEffect(() => {
    if (seen.current === null) {
      seen.current = k;
      return;
    }
    if (!run || seen.current === k) return;
    seen.current = k;
    if (run.state === "running") setSay(APCOPY.liveRunning);
    else if (run.state === "error") setSay(APCOPY.liveFailed);
    else if (run.state === "done") setSay(run.suggestion ? APCOPY.liveReady : APCOPY.liveNone);
    else setSay("");
  }, [k]);
  return (
    <span className="sr-only" role="status" aria-live="polite" data-ap-live="">
      {say}
    </span>
  );
}
