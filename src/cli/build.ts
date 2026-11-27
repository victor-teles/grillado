// The plan-to-build loop as a coding agent uses it: get the next build step, report a step started
// or done, ask the user a decision, wait for the answer, withdraw an ask. One owner for each,
// shared by `grillado build …` (shell) and the `build_*` tools of `grillado mcp`. Plain values in
// and out; errors are sentences an agent can act on.
//
// Every change goes through the session's lock (Store.update), so the web app, a shell command and
// the MCP server can all work on the same plan. None of these answers an ask or decides anything:
// the user does that in the browser.
import {
  type AskInput,
  type BuildAsk,
  type BuildState,
  type BuildStep,
  BuildError,
  addAsk,
  changesSince,
  emptyBuild,
  findAsk,
  findStep,
  finishStep,
  nextStep,
  openAsks,
  startStep,
  stepNumber,
  withdrawAsk,
} from "../core/build.ts";
import type { Session } from "../core/session.ts";
import { UnknownPlan, isDraft, sessionUrl } from "./plans.ts";
import type { Store } from "./store.ts";

export { BuildError };

const NO_STEPS = "This plan has no build steps (it was written before Grillado had them, or the user removed them). Build from the plan text, or ask the user to add steps in Grillado’s Build tab.";

function plated(store: Store, id: string): Session {
  const s = store.load(id);
  if (!s) throw new UnknownPlan(id);
  if (isDraft(s)) throw new BuildError(`Plan "${id}" is still a draft: there is nothing to build until the user confirms it in Grillado.`);
  return s;
}

const facts = (store: Store, s: Session) => ({ markdown: store.readPlan(s.id) ?? s.plan?.markdown ?? "", decisions: Object.values(s.decisions) });

const stepView = (b: BuildState, step: BuildStep) => ({
  n: stepNumber(b, step.key),
  key: step.key,
  title: step.title,
  done: step.done,
  status: step.status,
  ...(step.verified ? { verified: step.verified } : {}),
  ...(step.deviation ? { deviation: step.deviation } : {}),
});

const askView = (b: BuildState, ask: BuildAsk) => ({
  key: ask.key,
  title: ask.title,
  state: ask.state,
  ...(ask.step ? { step: stepNumber(b, ask.step) || undefined } : {}),
  ...(ask.answer !== undefined ? { answer: ask.answer } : {}),
  ...(ask.answerId ? { answerId: ask.answerId } : {}),
});

/**
 * What every build reply carries: the plan's revision, and what changed since the agent last read
 * the plan when the revision has moved (new decisions, edited sections, step edits).
 */
function base(store: Store, s: Session) {
  const b = s.build ?? emptyBuild();
  const changed = changesSince(b.seen, b, facts(store, s));
  return {
    plan: s.id,
    rev: b.rev,
    ...(changed.length ? { changed: { from: b.seen!.rev, to: b.rev, what: changed, next: `The plan changed since you last read it. Run \`grillado plan get ${s.id}\` before the next step.` } } : {}),
    progress: { done: b.steps.filter((x) => x.status === "done").length, of: b.steps.length },
    ...(openAsks(b).length ? { waitingOnUser: openAsks(b).map((a) => a.key) } : {}),
  };
}

/** Change the build state under the session's lock, then show it in the plan file. */
function change<T>(store: Store, id: string, fn: (b: BuildState, s: Session) => T): { s: Session; out: T } {
  plated(store, id);
  let out!: T;
  let after!: Session;
  store.update(id, (s) => {
    s.build ??= emptyBuild();
    out = fn(s.build, s);
    after = s;
  });
  store.refreshPlan(id);
  return { s: after, out };
}

/** The step to work on now: one already started, else the first not done, in the user's order. */
export function buildNext(store: Store, id: string) {
  const s = plated(store, id);
  const b = s.build ?? emptyBuild();
  const step = nextStep(b);
  const head = base(store, s);
  if (!b.steps.length) return { ...head, step: null, next: NO_STEPS };
  if (!step) return { ...head, step: null, next: "Every build step is done. Tell the user what was built; they can reopen a step in Grillado." };
  const n = stepNumber(b, step.key);
  return {
    ...head,
    step: stepView(b, step),
    next:
      step.status === "started"
        ? `Step ${n} is in progress. When its done check holds, run: grillado build done ${id} --step ${n} --verified "<what you ran and saw>"`
        : `Run \`grillado build start ${id} --step ${n}\`, build it, then report it done with what you verified.`,
  };
}

export function buildStart(store: Store, id: string, step: string | number | undefined) {
  const { s, out } = change(store, id, (b) => {
    if (!b.steps.length) throw new BuildError(NO_STEPS);
    return startStep(b, step ?? nextStep(b)?.key ?? "");
  });
  const b = s.build!;
  const n = stepNumber(b, out.key);
  return { ...base(store, s), step: stepView(b, out), next: `Build step ${n}. If the plan doesn't cover a decision you need, ask the user: grillado build ask ${id} --key <key> --title "<question>" --option a="…" --option b="…"` };
}

export function buildDone(store: Store, id: string, step: string | number | undefined, report: { verified?: string; deviation?: string }) {
  const { s, out } = change(store, id, (b) => {
    if (!b.steps.length) throw new BuildError(NO_STEPS);
    const target = step ?? b.steps.find((x) => x.status === "started")?.key;
    if (target === undefined) throw new BuildError("Say which step: --step <number>. No step is in progress.");
    return finishStep(b, target, report);
  });
  const b = s.build!;
  const upcoming = nextStep(b);
  return {
    ...base(store, s),
    step: stepView(b, out),
    next: upcoming ? `Step ${stepNumber(b, out.key)} is done. Next: grillado build next ${id}` : "Every build step is done. Tell the user what was built; they can reopen a step in Grillado.",
  };
}

/** Ask the user a decision. It shows in Grillado as a card with these options; only the user answers. */
export function buildAsk(store: Store, id: string, input: AskInput) {
  const { s, out } = change(store, id, (b) => addAsk(b, input));
  const url = sessionUrl(store, id);
  return {
    ...base(store, s),
    ask: askView(s.build!, out),
    url,
    next: url
      ? `The question is waiting for the user in Grillado (${url}). Wait for the answer: grillado build wait ${id} --ask ${out.key}. Don't answer it yourself and don't guess meanwhile.`
      : `The question is saved, but Grillado's web app isn't running, so the user can't see it yet. Tell them to open Grillado, then wait: grillado build wait ${id} --ask ${out.key}`,
  };
}

export function buildWithdraw(store: Store, id: string, key: string | undefined, reason?: string) {
  const { s, out } = change(store, id, (b) => withdrawAsk(b, key ?? "", reason));
  return { ...base(store, s), ask: askView(s.build!, out), next: `"${out.key}" is withdrawn. It is not a decision; nothing was recorded as decided.` };
}

/** How an ask stands now: the answer once the user gave one, "withdrawn", or still waiting. */
export function askResult(store: Store, id: string, key: string | undefined) {
  const s = plated(store, id);
  const b = s.build ?? emptyBuild();
  const ask = findAsk(b, key);
  const head = { ...base(store, s), ask: askView(b, ask) };
  if (ask.state === "answered")
    return { ...head, result: "answered" as const, answer: ask.answer!, next: `The user decided: ${ask.answer}. It is in the plan as [B:${ask.key}]. Build with it.` };
  if (ask.state === "withdrawn") return { ...head, result: "withdrawn" as const, next: "This ask was withdrawn. It is not a decision." };
  return { ...head, result: "waiting" as const, url: sessionUrl(store, id), next: `The user hasn't answered yet. Run the same command again to keep waiting. If you no longer need the answer: grillado build withdraw ${id} --ask ${ask.key}` };
}

/** Wait for the user to answer an ask, up to `timeoutS`; "waiting" when it passes first (run it again). */
export async function buildWait(store: Store, id: string, key: string | undefined, timeoutS: number, o: { pollMs?: number; signal?: AbortSignal } = {}) {
  const end = Date.now() + timeoutS * 1000;
  for (;;) {
    const r = askResult(store, id, key);
    if (r.result !== "waiting" || Date.now() >= end || o.signal?.aborted) return r;
    await new Promise((res) => setTimeout(res, o.pollMs ?? 500));
  }
}

/** The step a reference names, for callers that only need to check it exists. */
export const stepOf = (store: Store, id: string, ref: string | number) => findStep(plated(store, id).build ?? emptyBuild(), ref);
