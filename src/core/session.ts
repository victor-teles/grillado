import { randomUUID } from "node:crypto";
import type { PlanReply, Question, RoundReply, Upcoming } from "./schema.ts";
import type { FailureCode } from "./classify.ts";
import type { ProviderId } from "./providers/types.ts";

export type SessionStatus =
  | "asking" // waiting for the agent's next round
  | "answering" // a round is on screen
  | "confirm" // frontier empty (or wrapped up): waiting for the user's go
  | "synthesizing" // writing the plan
  | "plated"; // plan saved

export const UNKNOWN_OPTION = "__unknown";
export const OTHER_OPTION = "__other";

export interface Answer {
  questionId: string;
  /** An option id, OTHER_OPTION, or UNKNOWN_OPTION. */
  optionId: string;
  /** Free text for OTHER_OPTION. */
  text?: string;
  accepted_recommendation: boolean;
}

export interface Round {
  n: number;
  questions: Question[];
  summary: string;
  /** Decisions the agent expects to ask later (drawn as "waiting" in the tree). */
  upcoming?: Upcoming[];
  answers?: Answer[];
  askedAt: string;
  answeredAt?: string;
}

export interface Decision {
  key: string;
  round: number;
  /** Short name for the tree; falls back to the title. */
  label?: string;
  title: string;
  answer: string;
  kind: "option" | "other" | "unknown";
  accepted_recommendation: boolean;
  dependsOn: string[];
  /** Settled again after being reopened. */
  reopened?: boolean;
}

/** A decision that was settled, then invalidated by a reopen; it waits to be asked again. */
export interface StaleDecision {
  key: string;
  label: string;
  title: string;
  answer: string;
  round: number;
  dependsOn: string[];
  /** Short reason for the tree, e.g. "Platform changed". */
  reason: string;
}

export interface SessionError {
  code: FailureCode;
  message: string;
  at: string;
}

export interface Session {
  id: string;
  createdAt: string;
  updatedAt: string;
  provider: ProviderId;
  idea: string;
  context: string;
  status: SessionStatus;
  rounds: Round[];
  decisions: Record<string, Decision>;
  /** Decisions the user reopened, to be asked again in the next round. */
  reopened: string[];
  /** Reopened decisions not yet settled again, for the tree (kept across rounds). */
  stale?: Record<string, StaleDecision>;
  /** "Looks right" on the passivity nudge hides it for the rest of the session. */
  nudgeDismissed?: boolean;
  wrappedUp: boolean;
  keepGoing: boolean;
  summary: string;
  error?: SessionError;
  plan?: { title: string; markdown: string; path: string; openDecisions: string[]; createdAt: string; editedAt?: string };
}

export function createSession(input: { idea: string; context?: string; provider: ProviderId }): Session {
  const now = new Date().toISOString();
  return {
    id: `${now.slice(0, 10)}-${randomUUID().slice(0, 8)}`,
    createdAt: now,
    updatedAt: now,
    provider: input.provider,
    idea: input.idea.trim(),
    context: (input.context ?? "").trim(),
    status: "asking",
    rounds: [],
    decisions: {},
    reopened: [],
    wrappedUp: false,
    keepGoing: false,
    summary: "",
  };
}

const touch = (s: Session) => {
  s.updatedAt = new Date().toISOString();
};

export const currentRound = (s: Session): Round | undefined => {
  const last = s.rounds.at(-1);
  return last && !last.answers ? last : undefined;
};

/**
 * Validate a round against the session (AC6 and friends). Returns an error message for the repair
 * retry, or null when the round is usable.
 */
export function validateRound(s: Session, reply: RoundReply): string | null {
  if (reply.type === "frontier_empty") {
    return reply.questions.length ? 'A "frontier_empty" reply must have an empty questions array.' : null;
  }
  if (!reply.questions.length) return 'An "ask_round" reply needs at least one question.';
  const keys = new Set<string>();
  for (const q of reply.questions) {
    if (keys.has(q.key)) return `Question key "${q.key}" is used twice in this round.`;
    keys.add(q.key);
    if (s.decisions[q.key]) return `Question key "${q.key}" is already settled. Do not re-ask settled decisions.`;
    const optionIds = new Set(q.options.map((o) => o.id));
    if (optionIds.size !== q.options.length) return `Question "${q.key}" has duplicate option ids.`;
    if (optionIds.has(UNKNOWN_OPTION) || optionIds.has(OTHER_OPTION)) return `Question "${q.key}" uses a reserved option id.`;
    if (!optionIds.has(q.recommendedOptionId))
      return `Question "${q.key}" recommends "${q.recommendedOptionId}", which is not one of its option ids.`;
  }
  for (const q of reply.questions) {
    const clash = q.dependsOn.find((d) => keys.has(d));
    if (clash) return `Question "${q.key}" depends on "${clash}", which is asked in the same round. Move it to a later round.`;
  }
  return null;
}

export function applyRound(s: Session, reply: RoundReply): void {
  s.error = undefined;
  s.summary = reply.summary;
  s.keepGoing = false;
  if (reply.type === "frontier_empty") {
    s.status = "confirm";
  } else {
    const asked = new Set(reply.questions.map((q) => q.key));
    // Keep only usable "upcoming" hints: not settled, not asked now, not duplicated.
    const seen = new Set<string>();
    const upcoming = (reply.upcoming ?? []).filter((u) => {
      if (asked.has(u.key) || s.decisions[u.key] || seen.has(u.key)) return false;
      seen.add(u.key);
      return true;
    });
    s.rounds.push({ n: s.rounds.length + 1, questions: reply.questions, upcoming, summary: reply.summary, askedAt: new Date().toISOString() });
    s.reopened = [];
    s.status = "answering";
  }
  touch(s);
}

/** Record a full round of answers. Throws on invalid input (it comes from the browser). */
export function submitAnswers(s: Session, roundN: number, answers: Answer[]): void {
  const round = currentRound(s);
  if (s.status !== "answering" || !round || round.n !== roundN) throw new Error("That round is not open.");
  const byId = new Map(answers.map((a) => [a.questionId, a]));
  const recorded: Answer[] = [];
  for (const q of round.questions) {
    const a = byId.get(q.key);
    if (!a) throw new Error(`Missing answer for "${q.title}".`);
    const option = q.options.find((o) => o.id === a.optionId);
    let decision: Decision;
    const label = q.label?.trim() || undefined;
    if (option) {
      decision = { key: q.key, round: round.n, title: q.title, answer: option.label, kind: "option", accepted_recommendation: false, dependsOn: q.dependsOn };
    } else if (a.optionId === OTHER_OPTION && a.text?.trim()) {
      decision = { key: q.key, round: round.n, title: q.title, answer: a.text.trim().slice(0, 2000), kind: "other", accepted_recommendation: false, dependsOn: q.dependsOn };
    } else if (a.optionId === UNKNOWN_OPTION) {
      decision = { key: q.key, round: round.n, title: q.title, answer: "I don't know", kind: "unknown", accepted_recommendation: false, dependsOn: q.dependsOn };
    } else {
      throw new Error(`Invalid answer for "${q.title}".`);
    }
    // Only the recommended option counts as accepting it; the browser's flag is advisory.
    const accepted = Boolean(option && option.id === q.recommendedOptionId && a.accepted_recommendation !== false);
    decision.accepted_recommendation = accepted;
    if (label) decision.label = label;
    if (s.stale?.[q.key]) {
      decision.reopened = true;
      delete s.stale[q.key];
    }
    s.decisions[q.key] = decision;
    recorded.push({ questionId: q.key, optionId: a.optionId, text: a.optionId === OTHER_OPTION ? decision.answer : undefined, accepted_recommendation: accepted });
  }
  round.answers = recorded;
  round.answeredAt = new Date().toISOString();
  s.status = "asking";
  s.error = undefined;
  touch(s);
}

/** Keys that (transitively) depend on `key`. */
export function dependentsOf(s: Session, key: string): string[] {
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

/** Reopen a decision: it and everything downstream of it go back on the frontier (user story 6). */
export function reopen(s: Session, key: string): string[] {
  if (!s.decisions[key]) throw new Error("Unknown decision.");
  if (s.status === "asking" || s.status === "synthesizing") throw new Error("Wait for the agent to finish first.");
  const affected = [key, ...dependentsOf(s, key)];
  const root = s.decisions[key];
  const rootLabel = root.label || root.title;
  s.stale ??= {};
  for (const k of affected) {
    const d = s.decisions[k];
    s.stale[k] = {
      key: k,
      label: d.label || d.title,
      title: d.title,
      answer: d.answer,
      round: d.round,
      dependsOn: d.dependsOn,
      reason: k === key ? "You reopened it" : `${rootLabel} changed`,
    };
    delete s.decisions[k];
  }
  // An open round on screen is dropped too: its questions may depend on what just changed.
  const open = currentRound(s);
  if (open) s.rounds.pop();
  s.reopened = [...new Set([...s.reopened, ...affected])];
  s.status = "asking";
  s.wrappedUp = false;
  s.plan = undefined;
  s.error = undefined;
  touch(s);
  return affected;
}

/** Largest plan the editor may save (the HTTP body limit is 1 MB). */
export const MAX_PLAN_CHARS = 500_000;

/**
 * The user edited the plan (editor autosave). The text is stored exactly as sent, so raw
 * `[R1:id]` citations and anything else the editor doesn't understand survive untouched.
 */
export function editPlan(s: Session, markdown: unknown) {
  if (s.status !== "plated" || !s.plan) throw new Error("There's no plan to edit yet.");
  if (typeof markdown !== "string") throw new Error("Expected the plan as Markdown text.");
  if (markdown.length > MAX_PLAN_CHARS) throw new Error("The plan is too long to save.");
  s.plan.markdown = markdown;
  s.plan.editedAt = new Date().toISOString();
  touch(s);
}

/** "Wrap it up": stop asking; the plan lists what's still open (user story 8). */
export function wrapUp(s: Session): void {
  if (s.status !== "answering" && s.status !== "asking") throw new Error("Nothing to wrap up.");
  s.wrappedUp = true;
  s.status = "confirm";
  s.error = undefined;
  touch(s);
}

/** Rounds in a row (most recent first) where every answer kept the recommendation untouched. */
export function acceptStreak(s: Session): number {
  let n = 0;
  for (let i = s.rounds.length - 1; i >= 0; i--) {
    const r = s.rounds[i];
    if (!r.answers) continue; // the open round doesn't count
    if (r.answers.length && r.answers.every((a) => a.accepted_recommendation)) n++;
    else break;
  }
  return n;
}

export const NUDGE_AFTER_ROUNDS = 4;

/** Show the passivity nudge on the open round after 4 all-accept rounds, until dismissed. */
export function shouldNudge(s: Session): boolean {
  return s.status === "answering" && !s.nudgeDismissed && acceptStreak(s) >= NUDGE_AFTER_ROUNDS;
}

export function dismissNudge(s: Session): void {
  s.nudgeDismissed = true;
  touch(s);
}

export function keepGoing(s: Session): void {
  if (s.status !== "confirm") throw new Error("Not at the confirm step.");
  s.keepGoing = true;
  s.wrappedUp = false;
  s.status = "asking";
  touch(s);
}

export function startSynthesis(s: Session): void {
  if (s.status !== "confirm") throw new Error("Confirm the decisions first.");
  s.status = "synthesizing";
  s.error = undefined;
  touch(s);
}

export function setError(s: Session, code: FailureCode, message: string): void {
  s.error = { code, message, at: new Date().toISOString() };
  touch(s);
}

/** Questions asked but never answered (open round when wrapping up). */
export function openQuestions(s: Session): Question[] {
  return currentRound(s)?.questions ?? [];
}

/** Everything the user typed, used to exempt their own words from the banned-term filter. */
export function userText(s: Session): string {
  const answers = Object.values(s.decisions)
    .filter((d) => d.kind === "other")
    .map((d) => d.answer);
  return [s.idea, s.context, ...answers].join("\n");
}

/** Validate a plan's citations (AC16). Returns an error for the repair retry, or null. */
export function validatePlan(s: Session, plan: PlanReply): string | null {
  for (const c of plan.decisions) {
    const d = s.decisions[c.questionId];
    if (!d || d.round !== c.round) return `Citation R${c.round}:${c.questionId} does not match any settled decision.`;
  }
  return null;
}

/**
 * Final plan.md. The model writes the body; the decision log is generated from session data so
 * every answered question appears with its {round, questionId}, whatever the model did (AC16).
 */
export function renderPlanMarkdown(s: Session, plan: PlanReply): string {
  const statements = new Map(plan.decisions.map((d) => [d.questionId, d.statement]));
  const decisions = Object.values(s.decisions).sort((a, b) => a.round - b.round || a.key.localeCompare(b.key));
  const lines = [`# ${plan.title}`, "", plan.markdown.trim(), "", "## Decision log", ""];
  for (const d of decisions) {
    const how = d.kind === "unknown" ? "left to a default" : d.accepted_recommendation ? "accepted the recommendation" : "your call";
    const statement = statements.get(d.key);
    lines.push(`- **[R${d.round}:${d.key}]** ${d.title} → ${d.answer} (${how})${statement ? `. ${statement}` : ""}`);
  }
  const open = [...new Set([...openQuestions(s).map((q) => q.title), ...plan.openDecisions])];
  if (open.length) {
    lines.push("", "## Open decisions", "");
    for (const o of open) lines.push(`- ${o}`);
  }
  lines.push("");
  return lines.join("\n");
}
