import { Fragment, type ReactNode } from "react";
import { type Block, citedKeys, parseBlocks, passageId, sentences } from "./editor/blocks";
import { Diagram } from "./editor/Diagram";
import { IEdit } from "./icons";

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
 * Minimal, safe Markdown → React (no raw HTML): headings, lists, paragraphs, code fences, **bold**, `code`.
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
  edit,
  decision,
  link,
}: {
  source: string;
  cite?: CiteRenderer;
  afterTitle?: ReactNode;
  openBadge?: ReactNode;
  onBlock?: (b: Block) => void;
  edit?: { start: number; end: number; node: ReactNode };
  /** Renders a ```decision fence (the n-th in the document). */
  decision?: (b: FenceBlock, n: number) => ReactNode;
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
  const ctx = { cite, n: 0 };
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
          if (window.getSelection()?.toString()) return; // selecting text isn't a request to edit
          onBlock(b);
        }}
      >
        {/* The keyboard way in (v1.2 §1): one Tab stop per block, shown on focus or hover. Mermaid keeps "Edit source". */}
        {b.kind === "fence" && b.lang === "mermaid" ? null : (
          <button type="button" className="blk-act" aria-label={editLabel(b)} onClick={() => onBlock(b)}>
            <IEdit s={14} />
            Edit
          </button>
        )}
        {node}
      </div>
    ) : (
      <Fragment key={b.start}>{node}</Fragment>
    );

  for (const b of parseBlocks(source)) {
    // Blocks inside (or starting inside) the edited range are replaced by the block editor.
    if (edit && b.start >= edit.start && (b.start < edit.end || b.end <= edit.end)) {
      showEdit();
      continue;
    }
    if (edit && b.start >= edit.end) showEdit();
    if (b.kind === "fence" && b.lang === "decision" && decision) {
      push(
        <div key={b.start} className="blk" data-block="decision">
          {decision(b, decisions++)}
        </div>,
      );
    } else if (b.kind === "fence") {
      push(
        wrap(
          b,
          b.lang === "mermaid" ? (
            <Diagram code={b.body} onEdit={onBlock ? () => onBlock(b) : undefined} />
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
      const items = b.items.map((t, n) => <li key={n}>{passage(b, n, t)}</li>);
      push(wrap(b, b.ordered ? <ol start={b.first === 1 ? undefined : b.first}>{items}</ol> : <ul>{items}</ul>));
    } else {
      push(wrap(b, <p>{sentences(b.text).map((t, i) => passage(b, i, t))}</p>));
    }
  }
  showEdit();
  closeOpen();
  return <>{out}</>;
}

const CITE = /\[(R\d+:[^\]\s,]+(?:\s*,\s*R\d+:[^\]\s,]+)*)\]/;

function inline(text: string, ctx: { cite?: CiteRenderer; n: number }): ReactNode {
  const parts = text.split(new RegExp(`(\\*\\*[^*]+\\*\\*|\`[^\`]+\`|${CITE.source})`, "g")).filter((p) => p !== undefined);
  const nodes: ReactNode[] = [];
  let skip = false;
  parts.forEach((p, n) => {
    if (skip) {
      skip = false;
      return;
    }
    if (p.startsWith("**") && p.endsWith("**")) {
      const inner = p.slice(2, -2);
      // "**[R1:platform]**" (the generated decision log) renders as plain citation chips.
      if (ctx.cite && new RegExp(`^${CITE.source}$`).test(inner)) nodes.push(<Fragment key={n}>{inline(inner, ctx)}</Fragment>);
      else nodes.push(<strong key={n}>{inline(inner, ctx)}</strong>);
    }
    else if (p.startsWith("`") && p.endsWith("`") && p.length > 1) nodes.push(<code key={n}>{p.slice(1, -1)}</code>);
    else if (CITE.test(p) && p.startsWith("[")) {
      // The capture group repeats the inner text as the next part; skip it.
      skip = true;
      const refs = p.slice(1, -1).split(/\s*,\s*/);
      for (const r of refs) {
        const m = /^R(\d+):(.+)$/.exec(r);
        if (!m) continue;
        nodes.push(<Fragment key={`${n}-${r}`}>{ctx.cite ? ctx.cite(Number(m[1]), m[2], ctx.n++) : null}</Fragment>);
      }
    } else nodes.push(<Fragment key={n}>{p}</Fragment>);
  });
  return nodes;
}
