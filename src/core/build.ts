// The plan-to-build loop: a written plan carries build steps, the coding agent reports its progress
// on them and asks the user a decision when the plan doesn't cover one, and the plan file records
// it all. DOM-free: the CLI, the MCP server, the web server and the browser share these types and
// rules. Grillado still writes no product code and runs no commands; it only keeps this state.
//
// The session holds the state (`session.build`). The plan file on disk shows it as two sections
// Grillado writes at the end, "## Build steps" and "## Build log" (the appendix). The plan text the
// user edits never contains the appendix: it is added when the file is written and taken out when
// the file is read back.

export type StepStatus = "todo" | "started" | "done";

export interface BuildStep {
  /** Stable for the life of the plan: progress, asks and the log refer to it. */
  key: string;
  title: string;
  /** The done check: how to tell the step is done. */
  done: string;
  status: StepStatus;
  startedAt?: string;
  doneAt?: string;
  /** What the agent verified when it reported the step done. */
  verified?: string;
  /** Where the agent moved away from the plan, if it did. */
  deviation?: string;
}

export interface AskOption {
  id: string;
  label: string;
  description?: string;
}

/** A decision the coding agent needs from the user during the build. Only the user answers it. */
export interface BuildAsk {
  key: string;
  title: string;
  body?: string;
  options: AskOption[];
  /** The option the agent would pick; shown as suggested, never applied for the user. */
  recommended?: string;
  /** The key of the step it was raised at. */
  step?: string;
  state: "open" | "answered" | "withdrawn";
  askedAt: string;
  endedAt?: string;
  /** The answer as text: the chosen option's label, or the user's own words. */
  answer?: string;
  /** The chosen option's id; absent when the user wrote their own answer. */
  answerId?: string;
  /** Why the agent withdrew it, when it said. */
  reason?: string;
}

export interface BuildLogEntry {
  at: string;
  kind: "started" | "done" | "reopened" | "asked" | "answered" | "withdrawn";
  step?: string;
  ask?: string;
  /** The step's title or the ask's question when it was logged (steps can be renamed or removed later). */
  label?: string;
  verified?: string;
  deviation?: string;
  answer?: string;
}

/** What the plan looked like when the coding agent last read it, for "what changed since". */
export interface BuildSnapshot {
  rev: number;
  at: string;
  /** How many log entries there were: what came after is new. */
  log: number;
  /** Decision key → cite and answer. */
  decisions: Record<string, { cite: string; answer: string }>;
  /** Section heading → a hash of its text. */
  sections: Record<string, string>;
  steps: { key: string; title: string; done: string }[];
}

export interface BuildState {
  /**
   * The plan's revision. It moves when the user's side changes the plan: an answered round, an edit
   * to the text, a step edited, moved, added, removed or reopened, an answered ask. The agent's own
   * reports (a step started or done, an ask made or withdrawn) don't move it.
   */
  rev: number;
  /** Counter for step keys. */
  seq: number;
  steps: BuildStep[];
  asks: BuildAsk[];
  log: BuildLogEntry[];
  seen?: BuildSnapshot;
}

export const MAX_STEPS = 30;
export const MAX_STEP_TITLE = 160;
export const MAX_DONE_CHECK = 400;
export const MAX_REPORT = 1000;
export const MAX_ASK_TITLE = 200;
export const MAX_ASK_BODY = 1000;
export const MAX_ASK_OPTIONS = 6;
export const MAX_OPTION_LABEL = 200;
export const MAX_OPTION_DESCRIPTION = 400;
export const MAX_ANSWER = 2000;
export const MAX_OPEN_ASKS = 6;
export const BUILD_STEPS_HEADING = "## Build steps";
export const BUILD_LOG_HEADING = "## Build log";
const KEY = /^[a-z0-9][a-z0-9-]{0,63}$/;

export class BuildError extends Error {}

export const emptyBuild = (): BuildState => ({ rev: 1, seq: 0, steps: [], asks: [], log: [] });

const one = (text: string, max: number) => text.replace(/\s+/g, " ").trim().slice(0, max);
const now = () => new Date().toISOString();

// ---------------------------------------------------------------- steps

/** Steps as the plan run wrote them. Unusable entries are dropped; at most MAX_STEPS are kept. */
export function cleanSteps(raw: { title?: unknown; done?: unknown }[] | undefined): { title: string; done: string }[] {
  const out: { title: string; done: string }[] = [];
  for (const r of raw ?? []) {
    const title = typeof r?.title === "string" ? one(r.title, MAX_STEP_TITLE) : "";
    if (!title) continue;
    out.push({ title, done: typeof r?.done === "string" ? one(r.done, MAX_DONE_CHECK) : "" });
    if (out.length >= MAX_STEPS) break;
  }
  return out;
}

/**
 * Put a newly written plan's steps on the build. A plan written again (after another round) keeps
 * the progress of every step whose title is unchanged; the rest start over as new steps.
 */
export function setSteps(b: BuildState, steps: { title: string; done: string }[]): void {
  const old = new Map(b.steps.map((s) => [s.title.toLowerCase(), s]));
  b.steps = cleanSteps(steps).map((s) => {
    const kept = old.get(s.title.toLowerCase());
    if (kept) {
      old.delete(s.title.toLowerCase());
      return { ...kept, title: s.title, done: s.done };
    }
    return { key: `step-${++b.seq}`, title: s.title, done: s.done, status: "todo" as const };
  });
}

export const stepNumber = (b: BuildState, key: string | undefined) => (key ? b.steps.findIndex((s) => s.key === key) + 1 : 0);

/** A step by its key or its number in the list ("3"). */
export function findStep(b: BuildState, ref: string | number | undefined): BuildStep {
  const r = String(ref ?? "").trim();
  const step = /^\d+$/.test(r) ? b.steps[Number(r) - 1] : b.steps.find((s) => s.key === r);
  if (!step) throw new BuildError(b.steps.length ? `There is no step "${r}". The plan has steps 1 to ${b.steps.length}.` : "This plan has no build steps.");
  return step;
}

/** The step to work on: one already started, else the first that isn't done, in the user's order. */
export const nextStep = (b: BuildState) => b.steps.find((s) => s.status === "started") ?? b.steps.find((s) => s.status !== "done") ?? null;

export function startStep(b: BuildState, ref: string | number): BuildStep {
  const step = findStep(b, ref);
  if (step.status === "done") throw new BuildError(`Step ${stepNumber(b, step.key)} is already done. The user can reopen it in Grillado.`);
  if (step.status !== "started") {
    step.status = "started";
    step.startedAt = now();
    b.log.push({ at: step.startedAt, kind: "started", step: step.key, label: step.title });
  }
  return step;
}

/** The agent reports a step done. It must say what it verified; a deviation is optional. */
export function finishStep(b: BuildState, ref: string | number, report: { verified?: string; deviation?: string }): BuildStep {
  const step = findStep(b, ref);
  const verified = one(report.verified ?? "", MAX_REPORT);
  if (!verified) throw new BuildError("Say what you verified: the checks you ran and what they showed. A step is not done without it.");
  const deviation = one(report.deviation ?? "", MAX_REPORT) || undefined;
  step.status = "done";
  step.doneAt = now();
  step.startedAt ??= step.doneAt;
  step.verified = verified;
  step.deviation = deviation;
  b.log.push({ at: step.doneAt, kind: "done", step: step.key, label: step.title, verified, ...(deviation ? { deviation } : {}) });
  return step;
}

/** The user reopens a step the agent marked done. Its log entry stays as history. */
export function reopenStep(b: BuildState, ref: string | number): BuildStep {
  const step = findStep(b, ref);
  if (step.status === "todo") return step;
  step.status = "todo";
  step.startedAt = step.doneAt = step.verified = step.deviation = undefined;
  b.log.push({ at: now(), kind: "reopened", step: step.key, label: step.title });
  b.rev++;
  return step;
}

export function editStep(b: BuildState, ref: string | number, patch: { title?: string; done?: string }): BuildStep {
  const step = findStep(b, ref);
  const title = patch.title === undefined ? step.title : one(patch.title, MAX_STEP_TITLE);
  if (!title) throw new BuildError("A step needs a title.");
  const done = patch.done === undefined ? step.done : one(patch.done, MAX_DONE_CHECK);
  if (title === step.title && done === step.done) return step;
  step.title = title;
  step.done = done;
  b.rev++;
  return step;
}

/** Move a step up (-1) or down (+1) one place. */
export function moveStep(b: BuildState, ref: string | number, by: -1 | 1): void {
  const i = b.steps.indexOf(findStep(b, ref));
  const j = i + by;
  if (j < 0 || j >= b.steps.length) return;
  [b.steps[i], b.steps[j]] = [b.steps[j], b.steps[i]];
  b.rev++;
}

export function addStep(b: BuildState, step: { title: string; done?: string }, after?: string): BuildStep {
  if (b.steps.length >= MAX_STEPS) throw new BuildError(`A plan holds at most ${MAX_STEPS} build steps.`);
  const title = one(step.title ?? "", MAX_STEP_TITLE);
  if (!title) throw new BuildError("A step needs a title.");
  const added: BuildStep = { key: `step-${++b.seq}`, title, done: one(step.done ?? "", MAX_DONE_CHECK), status: "todo" };
  const at = after ? b.steps.findIndex((s) => s.key === after) : -1;
  b.steps.splice(at >= 0 ? at + 1 : b.steps.length, 0, added);
  b.rev++;
  return added;
}

export function removeStep(b: BuildState, ref: string | number): void {
  const step = findStep(b, ref);
  b.steps = b.steps.filter((s) => s !== step);
  b.rev++;
}

// ---------------------------------------------------------------- asks

export const openAsks = (b: BuildState | undefined) => (b?.asks ?? []).filter((a) => a.state === "open");

export function findAsk(b: BuildState, key: string | undefined): BuildAsk {
  const ask = b.asks.find((a) => a.key === String(key ?? "").trim());
  if (!ask) throw new BuildError(`There is no ask "${key ?? ""}" on this plan.`);
  return ask;
}

export interface AskInput {
  key?: string;
  title?: string;
  body?: string;
  options?: { id?: string; label?: string; description?: string }[];
  recommended?: string;
  step?: string | number;
}

/** The agent asks a decision. The options are the agent's; the answer is only ever the user's. */
export function addAsk(b: BuildState, input: AskInput): BuildAsk {
  const key = String(input.key ?? "").trim();
  if (!KEY.test(key)) throw new BuildError('An ask needs a key in lowercase-kebab-case, like "ask-storage".');
  if (b.asks.some((a) => a.key === key)) throw new BuildError(`"${key}" was already asked on this plan. Use a new key, or wait for its answer.`);
  if (openAsks(b).length >= MAX_OPEN_ASKS) throw new BuildError(`${MAX_OPEN_ASKS} asks are already waiting for the user. Wait for an answer, or withdraw one you no longer need.`);
  const title = one(input.title ?? "", MAX_ASK_TITLE);
  if (!title) throw new BuildError("An ask needs the question, as its title.");
  const seen = new Set<string>();
  const options: AskOption[] = [];
  for (const o of input.options ?? []) {
    const id = String(o?.id ?? "").trim();
    const label = one(String(o?.label ?? ""), MAX_OPTION_LABEL);
    if (!KEY.test(id)) throw new BuildError('Each option needs a short id, like a="Keep waiting".');
    if (!label) throw new BuildError(`Option "${id}" needs a label.`);
    if (seen.has(id)) throw new BuildError(`Option id "${id}" is used twice.`);
    seen.add(id);
    const description = one(String(o?.description ?? ""), MAX_OPTION_DESCRIPTION);
    options.push({ id, label, ...(description ? { description } : {}) });
  }
  if (options.length < 2 || options.length > MAX_ASK_OPTIONS) throw new BuildError(`Give 2 to ${MAX_ASK_OPTIONS} options for the user to choose from.`);
  const recommended = String(input.recommended ?? "").trim() || undefined;
  if (recommended && !seen.has(recommended)) throw new BuildError(`The suggested option "${recommended}" is not one of the options.`);
  const step = input.step !== undefined && String(input.step).trim() ? findStep(b, input.step) : (b.steps.find((s) => s.status === "started") ?? undefined);
  const body = one(input.body ?? "", MAX_ASK_BODY) || undefined;
  const ask: BuildAsk = { key, title, ...(body ? { body } : {}), options, ...(recommended ? { recommended } : {}), ...(step ? { step: step.key } : {}), state: "open", askedAt: now() };
  b.asks.push(ask);
  b.log.push({ at: ask.askedAt, kind: "asked", ask: key, label: title, ...(step ? { step: step.key } : {}) });
  return ask;
}

/** The user's answer: one of the options, or their own words. */
export function answerAsk(b: BuildState, key: string, pick: { optionId?: string; text?: string }): BuildAsk {
  const ask = findAsk(b, key);
  if (ask.state !== "open") throw new BuildError(ask.state === "answered" ? "That was already answered." : "The agent withdrew that question.");
  const option = ask.options.find((o) => o.id === pick.optionId);
  const text = one(pick.text ?? "", MAX_ANSWER);
  if (!option && !text) throw new BuildError("Pick one of the options, or type your own answer.");
  ask.state = "answered";
  ask.endedAt = now();
  ask.answer = option ? option.label : text;
  if (option) ask.answerId = option.id;
  b.log.push({ at: ask.endedAt, kind: "answered", ask: ask.key, label: ask.title, answer: ask.answer, ...(ask.step ? { step: ask.step } : {}) });
  b.rev++;
  return ask;
}

/** The agent no longer needs the answer. A withdrawn ask is never a decision. */
export function withdrawAsk(b: BuildState, key: string, reason?: string): BuildAsk {
  const ask = findAsk(b, key);
  if (ask.state === "answered") throw new BuildError(`"${ask.key}" was already answered: ${ask.answer}`);
  if (ask.state === "withdrawn") return ask;
  ask.state = "withdrawn";
  ask.endedAt = now();
  const why = one(reason ?? "", 300);
  if (why) ask.reason = why;
  b.log.push({ at: ask.endedAt, kind: "withdrawn", ask: ask.key, label: ask.title });
  return ask;
}

/** The citation of a decision made during the build: `[B:ask-key]`, next to a round's `[R2:key]`. */
export const buildCite = (key: string) => `B:${key}`;

/** The line an answered ask adds under Implementation decisions. */
export function decisionBullet(b: BuildState, ask: BuildAsk): string {
  const n = stepNumber(b, ask.step);
  const q = ask.title.replace(/\s+/g, " ").replace(/[.:]+$/, "");
  const a = (ask.answer ?? "").replace(/\s+/g, " ").replace(/\.+$/, "");
  return `- ${q}${/[?!]$/.test(q) ? "" : ":"} ${a}. Decided during the build${n ? `, at step ${n}` : ""}. [${buildCite(ask.key)}]`;
}

/** Add a line to the end of the bullets under "## Implementation decisions" (the section is made when the plan has none). */
export function addDecisionLine(md: string, bullet: string): string {
  const lines = md.split("\n");
  const start = lines.findIndex((l) => /^##\s+Implementation decisions\s*$/i.test(l));
  if (start < 0) {
    const before = lines.findIndex((l) => /^##\s+(Testing decisions|Out of scope|Assumptions)/i.test(l));
    const block = ["## Implementation decisions", "", bullet, ""];
    if (before < 0) return [...trimEnd(lines), "", ...block].join("\n");
    return [...lines.slice(0, before), ...block, ...lines.slice(before)].join("\n");
  }
  let end = lines.findIndex((l, i) => i > start && /^##\s/.test(l));
  if (end < 0) end = lines.length;
  // After the section's own text and before the decision blocks Grillado adds at its end.
  let at = start + 1;
  let fence = false;
  let block = end;
  for (let i = start + 1; i < end; i++) {
    if (/^(`{3,}|~{3,})/.test(lines[i])) {
      if (!fence && /^`{3,}decision\b/.test(lines[i]) && block === end) block = i;
      fence = !fence;
      continue;
    }
    if (!fence && block === end && lines[i].trim()) at = i + 1;
  }
  const out = [...lines.slice(0, at), bullet, ...(lines[at]?.trim() ? [""] : []), ...lines.slice(at)];
  return out.join("\n");
}

function trimEnd(lines: string[]): string[] {
  const out = [...lines];
  while (out.length && !out.at(-1)!.trim()) out.pop();
  return out;
}

// ---------------------------------------------------------------- the plan file's appendix

const MARK: Record<StepStatus, string> = { todo: "[ ]", started: "[~]", done: "[x]" };
const text = (t: string | undefined) => (t ?? "").replace(/\s+/g, " ").trim();

/** "## Build steps" and "## Build log" for the plan file. Empty when the plan has no steps and nothing was logged. */
export function buildAppendix(b: BuildState | undefined): string[] {
  if (!b || (!b.steps.length && !b.log.length)) return [];
  const lines: string[] = [];
  if (b.steps.length) {
    lines.push(BUILD_STEPS_HEADING, "");
    b.steps.forEach((s, i) => {
      lines.push(`- ${MARK[s.status]} ${i + 1}. ${text(s.title)}${s.status === "started" ? " (started)" : ""}`);
      if (s.done) lines.push(`  Done when: ${text(s.done)}`);
    });
  }
  const log = logLines(b);
  if (log.length) lines.push(...(lines.length ? [""] : []), BUILD_LOG_HEADING, "", ...log);
  return lines;
}

/** The log as the file shows it: what each step's report said, and how each ask ended. Starts and asks still open aren't listed. */
function logLines(b: BuildState): string[] {
  const out: string[] = [];
  for (const e of b.log) {
    const n = stepNumber(b, e.step);
    const step = n ? `Step ${n}` : `Step “${text(e.label)}”`;
    if (e.kind === "done") {
      out.push(`- ${step} done. Verified: ${text(e.verified)}`);
      if (e.deviation) out.push(`  Deviation: ${text(e.deviation)}`);
    } else if (e.kind === "reopened") out.push(`- ${step} reopened by you.`);
    else if (e.kind === "answered") out.push(`- Ask \`${e.ask}\` answered: “${text(e.answer)}” [${buildCite(e.ask ?? "")}]`);
    else if (e.kind === "withdrawn") out.push(`- Ask \`${e.ask}\` withdrawn by the agent: “${text(e.label)}”`);
  }
  return out;
}

/** Where the appendix starts in the file: a comment line, so the text before it comes back byte for byte. */
export const BUILD_MARKER = "<!-- grillado:build -->";

/** Cut the two sections out of `md` by their headings; everything else stays. */
function cutSections(md: string): { text: string; cut: boolean } {
  const lines = md.split("\n");
  const out: string[] = [];
  let skip = false;
  let fence = false;
  for (const l of lines) {
    if (/^(`{3,}|~{3,})/.test(l)) fence = !fence;
    if (!fence && /^##\s/.test(l)) skip = l.trim() === BUILD_STEPS_HEADING || l.trim() === BUILD_LOG_HEADING;
    if (!skip) out.push(l);
  }
  return { text: out.join("\n"), cut: out.length !== lines.length };
}

/**
 * The plan text without the appendix. With the marker line the text before it is returned exactly
 * as it was written; anything a person added after the appendix is kept. A file whose marker was
 * removed by hand still loses the two sections, by their headings.
 */
export function stripBuildAppendix(md: string): string {
  const at = md.indexOf(`\n${BUILD_MARKER}`);
  if (at < 0) {
    const { text, cut } = cutSections(md);
    return cut ? `${trimEnd(text.split("\n")).join("\n")}\n` : md;
  }
  const head = md.slice(0, at);
  const rest = cutSections(md.slice(at + BUILD_MARKER.length + 1)).text.trim();
  return rest ? `${head}\n${rest}\n` : head;
}

/** The plan file: the text, the marker, then the appendix. */
export function withBuildAppendix(md: string, b: BuildState | undefined): string {
  const body = stripBuildAppendix(md);
  const appendix = buildAppendix(b);
  if (!appendix.length) return body;
  return `${body}\n${BUILD_MARKER}\n\n${appendix.join("\n")}\n`;
}

// ---------------------------------------------------------------- what changed since the agent last read

/** A short, stable hash of text (djb2), enough to tell a section was edited. */
function hash(t: string): string {
  let h = 5381;
  for (let i = 0; i < t.length; i++) h = ((h << 5) + h + t.charCodeAt(i)) | 0;
  return (h >>> 0).toString(36);
}

/** Section heading → hash of its text, from the plan text (decision blocks left out: decisions are compared on their own). */
export function sectionHashes(md: string): Record<string, string> {
  const out: Record<string, string> = {};
  let name = "";
  let buf: string[] = [];
  let fence = false;
  let decision = false;
  const flush = () => {
    if (name) out[name] = hash(buf.join("\n").replace(/\s+/g, " ").trim());
    buf = [];
  };
  for (const l of stripBuildAppendix(md).split("\n")) {
    if (/^(`{3,}|~{3,})/.test(l)) {
      if (!fence) decision = /^`{3,}decision\b/.test(l);
      else if (decision) {
        fence = false;
        decision = false;
        continue;
      }
      fence = !fence;
    }
    if (fence && decision) continue;
    if (!fence && /^##\s/.test(l)) {
      flush();
      name = l.replace(/^##\s+/, "").trim();
      continue;
    }
    buf.push(l);
  }
  flush();
  return out;
}

export interface PlanFacts {
  markdown: string;
  decisions: { key: string; round: number; answer: string }[];
}

export function snapshot(b: BuildState, plan: PlanFacts): BuildSnapshot {
  const decisions: BuildSnapshot["decisions"] = {};
  for (const d of plan.decisions) decisions[d.key] = { cite: `R${d.round}:${d.key}`, answer: d.answer };
  for (const a of b.asks) if (a.state === "answered") decisions[buildCite(a.key)] = { cite: buildCite(a.key), answer: a.answer ?? "" };
  return { rev: b.rev, at: now(), log: b.log.length, decisions, sections: sectionHashes(plan.markdown), steps: b.steps.map((s) => ({ key: s.key, title: s.title, done: s.done })) };
}

/**
 * What changed in the plan since `seen`, one line each: decisions first, then sections, then steps.
 * Empty when the revision hasn't moved (or the agent never read the plan: there is nothing to compare).
 */
export function changesSince(seen: BuildSnapshot | undefined, b: BuildState, plan: PlanFacts): string[] {
  if (!seen || seen.rev === b.rev) return [];
  const cur = snapshot(b, plan);
  const out: string[] = [];
  for (const [key, d] of Object.entries(cur.decisions)) {
    const was = seen.decisions[key];
    if (!was) out.push(`+ decision [${d.cite}] ${d.answer}`);
    else if (was.answer !== d.answer) out.push(`~ decision [${d.cite}] changed: ${was.answer} -> ${d.answer}`);
  }
  for (const [key, d] of Object.entries(seen.decisions)) if (!cur.decisions[key]) out.push(`- decision [${d.cite}] reopened or removed`);
  for (const [name, h] of Object.entries(cur.sections)) {
    if (!(name in seen.sections)) out.push(`+ section "${name}"`);
    else if (seen.sections[name] !== h) out.push(`~ section "${name}" edited`);
  }
  for (const name of Object.keys(seen.sections)) if (!(name in cur.sections)) out.push(`- section "${name}" removed`);
  const was = new Map(seen.steps.map((s, i) => [s.key, { ...s, i }]));
  const order: string[] = [];
  cur.steps.forEach((s, i) => {
    const o = was.get(s.key);
    if (!o) out.push(`+ step ${i + 1} "${s.title}"`);
    else {
      if (o.title !== s.title || o.done !== s.done) out.push(`~ step ${i + 1} edited: "${s.title}"`);
      order.push(s.key);
    }
  });
  const keys = new Set(cur.steps.map((s) => s.key));
  for (const s of seen.steps) if (!keys.has(s.key)) out.push(`- step "${s.title}" removed`);
  const before = seen.steps.map((s) => s.key).filter((k) => keys.has(k));
  if (before.join() !== order.join()) out.push("~ steps reordered");
  for (const e of b.log.slice(seen.log ?? b.log.length)) if (e.kind === "reopened") out.push(`~ step ${stepNumber(b, e.step) || `"${e.label}"`} reopened by the user`);
  return out.length ? out : ["~ the plan was edited"];
}
