import { Fragment, type ReactNode } from "react";

export type CiteRenderer = (round: number, key: string, n: number) => ReactNode;

/**
 * Minimal, safe Markdown → React (no raw HTML): headings, lists, paragraphs, code fences, **bold**, `code`.
 * `[R2:key]` citations become chips via `cite`; an "Open decisions" section is wrapped for the hatched style.
 */
export function Markdown({ source, cite, afterTitle, openBadge }: { source: string; cite?: CiteRenderer; afterTitle?: ReactNode; openBadge?: ReactNode }) {
  const out: ReactNode[] = [];
  let openSection: ReactNode[] | null = null;
  const push = (n: ReactNode) => (openSection ? openSection.push(n) : out.push(n));
  const lines = source.replace(/\r\n/g, "\n").split("\n");
  let i = 0;
  let key = 0;
  let titled = false;
  const ctx = { cite, n: 0 };
  while (i < lines.length) {
    const line = lines[i];
    if (!line.trim()) {
      i++;
      continue;
    }
    if (line.startsWith("```")) {
      const body: string[] = [];
      i++;
      while (i < lines.length && !lines[i].startsWith("```")) body.push(lines[i++]);
      i++;
      push(
        <pre key={key++}>
          <code>{body.join("\n")}</code>
        </pre>,
      );
      continue;
    }
    const h = /^(#{1,4})\s+(.*)$/.exec(line);
    if (h) {
      const level = h[1].length;
      i++;
      if (level === 1 && !titled) {
        titled = true;
        out.push(<h1 key={key++}>{inline(h[2], ctx)}</h1>);
        if (afterTitle) out.push(<Fragment key={key++}>{afterTitle}</Fragment>);
        continue;
      }
      if (level <= 2 && openSection) {
        out.push(
          <section key={key++} className="open" aria-label="Open decisions">
            {openSection}
          </section>,
        );
        openSection = null;
      }
      const Tag = (["h1", "h2", "h3", "h4"] as const)[level - 1];
      if (level === 2 && /^open decisions$/i.test(h[2].trim())) {
        openSection = [
          <h2 key={key++}>
            {h[2]}
            {openBadge}
          </h2>,
        ];
        continue;
      }
      push(<Tag key={key++}>{inline(h[2], ctx)}</Tag>);
      continue;
    }
    if (/^\s*([-*]|\d+\.)\s+/.test(line)) {
      const ordered = /^\s*\d+\./.test(line);
      const items: string[] = [];
      while (i < lines.length && /^\s*([-*]|\d+\.)\s+/.test(lines[i])) items.push(lines[i++].replace(/^\s*([-*]|\d+\.)\s+/, ""));
      const List = ordered ? "ol" : "ul";
      push(
        <List key={key++}>
          {items.map((t, n) => (
            <li key={n}>{inline(t, ctx)}</li>
          ))}
        </List>,
      );
      continue;
    }
    const para: string[] = [];
    while (i < lines.length && lines[i].trim() && !/^(#{1,4}\s|```|\s*([-*]|\d+\.)\s)/.test(lines[i])) para.push(lines[i++]);
    push(<p key={key++}>{inline(para.join(" "), ctx)}</p>);
  }
  if (openSection)
    out.push(
      <section key={key++} className="open" aria-label="Open decisions">
        {openSection}
      </section>,
    );
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
