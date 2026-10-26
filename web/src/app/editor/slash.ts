// The slash menu's data and rules (v1.1 item 4): commands, ranking, templates and fields, and
// when a "/" opens the menu. DOM-free so the rules are unit-tested; the menu, the block editor
// and the Markdown view all read from here.

export type CmdId =
  | "decision" | "question" | "flow" | "state" | "agentdiag"
  | "callout" | "code" | "diff" | "table" | "tabs"
  | "h" | "list" | "check";
export type Group = "Plan" | "Diagrams" | "Blocks" | "Text";

export interface Cmd {
  id: CmdId;
  group: Group;
  label: string;
  desc: string;
  aliases: string[];
  /** The Markdown shortcut it stands for (shown as a mono chip). */
  sc?: string;
  /** Runs the agent instead of inserting text. */
  agent?: boolean;
}

/** In the handoff's group order. `{agent}` is the selected agent's display name (data, not copy). */
const CMDS: Cmd[] = [
  { id: "decision", group: "Plan", label: "Decision", desc: "A question and the answer you chose", aliases: ["choice", "answer", "decide"] },
  { id: "question", group: "Plan", label: "Question", desc: "An open question. {agent} asks it in the next round", aliases: ["ask", "open", "todo"] },
  { id: "flow", group: "Diagrams", label: "Flowchart", desc: "Steps and branches, written in Mermaid", aliases: ["diagram", "mermaid", "flow", "chart"] },
  { id: "state", group: "Diagrams", label: "State diagram", desc: "States and what moves between them", aliases: ["mermaid", "lifecycle", "states"] },
  { id: "agentdiag", group: "Diagrams", label: "Diagram by {agent}", desc: "{agent} reads this section and suggests a diagram. Nothing changes until you accept it.", aliases: ["draw", "add diagrams", "mermaid"], agent: true },
  { id: "callout", group: "Blocks", label: "Callout", desc: "A note or warning set apart from the text", aliases: ["note", "warning", "tip", "alert"] },
  { id: "code", group: "Blocks", label: "Code", desc: "A code block with syntax colours", aliases: ["snippet", "fence"], sc: "```" },
  { id: "diff", group: "Blocks", label: "Diff", desc: "Lines removed and added", aliases: ["change", "patch", "before after"] },
  { id: "table", group: "Blocks", label: "Table", desc: "Rows and columns", aliases: ["grid", "columns"], sc: "|" },
  { id: "tabs", group: "Blocks", label: "Tabs", desc: "Alternatives side by side, one shown at a time", aliases: ["options", "variants", "alternatives"] },
  { id: "h", group: "Text", label: "Heading", desc: "A section title", aliases: ["title", "section"], sc: "##" },
  { id: "list", group: "Text", label: "Bulleted list", desc: "A simple list", aliases: ["bullets", "points"], sc: "-" },
  { id: "check", group: "Text", label: "Checklist", desc: "Items to tick off", aliases: ["todo", "tasks", "checkbox"], sc: "[ ]" },
];

/**
 * The commands for `agent`. "Diagram by {agent}" is listed only when the host can run it
 * (`agentDiagram`, item 5's hook); otherwise it is left out rather than shown dead.
 */
export function commands(agent: string, agentDiagram: boolean): Cmd[] {
  const fill = (t: string) => t.replaceAll("{agent}", agent);
  return CMDS.filter((c) => agentDiagram || !c.agent).map((c) => ({ ...c, label: fill(c.label), desc: fill(c.desc) }));
}

export interface Hit {
  cmd: Cmd;
  score: number;
  /** Matched character indexes in the label (bolded), or null. */
  hit: number[] | null;
  /** The alias that matched, shown after the label. */
  alias: string | null;
}

/** Label prefix > word start > alias prefix > subsequence; agent rows rank 300 lower so a direct insert wins a tie. */
export function score(c: Cmd, query: string): Hit {
  const L = c.label.toLowerCase();
  const q = query.toLowerCase();
  let s = 0;
  let hit: number[] | null = null;
  let alias: string | null = null;
  const run = (from: number) => [...q].map((_, i) => from + i);
  if (L.startsWith(q)) {
    s = 1000;
    hit = run(0);
  } else {
    let off = 0;
    for (const w of L.split(" ")) {
      if (w.startsWith(q)) {
        s = 800;
        hit = run(off);
        break;
      }
      off += w.length + 1;
    }
  }
  if (!s) {
    const al = c.aliases.find((x) => x.startsWith(q));
    if (al) {
      s = 600;
      alias = al;
    }
  }
  if (!s) {
    let j = 0;
    let streak = 0;
    let best = 0;
    const idx: number[] = [];
    for (let i = 0; i < L.length && j < q.length; i++) {
      if (L[i] !== q[j]) continue;
      idx.push(i);
      streak = idx.length > 1 && idx[idx.length - 2] === i - 1 ? streak + 1 : 0;
      best += streak;
      j++;
    }
    if (j === q.length) {
      s = 300 + best * 50 - idx[0] * 5;
      hit = idx;
    }
  }
  if (s && c.agent) s -= 300;
  return { cmd: c, score: s, hit, alias };
}

/** What the menu lists for `query`: everything in group order when empty, else the best 8. */
export function rank(cmds: Cmd[], query: string): Hit[] {
  if (!query) return cmds.map((cmd) => ({ cmd, score: 1, hit: null, alias: null }));
  return cmds
    .map((c, i) => ({ h: score(c, query), i }))
    .filter((r) => r.h.score > 0)
    .sort((a, b) => b.h.score - a.h.score || a.i - b.i)
    .slice(0, 8)
    .map((r) => r.h);
}

// ---------------- templates ----------------
/** `{Label}` marks a field; Tab moves to the next one. */
const TPL: Record<string, string[]> = {
  decision: ["```decision", "question: {Question}", "answer: {Answer}", "```"],
  question: ["```decision", "question: {Question}", "answer:", "```"],
  flow: ["```mermaid", "flowchart LR", "  A[{First step}] --> B[{Next step}]", "```"],
  state: ["```mermaid", "stateDiagram-v2", "  [*] --> {First state}", "  {First state} --> {Next state}", "```"],
  callout: ["> [!NOTE]", "> {Text}"],
  warning: ["> [!WARNING]", "> {Text}"],
  code: ["```{language}", "{code}", "```"],
  diff: ["```diff", "- {removed line}", "+ {added line}", "```"],
  table: ["| {Column} | {Column} |", "| --- | --- |", "| {Cell} | {Cell} |"],
  tabs: ["```tabs", "--- {First tab}", "{Text}", "--- {Second tab}", "{Text}", "```"],
  h: ["## {Heading}"],
  list: ["- {Item}"],
  check: ["- [ ] {Task}"],
};
/** Templates whose repeated labels are one value typed once (the state diagram's first state). */
const LINKED = new Set(["state"]);

export interface Field {
  start: number;
  end: number;
  /** Fields with the same `link` mirror each other as you type. */
  link?: number;
}

export interface Expanded {
  text: string;
  fields: Field[];
}

/** The Markdown a command inserts, with its fields. `alias` "warning" picks the warning callout. */
export function expand(id: CmdId, alias?: string | null): Expanded {
  const key = id === "callout" && alias === "warning" ? "warning" : id;
  const lines = TPL[key];
  if (!lines) return { text: "", fields: [] };
  const src = lines.join("\n");
  const fields: Field[] = [];
  const links = new Map<string, number>();
  let text = "";
  let at = 0;
  for (const m of src.matchAll(/\{([^}]+)\}/g)) {
    text += src.slice(at, m.index);
    const label = m[1];
    const f: Field = { start: text.length, end: text.length + label.length };
    if (LINKED.has(key)) {
      const prev = links.get(label);
      if (prev !== undefined) {
        f.link = prev;
        fields[prev].link = prev;
      } else links.set(label, fields.length);
    }
    fields.push(f);
    text += label;
    at = m.index + m[0].length;
  }
  text += src.slice(at);
  return { text, fields };
}

/** Tab order: linked copies after the first are skipped (they follow it). */
export function tabStops(fields: Field[]): number[] {
  return fields.map((f, i) => (f.link !== undefined && f.link !== i ? -1 : i)).filter((i) => i >= 0);
}

// ---------------- the trigger ----------------
export interface SlashRun {
  /** Offset of the "/". */
  from: number;
  /** Text typed after it, up to the caret. */
  query: string;
}

const inFence = (text: string, lineStart: number) => {
  let open = false;
  for (const line of text.slice(0, lineStart).split("\n")) if (/^\s*(```|~~~)/.test(line)) open = !open;
  return open;
};

/**
 * The "/run" the caret sits in, or null. A "/" counts only at the start of a line (spaces
 * allowed before it), outside a code fence, and the run holds no spaces: "and/or" mid-line and a
 * "/" in code stay text.
 */
export function slashQuery(text: string, caret: number): SlashRun | null {
  const lineStart = text.lastIndexOf("\n", caret - 1) + 1;
  const m = /^(\s*)\/([^\s/]*)$/.exec(text.slice(lineStart, caret));
  if (!m) return null;
  if (inFence(text, lineStart)) return null;
  return { from: lineStart + m[1].length, query: m[2] };
}

export interface Insertion extends Expanded {
  /** Replace text[from, to) with `text`; field offsets are absolute in the new document. */
  from: number;
  to: number;
  /** End of the inserted block in the new document (before any blank line added after it). */
  end: number;
}

/**
 * Replacing the "/run" at `run` (ending at `caret`) with a template. The block starts on its own
 * line, and gets a blank line before and after when it touches other text, so it parses as its
 * own block.
 */
export function insertion(doc: string, run: SlashRun, caret: number, tpl: Expanded): Insertion {
  const lineStart = doc.lastIndexOf("\n", run.from - 1) + 1;
  const lineEnd = doc.indexOf("\n", caret);
  const rest = doc.slice(caret, lineEnd === -1 ? doc.length : lineEnd);
  const from = lineStart;
  const to = rest.trim() ? caret : lineEnd === -1 ? doc.length : lineEnd;
  const before = doc.slice(0, from);
  const after = doc.slice(to);
  const pre = !before || before.endsWith("\n\n") ? "" : before.endsWith("\n") ? "\n" : "\n\n";
  const post = !after || after.startsWith("\n\n") ? "" : after.startsWith("\n") ? "\n" : "\n\n";
  const shift = from + pre.length;
  return {
    from,
    to,
    text: pre + tpl.text + post,
    end: shift + tpl.text.length,
    fields: tpl.fields.map((f) => ({ ...f, start: f.start + shift, end: f.end + shift })),
  };
}

/**
 * Fields after an edit from `prev` to `next` while `active` is selected. Typing inside the active
 * field grows it and shifts the ones after; linked copies get the same text. null when the edit
 * reaches outside the active field (field mode ends).
 */
export function editFields(prev: string, next: string, fields: Field[], active: number): { text: string; fields: Field[] } | null {
  let a = 0;
  while (a < prev.length && a < next.length && prev[a] === next[a]) a++;
  let e = 0;
  while (e < prev.length - a && e < next.length - a && prev[prev.length - 1 - e] === next[next.length - 1 - e]) e++;
  const oldEnd = prev.length - e;
  const delta = next.length - prev.length;
  const f = fields[active];
  if (a < f.start || oldEnd > f.end) return null;
  let out = fields.map((x, i) =>
    i === active ? { ...x, end: x.end + delta } : x.start >= f.end ? { ...x, start: x.start + delta, end: x.end + delta } : x,
  );
  let text = next;
  const link = f.link;
  if (link === undefined) return { text, fields: out };
  const value = text.slice(out[active].start, out[active].end);
  // Rewrite the linked copies, last first so earlier offsets stay valid.
  const copies = out.map((x, i) => ({ x, i })).filter(({ x, i }) => i !== active && x.link === link).reverse();
  for (const { x, i } of copies) {
    const d = value.length - (x.end - x.start);
    text = text.slice(0, x.start) + value + text.slice(x.end);
    out = out.map((y, j) => (j === i ? { ...y, end: y.end + d } : y.start >= x.end ? { ...y, start: y.start + d, end: y.end + d } : y));
  }
  return { text, fields: out };
}
