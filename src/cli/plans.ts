// The plan operations a coding agent uses (plan 004): list, read, start and comment. One owner for
// each, shared by `grillado mcp` (its tools) and `grillado plan …` (shell commands). Plain values in
// and out; errors are sentences an agent can act on.
import { planOpenNow } from "../core/floor.ts";
import { issuesOf } from "../core/issues.ts";
import { MAX_COMMENT, MAX_QUOTE, addCoderComment } from "../core/comments.ts";
import { type ProviderId, PROVIDER_IDS } from "../core/providers/types.ts";
import { createAdapters } from "../core/providers/adapters.ts";
import { emptyBuild, snapshot, stepNumber, withBuildAppendix } from "../core/build.ts";
import { type Session, createSession } from "../core/session.ts";
import { projectContextView } from "../core/project-context.ts";
import { captureProjectContext } from "./project-context.ts";
import type { Store } from "./store.ts";

export const URI = "grillado://plans/";
/** A plan id looks like 2026-10-26-1a2b3c4d. */
export const PLAN_ID = /^[\w-]{1,80}$/;
export const MAX_IDEA = 8000;
export const MAX_CONTEXT = 20_000;
export { MAX_COMMENT, MAX_QUOTE };

export class UnknownPlan extends Error {
  constructor(id: string) {
    super(`No plan with id "${id}". Call list_plans to see the ids.`);
  }
}

export const titleOf = (s: Session) => s.plan?.title || s.idea.split("\n")[0].slice(0, 80);
/** Not confirmed yet: no plan written, or the interview reopened after it was. */
export const isDraft = (s: Session) => s.status !== "plated" || !s.plan;

export function summary(s: Session) {
  return {
    id: s.id,
    title: titleOf(s),
    status: s.status,
    draft: isDraft(s),
    decisions: Object.keys(s.decisions).length,
    updatedAt: s.updatedAt,
    // Friction 26: the export shows in list_plans, as it does in get_plan.
    issues: issuesOf(s),
    uri: URI + s.id,
  };
}

/** `md`: the plan text the reader sees (plan.md on disk); the open list is derived from it (PR46 r3 M2). */
export function decisionsOf(s: Session, md: string = s.plan?.markdown ?? "") {
  return {
    id: s.id,
    draft: isDraft(s),
    decisions: Object.values(s.decisions)
      .sort((a, b) => a.round - b.round)
      .map((d) => ({
        key: d.key,
        title: d.title,
        answer: d.answer,
        round: d.round,
        /** "unknown" means the user left the call to the agent. */
        kind: d.kind,
        acceptedRecommendation: d.accepted_recommendation,
        dependsOn: d.dependsOn,
      })),
    open: s.plan ? planOpenNow(s, md) : [],
    stale: Object.values(s.stale ?? {}).map((d) => ({ key: d.key, title: d.title, reason: d.reason })),
  };
}

/** The plan's Markdown (plan.md is the source of truth), or a draft built from the decisions so far. */
export function markdownOf(store: Store, s: Session): string {
  const md = s.plan ? (store.readPlan(s.id) ?? s.plan.markdown) : null;
  if (md !== null && !isDraft(s)) return md;
  const note = `> **Draft.** This plan isn't confirmed yet (status: ${s.status}). Finish the interview in Grillado for the final plan.`;
  if (md !== null) return `${note}\n\n${md}`;
  const lines = Object.values(s.decisions)
    .sort((a, b) => a.round - b.round)
    .map((d) => `- **${d.title}**: ${d.answer}`);
  return [`# Draft: ${titleOf(s)}`, "", note, "", "## Idea", "", s.idea, ...(s.context ? ["", "## Context", "", s.context] : []), "", "## Decisions so far", "", ...(lines.length ? lines : ["None yet."]), ""].join("\n");
}

export function loadPlan(store: Store, id: string): Session {
  const s = store.load(id);
  if (!s) throw new UnknownPlan(id);
  return s;
}

/** Every plan, newest first. */
export function listPlans(store: Store) {
  return store.list().map(summary);
}

/** The build state a coding agent sees with the plan: revision, steps and asks. Absent for a plan with none. */
export function buildOf(s: Session) {
  const b = s.build;
  if (!b || (!b.steps.length && !b.asks.length)) return undefined;
  return {
    rev: b.rev,
    steps: b.steps.map((x, i) => ({ n: i + 1, key: x.key, title: x.title, done: x.done, status: x.status })),
    asks: b.asks.map((a) => ({ key: a.key, title: a.title, state: a.state, ...(a.step ? { step: stepNumber(b, a.step) || undefined } : {}), ...(a.answer !== undefined ? { answer: a.answer } : {}) })),
  };
}

/**
 * One plan: its Markdown (with its build steps and log, as in the file), decisions, what's still
 * open, and its issue links. Reading it is what later build replies compare against ("the plan
 * changed since you last read it").
 */
export function getPlan(store: Store, id: string) {
  const s = loadPlan(store, id);
  const text = markdownOf(store, s);
  const d = decisionsOf(s, text);
  const build = isDraft(s) ? undefined : buildOf(s);
  if (!isDraft(s) && s.build)
    store.update(id, (x) => {
      x.build ??= emptyBuild();
      x.build.seen = snapshot(x.build, { markdown: store.readPlan(id) ?? x.plan?.markdown ?? "", decisions: Object.values(x.decisions) });
    });
  return { ...summary(s), markdown: isDraft(s) ? text : withBuildAppendix(text, s.build), decisions: d.decisions, open: d.open, issues: issuesOf(s), ...(build ? { build } : {}) };
}

/**
 * The agent a plan started from a shell runs on (`plan start --agent`). It must be one that can
 * read the project: a plan written without the code is the thing this option is for avoiding.
 */
export function agentFor(id: string | undefined): ProviderId | undefined {
  if (id === undefined) return undefined;
  const all = createAdapters();
  const can = all.filter((a) => a.canRead).map((a) => `${a.id} (${a.displayName})`).join(", ");
  const a = all.find((x) => x.id === id.trim());
  if (!a) throw new Error(`Unknown agent "${id}". Agents that can read the project: ${can}.`);
  if (!a.canRead) throw new Error(`${a.displayName} can’t read the project yet, so its questions and plan wouldn’t know the code. Agents that can: ${can}.`);
  return a.id;
}

export function getDecisions(store: Store, id: string) {
  const s = loadPlan(store, id);
  return decisionsOf(s, markdownOf(store, s));
}

/** The running web app's link to a session, or null when no app is running. */
export function sessionUrl(store: Store, id: string): string | null {
  const info = store.readServerInfo();
  return info ? `http://127.0.0.1:${info.port}/s/${id}?t=${info.token}` : null;
}

export interface StartInput {
  idea: string;
  context?: string;
  /** The project folder; its plans folder (docs/plans unless the user set another) gets the plan. */
  cwd: string;
  /** Plan 005: an absolute plans folder for this plan, over the project's setting. */
  plansDir?: string;
  /** Who started it, for Recent ("From Cursor"); "" reads "From your editor". */
  from?: string;
  /** How to start the web app, for the hint when none is running. */
  appLine: string;
  home?: string;
  /** The shared project scan opt-out. */
  scanOff?: boolean;
  /** `--agent`: the agent that asks and writes this plan, over the one selected in the web app. Checked with agentFor(). */
  agent?: ProviderId;
}

/** Send an idea to Grillado: a queued session whose first round starts when the web app opens it. */
export async function startPlan(store: Store, input: StartInput) {
  const projectContext = await captureProjectContext({ cwd: input.cwd, dataDir: store.dir, home: input.home, off: !!input.scanOff });
  const s = createSession({ idea: input.idea, context: input.context, projectContext, provider: input.agent ?? store.readConfig().defaultProvider ?? PROVIDER_IDS[0] });
  s.queued = true;
  if (input.agent) s.agentPinned = true;
  // Always marked editor-started; a client without a usable name reads "From your editor" (#108).
  s.from = (input.from ?? "").slice(0, 80);
  store.create(s, input.cwd, input.plansDir);
  const url = sessionUrl(store, s.id);
  const next = url ? `Open ${url} to answer Grillado's questions.` : `Grillado's web app isn't running. Run \`${input.appLine}\` and open this idea from Recent; the questions start there.`;
  const contextView = projectContextView(projectContext);
  return { id: s.id, url, uri: URI + s.id, next, ...(contextView ? { projectContext: contextView } : {}) };
}

/** A comment on a passage of a written plan, shown in its Comments rail as from the coding agent. */
export function commentOnPlan(store: Store, input: { plan: string; quote: string; text: string; client?: string }) {
  const t = store.update(input.plan, (s) => {
    if (s.status !== "plated" || !s.plan) throw new Error(`Plan "${input.plan}" is still a draft: comments open once its plan is written.`);
    const view = { comments: s.comments, plan: { markdown: store.readPlan(s.id) ?? s.plan.markdown } };
    let thread;
    try {
      thread = addCoderComment(view, { quote: input.quote, text: input.text, client: input.client });
    } catch {
      throw new Error("That quote isn't in the plan. Copy it exactly from get_plan's Markdown.");
    }
    s.comments = view.comments;
    s.updatedAt = new Date().toISOString();
    return thread;
  });
  if (!t) throw new UnknownPlan(input.plan);
  return { plan: input.plan, thread: t.id };
}
