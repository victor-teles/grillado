// Fenced ```decision blocks in plan.md (v1.1, Q3): a small, flat `name: value` format that any
// agent or editor can read. DOM-free and shared by the server (writes them) and the web editor
// (renders, validates and edits them).
//
//   ```decision
//   id: R3·1
//   key: merge
//   question: How should two edits to the same item merge?
//   answer: Merge per item
//   by: you
//   kept_suggestion: false
//   at: 2026-10-22T21:14-03:00
//   ```
//
// `key` is the question id that `[R3:merge]` citations use (AC16). Unknown names are kept as-is.

export interface DecisionFields {
  id: string;
  key?: string;
  question: string;
  answer?: string;
  note?: string;
  by?: "you" | "agent";
  kept_suggestion?: boolean;
  at?: string;
  status?: "open";
}

export interface DecisionEntry {
  name: string;
  value: string;
  /** 0-based line inside the block body. */
  line: number;
}

export type DecisionParse =
  | { ok: true; fields: DecisionFields; entries: DecisionEntry[] }
  | { ok: false; /** 0-based line inside the body; -1 means the opening fence. */ line: number; message: string; entries: DecisionEntry[] };

const LINE = /^([A-Za-z_][\w-]*)\s*:\s?(.*)$/;
// Round ids (R3·1) or a decision you added yourself (U1, item 4; never collides with a round).
const ID = /^(R\d+[·.:]\S+|U\d+)$/;
const KNOWN = ["id", "key", "question", "answer", "note", "by", "kept_suggestion", "at", "status"];

const unquote = (v: string) => {
  const t = v.trim();
  return t.length >= 2 && ((t[0] === '"' && t.at(-1) === '"') || (t[0] === "'" && t.at(-1) === "'")) ? t.slice(1, -1) : t;
};

/** Parse and validate one block body (the lines between the fences). Messages are plain language. */
export function parseDecisionBody(body: string): DecisionParse {
  const entries: DecisionEntry[] = [];
  const lines = body.split("\n");
  const seen = new Map<string, number>();
  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i].replace(/\r$/, "");
    if (!raw.trim() || raw.trimStart().startsWith("#")) continue;
    const m = LINE.exec(raw);
    if (!m) return { ok: false, line: i, message: `each line needs a name, a colon and a value, like “answer: Merge per item”.`, entries };
    const name = m[1];
    if (seen.has(name)) return { ok: false, line: i, message: `“${name}” is set twice.`, entries };
    seen.set(name, i);
    entries.push({ name, value: unquote(m[2]), line: i });
  }
  const get = (n: string) => entries.find((e) => e.name === n);
  const id = get("id");
  if (!id || !id.value) return { ok: false, line: id?.line ?? -1, message: "the block needs an id, like “id: R3·1”.", entries };
  if (!ID.test(id.value)) return { ok: false, line: id.line, message: `the id should look like R3·1 or U1, not “${id.value}”.`, entries };
  const question = get("question");
  if (!question || !question.value) return { ok: false, line: question?.line ?? -1, message: "the block needs a question.", entries };
  const status = get("status");
  if (status && status.value && status.value !== "open") return { ok: false, line: status.line, message: "“status” can only be “open”.", entries };
  const answer = get("answer");
  const open = status?.value === "open";
  if (!open && (!answer || !answer.value)) return { ok: false, line: answer?.line ?? -1, message: "the block needs an answer, or “status: open”.", entries };
  const kept = get("kept_suggestion");
  if (kept && kept.value !== "true" && kept.value !== "false") return { ok: false, line: kept.line, message: "“kept_suggestion” must be true or false.", entries };
  const by = get("by");
  if (by && by.value !== "you" && by.value !== "agent") return { ok: false, line: by.line, message: "“by” must be you or agent.", entries };
  const at = get("at");
  if (at && at.value && Number.isNaN(Date.parse(at.value))) return { ok: false, line: at.line, message: "“at” must be a date and time, like 2026-10-22T21:14-03:00.", entries };
  const key = get("key");
  if (key && !/^[^\s\],]+$/.test(key.value)) return { ok: false, line: key.line, message: "“key” can't contain spaces, commas or ].", entries };
  return {
    ok: true,
    entries,
    fields: {
      id: id.value,
      key: key?.value || undefined,
      question: question.value,
      answer: answer?.value || undefined,
      note: get("note")?.value || undefined,
      by: (by?.value as "you" | "agent") || undefined,
      kept_suggestion: kept ? kept.value === "true" : undefined,
      at: at?.value || undefined,
      status: open ? "open" : undefined,
    },
  };
}

const clean = (v: string) => v.replace(/[\r\n]+/g, " ").trim();

/** A whole fenced block, fields in the canonical order. */
export function serializeDecision(f: DecisionFields & Record<string, unknown>): string {
  const out = ["```decision"];
  const order = [...KNOWN, ...Object.keys(f).filter((k) => !KNOWN.includes(k))];
  for (const k of order) {
    const v = f[k];
    if (v === undefined || v === null || v === "") continue;
    out.push(`${k}: ${clean(String(v))}`);
  }
  out.push("```");
  return out.join("\n");
}

/** A fenced ```decision block located in a Markdown document (offsets cover both fences). */
export interface DecisionBlockRef {
  start: number;
  end: number;
  bodyStart: number;
  /** 0-based line of the opening fence in the document. */
  fenceLine: number;
  body: string;
  parsed: DecisionParse;
}

/** Every ```decision block in source order. Unclosed blocks run to the end, like any fence. */
export function findDecisionBlocks(md: string): DecisionBlockRef[] {
  const out: DecisionBlockRef[] = [];
  const lines = md.split("\n");
  let offset = 0;
  let open: { start: number; bodyStart: number; line: number; lang: string } | null = null;
  const bodyLines: string[] = [];
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i];
    const lineEnd = offset + l.length;
    if (l.startsWith("```")) {
      if (!open) {
        open = { start: offset, bodyStart: lineEnd + 1, line: i, lang: l.slice(3).trim().split(/\s+/)[0] ?? "" };
        bodyLines.length = 0;
      } else {
        if (open.lang === "decision") {
          const body = bodyLines.join("\n");
          out.push({ start: open.start, end: lineEnd, bodyStart: open.bodyStart, fenceLine: open.line, body, parsed: parseDecisionBody(body) });
        }
        open = null;
      }
    } else if (open) bodyLines.push(l);
    offset = lineEnd + 1;
  }
  if (open && open.lang === "decision") {
    const body = bodyLines.join("\n");
    out.push({ start: open.start, end: md.length, bodyStart: Math.min(open.bodyStart, md.length), fenceLine: open.line, body, parsed: parseDecisionBody(body) });
  }
  return out;
}

/** The key a block refers to: its `key`, or the id's tail when the id was written as R3:key. */
export function blockKey(p: DecisionParse): string | undefined {
  const e = p.entries;
  const key = e.find((x) => x.name === "key")?.value;
  if (key) return key;
  const id = e.find((x) => x.name === "id")?.value ?? "";
  const m = /^R\d+:(.+)$/.exec(id);
  return m?.[1];
}

/**
 * Rewrite the named fields of the block for `key`, keeping every other line (unknown names,
 * comments, order) byte for byte. `undefined` removes a field. Returns the source unchanged
 * when there's no such block.
 */
export function updateDecisionBlock(md: string, key: string, patch: Record<string, string | boolean | undefined>): string {
  const ref = findDecisionBlocks(md).find((b) => blockKey(b.parsed) === key);
  if (!ref) return md;
  const lines = ref.body.split("\n");
  const done = new Set<string>();
  const next: string[] = [];
  for (const l of lines) {
    const m = LINE.exec(l.replace(/\r$/, ""));
    if (m && m[1] in patch) {
      done.add(m[1]);
      const v = patch[m[1]];
      if (v === undefined || v === "") continue;
      next.push(`${m[1]}: ${clean(String(v))}`);
    } else next.push(l);
  }
  for (const [k, v] of Object.entries(patch)) if (!done.has(k) && v !== undefined && v !== "") next.push(`${k}: ${clean(String(v))}`);
  // Keep a trailing empty line out of the middle of the block.
  while (next.length && !next.at(-1)!.trim()) next.pop();
  const body = next.join("\n");
  return md.slice(0, ref.bodyStart) + body + md.slice(ref.bodyStart + ref.body.length);
}

/** Problems in a plan's decision blocks, by 1-based document line (Markdown view markers). */
export function decisionProblems(md: string): { line: number; message: string }[] {
  return findDecisionBlocks(md).flatMap((b) => {
    if (b.parsed.ok) return [];
    const line = b.parsed.line < 0 ? b.fenceLine + 1 : b.fenceLine + 2 + b.parsed.line;
    return [{ line, message: `This decision block can't be read: ${b.parsed.message}` }];
  });
}

/** A settled answer that a hand edit of plan.md changed (DECISIONS #22). */
export interface AnswerEdit {
  key: string;
  /** The settled answer. */
  from: string;
  /** What the block now says. */
  to: string;
}

// Whitespace and casing alone never change an answer (DECISIONS #26).
const norm = (v: string) => clean(v).replace(/\s+/g, " ").toLowerCase();
const same = (a: string, b: string) => norm(a) === norm(b);

/**
 * Settled answers that hand edits changed: every valid block whose `key` is settled in `answers`
 * and whose `answer:` no longer matches it (once per key). Open, stale and unknown keys, and
 * blocks that don't parse, are ignored; an edit to `answer:` counts as a Change and is saved
 * only through "Save and re-ask".
 */
export function answerEdits(md: string, answers: Record<string, string>): AnswerEdit[] {
  const out: AnswerEdit[] = [];
  for (const b of findDecisionBlocks(md)) {
    if (!b.parsed.ok || b.parsed.fields.status === "open") continue;
    const key = blockKey(b.parsed);
    if (!key || !Object.hasOwn(answers, key) || out.some((e) => e.key === key)) continue;
    const to = b.parsed.fields.answer ?? "";
    if (!same(to, answers[key])) out.push({ key, from: answers[key], to: clean(to) });
  }
  return out;
}

/** Cancel hand edits of settled answers: put each changed `answer:` line back, nothing else. */
export function revertAnswerEdits(md: string, answers: Record<string, string>): string {
  let out = md;
  // Last block first, so earlier offsets stay valid.
  for (const b of findDecisionBlocks(md).reverse()) {
    if (!b.parsed.ok || b.parsed.fields.status === "open") continue;
    const key = blockKey(b.parsed);
    if (!key || !Object.hasOwn(answers, key) || same(b.parsed.fields.answer ?? "", answers[key])) continue;
    const lines = b.body.split("\n");
    const i = b.parsed.entries.find((e) => e.name === "answer")?.line;
    if (i === undefined) continue;
    lines[i] = `answer: ${clean(answers[key])}`;
    out = out.slice(0, b.bodyStart) + lines.join("\n") + out.slice(b.bodyStart + b.body.length);
  }
  return out;
}

/**
 * The save path for decisions you add yourself (item 4, slash menu): every block with a question
 * and no id gets the next `U{n}` id, `key: u{n}`, `by: you` and `at`; an empty answer makes it
 * open (`status: open`), a Question the agent asks in the next round. Other lines are kept.
 */
export function fillUserDecisions(md: string, now: string): string {
  const blocks = findDecisionBlocks(md);
  let n = 0;
  for (const b of blocks) {
    const m = /^U(\d+)$/.exec(b.parsed.entries.find((e) => e.name === "id")?.value ?? "");
    if (m) n = Math.max(n, Number(m[1]));
  }
  const todo = blocks
    .filter((b) => {
      const get = (k: string) => b.parsed.entries.find((x) => x.name === k)?.value;
      return !get("id") && !!get("question");
    })
    .map((b) => ({ b, id: ++n }));
  let out = md;
  // Last first, so earlier offsets stay valid.
  for (const { b, id } of todo.reverse()) {
    const e = b.parsed.entries;
    const get = (k: string) => e.find((x) => x.name === k);
    const lines = b.body.split("\n").filter((l) => !/^id\s*:\s*$/.test(l));
    while (lines.length && !lines.at(-1)!.trim()) lines.pop();
    const add = [`by: you`, `at: ${now}`];
    if (!get("answer")?.value && !get("status")?.value) add.push("status: open");
    const body = [`id: U${id}`, `key: u${id}`, ...lines.filter((l) => !/^key\s*:/.test(l)), ...add.filter((l) => !get(l.split(":")[0]))].join("\n");
    out = out.slice(0, b.bodyStart) + body + out.slice(b.bodyStart + b.body.length);
  }
  return out;
}

/**
 * Decisions and Questions you added to the plan yourself (U ids, item 4 #34), not yet settled in
 * the interview. `asked`: open, the next round asks them word for word. `answered`: you answered
 * them in the plan, so the answer is final and they are never asked (PO, #5).
 */
export function userBlocks(md: string, settled: Record<string, unknown> = {}) {
  const asked: { key: string; question: string }[] = [];
  const answered: { key: string; question: string; answer: string }[] = [];
  for (const b of findDecisionBlocks(md)) {
    if (!b.parsed.ok || !/^U\d+$/.test(b.parsed.fields.id)) continue;
    const key = blockKey(b.parsed);
    if (!key || settled[key]) continue;
    const f = b.parsed.fields;
    if (f.answer) answered.push({ key, question: f.question, answer: f.answer });
    else if (f.status === "open") asked.push({ key, question: f.question });
  }
  return { asked, answered };
}
