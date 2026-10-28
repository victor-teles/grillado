// v1.3 item 1: an Extract becomes a normal Grillado session. Only text is copied (the opening idea,
// the answered questions and the plan text), never tool calls, tool output or file contents, and
// all of it goes through the output filter before it's stored.
import { findBanned, redact } from "../filter.ts";
import type { ProviderId } from "../providers/types.ts";
import type { Question } from "../schema.ts";
import { type Decision, type ImportedSource, OTHER_OPTION, type Round, type Session, createSession, renderPlanMarkdown, userText } from "../session.ts";
import { textHash } from "../text-hash.ts";
import { type Extract, contentHash, stripInvocation } from "./extract.ts";

export class ImportError extends Error {
  constructor(
    readonly code: "unknown" | "in_progress" | "needs_agent" | "not_qualified" | "unreadable" | "filtered" | "busy" | "stopped" | "agent",
    message: string,
    /** "agent": the failure code from the CLI (rate, auth, timeout…), shown as words in the row. */
    readonly reason?: string,
  ) {
    super(message);
  }
}

/** Text the agent wrote: banned names and prompt text are cut. */
const agentText = (t: string) => redact(t.trim());
/** Text the user typed: the starting command is dropped; their own words are kept (AC18 exempts them). */
const ownText = (t: string) => {
  const own = stripInvocation(t);
  return redact(own, own);
};

const slug = (t: string) =>
  t
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40)
    .replace(/-+$/, "") || "q";

/** Rounds and decisions from the answered questions; one structured ask is one round. */
function roundsFrom(x: Extract, at: string): { rounds: Round[]; decisions: Record<string, Decision> } {
  const rounds: Round[] = [];
  const decisions: Record<string, Decision> = {};
  const used = new Set<string>();
  const calls = [...new Set(x.qa.map((q) => q.call))];
  for (const c of calls) {
    const answered = x.qa.filter((q) => q.call === c && q.answer !== undefined);
    if (!answered.length) continue;
    const n = rounds.length + 1;
    const questions: Question[] = [];
    const answers: NonNullable<Round["answers"]> = [];
    for (const qa of answered) {
      const base = slug(qa.header || qa.question);
      let key = base;
      for (let i = 2; used.has(key); i++) key = `${base.slice(0, 36)}-${i}`;
      used.add(key);
      const options = qa.options.map((o, i) => ({ id: `o${i + 1}`, label: agentText(o.label).slice(0, 200), description: agentText(o.description).slice(0, 600) }));
      const rec = qa.options.findIndex((o) => o.recommended);
      const title = agentText(qa.question).slice(0, 160);
      const label = agentText(qa.header).slice(0, 60);
      questions.push({ key, label, title, body: "", options, recommendedOptionId: rec >= 0 ? `o${rec + 1}` : "", dependsOn: [] });
      const raw = qa.answer!.trim();
      const picked = qa.options.findIndex((o) => o.label.toLowerCase() === raw.toLowerCase());
      const parts = raw.split(/\s*,\s*/);
      const several = parts.length > 1 && parts.every((p) => qa.options.some((o) => o.label.toLowerCase() === p.toLowerCase()));
      const accepted = picked >= 0 && picked === rec;
      let answer: string;
      if (picked >= 0) {
        answer = options[picked].label;
        answers.push({ questionId: key, optionId: options[picked].id, accepted_recommendation: accepted });
      } else {
        answer = several ? parts.map(agentText).join(", ") : ownText(raw);
        answers.push({ questionId: key, optionId: OTHER_OPTION, text: answer, accepted_recommendation: false });
      }
      decisions[key] = { key, round: n, ...(label ? { label } : {}), title, answer, kind: picked >= 0 || several ? "option" : "other", accepted_recommendation: accepted, dependsOn: [] };
    }
    rounds.push({ n, questions, summary: "", answers, askedAt: at, answeredAt: at });
  }
  return { rounds, decisions };
}

/** The plan's Markdown: the source's plan text with the imported decisions as ```decision blocks. */
function planMarkdown(s: Session, x: Extract, title: string): string | null {
  if (!x.plan) return null;
  const body = agentText(x.plan.markdown);
  // A plan file is copied as written (its own decision blocks included); a session's plan gets the
  // decisions from its Q&A, placed like a plan Grillado wrote.
  if (x.kind === "plan") return `${body}\n`;
  return renderPlanMarkdown(s, { type: "plan", title, markdown: body.replace(/^\s*#\s+.*\n?/, "").trim() || "_No plan text._", decisions: [], openDecisions: [] });
}

export interface ImportInput {
  extract: Extract;
  path: string;
  fingerprint: string;
  project: string;
  provider: ProviderId;
  /** Source still being written (last change < 2 min ago). */
  inProgress?: boolean;
  /** Free-text sessions (§4): the decisions {agent} made from the answers, one round. */
  agentDecisions?: AgentDecision[];
}

/** One decision {agent} read out of a free-text answer. */
export interface AgentDecision {
  label: string;
  title: string;
  answer: string;
}

/** The free-text source with {agent}'s decisions in place of structured questions (one round). */
function withDecisions(x: Extract, ds: AgentDecision[]): Extract {
  return { ...x, qualifies: "structured", qa: ds.map((d) => ({ call: 1, header: d.label, question: d.title, options: [], answer: d.answer })) };
}

function check(x: Extract, inProgress?: boolean, decided?: boolean) {
  if (inProgress) throw new ImportError("in_progress", "This session is still going. Import it once it’s finished.");
  if (x.qualifies === "freetext" && !decided) throw new ImportError("needs_agent", "This interview has no structured questions; turning its answers into decisions needs an agent run.");
  if (x.qualifies !== "structured" && !(x.qualifies === "freetext" && decided)) throw new ImportError("not_qualified", "This isn’t a planning session.");
}

/** Fill `s` (new or existing) from the source: idea, rounds, decisions, status and plan text. */
function fill(s: Session, x: Extract, title: string, at: string): string | null {
  const { rounds, decisions } = roundsFrom(x, at);
  s.idea = ownText(x.idea).slice(0, 8000) || title;
  s.rounds = rounds;
  s.decisions = decisions;
  s.reopened = [];
  s.stale = undefined;
  s.summary = "";
  s.error = undefined;
  const md = planMarkdown(s, x, title);
  s.status = md ? "plated" : "confirm";
  s.wrappedUp = !md;
  const agentSide = [md ?? "", title, ...rounds.flatMap((r) => r.questions.flatMap((q) => [q.title, q.label, ...q.options.flatMap((o) => [o.label, o.description])]))].join("\n");
  if (findBanned(agentSide, userText(s))) throw new ImportError("filtered", "Couldn’t import this source safely.");
  return md;
}

function sourceOf(inp: ImportInput, at: string, title: string, planHash?: string): ImportedSource {
  const x = inp.extract;
  const unanswered = x.qa.filter((q) => q.answer === undefined).length;
  const viaAgent = !!inp.agentDecisions;
  return {
    app: x.app,
    kind: x.kind,
    path: inp.path,
    ...(x.sessionId ? { sessionId: x.sessionId } : {}),
    fingerprint: inp.fingerprint,
    contentHash: contentHash(x),
    importedAt: at,
    title,
    ...(planHash ? { planHash } : {}),
    questions: viaAgent ? (x.pairs?.length ?? 0) : x.qa.length - unanswered,
    ...(viaAgent ? { viaAgent: true } : {}),
    ...(unanswered ? { unanswered } : {}),
    ...(x.compacted ? { compacted: true } : {}),
    ...(x.ideaFromSummary ? { ideaFromSummary: true } : {}),
  };
}

/** A new session from a source. The caller writes it (and plan.md, when `markdown` isn't null). */
export function sessionFromSource(inp: ImportInput, now = new Date()): { session: Session; markdown: string | null } {
  check(inp.extract, inp.inProgress, !!inp.agentDecisions);
  const at = now.toISOString();
  const x = inp.agentDecisions ? withDecisions(inp.extract, inp.agentDecisions) : inp.extract;
  const title = agentText(x.title) || "Untitled session";
  const s = createSession({ idea: title, provider: inp.provider });
  const md = fill(s, x, title, at);
  s.project = inp.project;
  s.source = sourceOf(inp, at, title, md ? textHash(md) : undefined);
  if (md) s.plan = { title, markdown: md, path: "", openDecisions: [], createdAt: at };
  return { session: s, markdown: md };
}

/**
 * Update: the source changed since it was imported. Re-import into the same session, keeping its
 * comments. When the user edited plan.md since the import (its text no longer matches what the
 * import wrote), their plan stays as it is and the new import goes to plan.conflict.md (v1.1 Q5).
 */
export function updateFromSource(s: Session, inp: ImportInput, diskPlan: string | null, now = new Date()): { markdown: string | null; conflict: string | null } {
  check(inp.extract, inp.inProgress, !!inp.agentDecisions);
  const at = now.toISOString();
  const x = inp.agentDecisions ? withDecisions(inp.extract, inp.agentDecisions) : inp.extract;
  const title = agentText(x.title) || s.plan?.title || "Untitled session";
  const edited = !!s.plan && diskPlan !== null && !!s.source?.planHash && textHash(diskPlan) !== s.source.planHash;
  if (edited) {
    // Built on a copy: the user's plan, rounds and decisions stay exactly as they are.
    const md = fill(structuredClone(s), x, title, at);
    if (md) {
      s.source = { ...sourceOf(inp, at, title, s.source!.planHash), conflict: at };
      s.updatedAt = at;
      return { markdown: null, conflict: md };
    }
  }
  const keep = s.plan;
  const md = fill(s, x, title, at);
  s.source = sourceOf(inp, at, title, md ? textHash(md) : undefined);
  if (md) s.plan = { ...(keep ?? { openDecisions: [], createdAt: at, path: "" }), title, markdown: md, editedAt: undefined, external: undefined, waiting: undefined };
  else s.plan = undefined;
  s.updatedAt = at;
  return { markdown: md, conflict: null };
}
