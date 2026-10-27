import { Fragment, type KeyboardEvent, type ReactNode, useId, useState } from "react";
import { type Block, citedKeys, parseBlocks, passageId, sentences } from "./editor/blocks";
import { Diagram } from "./editor/Diagram";
import { IEdit } from "./icons";
import { CalloutIcon, PlusIcon } from "./editor/SlashMenu";

const KIND = { para: "paragraph", heading: "heading", list: "list", fence: "code block" } as const;
/** "Edit paragraph: A weekend MVP for the four…" — the first few words, without Markdown marks or citations. */
export function editLabel(b: Block): string {
  const words = b.raw
    .replace(/^```.*$/gm, "")
    .replace(/\[R\d+:[^\]]*\]/g, "")
    .replace(/[#*_`>]|^\s*([-+]|\d+[.)])\s+/gm, "")
    .split(/\s+/)
    .filter(Boolean);
  const head = words.slice(0, 6).join(" ");
  return `Edit ${KIND[b.kind]}${head ? `: ${head}${words.length > 6 ? "…" : ""}` : ""}`;
}

export type CiteRenderer = (round: number, key: string, n: number) => ReactNode;

/**
 * Comment anchors and pending suggestions drawn over the text (item 3 §3.4, §4.2): `mark.cmk`
 * (its first piece is a Tab stop with `aria-details` → the thread), and each suggestion as
 * `del.sg` (the text it removes) then `ins.sg`. Ranges are source offsets in the rendered Markdown.
 */
export interface DocMarks {
  /** `details`: id of the thread element when it is on screen (the rail is open). */
  anchors: { id: string; start: number; end: number; active: boolean; label: string; details?: string }[];
  /**
   * `phase` (v1.1 polish #102): "out" fades the deletion (120ms), "ok" drops it from the DOM and fades the
   * insertion's tint to plain (220ms) while an accept is held; "rej" fades the insertion out.
   */
  edits: { id: string; start: number; end: number; after: string; focused: boolean; phase?: "out" | "ok" | "rej" }[];
  onAnchor: (id: string) => void;
  onAnchorHover: (id: string | null) => void;
  onEdit: (id: string) => void;
  /** Accept / Reject controls after the focused suggestion. */
  pill: (id: string) => ReactNode;
  /** Block-level additions (item 5): each goes before the first block that starts at or after `at`. */
  inserts?: { key: string; at: number; node: ReactNode }[];
  /** Blocks shown in place of the block starting at `start` (a diagram replacement pair). */
  replaces?: { start: number; node: ReactNode }[];
}

// Private-use sentinels spliced into a block's source so marks survive the Markdown parse.
const A_OPEN = "\uE000";
const A_CLOSE = "\uE005";
const E_OPEN = "\uE003";
const E_SEP = "\uE001";
const E_CLOSE = "\uE002";
const IDX = 0xe100;
const SENTINELS = /[\uE000-\uE005]|[\uE100-\uE1FF]/;

/** The block's source with mark sentinels in it, or null when nothing is marked in it. */
function decorate(b: Block, marks: DocMarks | undefined): string | null {
  if (!marks || b.kind === "fence") return null;
  const tokens: { at: number; rank: number; s: string }[] = [];
  const inBlock = (start: number, end: number) => start < b.end && end > b.start;
  marks.anchors.forEach((a, i) => {
    if (!inBlock(a.start, a.end)) return;
    tokens.push({ at: Math.max(a.start, b.start), rank: 2, s: A_OPEN + String.fromCharCode(IDX + i) });
    tokens.push({ at: Math.min(a.end, b.end), rank: 1, s: A_CLOSE });
  });
  marks.edits.forEach((e, i) => {
    if (e.start < b.start || e.end > b.end) return;
    // A pure insertion is one token, after any anchor that ends here.
    if (e.start === e.end) return tokens.push({ at: e.start, rank: 1.5, s: E_OPEN + String.fromCharCode(IDX + i) + E_SEP + e.after.replace(/\n/g, " ") + E_CLOSE });
    tokens.push({ at: e.start, rank: 3, s: E_OPEN + String.fromCharCode(IDX + i) });
    tokens.push({ at: e.end, rank: 0, s: E_SEP + e.after.replace(/\n/g, " ") + E_CLOSE });
  });
  if (!tokens.length) return null;
  tokens.sort((x, y) => x.at - y.at || x.rank - y.rank);
  let out = "";
  let from = b.start;
  for (const t of tokens) {
    out += b.raw.slice(from - b.start, t.at - b.start) + t.s;
    from = t.at;
  }
  return out + b.raw.slice(from - b.start);
}

interface MarkState {
  anchor: number | null;
  edit: number | null;
  part: "del" | "ins" | null;
  /** The next piece of the current part is its first (it carries the hidden "suggested …" label). */
  first?: boolean;
  /** Anchors that already have their Tab stop. */
  seen?: Set<number>;
  /** Pieces so far of the current part, so each piece keys by suggestion id, not position (#102). */
  piece?: number;
}

/** Plan text ↔ decision linking (item 2 handoff §2). */
export interface PassageLink {
  /** Decision hovered or focused: all its passages light up. */
  active: string | null;
  /** Passage hovered (after the 120ms intent): only it lights up. */
  hover: string | null;
  /** Keys whose passages go muted while they're asked again. */
  stale: Set<string>;
  onEnter: (id: string, keys: string[]) => void;
  onLeave: (id: string) => void;
  /** The passage's right-margin cites. */
  gut?: (keys: string[], id: string) => ReactNode;
}
export type FenceBlock = Extract<Block, { kind: "fence" }>;

/**
 * Minimal, safe Markdown → React (no raw HTML): headings, lists, paragraphs, code fences, **bold**, *italic*, ~~strike~~, `code`, [links](https://…).
 * `[R2:key]` citations render via `cite`; an "Open decisions" section is wrapped in `section.open`.
 * ```mermaid fences render as diagrams.
 *
 * Editing (plan editor): with `onBlock`, every top-level block is wrapped in
 * `<div class="blk" data-block=kind>` and clicking it calls `onBlock(block)`. `edit` swaps the
 * blocks inside `edit.start..edit.end` for `edit.node` (the block editor).
 */
export function Markdown({
  source,
  cite,
  afterTitle,
  openBadge,
  onBlock,
  onAdd,
  edit,
  decision,
  marks,
  link,
}: {
  source: string;
  cite?: CiteRenderer;
  afterTitle?: ReactNode;
  openBadge?: ReactNode;
  onBlock?: (b: Block) => void;
  /** "+" in the left margin of a block: add a block below it (item 4). */
  onAdd?: (b: Block) => void;
  edit?: { start: number; end: number; node: ReactNode };
  /** Renders a ```decision fence (the n-th in the document). */
  decision?: (b: FenceBlock, n: number) => ReactNode;
  marks?: DocMarks;
  link?: PassageLink;
}) {
  const out: ReactNode[] = [];
  let openSection: ReactNode[] | null = null;
  const push = (n: ReactNode) => (openSection ? openSection.push(n) : out.push(n));
  const closeOpen = () => {
    if (!openSection) return;
    out.push(
      <section key={`open-${out.length}`} className="open" aria-label="Open decisions">
        {openSection}
      </section>,
    );
    openSection = null;
  };
  const ctx: Ctx = { cite, n: 0, marks, mk: { anchor: null, edit: null, part: null } };
  let decisions = 0;
  // A passage (sentence or list item) that cites decisions: `span.ps[id]`, so a decision block can
  // point at it (aria-describedby) and light it, and hovering it lights its decision (§2.2).
  // Its cites move from the text to buttons in the right margin (`.gut`, §2.3).
  const passage = (b: Block, i: number, t: string) => {
    const keys = citedKeys(t);
    if (!keys.length) return <Fragment key={i}>{inline(t, ctx)}</Fragment>;
    const id = passageId(b.start, i);
    const lit = !!link && ((!!link.active && keys.includes(link.active)) || link.hover === id);
    const stale = !!link && keys.some((k) => link.stale.has(k));
    return (
      <Fragment key={i}>
        {link?.gut ? (
          <span className="gut" contentEditable={false}>
            {link.gut(keys, id)}
          </span>
        ) : null}
        <span
          id={id}
          className={`ps${lit ? " lk" : ""}${stale ? " stale" : ""}`}
          data-keys={keys.join(" ")}
          onPointerEnter={link ? () => link.onEnter(id, keys) : undefined}
          onPointerLeave={link ? () => link.onLeave(id) : undefined}
        >
          {inline(link?.gut ? t.replace(new RegExp(`\\s*${CITE.source}`, "g"), "") : t, ctx)}
        </span>
      </Fragment>
    );
  };
  let titled = false;
  let editShown = false;
  const showEdit = () => {
    if (!edit || editShown) return;
    editShown = true;
    push(<Fragment key="edit">{edit.node}</Fragment>);
  };
  const wrap = (b: Block, node: ReactNode) =>
    onBlock ? (
      <div
        key={b.start}
        className="blk"
        data-block={b.kind}
        data-start={b.start}
        onClick={(e) => {
          // Chips, links and other controls inside a block keep their own behavior.
          if ((e.target as HTMLElement).closest("button,a,input,textarea,select")) return;
          // A pending suggestion is reviewed, not edited: clicking it focuses it.
          const ae = (e.target as HTMLElement).closest<HTMLElement>("[data-sg]");
          if (ae && marks) return marks.onEdit(ae.dataset.sg!);
          if (window.getSelection()?.toString()) return; // selecting text isn't a request to edit
          onBlock(b);
        }}
      >
        {/* The keyboard way in (v1.2 §1): one Tab stop per block, shown on focus or hover. Mermaid keeps "Edit source". */}
        {b.kind === "fence" && b.lang === "mermaid" ? null : (
          <button type="button" className="blk-act" aria-label={editLabel(b)} aria-keyshortcuts="/" aria-description="Slash adds a block below" onClick={() => onBlock(b)}>
            <IEdit s={14} />
            Edit
          </button>
        )}
        {node}
        {onAdd ? (
          // Pointer only, after the content so text reads first: the keyboard way is "/" on the focused block (#32).
          <button
            type="button"
            className="blk-add"
            tabIndex={-1}
            aria-label="Add a block below"
            onMouseDown={(e) => e.preventDefault()}
            onClick={(e) => {
              e.stopPropagation();
              // The tooltip stays hidden after a click until the pointer leaves (it would cover the new block).
              e.currentTarget.dataset.used = "";
              onAdd(b);
            }}
            onPointerLeave={(e) => delete e.currentTarget.dataset.used}
          >
            <PlusIcon />
            <span className="tip4" aria-hidden="true">
              Add a block below<span className="kb4">/</span>
            </span>
          </button>
        ) : null}
      </div>
    ) : (
      <Fragment key={b.start}>{node}</Fragment>
    );

  const inserts = [...(marks?.inserts ?? [])].sort((a, b) => a.at - b.at);
  const flushInserts = (upTo: number) => {
    while (inserts.length && inserts[0].at <= upTo) {
      const x = inserts.shift()!;
      push(<Fragment key={`ins-${x.key}`}>{x.node}</Fragment>);
    }
  };
  for (const plain of parseBlocks(source)) {
    flushInserts(plain.start);
    const rep = marks?.replaces?.find((r) => r.start === plain.start);
    if (rep && !(edit && plain.start >= edit.start && plain.start < edit.end)) {
      push(<Fragment key={`rep-${plain.start}`}>{rep.node}</Fragment>);
      continue;
    }
    // With marks, render a re-parse of the decorated source (same kind, same offsets for editing).
    const deco = decorate(plain, marks);
    const re = deco === null ? null : parseBlocks(deco)[0];
    const b: Block = re && re.kind === plain.kind ? ({ ...re, start: plain.start, end: plain.end, raw: plain.raw } as Block) : plain;
    const lines = (deco ?? plain.raw).split("\n");
    ctx.mk = { anchor: null, edit: null, part: null, seen: ctx.mk.seen };
    // Blocks inside (or starting inside) the edited range are replaced by the block editor.
    if (edit && b.start >= edit.start && (b.start < edit.end || b.end <= edit.end)) {
      showEdit();
      continue;
    }
    if (edit && b.start >= edit.end) showEdit();
    if (b.kind === "fence" && b.lang === "decision" && decision) {
      push(
        <div key={b.start} className="blk" data-block="decision" data-start={b.start}>
          {decision(b, decisions++)}
        </div>,
      );
    } else if (b.kind === "fence") {
      push(
        wrap(
          b,
          b.lang === "mermaid" ? (
            <Diagram code={b.body} onEdit={onBlock ? () => onBlock(b) : undefined} />
          ) : b.lang === "diff" ? (
            <pre className="diff4">
              <code>
                {b.body.split("\n").map((l, i) => (
                  <span key={i} className={l.startsWith("-") ? "dl" : l.startsWith("+") ? "dd" : undefined}>
                    {l || "\u200b"}
                  </span>
                ))}
              </code>
            </pre>
          ) : b.lang === "tabs" ? (
            <Tabs body={b.body} />
          ) : (
            <pre>
              <code>{b.body}</code>
            </pre>
          ),
        ),
      );
    } else if (b.kind === "heading") {
      if (b.level === 1 && !titled) {
        titled = true;
        out.push(wrap(b, <h1>{inline(b.text, ctx)}</h1>));
        if (afterTitle) out.push(<Fragment key="after-title">{afterTitle}</Fragment>);
        continue;
      }
      if (b.level <= 2) closeOpen();
      if (b.level === 2 && /^open decisions$/i.test(b.text.trim())) {
        openSection = [];
        push(
          wrap(
            b,
            <h2>
              {b.text}
              {openBadge}
            </h2>,
          ),
        );
        continue;
      }
      const Tag = (["h1", "h2", "h3", "h4"] as const)[b.level - 1];
      push(wrap(b, <Tag>{inline(b.text, ctx)}</Tag>));
    } else if (b.kind === "list") {
      const check = !b.ordered && b.items.every((t) => CHECK.test(t));
      const items = b.items.map((t, n) => {
        if (!check) return <li key={n}>{passage(b, n, t)}</li>;
        const on = /^\[[xX]\]/.test(t);
        return (
          <li key={n}>
            <span className="bx" data-on={on ? "" : undefined} role="img" aria-label={on ? "Done" : "Not done"}>
              {on ? "✓" : null}
            </span>
            <span>{passage(b, n, t.replace(CHECK, ""))}</span>
          </li>
        );
      });
      push(wrap(b, b.ordered ? <ol start={b.first === 1 ? undefined : b.first}>{items}</ol> : <ul className={check ? "ck4" : undefined}>{items}</ul>));
    } else if (b.kind === "para" && callout(lines)) {
      const c = callout(lines)!;
      push(
        wrap(
          b,
          <div className="cal4" data-kind={c.kind} role="note" aria-label={c.label}>
            <CalloutIcon />
            <p>{inline(c.body, ctx)}</p>
          </div>,
        ),
      );
    } else if (b.kind === "para" && table(lines)) {
      const rows = table(lines)!;
      push(
        wrap(
          b,
          <div className="tbl4">
            <table>
              <thead>
                <tr>
                  {rows[0].map((c, i) => (
                    <th key={i}>{inline(c, ctx)}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {rows.slice(1).map((r, i) => (
                  <tr key={i}>
                    {r.map((c, j) => (
                      <td key={j}>{inline(c, ctx)}</td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>,
        ),
      );
    } else {
      push(wrap(b, <p>{sentences(b.text).map((t, i) => passage(b, i, t))}</p>));
    }
  }
  showEdit();
  flushInserts(Infinity);
  closeOpen();
  return <>{out}</>;
}

const CHECK = /^\[[ xX]\]\s+/;
const CALLOUT = /^>\s*\[!(NOTE|TIP|IMPORTANT|WARNING|CAUTION)\]\s*$/i;

/** `> [!NOTE]` / `> [!WARNING]` blockquotes (GitHub alerts) → a callout. */
function callout(lines: string[]) {
  const m = CALLOUT.exec(lines[0] ?? "");
  if (!m || !lines.every((l) => l.startsWith(">"))) return null;
  const warn = /^(warning|caution)$/i.test(m[1]);
  return {
    kind: warn ? "warning" : "note",
    label: warn ? "Warning" : "Note",
    body: lines
      .slice(1)
      .map((l) => l.replace(/^>\s?/, ""))
      .join(" "),
  };
}

/** A pipe table: every line starts with "|", the second is the --- row. */
function table(lines: string[]) {
  if (lines.length < 2 || !lines.every((l) => l.trim().startsWith("|")) || !/^\s*\|?(\s*:?-{3,}:?\s*\|)+\s*$/.test(lines[1])) return null;
  const cells = (l: string) =>
    l
      .trim()
      .replace(/^\|/, "")
      .replace(/\|$/, "")
      .split("|")
      .map((c) => c.trim());
  return [cells(lines[0]), ...lines.slice(2).map(cells)];
}

/** A ```tabs fence: `--- Title` starts each tab (#31). Only the open tab shows. */
function Tabs({ body }: { body: string }) {
  const id = useId();
  const tabs: { title: string; text: string[] }[] = [];
  for (const l of body.split("\n")) {
    const m = /^---\s+(.+)$/.exec(l);
    if (m) tabs.push({ title: m[1].trim(), text: [] });
    else if (tabs.length) tabs.at(-1)!.text.push(l);
    else tabs.push({ title: "Tab", text: [l] });
  }
  const [on, setOn] = useState(0);
  const cur = Math.min(on, Math.max(0, tabs.length - 1));
  const key = (e: KeyboardEvent<HTMLButtonElement>) => {
    const d = e.key === "ArrowRight" ? 1 : e.key === "ArrowLeft" ? -1 : 0;
    if (!d) return;
    e.preventDefault();
    const next = (cur + d + tabs.length) % tabs.length;
    setOn(next);
    (e.currentTarget.parentElement?.children[next] as HTMLElement | undefined)?.focus();
  };
  if (!tabs.length) return null;
  return (
    <div className="tabs4">
      <div role="tablist" aria-label="Tabs">
        {tabs.map((t, i) => (
          <button
            key={i}
            type="button"
            role="tab"
            id={`${id}-t${i}`}
            aria-selected={i === cur}
            aria-controls={`${id}-p${i}`}
            tabIndex={i === cur ? 0 : -1}
            onClick={() => setOn(i)}
            onKeyDown={key}
          >
            {t.title}
          </button>
        ))}
      </div>
      <div role="tabpanel" id={`${id}-p${cur}`} aria-labelledby={`${id}-t${cur}`}>
        <Markdown source={tabs[cur].text.join("\n")} />
      </div>
    </div>
  );
}

const CITE = /\[(R\d+:[^\]\s,]+(?:\s*,\s*R\d+:[^\]\s,]+)*)\]/;

interface Ctx {
  cite?: CiteRenderer;
  n: number;
  marks?: DocMarks;
  mk: MarkState;
}

/** Plain text with mark sentinels → text wrapped in the marks open at each point. */
function runs(text: string, ctx: Ctx, key: string | number): ReactNode {
  if (!ctx.marks || (!SENTINELS.test(text) && ctx.mk.anchor === null && ctx.mk.edit === null)) return text;
  const { marks, mk } = ctx;
  const out: ReactNode[] = [];
  let buf = "";
  const flush = () => {
    if (!buf) return;
    let node: ReactNode = buf;
    let k = `${key}-${out.length}`;
    if (mk.edit !== null && mk.part) {
      const e = marks.edits[mk.edit];
      const Tag = mk.part;
      // A held accept's deletion has faded (phase "out") and now leaves the DOM: the text reflows once.
      if (Tag === "del" && e.phase === "ok") {
        buf = "";
        return;
      }
      const first = mk.first;
      mk.first = false;
      // Keyed by suggestion id: a held accept keeps its elements, so its fades run (#102).
      k = `${key}-sg-${e.id}-${Tag}-${(mk.piece = (mk.piece ?? 0) + 1)}`;
      const ph = e.phase === "out" ? (Tag === "del" ? " out" : "") : e.phase === "ok" ? " ok" : e.phase === "rej" ? (Tag === "ins" ? " out" : "") : "";
      node = (
        <Tag key={`${k}e`} className={`sg${e.focused ? " f" : ""}${ph}`} data-sg={e.id} tabIndex={-1}>
          {first ? <span className="sr-only">{Tag === "del" ? "suggested removal: " : "suggested insertion: "}</span> : null}
          {node}
        </Tag>
      );
    }
    if (mk.anchor !== null) {
      const n = mk.anchor;
      const a = marks.anchors[n];
      const seen = (mk.seen ??= new Set());
      const stop = !seen.has(n);
      seen.add(n);
      node = (
        <mark
          key={`${k}a`}
          className={`cmk${a.active ? " on" : ""}`}
          data-thread={a.id}
          tabIndex={stop ? 0 : undefined}
          aria-details={stop ? a.details : undefined}
          aria-label={stop ? a.label : undefined}
          onClick={(ev) => {
            ev.stopPropagation();
            if (!getSelection()?.toString()) marks.onAnchor(a.id);
          }}
          onKeyDown={(ev) => {
            if (ev.key === "Enter") {
              ev.preventDefault();
              marks.onAnchor(a.id);
            }
          }}
          onPointerEnter={() => marks.onAnchorHover(a.id)}
          onPointerLeave={() => marks.onAnchorHover(null)}
        >
          {node}
        </mark>
      );
    }
    out.push(<Fragment key={k}>{node}</Fragment>);
    buf = "";
  };
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (c === A_OPEN || c === E_OPEN) {
      flush();
      const n = text.charCodeAt(++i) - IDX;
      if (c === A_OPEN) mk.anchor = n;
      else {
        mk.edit = n;
        mk.part = "del";
        mk.first = true;
        mk.piece = 0;
      }
    } else if (c === A_CLOSE) {
      flush();
      mk.anchor = null;
    } else if (c === E_SEP) {
      flush();
      mk.part = "ins";
      mk.first = true;
      mk.piece = 0;
    } else if (c === E_CLOSE) {
      flush();
      const e = mk.edit === null ? null : marks.edits[mk.edit];
      mk.edit = null;
      mk.part = null;
      if (e?.focused) out.push(<Fragment key={`${key}-p`}>{marks.pill(e.id)}</Fragment>);
    } else if (c.charCodeAt(0) < IDX || c.charCodeAt(0) > IDX + 0xff) buf += c;
  }
  flush();
  return out;
}

const INLINE = new RegExp(`(\\*\\*[^*]+\\*\\*|~~[^~]+~~|\\*(?=[^*\\s])[^*]*[^*\\s]\\*|\\*[^*\\s]\\*|\`[^\`]+\`|\\[[^\\]]+\\]\\(https?:\\/\\/[^)\\s]+\\)|${CITE.source})`, "g");
const LINK = /^\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)$/;

function inline(text: string, ctx: Ctx): ReactNode {
  const parts = text.split(INLINE).filter((p) => p !== undefined);
  const nodes: ReactNode[] = [];
  let skip = false;
  parts.forEach((p, n) => {
    if (skip) {
      skip = false;
      return;
    }
    if (p.startsWith("**") && p.endsWith("**") && p.length > 4) {
      const inner = p.slice(2, -2);
      // "**[R1:platform]**" (the generated decision log) renders as plain citation chips.
      if (ctx.cite && new RegExp(`^${CITE.source}$`).test(inner)) nodes.push(<Fragment key={n}>{inline(inner, ctx)}</Fragment>);
      else nodes.push(<strong key={n}>{inline(inner, ctx)}</strong>);
    } else if (p.startsWith("~~") && p.endsWith("~~") && p.length > 4) nodes.push(<s key={n}>{inline(p.slice(2, -2), ctx)}</s>);
    else if (p.startsWith("*") && p.endsWith("*") && p.length > 2) nodes.push(<em key={n}>{inline(p.slice(1, -1), ctx)}</em>);
    else if (p.startsWith("`") && p.endsWith("`") && p.length > 1) nodes.push(<code key={n}>{runs(p.slice(1, -1), ctx, n)}</code>);
    else if (LINK.test(p)) {
      const m = LINK.exec(p)!;
      nodes.push(
        <a key={n} href={m[2]} target="_blank" rel="noopener noreferrer">
          {inline(m[1], ctx)}
        </a>,
      );
    } else if (CITE.test(p) && p.startsWith("[")) {
      // The capture group repeats the inner text as the next part; skip it.
      skip = true;
      const refs = p.slice(1, -1).split(/\s*,\s*/);
      for (const r of refs) {
        const m = /^R(\d+):(.+)$/.exec(r);
        if (!m) continue;
        nodes.push(<Fragment key={`${n}-${r}`}>{ctx.cite ? ctx.cite(Number(m[1]), m[2], ctx.n++) : null}</Fragment>);
      }
    } else nodes.push(<Fragment key={n}>{runs(p, ctx, n)}</Fragment>);
  });
  return nodes;
}
