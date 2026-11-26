// The plan operations a coding agent uses (plan 004): list, read, start and comment. One owner for
// each, shared by `grillado mcp` (its tools) and `grillado plan …` (shell commands). Plain values in
// and out; errors are sentences an agent can act on.
import { planOpenNow } from "../core/floor.ts";
import { issuesOf } from "../core/issues.ts";
import { MAX_COMMENT, MAX_QUOTE, addCoderComment } from "../core/comments.ts";
import { PROVIDER_IDS } from "../core/providers/types.ts";
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

/** One plan: its Markdown, decisions, what's still open, and its issue links. */
export function getPlan(store: Store, id: string) {
  const s = loadPlan(store, id);
  const markdown = markdownOf(store, s);
  const d = decisionsOf(s, markdown);
  return { ...summary(s), markdown, decisions: d.decisions, open: d.open, issues: issuesOf(s) };
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
  /** The project folder; its docs/plans gets the plan. */
  cwd: string;
  /** Who started it, for Recent ("From Cursor"); "" reads "From your editor". */
  from?: string;
  /** How to start the web app, for the hint when none is running. */
  appLine: string;
  home?: string;
  /** The shared project scan opt-out. */
  scanOff?: boolean;
}

/** Send an idea to Grillado: a queued session whose first round starts when the web app opens it. */
export async function startPlan(store: Store, input: StartInput) {
  const projectContext = await captureProjectContext({ cwd: input.cwd, dataDir: store.dir, home: input.home, off: !!input.scanOff });
  const s = createSession({ idea: input.idea, context: input.context, projectContext, provider: store.readConfig().defaultProvider ?? PROVIDER_IDS[0] });
  s.queued = true;
  // Always marked editor-started; a client without a usable name reads "From your editor" (#108).
  s.from = (input.from ?? "").slice(0, 80);
  store.create(s, input.cwd);
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
