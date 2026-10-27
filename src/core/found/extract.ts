// v1.3 item 1, "Found in this project": turn one source file (a Claude Code or Codex transcript, a
// Cursor plan or a plan-shaped Markdown file) into a small, plain Extract: the opening idea, the
// answered questions and the plan text. Pure (text in, data out), so the scanner can cache it and
// the tests can feed it fixtures. These formats are internal to each tool and change between
// versions: a malformed line is skipped, an unknown record type is ignored, nothing is fatal.
import { BANNED_TERMS } from "../filter.ts";
import { textHash } from "../text-hash.ts";

export type SourceApp = "claude" | "codex" | "cursor" | "file";

export interface QAOption {
  label: string;
  description: string;
  /** Marked "(Recommended)" (or similar) by the agent. */
  recommended: boolean;
}

export interface QA {
  /** One structured ask (AskUserQuestion / request_user_input call) is one round. */
  call: number;
  header: string;
  question: string;
  options: QAOption[];
  /** The picked label(s), or the user's free text. Absent when the question went unanswered. */
  answer?: string;
}

export interface Extract {
  app: SourceApp;
  kind: "session" | "plan";
  sessionId?: string;
  /** Where the session ran (transcripts only). */
  cwd?: string;
  branch?: string;
  /** Last activity in the source (ISO); falls back to the file's mtime. */
  date?: string;
  idea: string;
  title: string;
  qa: QA[];
  plan?: { title?: string; markdown: string };
  /** Claude plan-mode files the transcript wrote or named (only under the user's plans folder). */
  planRefs: string[];
  /** ```decision blocks in a plan file (the "n decisions" count). */
  decisions: number;
  /**
   * Why it shows in Found: "structured" (≥ 3 answered structured questions, or a plan file),
   * "freetext" (an interview in plain turns, case b: needs an agent run to import), or null.
   */
  qualifies: "structured" | "freetext" | null;
  /** Part of the session was compacted away; what's left is imported and the plan says so. */
  compacted: boolean;
  /** The opening idea came from the compaction summary, since the first prompt is gone. */
  ideaFromSummary: boolean;
  /** Lines that couldn't be parsed (a torn last line, a cut file). */
  skipped: number;
  /** Read only up to the byte budget. */
  truncated: boolean;
}

/** Hash of what an import copies: a source whose hash changes offers Update. */
export function contentHash(x: Pick<Extract, "idea" | "qa" | "plan">): string {
  return textHash(JSON.stringify([x.idea, x.qa.map((q) => [q.question, q.answer ?? null]), x.plan?.markdown ?? null]));
}

// ---------------------------------------------------------------- shared helpers

function jsonl(text: string): { records: any[]; skipped: number } {
  const records: any[] = [];
  let skipped = 0;
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    try {
      const v = JSON.parse(line);
      if (v && typeof v === "object") records.push(v);
      else skipped++;
    } catch {
      skipped++;
    }
  }
  return { records, skipped };
}

const RECOMMENDED = /\s*[([]?\s*(recommended|suggested|my pick)\s*[)\]]?\s*$/i;
const recommendedLabel = (label: string) => RECOMMENDED.test(label);
export const cleanLabel = (label: string) => label.replace(RECOMMENDED, "").trim() || label.trim();

/** Plan-shaped H2s (spec v1.3 item 1). */
const PLAN_H2 = /^(problem|goals?|solution|user stories|requirements|(implementation )?decisions|acceptance criteria|out of scope|tasks|milestones|open questions)\b/i;
export function planH2s(md: string): number {
  const seen = new Set<string>();
  for (const m of md.matchAll(/^##\s+(.+?)\s*#*\s*$/gm)) {
    const h = m[1].replace(/^[\d.)\s]+/, "").trim();
    const k = PLAN_H2.exec(h)?.[1]?.toLowerCase().replace(/^implementation /, "").replace(/s$/, "");
    if (k) seen.add(k);
  }
  return seen.size;
}
const firstH1 = (md: string) => /^#\s+(.+?)\s*#*\s*$/m.exec(md)?.[1]?.trim();

/** A title for a row: the plan name, the first H1, or the opening idea cut to 80 characters on a word. */
export function titleFrom(...candidates: (string | undefined)[]): string {
  for (const c of candidates) {
    const t = (c ?? "").replace(/\s+/g, " ").trim();
    if (!t) continue;
    if (t.length <= 80) return t;
    const cut = t.slice(0, 80);
    const sp = cut.lastIndexOf(" ");
    return `${(sp > 40 ? cut.slice(0, sp) : cut).replace(/[\s,.;:–-]+$/, "")}…`;
  }
  return "Untitled session";
}

/**
 * The user's opening words without the slash command or skill call that started the session
 * ("/plan-it a recipe app" → "a recipe app"). Claude Code wraps commands in <command-*> tags.
 */
export function stripInvocation(text: string): string {
  let t = text;
  const args = /<command-args>([\s\S]*?)<\/command-args>/.exec(t);
  if (/<command-name>/.test(t)) t = args ? args[1] : "";
  t = t.replace(/<command-(message|name|args)>[\s\S]*?<\/command-\1>/g, "");
  t = t.replace(/^\s*[/$][\w:.-]+(\s+|$)/, "");
  return t.trim();
}

/** Text a tool injected into the user's turn (skill bodies, environment blocks, caveats), not the user's own words. */
const injected = (t: string) =>
  /^\s*(<(local-command-|environment_context|user_instructions|system-reminder|command-stdout)|Base directory for this skill:|# AGENTS\.md instructions|Caveat: )/i.test(t);

/** A user turn asking to be interviewed or questioned about a plan (case b). */
const ASKS_INTERVIEW = /\b(interview me|question me|quiz me|ask me (some |a few |more )?questions|grill me|challenge (my|the) plan|poke holes)\b/i;
/** The skill names that count as a planning or interview method (server-side only, never sent to the browser). */
const INTERVIEW_SKILL = new RegExp(`(^|[\\s/$:"'])(${[BANNED_TERMS[0], "interview", "plan(ning)?", "prd", "spec"].join("|")})([\\s:"'-]|$)`, "i");

const WRITE_TOOLS = /^(Write|Edit|MultiEdit|NotebookEdit|apply_patch|write_file|edit_file|shell)$/;

interface Turn {
  role: "user" | "assistant";
  text: string;
}

/** Case (b): ≥ 4 assistant turns that end on one question, each answered in < 400 chars with no write in between. */
function freeTextTurns(turns: (Turn | { role: "tool"; write: boolean })[]): number {
  let n = 0;
  for (let i = 0; i < turns.length; i++) {
    const a = turns[i];
    if (a.role !== "assistant") continue;
    const t = a.text.trim();
    if (!t.endsWith("?") || (t.match(/\?/g)?.length ?? 0) > 2) continue;
    let wrote = false;
    for (let j = i + 1; j < turns.length; j++) {
      const b = turns[j];
      if (b.role === "tool") {
        wrote ||= b.write;
        continue;
      }
      if (b.role === "user") {
        if (!wrote && b.text.trim().length > 0 && b.text.trim().length < 400) n++;
        break;
      }
      if (b.role === "assistant" && b.text.trim()) break;
    }
  }
  return n;
}

function qualify(qa: QA[], turns: Parameters<typeof freeTextTurns>[0], invoked: boolean, asked: boolean): Extract["qualifies"] {
  if (qa.filter((q) => q.answer !== undefined).length >= 3) return "structured";
  if ((invoked || asked) && freeTextTurns(turns) >= 4) return "freetext";
  return null;
}

const contentText = (c: unknown): string =>
  typeof c === "string" ? c : Array.isArray(c) ? c.map((x) => (typeof x === "string" ? x : x?.type === "text" || x?.type === "input_text" || x?.type === "output_text" ? String(x.text ?? "") : "")).join("") : "";

function parseOptions(raw: unknown): QAOption[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .map((o) => (typeof o === "string" ? { label: o, description: "" } : { label: String(o?.label ?? ""), description: String(o?.description ?? "") }))
    .filter((o) => o.label.trim())
    .map((o) => ({ label: cleanLabel(o.label), description: o.description, recommended: recommendedLabel(o.label) || /\(recommended\)/i.test(o.description) }));
}

// ---------------------------------------------------------------- Claude Code

/**
 * `~/.claude/projects/<dir>/<session>.jsonl`. Q&A from AskUserQuestion (assistant tool_use) paired
 * by tool_use_id with the user's tool_result and its top-level `toolUseResult.answers`. A plan from
 * ExitPlanMode `input.plan`, or a file under `plansDir` the session wrote or named.
 */
export function parseClaude(text: string, opts: { plansDir?: string; truncated?: boolean } = {}): Extract {
  const { records, skipped } = jsonl(text);
  const asks = new Map<string, QA[]>();
  const qa: QA[] = [];
  const turns: Parameters<typeof freeTextTurns>[0] = [];
  const planRefs = new Set<string>();
  let idea = "";
  let summary = "";
  let compacted = false;
  let sessionId: string | undefined;
  let cwd: string | undefined;
  let branch: string | undefined;
  let date: string | undefined;
  let plan: string | undefined;
  let invoked = false;
  let asked = false;
  let call = 0;
  const refRe = opts.plansDir ? new RegExp(`${opts.plansDir.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}/[\\w.-]+\\.md`, "g") : null;
  const noteRefs = (s: string) => {
    if (refRe) for (const m of s.matchAll(refRe)) planRefs.add(m[0]);
  };
  for (const r of records) {
    if (typeof r.sessionId === "string") sessionId ??= r.sessionId;
    if (typeof r.cwd === "string") cwd ??= r.cwd;
    if (typeof r.gitBranch === "string" && r.gitBranch) branch = r.gitBranch;
    if (typeof r.timestamp === "string") date = r.timestamp;
    if (r.type === "summary" || (r.type === "system" && r.subtype === "compact_boundary")) {
      compacted = true;
      if (r.type === "summary" && typeof r.summary === "string") summary ||= r.summary;
      continue;
    }
    const msg = r.message;
    if (!msg || (r.type !== "user" && r.type !== "assistant")) continue;
    const content = Array.isArray(msg.content) ? msg.content : [{ type: "text", text: String(msg.content ?? "") }];
    if (r.type === "user") {
      if (r.isCompactSummary) {
        compacted = true;
        summary ||= contentText(msg.content);
        continue;
      }
      for (const c of content) {
        if (c?.type !== "tool_result") continue;
        const qs = asks.get(String(c.tool_use_id));
        if (!qs) continue;
        const answers = r.toolUseResult?.answers;
        for (const q of qs) {
          const a = answers && typeof answers === "object" ? answers[q.question] : undefined;
          if (typeof a === "string" && a.trim()) q.answer = a.trim();
          else if (Array.isArray(a) && a.length) q.answer = a.map(String).join(", ");
        }
        asks.delete(String(c.tool_use_id));
      }
      if (r.isMeta) continue; // skill bodies and other text the tool injected
      const t = content.filter((c: any) => c?.type === "text").map((c: any) => String(c.text ?? "")).join("\n");
      if (!t.trim() || injected(t)) continue;
      if (/<command-name>/.test(t) || /^\s*\/[\w:.-]+/.test(t)) invoked ||= INTERVIEW_SKILL.test(/<command-name>([\s\S]*?)<\/command-name>/.exec(t)?.[1] ?? t.split(/\s/)[0]);
      asked ||= ASKS_INTERVIEW.test(t);
      const own = stripInvocation(t);
      if (!idea && own) idea = own;
      noteRefs(t);
      turns.push({ role: "user", text: own });
      continue;
    }
    for (const c of content) {
      if (c?.type === "text") {
        turns.push({ role: "assistant", text: String(c.text ?? "") });
        noteRefs(String(c.text ?? ""));
      } else if (c?.type === "tool_use") {
        const name = String(c.name ?? "");
        if (name === "AskUserQuestion" && Array.isArray(c.input?.questions)) {
          call++;
          const qs = c.input.questions
            .filter((q: any) => typeof q?.question === "string")
            .map((q: any) => ({ call, header: String(q.header ?? ""), question: q.question.trim(), options: parseOptions(q.options) }));
          asks.set(String(c.id), qs);
          qa.push(...qs);
        } else if (name === "ExitPlanMode" && typeof c.input?.plan === "string") plan = c.input.plan;
        else if (name === "Skill" || name === "SlashCommand") invoked ||= INTERVIEW_SKILL.test(JSON.stringify(c.input ?? ""));
        const file = c.input?.file_path;
        if (typeof file === "string" && opts.plansDir && file.startsWith(`${opts.plansDir}/`) && file.endsWith(".md")) planRefs.add(file);
        turns.push({ role: "tool", write: WRITE_TOOLS.test(name) && !(typeof file === "string" && opts.plansDir && file.startsWith(`${opts.plansDir}/`)) });
      }
    }
  }
  const ideaFromSummary = !idea && !!summary;
  if (!idea) idea = summary.split("\n").find((l) => l.trim())?.trim() ?? "";
  return finish({ app: "claude", sessionId, cwd, branch, date, idea, qa, turns, invoked, asked, plan, planRefs: [...planRefs], compacted, ideaFromSummary, skipped, truncated: !!opts.truncated });
}

function finish(p: {
  app: SourceApp;
  sessionId?: string;
  cwd?: string;
  branch?: string;
  date?: string;
  idea: string;
  qa: QA[];
  turns: Parameters<typeof freeTextTurns>[0];
  invoked: boolean;
  asked: boolean;
  plan?: string;
  planRefs: string[];
  compacted: boolean;
  ideaFromSummary: boolean;
  skipped: number;
  truncated: boolean;
}): Extract {
  const plan = p.plan?.trim() ? { title: firstH1(p.plan), markdown: p.plan.trim() } : undefined;
  return {
    app: p.app,
    kind: "session",
    sessionId: p.sessionId,
    cwd: p.cwd,
    branch: p.branch,
    date: p.date,
    idea: p.idea,
    title: titleFrom(plan?.title, p.idea),
    qa: p.qa,
    plan,
    planRefs: p.planRefs,
    decisions: 0,
    qualifies: qualify(p.qa, p.turns, p.invoked, p.asked),
    compacted: p.compacted,
    ideaFromSummary: p.ideaFromSummary,
    skipped: p.skipped,
    truncated: p.truncated,
  };
}

// ---------------------------------------------------------------- Codex

/** The first line of a rollout: `{type: "session_meta", payload: {id, cwd, git: {branch}}}`. */
export function codexMeta(firstLine: string): { id?: string; cwd?: string; branch?: string } | null {
  try {
    const r = JSON.parse(firstLine);
    if (r?.type !== "session_meta" || typeof r.payload?.cwd !== "string") return null;
    return { id: r.payload.id, cwd: r.payload.cwd, branch: r.payload.git?.branch };
  } catch {
    return null;
  }
}

const parseArgs = (v: unknown) => {
  if (typeof v !== "string") return v;
  try {
    return JSON.parse(v);
  } catch {
    return null;
  }
};

/** One answer from request_user_input's output, which has changed shape between versions. */
function codexAnswer(v: unknown): string | undefined {
  if (typeof v === "string") return v.trim() || undefined;
  if (Array.isArray(v)) return v.map(codexAnswer).filter(Boolean).join(", ") || undefined;
  if (v && typeof v === "object") {
    const o = v as any;
    return codexAnswer(o.answers ?? o.answer ?? o.selected ?? o.label ?? o.text ?? o.value);
  }
  return undefined;
}

/**
 * `~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl`. Q&A from the `request_user_input` function call
 * and its `function_call_output` with the same call_id. Codex keeps the plan in the conversation:
 * the last plan-shaped assistant message (or a <proposed_plan> block) is the plan.
 */
export function parseCodex(text: string, opts: { truncated?: boolean } = {}): Extract {
  const { records, skipped } = jsonl(text);
  const asks = new Map<string, { ids: string[]; qs: QA[] }>();
  const qa: QA[] = [];
  const turns: Parameters<typeof freeTextTurns>[0] = [];
  let idea = "";
  let summary = "";
  let compacted = false;
  let meta: ReturnType<typeof codexMeta> = null;
  let date: string | undefined;
  let plan: string | undefined;
  let invoked = false;
  let asked = false;
  let call = 0;
  for (const r of records) {
    if (typeof r.timestamp === "string") date = r.timestamp;
    if (r.type === "session_meta") {
      meta ??= codexMeta(JSON.stringify(r));
      continue;
    }
    if (r.type === "compacted") {
      compacted = true;
      summary ||= String(r.payload?.message ?? "");
      continue;
    }
    if (r.type !== "response_item") continue;
    const p = r.payload ?? {};
    if (p.type === "message" && (p.role === "user" || p.role === "assistant")) {
      const t = contentText(p.content);
      if (!t.trim() || (p.role === "user" && injected(t))) continue;
      if (p.role === "user") {
        if (/^\s*[/$][\w:.-]+/.test(t)) invoked ||= INTERVIEW_SKILL.test(t.trim().split(/\s/)[0]);
        asked ||= ASKS_INTERVIEW.test(t);
        const own = stripInvocation(t);
        if (!idea && own) idea = own;
        turns.push({ role: "user", text: own });
      } else {
        turns.push({ role: "assistant", text: t });
        const proposed = /<proposed_plan>([\s\S]*?)<\/proposed_plan>/.exec(t)?.[1];
        if (proposed) plan = proposed;
        else if (planH2s(t) >= 3) plan = t;
      }
    } else if (p.type === "function_call") {
      const name = String(p.name ?? "");
      if (name === "request_user_input") {
        const args = parseArgs(p.arguments) as any;
        if (Array.isArray(args?.questions)) {
          call++;
          const list = args.questions.filter((q: any) => typeof q?.question === "string");
          const qs = list.map((q: any) => ({ call, header: String(q.header ?? ""), question: q.question.trim(), options: parseOptions(q.options) }));
          asks.set(String(p.call_id), { ids: list.map((q: any, i: number) => String(q.id ?? i)), qs });
          qa.push(...qs);
        }
      }
      turns.push({ role: "tool", write: WRITE_TOOLS.test(name) });
    } else if (p.type === "function_call_output") {
      const ask = asks.get(String(p.call_id));
      if (!ask) continue;
      const out = parseArgs(typeof p.output === "string" ? p.output : (p.output?.content ?? p.output)) as any;
      const answers = out?.answers ?? out;
      ask.qs.forEach((q, i) => {
        const a = Array.isArray(answers) ? answers[i] : answers?.[ask.ids[i]] ?? answers?.[q.question];
        const v = codexAnswer(a);
        if (v) q.answer = v;
      });
      asks.delete(String(p.call_id));
    } else if (p.type === "local_shell_call" || p.type === "custom_tool_call") {
      turns.push({ role: "tool", write: true });
    }
  }
  const ideaFromSummary = !idea && !!summary;
  if (!idea) idea = summary.split("\n").find((l) => l.trim())?.trim() ?? "";
  return finish({ app: "codex", sessionId: meta?.id, cwd: meta?.cwd, branch: meta?.branch, date, idea, qa, turns, invoked, asked, plan, planRefs: [], compacted, ideaFromSummary, skipped, truncated: !!opts.truncated });
}

// ---------------------------------------------------------------- plan files

/** Cursor `.plan.md` frontmatter: `name`, `overview`, `todos[] {id, content, status}`. A small YAML subset. */
export function cursorFrontmatter(text: string): { name: string; overview: string; todos: { content: string; status?: string }[]; body: string } | null {
  const m = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(text);
  if (!m) return null;
  const unq = (v: string) => {
    const t = v.trim();
    return /^(["']).*\1$/.test(t) ? t.slice(1, -1) : t;
  };
  let name = "";
  let overview = "";
  const todos: { content: string; status?: string }[] = [];
  let inTodos = false;
  for (const line of m[1].split(/\r?\n/)) {
    const top = /^([A-Za-z_]\w*):\s*(.*)$/.exec(line);
    if (top) {
      inTodos = top[1] === "todos";
      if (top[1] === "name") name = unq(top[2]);
      if (top[1] === "overview") overview = unq(top[2]);
      continue;
    }
    if (!inTodos) continue;
    const item = /^\s*-\s*(\w+):\s*(.*)$/.exec(line);
    if (item) todos.push({ content: "" });
    const kv = item ?? /^\s+(\w+):\s*(.*)$/.exec(line);
    if (kv && todos.length) {
      const t = todos[todos.length - 1];
      if (kv[1] === "content") t.content = unq(kv[2]);
      if (kv[1] === "status") t.status = unq(kv[2]);
    }
  }
  if (!name) return null;
  return { name, overview, todos: todos.filter((t) => t.content), body: text.slice(m[0].length) };
}

const NEVER = /^(readme|changelog|contributing|license|licence|code_of_conduct|security)(\.|$)/i;
const PLAN_DIRS = /(^|\/)(docs\/plans|plans|docs\/prd|\.cursor\/plans|\.claude\/plans)\//;
const PLAN_NAMES = /(^|\/)(PLAN\.md|plan[^/]*\.md|PRD[^/]*\.md|prd[^/]*\.md|SPEC\.md|RFC[^/]*\.md|[^/]+\.plan\.md)$/;

/** Is this repo-relative path worth reading as a plan file? */
export const isPlanCandidate = (rel: string) => rel.endsWith(".md") && !NEVER.test(rel.split("/").pop()!) && (PLAN_NAMES.test(rel) || PLAN_DIRS.test(rel));

/** A Grillado export (`grillado-plan-<session id>.md`) links to its plan instead of importing again. */
export const exportedPlanId = (rel: string) => /(^|\/)grillado-plan-([\w-]+)\.md$/.exec(rel)?.[2] ?? null;

/** A plan file qualifies when it's a `.plan.md` with valid frontmatter or has ≥ 3 plan-shaped H2s. */
export function parsePlanFile(rel: string, text: string, app: SourceApp = rel.endsWith(".plan.md") ? "cursor" : "file"): Extract | null {
  if (!isPlanCandidate(rel) && app !== "cursor") return null;
  const fm = rel.endsWith(".plan.md") ? cursorFrontmatter(text) : null;
  let markdown: string;
  let title: string | undefined;
  if (fm) {
    title = fm.name;
    const parts = [`# ${fm.name}`, ""];
    if (fm.overview) parts.push(fm.overview, "");
    const body = fm.body.replace(/^\s*#\s+.*\n/, "").trim();
    if (body) parts.push(body, "");
    if (fm.todos.length) parts.push("## Tasks", "", ...fm.todos.map((t) => `- [${t.status === "completed" ? "x" : " "}] ${t.content}`), "");
    markdown = parts.join("\n").trim();
  } else {
    if (planH2s(text) < 3) return null;
    markdown = text.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/, "").trim();
    title = firstH1(markdown);
  }
  const name = rel.split("/").pop()!.replace(/(\.plan)?\.md$/, "").replace(/[-_]+/g, " ");
  return {
    app,
    kind: "plan",
    idea: fm?.overview || title || name,
    title: titleFrom(title, name),
    qa: [],
    plan: { title: title ?? titleFrom(name), markdown },
    planRefs: [],
    decisions: (markdown.match(/^```decision\s*$/gm) ?? []).length,
    qualifies: "structured",
    compacted: false,
    ideaFromSummary: false,
    skipped: 0,
    truncated: false,
  };
}

/** Paths a home-folder Cursor plan mentions, to tell which project it belongs to. */
export function mentionedPaths(text: string): string[] {
  const out = new Set<string>();
  for (const m of text.matchAll(/(?:^|[\s`'"(\[])((?:\.{0,2}\/)?[\w@.-]+(?:\/[\w@.-]+)*\.\w{1,8}|[\w@.-]+(?:\/[\w@.-]+)+\/?)(?=$|[\s`'")\],:;])/gm)) {
    const p = m[1].replace(/^\.\//, "").replace(/\/$/, "");
    if (p && !p.startsWith("..") && !/^https?:/.test(p) && !/^\d+(\.\d+)+$/.test(p)) out.add(p);
  }
  return [...out];
}
