// "Add diagrams" (v1.1 item 5, DECISIONS #36–50): the agent drafts one Mermaid flowchart or state
// diagram per chosen H2 section, and each one lands as a block suggestion (#16 rules: nothing
// changes until the user accepts). DOM-free: the browser uses `planSections` and `checkMermaid` too.

import { fenceRanges, newSuggestionId, type CommentState, type Suggestion } from "./comments.ts";

export type DiagramKind = "flowchart" | "state";
export const DIAGRAM_KINDS: DiagramKind[] = ["flowchart", "state"];

export interface DiagramRun {
  state: "running" | "done" | "error" | "stopped";
  startedAt: string;
  ms?: number;
  /** Section titles asked for, in plan order. */
  sections: string[];
  kinds: DiagramKind[];
  focus?: string;
  /** Sections finished (drawn or skipped). */
  done: number;
  /** The section being drawn now. */
  current?: string;
  added: number;
  skipped: number;
  message?: string;
}

export interface PlanSection {
  /** Heading text as written ("Sync"). */
  title: string;
  start: number;
  end: number;
  /** The section's last block: a diagram is inserted after it. */
  anchor: string;
  anchorAt: number;
  /** The section's Mermaid fence, when it already has one (a new diagram replaces it). */
  diagram?: { text: string; at: number };
}

/** The plan's H2 sections, with where a new diagram would go. */
export function planSections(md: string): PlanSection[] {
  const fences = fenceRanges(md);
  const inFence = (i: number) => fences.some(([a, b]) => i > a && i < b);
  const heads = [...md.matchAll(/^## +(.+)$/gm)].filter((m) => !inFence(m.index!));
  return heads.map((m, i) => {
    const start = m.index!;
    const end = i + 1 < heads.length ? heads[i + 1].index! : md.length;
    const body = md.slice(start, end);
    // Blocks are separated by blank lines, except inside fences.
    // The heading is its own block, even with no blank line under it.
    const nl = body.indexOf("\n");
    const blocks: { at: number; text: string }[] = [{ at: start, text: nl < 0 ? body : body.slice(0, nl) }];
    let at = start + (nl < 0 ? body.length : nl + 1);
    for (const chunk of (nl < 0 ? "" : body.slice(nl + 1)).split(/(\n\s*\n)/)) {
      const open = blocks.length > 1 && (blocks[blocks.length - 1].text.match(/^```/gm)?.length ?? 0) % 2 === 1;
      if (/^\n\s*\n$/.test(chunk)) {
        if (open) blocks[blocks.length - 1].text += chunk;
      } else if (chunk.trim()) {
        if (open) blocks[blocks.length - 1].text += chunk;
        else blocks.push({ at, text: chunk });
      }
      at += chunk.length;
    }
    const last = blocks[blocks.length - 1];
    const anchor = last.text.replace(/\s+$/, "");
    const fence = blocks.find((b) => /^```mermaid\s*\n/.test(b.text));
    return {
      title: m[1].trim(),
      start,
      end,
      anchor,
      anchorAt: last.at,
      ...(fence ? { diagram: { text: fence.text.replace(/\s+$/, ""), at: fence.at } } : {}),
    };
  });
}

/** Mermaid source → the fence the plan holds. */
export const fenceOf = (code: string) => "```mermaid\n" + code.trim() + "\n```";

const SHAPES: [string, string][] = [["[", "]"], ["(", ")"], ["{", "}"]];

/**
 * A light check of the agent's Mermaid before it is shown (#43): the browser draws it with
 * Mermaid itself and drops one that still fails. Returns the problem, or null.
 */
export function checkMermaid(code: string, kinds: DiagramKind[] = DIAGRAM_KINDS): string | null {
  const lines = code.split("\n").map((l) => l.trim()).filter((l) => l && !l.startsWith("%%"));
  const head = lines[0] ?? "";
  const kind: DiagramKind | null = /^flowchart (TD|TB|LR)$/.test(head) ? "flowchart" : head === "stateDiagram-v2" ? "state" : null;
  if (!kind) return 'start with "flowchart TD", "flowchart LR" or "stateDiagram-v2"';
  if (!kinds.includes(kind)) return `draw a ${kinds.includes("flowchart") ? "flowchart" : "state diagram"} only`;
  if (!lines.some((l) => /^accTitle:\s*\S/.test(l))) return "add an accTitle: line";
  if (!lines.some((l) => /^accDescr:\s*\S/.test(l))) return "add an accDescr: line";
  if (/%%\{|^\s*(style|classDef|class|linkStyle)\b/m.test(code)) return "no style, classDef, class, linkStyle or %%{init} lines";
  if (kind === "state" && !lines.includes("direction LR")) return "state diagrams use direction LR";
  for (const [i, l] of lines.entries()) {
    if (/^acc(Title|Descr):/.test(l)) continue;
    const bare = l.replace(/"[^"]*"/g, '""');
    if ((bare.match(/"/g)?.length ?? 0) % 2) return `line ${i + 1}: a quote is not closed`;
    for (const [a, b] of SHAPES) if (bare.split(a).length !== bare.split(b).length) return `line ${i + 1}: a ${a}${b} shape is not closed`;
  }
  const shapes = lines.length - 3;
  if (shapes > 40) return "keep it under 40 lines";
  return null;
}

/** The accTitle/accDescr of a diagram's source (its caption and text description). */
export function accOf(code: string): { title: string; descr: string } {
  return {
    title: code.match(/^\s*accTitle:\s*(.+)$/m)?.[1].trim() ?? "",
    descr: code.match(/^\s*accDescr:\s*(.+)$/m)?.[1].trim() ?? "",
  };
}

export function diagramKind(code: string): DiagramKind | null {
  const head = code.split("\n").map((l) => l.trim()).find((l) => l && !l.startsWith("%%")) ?? "";
  return head.startsWith("flowchart") || head.startsWith("graph") ? "flowchart" : head.startsWith("stateDiagram") ? "state" : null;
}

/** One diagram as a block suggestion: after the section's last block, or in place of its diagram. */
export function addDiagramSuggestion(s: CommentState & { plan?: { markdown: string } }, section: PlanSection, code: string, baseHash?: string): Suggestion {
  const fence = fenceOf(code);
  const x: Suggestion = section.diagram
    ? { id: newSuggestionId(), threadId: "", kind: "diagram", section: section.title, replace: true, before: section.diagram.text, after: fence, at: section.diagram.at, status: "pending" }
    : { id: newSuggestionId(), threadId: "", kind: "diagram", section: section.title, before: section.anchor, after: `${section.anchor}\n\n${fence}`, at: section.anchorAt, status: "pending" };
  if (baseHash) x.baseHash = baseHash;
  s.suggestions = [...(s.suggestions ?? []), x];
  return x;
}

/** The Mermaid source a diagram suggestion adds. */
export function suggestedCode(x: Pick<Suggestion, "after" | "replace">): string {
  const m = x.after.match(/```mermaid\n([\s\S]*?)\n```$/);
  return m ? m[1] : "";
}

/** "4.2 s" (§18 B: number, space, unit). */
export function formatDuration(ms: number): string {
  return ms < 60_000 ? `${(ms / 1000).toFixed(1)} s` : `${Math.floor(ms / 60_000)} min ${Math.round((ms % 60_000) / 1000)} s`;
}

export interface DiagramEdge {
  from: string;
  to: string;
  label?: string;
}

/** Shapes and arrows read from the source, for full screen's Text view (#47). */
export function describeDiagram(code: string): { kind: DiagramKind | null; shapes: string[]; edges: DiagramEdge[] } {
  const kind = diagramKind(code);
  const names = new Map<string, string>();
  const edges: DiagramEdge[] = [];
  const node = (raw: string) => {
    const m = raw.trim().match(/^([A-Za-z0-9_\-*\[\]]+?)\s*(?:\[\(?|\(\(?|\{\{?|>)\s*"?([^"\]\)\}]*)"?\s*(?:\)?\]|\)?\)|\}?\})?$/);
    if (raw.trim() === "[*]") return "[*]";
    const id = m ? m[1] : raw.trim().split(/\s/)[0];
    if (m?.[2]) names.set(id, m[2].trim());
    else if (!names.has(id)) names.set(id, id);
    return id;
  };
  for (const raw of code.split("\n")) {
    const l = raw.trim();
    if (!l || /^(flowchart|graph|stateDiagram|direction|acc(Title|Descr)|%%)/.test(l)) continue;
    if (kind === "state") {
      const m = l.match(/^(\S+)\s*-->\s*([^:]+?)\s*(?::\s*(.+))?$/);
      if (m) edges.push({ from: node(m[1]), to: node(m[2]), ...(m[3] ? { label: m[3].trim() } : {}) });
      else if (/^state\s+"([^"]+)"\s+as\s+(\S+)/.test(l)) {
        const [, n, id] = l.match(/^state\s+"([^"]+)"\s+as\s+(\S+)/)!;
        names.set(id, n);
      } else node(l.split(":")[0]);
      continue;
    }
    const parts = l.split(/\s*(-->|---|-.->|==>)\s*(?:\|([^|]*)\|\s*)?/);
    if (parts.length < 4) {
      node(l);
      continue;
    }
    // A -- label --> B
    let prev = node(parts[0].replace(/\s+--\s+.*$/, ""));
    let pending = parts[0].match(/\s--\s+(.+)$/)?.[1];
    for (let i = 1; i + 2 < parts.length + 1; i += 3) {
      const label = parts[i + 1] ?? pending;
      let target = parts[i + 2] ?? "";
      pending = target.match(/\s--\s+(.+)$/)?.[1];
      target = target.replace(/\s+--\s+.*$/, "");
      if (!target) break;
      const to = node(target);
      edges.push({ from: prev, to, ...(label?.trim() ? { label: label.trim() } : {}) });
      prev = to;
    }
  }
  const label = (id: string) => (id === "[*]" ? (kind === "state" ? "Start" : id) : (names.get(id) ?? id));
  const named = edges.map((e) => ({
    from: e.from === "[*]" ? "Start" : label(e.from),
    to: e.to === "[*]" ? "End" : label(e.to),
    ...(e.label ? { label: e.label } : {}),
  }));
  return { kind, shapes: [...names.keys()].filter((k) => k !== "[*]").map(label), edges: named };
}
