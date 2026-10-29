import { randomUUID } from "node:crypto";
import type { PlanReply, Question, RoundReply, Upcoming } from "./schema.ts";
import type { FailureCode } from "./classify.ts";
import type { ProviderId } from "./providers/types.ts";
import type { CommentState } from "./comments.ts";
import type { PlanIssues, Slice, SplitSource } from "./issues.ts";
import { type AnswerEdit, answerEdits, blockKey, findDecisionBlocks, overrides, serializeDecision, updateDecisionBlock, userBlocks } from "./decision-block.ts";

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
  /**
   * Asked while something was owed (a reopened or stale decision): a repair the user asked for.
   * It runs past the cap and doesn't count toward it (#33, review of #42). Older rounds lack it and count.
   */
  reask?: boolean;
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

export interface Session extends CommentState {
  id: string;
  createdAt: string;
  updatedAt: string;
  /** When the agent was first asked for round 1 (#41). Only reported; it never starts, stops or extends a round. */
  roundsStartedAt?: string;
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
  wrappedUp: boolean;
  /**
   * Why the interview stopped at Confirm without a wrap (#33): "cap" when the saved rounds reached N,
   * "empty" when the agent had nothing left to ask. Cleared when another round starts.
   */
  stop?: "cap" | "empty";
  /** Ask 1 more round (#37): granted once at the cap, stored on the click, so a reload can't grant it twice. */
  extra?: boolean;
  keepGoing: boolean;
  summary: string;
  error?: SessionError;
  /** Created by a coding agent over `grillado mcp`: the first round starts when the web app opens it. */
  queued?: boolean;
  /** The MCP client that started it (its clientInfo.name, e.g. "cursor-vscode"), for Recent. */
  from?: string;
  /** Imported from a source found in the project (v1.3 item 1). */
  source?: ImportedSource;
  /** The project root the source was found in (v1.3 item 1). */
  project?: string;
  /**
   * The plan's tracker links (v1.3 item 2, the spec's "plan.issues"). Kept on the session, not inside
   * `plan`, so a plan rewritten after a reopen keeps its links and re-exports update instead of duplicating.
   */
  issues?: PlanIssues;
  /** {agent}'s last split, cached per plan text (v1.3 item 2). The story/to-do fallback is never cached. */
  issueSplit?: { planHash: string; source: SplitSource; slices: Slice[]; at: string };
  /** Titles edited in the sheet, as last sent, by item key (v1.3 item 2). Kept apart from the split. */
  issueTitles?: Record<string, string>;
  plan?: {
    title: string;
    markdown: string;
    path: string;
    openDecisions: string[];
    createdAt: string;
    editedAt?: string;
    /** Decisions being asked again after an inline change (Q2); the plan stays, marked, until the next plan. */
    waiting?: string[];
    /** Last time plan.md was reloaded after a change made outside Grillado (Q5). */
    reloadedAt?: string;
    /**
     * `answer:` lines changed outside Grillado that have dependents (DECISIONS #26). Nothing reruns
     * until the user confirms (re-ask) or dismisses (keep the answer, dependents go stale).
     */
    external?: ExternalEdit[];
  };
}

/** Where an imported plan came from (v1.3 item 1). Only text was copied; the source is never written. */
export interface ImportedSource {
  app: "claude" | "codex" | "cursor" | "file";
  kind: "session" | "plan";
  /** Absolute path of the transcript or plan file. */
  path: string;
  sessionId?: string;
  /** app + absolute path + session id: the key in sources.json, so a source never imports twice. */
  fingerprint: string;
  /** Hash of the imported text (idea, Q&A, plan); a new hash on disk offers Update. */
  contentHash: string;
  importedAt: string;
  /** Hash of the plan.md the import wrote, to tell a user's edit from our own on Update. */
  planHash?: string;
  /** The title the row had in Found, so Recent names the plan the same way (review-pr21 #6). */
  title?: string;
  /** Answered questions copied (free-text sessions: the answers {agent} turned into decisions). */
  questions: number;
  /** Free-text session: {agent} turned the answers into decisions at import (§4). */
  viaAgent?: boolean;
  /** Questions in the source that had no answer (a session cut short); not imported. */
  unanswered?: number;
  /** Part of the session was compacted away; the import holds what was left. */
  compacted?: boolean;
  /** The opening idea came from the compaction summary. */
  ideaFromSummary?: boolean;
  /** Last Update landed in plan.conflict.md because the plan had been edited (v1.1 Q5). */
  conflict?: string;
  /** The source's own agent, when it wasn't installed and the import used another (demo finding MUST 2). */
  agentFrom?: ProviderId;
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

/** The agent's plan is saved: plated, stamped with when it was written, and the session is updated (#41). */
export function setPlan(s: Session, plan: { title: string; markdown: string; path: string; openDecisions: string[] }): void {
  const at = new Date().toISOString();
  s.plan = { ...plan, createdAt: at };
  s.status = "plated";
  s.updatedAt = at;
}

/** The plan's tracker links after an export run (or its failure): the session changed (friction 26). */
export function setIssues(s: Session, issues: PlanIssues): void {
  s.issues = issues;
  touch(s);
}

/** "Plan written 12 min 5 s after round 1 started." (#41); nothing for sessions with no round-1 start. */
export function planTiming(s: Session): string | undefined {
  if (!s.roundsStartedAt || !s.plan) return undefined;
  const ms = Math.max(0, Date.parse(s.plan.createdAt) - Date.parse(s.roundsStartedAt));
  if (!Number.isFinite(ms)) return undefined;
  return `Plan written ${Math.floor(ms / 60_000)} min ${Math.floor((ms % 60_000) / 1000)} s after round 1 started.`;
}

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
  // Questions the user added (U ids): open ones are asked word for word; answered ones are final.
  const user = userBlocks(s.plan?.markdown ?? "", s.decisions);
  for (const q of reply.questions) {
    if (keys.has(q.key)) return `Question key "${q.key}" is used twice in this round.`;
    keys.add(q.key);
    if (s.decisions[q.key]) return `Question key "${q.key}" is already settled. Do not re-ask settled decisions.`;
    if (user.answered.some((u) => u.key === q.key)) return `Question key "${q.key}" was answered by the user in the plan. Their answer is final; do not ask it.`;
    const mine = user.asked.find((u) => u.key === q.key);
    if (mine && q.title.trim() !== mine.question.trim()) return `Question "${q.key}" is the user's own question: use it word for word as the title: "${mine.question}".`;
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

/**
 * Save the agent's round. Past the cap (`max` counted rounds) only what the user sent back may be
 * asked: other questions are dropped, and with nothing left Confirm opens (#33, review of #42).
 * A round that asks at least one owed decision is a re-ask, and re-asks don't count.
 */
export function applyRound(s: Session, reply: RoundReply, max = DEFAULT_MAX_ROUNDS): void {
  s.error = undefined;
  s.summary = reply.summary;
  s.keepGoing = false;
  const owe = new Set(owedKeys(s));
  const questions = roundsSaved(s) >= roundLimit(s, max) ? reply.questions.filter((q) => owe.has(q.key)) : reply.questions;
  if (reply.type === "frontier_empty") {
    s.status = "confirm";
    s.stop = "empty";
  } else if (!questions.length) {
    s.status = "confirm";
    s.stop = "cap";
  } else {
    s.stop = undefined;
    const asked = new Set(questions.map((q) => q.key));
    // Keep only usable "upcoming" hints: not settled, not asked now, not duplicated.
    const seen = new Set<string>();
    const upcoming = (reply.upcoming ?? []).filter((u) => {
      if (asked.has(u.key) || s.decisions[u.key] || seen.has(u.key)) return false;
      seen.add(u.key);
      return true;
    });
    s.rounds.push({
      n: s.rounds.length + 1,
      questions,
      upcoming,
      summary: reply.summary,
      askedAt: new Date().toISOString(),
      ...(questions.some((q) => owe.has(q.key)) ? { reask: true } : {}),
    });
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
      decision = { key: q.key, round: round.n, title: q.title, answer: "I don’t know", kind: "unknown", accepted_recommendation: false, dependsOn: q.dependsOn };
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
    // A Question you added yourself (U id, item 4 #34) gets its answer in the plan text too.
    if (s.plan && /^u\d+$/.test(q.key))
      s.plan.markdown = updateDecisionBlock(s.plan.markdown, q.key, { status: undefined, answer: decision.answer, by: "you", at: new Date().toISOString() });
    recorded.push({ questionId: q.key, optionId: a.optionId, text: a.optionId === OTHER_OPTION ? decision.answer : undefined, accepted_recommendation: accepted });
  }
  round.answers = recorded;
  round.answeredAt = new Date().toISOString();
  s.status = "asking";
  s.error = undefined;
  // The re-asked decisions are answered; from here the plan is no longer shown while waiting.
  if (s.plan) s.plan.waiting = undefined;
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
  s.stop = undefined;
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
  if (s.status !== "plated" || !s.plan) throw new Error("There’s no plan to edit yet.");
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
  s.stop = undefined;
  s.status = "confirm";
  s.error = undefined;
  touch(s);
}

/** Rounds of questions when `--max-rounds` isn't given (#32, PO override): the same for every agent. */
export const DEFAULT_MAX_ROUNDS = 2;

/** What the user sent back and is waiting to be asked again: reopened or stale decisions. */
export const owedKeys = (s: Session): string[] => [...new Set([...s.reopened, ...Object.keys(s.stale ?? {})])];

export const owed = (s: Session): boolean => owedKeys(s).length > 0;

/** Rounds that count toward the cap (#33): saved question batches, except re-asks (`reask`, rounds that asked an owed decision). */
export const roundsSaved = (s: Session): number => s.rounds.filter((r) => !r.reask).length;

/**
 * The cap gate (#33): `max` saved rounds and nothing owed. Decisions the user reopened or changed
 * (stale, or queued to re-ask) are owed: they run past the cap, because the user asked for them.
 */
export function atCap(s: Session, max: number): boolean {
  return roundsSaved(s) >= roundLimit(s, max) && !owed(s);
}

/** Rounds allowed: the cap, plus the one extra round once it's granted (#37). */
export const roundLimit = (s: { extra?: boolean }, max: number): number => max + (s.extra ? 1 : 0);

/** Ask 1 more round (#37): at the cap, once. The grant is saved before the round is asked. */
export function askMore(s: Session, max = DEFAULT_MAX_ROUNDS): void {
  if (s.status !== "confirm") throw new Error("Not at the confirm step.");
  if (!atCap(s, max) || s.extra) throw new Error("The extra round is used. Write the plan.");
  // The grant is round max + 1. After a relaunch with a lower --max-rounds the saved rounds are already
  // past that, so a grant would ask nothing.
  if (roundsSaved(s) > max) throw new Error("That was the last round. Write the plan.");
  s.extra = true;
  s.stop = undefined;
  s.wrappedUp = false;
  s.status = "asking";
  touch(s);
}

/** The last allowed round is answered: Confirm opens with no question-asking agent call (#33). */
export function stopAtCap(s: Session): void {
  s.status = "confirm";
  s.stop = "cap";
  s.keepGoing = false;
  s.error = undefined;
  touch(s);
}

export function keepGoing(s: Session, max = DEFAULT_MAX_ROUNDS): void {
  if (s.status !== "confirm") throw new Error("Not at the confirm step.");
  if (atCap(s, max)) throw new Error("That was the last round. Write the plan.");
  s.keepGoing = true;
  s.stop = undefined;
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

/** "R2·1": a decision's round and its position in that round, as the UI shows it. */
export function decisionLabel(s: Session, round: number, key: string): string {
  const r = s.rounds.find((x) => x.n === round);
  const i = r ? r.questions.findIndex((q) => q.key === key) : -1;
  return `R${round}·${i === -1 ? "?" : i + 1}`;
}

/** The question a decision answered (latest round that asked it). */
export function questionFor(s: Session, key: string): { round: Round; question: Question } | undefined {
  for (let i = s.rounds.length - 1; i >= 0; i--) {
    const q = s.rounds[i].questions.find((x) => x.key === key);
    if (q) return { round: s.rounds[i], question: q };
  }
  return undefined;
}

const keyCited = (text: string, round: number, key: string) =>
  [...text.matchAll(/\[(R\d+:[^\]\s,]+(?:\s*,\s*R\d+:[^\]\s,]+)*)\]/g)].some((m) => m[1].split(/\s*,\s*/).includes(`R${round}:${key}`));

/** A settled decision as a fenced ```decision block (Q3). */
export function decisionBlock(s: Session, d: Decision, note?: string): string {
  const at = s.rounds.find((r) => r.n === d.round)?.answeredAt;
  return serializeDecision({
    id: decisionLabel(s, d.round, d.key),
    key: d.key,
    question: d.title,
    answer: d.answer,
    note,
    by: "you",
    kept_suggestion: d.accepted_recommendation,
    at,
  });
}

/**
 * Final plan.md. The model writes the body; each decision is added from session data as a
 * fenced ```decision block, right after the section that first cites it (or under "More
 * decisions"), so every answered question appears with its {round, questionId} whatever the
 * model did (AC16).
 */
export function renderPlanMarkdown(s: Session, plan: PlanReply): string {
  const statements = new Map(plan.decisions.map((d) => [d.questionId, d.statement]));
  const pos = (d: Decision) => s.rounds.find((r) => r.n === d.round)?.questions.findIndex((q) => q.key === d.key) ?? 0;
  const decisions = Object.values(s.decisions).sort((a, b) => a.round - b.round || pos(a) - pos(b));
  const body = plan.markdown.trim().split("\n");
  // Sections of the body: [start line, end line) per "## " heading (section 0 is before the first).
  const starts = [0, ...body.flatMap((l, i) => (/^##\s/.test(l) ? [i] : []))].filter((v, i, a) => a.indexOf(v) === i);
  const sections = starts.map((a, i) => ({ a, b: starts[i + 1] ?? body.length, blocks: [] as string[] }));
  const rest: string[] = [];
  for (const d of decisions) {
    const block = decisionBlock(s, d, statements.get(d.key));
    const sec = sections.find((x) => keyCited(body.slice(x.a, x.b).join("\n"), d.round, d.key));
    if (sec) sec.blocks.push(block);
    else rest.push(block);
  }
  // Open decisions lead the document: after any intro, before the first section (v1.2 §5 e-early).
  const round = currentRound(s);
  const openQs = openQuestions(s);
  const openTitles = new Set(openQs.map((q) => q.title));
  const other = [...new Set(plan.openDecisions)].filter((o) => !openTitles.has(o));
  const lines = [`# ${plan.title}`, ""];
  let opened = false;
  const pushOpen = () => {
    opened = true;
    if (!openQs.length && !other.length) return;
    lines.push("## Open decisions", "");
    openQs.forEach((q, i) => {
      lines.push(serializeDecision({ id: `R${round!.n}·${i + 1}`, key: q.key, question: q.title, status: "open" }), "");
    });
    for (const o of other) lines.push(`- ${o}`);
    if (other.length) lines.push("");
  };
  for (const sec of sections) {
    if (!opened && /^##\s/.test(body[sec.a] ?? "")) pushOpen();
    const part = body.slice(sec.a, sec.b);
    while (part.length && !part.at(-1)!.trim()) part.pop();
    if (!part.length && !sec.blocks.length) continue;
    lines.push(...part, "");
    for (const b of sec.blocks) lines.push(b, "");
  }
  if (!opened) pushOpen();
  if (rest.length) {
    lines.push("## More decisions", "");
    for (const b of rest) lines.push(b, "");
  }
  while (lines.length && !lines.at(-1)!.trim()) lines.pop();
  lines.push("");
  return lines.join("\n");
}

/** Everything a pick in an inline decision block can be. */
export interface Pick {
  optionId: string;
  text?: string;
}

function answerFor(q: Question, pick: Pick): { answer: string; kind: Decision["kind"]; accepted: boolean } {
  const option = q.options.find((o) => o.id === pick.optionId);
  if (option) return { answer: option.label, kind: "option", accepted: option.id === q.recommendedOptionId };
  if (pick.optionId === OTHER_OPTION && pick.text?.trim()) return { answer: pick.text.trim().slice(0, 2000), kind: "other", accepted: false };
  throw new Error("Pick one of the options, or type your own answer.");
}

/**
 * Change a settled decision from its block in the plan (Q2: works like Reopen for what depends
 * on it). The decision takes the new answer right away and its block in plan.md is updated; its
 * dependents are marked "will be asked again" and a new round starts for them. The plan stays,
 * marked, until the next plan replaces it. Returns the dependents that will be re-asked.
 */
export function changeDecision(s: Session, key: string, pick: Pick): string[] {
  if (s.status !== "plated" || !s.plan) throw new Error("Change answers from the plan once it’s written.");
  const deps = setAnswer(s, key, pick);
  if (deps === null) return [];
  reask(s, key, deps);
  finishChange(s, deps);
  return deps;
}

/** The new answer, its round's record and its block; null when nothing changed. Returns the dependents. */
function setAnswer(s: Session, key: string, pick: Pick): string[] | null {
  const d = s.decisions[key];
  if (!d) throw new Error("Unknown decision.");
  const found = questionFor(s, key);
  if (!found) throw new Error("Unknown decision.");
  const next = answerFor(found.question, pick);
  if (next.answer === d.answer && next.kind === d.kind) return null;
  const deps = dependentsOf(s, key);
  s.decisions[key] = { ...d, answer: next.answer, kind: next.kind, accepted_recommendation: next.accepted };
  const ans = found.round.answers?.find((a) => a.questionId === key);
  if (ans) Object.assign(ans, { optionId: pick.optionId, text: next.kind === "other" ? next.answer : undefined, accepted_recommendation: next.accepted });
  const now = new Date().toISOString();
  const md = restateAnswer(s.plan!.markdown, `R${d.round}:${key}`, d.answer, next.answer);
  // The note stays (dogfood friction 20: it can be a person's, not only the agent's restatement):
  // where it restates the old answer word for word, those words become the new answer; otherwise
  // it's kept as written. updateDecisionBlock leaves a line that isn't in the patch byte for byte.
  // Except an "Overridden" note: it was the decision, and the person's Change is the newer one, so it goes
  // (review-pr29 must 2); kept, the block would say one thing in its answer and another in its note.
  const block = findDecisionBlocks(md).find((b) => blockKey(b.parsed) === key);
  const oldNote = block?.parsed.ok ? block.parsed.fields.note : undefined;
  const swapped = oldNote && !overrides(oldNote) ? swapAnswer(oldNote, d.answer, next.answer) : null;
  s.plan!.markdown = updateDecisionBlock(md, key, { answer: next.answer, ...(swapped ? { note: swapped } : overrides(oldNote) ? { note: undefined } : {}), by: "you", kept_suggestion: next.accepted, at: now });
  s.plan!.editedAt = now;
  return deps;
}

const escapeRe = (t: string) => t.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * `text` with every whole-word occurrence of the answer `from` replaced by `to` (case-insensitive;
 * the first letter follows the text's case). null when `from` doesn't appear.
 */
export function swapAnswer(text: string, from: string, to: string): string | null {
  const f = from.trim();
  if (!f) return null;
  const re = new RegExp(`(?<![\\p{L}\\p{N}])${escapeRe(f)}(?![\\p{L}\\p{N}])`, "giu");
  if (!re.test(text)) return null;
  re.lastIndex = 0;
  // Where the text changed the answer's first-letter case (sentence start, mid-sentence), follow it.
  const up = (c: string) => c !== c.toLowerCase();
  return text.replace(re, (m) => (up(m[0]) === up(f[0]) ? to : (up(m[0]) ? to.charAt(0).toUpperCase() : to.charAt(0).toLowerCase()) + to.slice(1)));
}

/**
 * The plan's prose after an answer changed: in each sentence or list item that cites the
 * decision (`[R1:key]`), outside fences, a word-for-word restatement of the old answer becomes
 * the new one. Prose that paraphrases the answer is left to the agent (folding a change into the
 * text is the Phase 2 agent edit, reviewed before it reaches plan.md, DECISIONS #15).
 */
export function restateAnswer(md: string, cite: string, from: string, to: string): string {
  if (!from.trim() || from === to) return md;
  let fence = false;
  return md
    .split("\n")
    .map((line) => {
      if (/^\s*```/.test(line)) {
        fence = !fence;
        return line;
      }
      if (fence || !line.includes(cite)) return line;
      // Sentences keep every character, so the line joins back unchanged where nothing matched.
      return line
        .split(/(?<=[.!?])(?=\s)/)
        .map((part) => (citesKey(part, cite) ? swapOutsideCites(part, from, to) : part))
        .join("");
    })
    .join("\n");
}

const CITE_RE = /\[(R\d+:[^\]\s,]+(?:\s*,\s*R\d+:[^\]\s,]+)*)\]/g;
const citesKey = (text: string, cite: string) => [...text.matchAll(CITE_RE)].some((m) => m[1].split(/\s*,\s*/).includes(cite));
/** Swap the answer in the text between cites, never inside a [R1:key] cite itself. */
function swapOutsideCites(text: string, from: string, to: string): string {
  let out = "";
  let last = 0;
  for (const m of text.matchAll(CITE_RE)) {
    const seg = text.slice(last, m.index);
    out += (swapAnswer(seg, from, to) ?? seg) + m[0];
    last = m.index! + m[0].length;
  }
  const tail = text.slice(last);
  return out + (swapAnswer(tail, from, to) ?? tail);
}

/** Mark what depends on a changed decision as "will be asked again". */
function reask(s: Session, key: string, deps: string[]) {
  const d = s.decisions[key];
  const rootLabel = d ? d.label || d.title : key;
  s.stale ??= {};
  for (const k of deps) {
    const x = s.decisions[k];
    if (!x) continue;
    s.stale[k] = { key: k, label: x.label || x.title, title: x.title, answer: x.answer, round: x.round, dependsOn: x.dependsOn, reason: `${rootLabel} changed` };
    delete s.decisions[k];
  }
}

/** After a change: a new round when anything is asked again; the plan stays, marked, until the next plan. */
function finishChange(s: Session, deps: string[]) {
  if (deps.length) {
    s.reopened = [...new Set([...s.reopened, ...deps])];
    s.plan!.waiting = deps;
    s.status = "asking";
    s.wrappedUp = false;
    s.stop = undefined;
  }
  s.error = undefined;
  touch(s);
}

/** The settled answers a plan.md text changed by hand (DECISIONS #22). */
export function planAnswerEdits(s: Session, markdown: string): AnswerEdit[] {
  return answerEdits(markdown, settledAnswers(s));
}

/**
 * Save a hand-edited plan whose `answer:` lines changed settled decisions (DECISIONS #22): the
 * same path as the card's Change. Each typed answer is matched to an option by its label, else
 * kept as the user's own words; what depends on a changed answer is re-asked in a new round.
 * Returns the decisions that will be asked again.
 */
export function saveAnswerEdits(s: Session, markdown: unknown): string[] {
  editPlan(s, markdown);
  const all: string[] = [];
  for (const e of planAnswerEdits(s, s.plan!.markdown)) all.push(...applyEdit(s, e, true));
  const deps = [...new Set(all)];
  finishChange(s, deps);
  return deps;
}

/** Record one edited answer (an option when it matches a label, any case; else your own words). */
function applyEdit(s: Session, e: AnswerEdit, markStale: boolean): string[] {
  if (!s.decisions[e.key]) return []; // asked again because an earlier edit changed what it depends on
  const q = questionFor(s, e.key)?.question;
  const option = q?.options.find((o) => o.label.trim().toLowerCase() === e.to.trim().toLowerCase());
  const deps = setAnswer(s, e.key, option ? { optionId: option.id } : { optionId: OTHER_OPTION, text: e.to });
  if (!deps) return [];
  if (markStale) reask(s, e.key, deps);
  return deps;
}

export interface ExternalEdit extends AnswerEdit {
  /** Decisions that would be asked again. */
  deps: string[];
}

/**
 * plan.md changed on disk (DECISIONS #26). Adopt the text. A changed answer that nothing depends
 * on is simply recorded; one with dependents waits in `plan.external` for the user. Edits that only
 * change whitespace or casing aren't changes (`answerEdits`).
 */
export function adoptExternalPlan(s: Session, markdown: string): void {
  if (!s.plan) return;
  s.plan.markdown = markdown;
  s.plan.reloadedAt = new Date().toISOString();
  const pending: ExternalEdit[] = [];
  for (const e of answerEdits(markdown, settledAnswers(s))) {
    const deps = dependentsOf(s, e.key);
    if (deps.length) pending.push({ ...e, deps });
    else applyEdit(s, e, false);
  }
  s.plan.external = pending.length ? pending : undefined;
  touch(s);
}

/** Confirm outside edits: the same path as the card's Change; returns what is asked again. */
export function confirmExternal(s: Session): string[] {
  const edits = s.plan?.external ?? [];
  s.plan!.external = undefined;
  const deps = [...new Set(edits.flatMap((e) => applyEdit(s, e, true)))];
  finishChange(s, deps);
  return deps;
}

/** Dismiss: keep the new answers, mark their dependents stale (each can be re-asked later). Never reverts. */
export function dismissExternal(s: Session): void {
  const edits = s.plan?.external ?? [];
  s.plan!.external = undefined;
  for (const e of edits) applyEdit(s, e, true);
  touch(s);
}

/** "Re-ask" on a stale decision: ask it again in a new round. */
export function reaskStale(s: Session, keys: string[]): string[] {
  if (s.status !== "plated" || !s.plan) throw new Error("There’s no plan yet.");
  const ks = keys.filter((k) => s.stale?.[k] && !s.decisions[k]);
  if (!ks.length) throw new Error("Nothing to ask again.");
  finishChange(s, ks);
  return ks;
}

const settledAnswers = (s: Session) => {
  const out = Object.fromEntries(Object.entries(s.decisions).map(([k, d]) => [k, d.answer]));
  // Outside edits waiting for the user already show their new answer; they aren't new edits.
  for (const e of s.plan?.external ?? []) if (Object.hasOwn(out, e.key)) out[e.key] = e.to;
  return out;
};

/**
 * Answer a decision that was left open when the plan was written early. It's settled with its
 * round, and its block in plan.md loses `status: open`. (Folding the answer into the plan's
 * text is the agent's job in a later step.)
 */
export function answerOpenDecision(s: Session, key: string, pick: Pick): void {
  if (s.status !== "plated" || !s.plan) throw new Error("There’s no plan yet.");
  if (s.decisions[key]) throw new Error("That decision is already answered.");
  const found = questionFor(s, key);
  if (!found) throw new Error("Unknown decision.");
  const next = answerFor(found.question, pick);
  const q = found.question;
  s.decisions[key] = {
    key,
    round: found.round.n,
    title: q.title,
    answer: next.answer,
    kind: next.kind,
    accepted_recommendation: next.accepted,
    dependsOn: q.dependsOn,
    ...(q.label?.trim() ? { label: q.label.trim() } : {}),
  };
  const now = new Date().toISOString();
  s.plan.markdown = updateDecisionBlock(s.plan.markdown, key, { status: undefined, answer: next.answer, by: "you", kept_suggestion: next.accepted, at: now });
  s.plan.openDecisions = s.plan.openDecisions.filter((t) => t !== q.title);
  s.plan.editedAt = now;
  touch(s);
}

/** Keys of decision blocks in a plan (AC16 checks and the Decisions tab). */
export function planDecisionKeys(md: string): string[] {
  return findDecisionBlocks(md).flatMap((b) => {
    const k = blockKey(b.parsed);
    return k ? [k] : [];
  });
}
