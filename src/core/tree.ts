import { type Session, currentRound } from "./session.ts";
import { openFloor } from "./floor.ts";

/*
 * The decision tree the UI draws (side panel, mobile strip, confirm and plan screens). It is derived
 * from the session file on every change and never stored, so it can't drift from the answers.
 * Shape follows the design handoff (TREE.md §6).
 */

export type NodeStatus = "settled" | "frontier" | "blocked" | "stale";

export interface DecisionNode {
  id: string;
  label: string;
  status: NodeStatus | "idea";
  parentId: string | null;
  dependsOn: string[];
  depth: number;
  openedInRound: number;
  /** Set while frontier: the card in the open round (index is 0-based). */
  questionId?: string;
  questionIndex?: number;
  answer?: {
    round: number;
    questionId: string;
    label: string;
    kind: "option" | "other" | "unknown";
    acceptedRecommendation: boolean;
    reopened?: boolean;
  };
  /** Labels of unsettled prerequisites (blocked nodes). */
  waitsOn?: string[];
  staleReason?: string;
}

export interface TreeState {
  rootId: string;
  nodes: DecisionNode[];
  counts: { settled: number; open: number };
  heat: HeatLevel;
}

export type HeatLevel = 1 | 2 | 3 | 4 | 5;

export const ROOT_ID = "__idea";

/**
 * Heat is derived, never stored: 5 when nothing is open, otherwise 1–4 by the settled share. It
 * drops when a round uncovers more open decisions than it settles (decision 5). No percentages.
 */
export function heatLevel(settled: number, open: number): HeatLevel {
  if (settled + open === 0) return 1;
  if (open === 0) return 5;
  return (1 + Math.floor((3.999 * settled) / (settled + open))) as HeatLevel;
}

interface Meta {
  key: string;
  label: string;
  dependsOn: string[];
  round: number;
  order: number;
}

export function buildTree(s: Session): TreeState {
  const meta = new Map<string, Meta>();
  let order = 0;
  const register = (key: string, label: string, dependsOn: string[], round: number) => {
    const known = meta.get(key);
    if (known) {
      // Questions are authoritative over earlier "upcoming" hints; keep the original position.
      if (label) known.label = label;
      known.dependsOn = dependsOn;
      return;
    }
    meta.set(key, { key, label, dependsOn, round, order: order++ });
  };
  for (const r of s.rounds) {
    for (const q of r.questions) register(q.key, q.label?.trim() || shortLabel(q.title), q.dependsOn, r.n);
    for (const u of r.upcoming ?? []) if (!meta.has(u.key)) register(u.key, u.label, u.dependsOn, r.n);
  }

  const open = currentRound(s);
  const frontier = new Map((open?.questions ?? []).map((q, i) => [q.key, i]));
  const latest = s.rounds.at(-1);
  // Every upcoming item no round asked stays open (the floor, #40), so the side count matches Confirm and the plan.
  const upcomingNow = new Set([...(latest?.upcoming ?? []).map((u) => u.key), ...openFloor(s).filter((f) => !f.asked).map((f) => f.key)]);
  const stale = s.stale ?? {};

  const statusOf = (key: string): NodeStatus | null => {
    if (s.decisions[key]) return "settled";
    if (frontier.has(key)) return "frontier";
    if (stale[key]) return "stale";
    if (upcomingNow.has(key)) return "blocked";
    return null; // an old hint the agent dropped, or an unanswered question from a dropped round
  };

  const visible = [...meta.values()].filter((m) => statusOf(m.key)).sort((a, b) => a.order - b.order);
  // Stale decisions from rounds that were dropped entirely still need a row.
  for (const st of Object.values(stale)) {
    if (!meta.has(st.key) && !s.decisions[st.key]) {
      const m = { key: st.key, label: st.label, dependsOn: st.dependsOn, round: st.round, order: order++ };
      meta.set(st.key, m);
      visible.push(m);
    }
  }
  const visibleKeys = new Set(visible.map((m) => m.key));
  const labelOf = (k: string) => s.decisions[k]?.label || meta.get(k)?.label || stale[k]?.label || k;

  // Primary parent: the visible prerequisite that appears last (the one that unlocked it). Only
  // earlier rows qualify, which keeps the outline a tree even if the agent's graph has a cycle.
  const parentOf = new Map<string, string>();
  for (const m of visible) {
    const deps = m.dependsOn.filter((d) => visibleKeys.has(d) && meta.get(d)!.order < m.order);
    deps.sort((a, b) => meta.get(b)!.order - meta.get(a)!.order);
    parentOf.set(m.key, deps[0] ?? ROOT_ID);
  }
  const children = new Map<string, Meta[]>();
  for (const m of visible) {
    const p = parentOf.get(m.key)!;
    children.set(p, [...(children.get(p) ?? []), m]);
  }

  const nodes: DecisionNode[] = [
    { id: ROOT_ID, label: s.idea.split("\n")[0].slice(0, 120), status: "idea", parentId: null, dependsOn: [], depth: 0, openedInRound: 0 },
  ];
  const walk = (parent: string, depth: number) => {
    for (const m of children.get(parent) ?? []) {
      const status = statusOf(m.key)!;
      const d = s.decisions[m.key];
      const node: DecisionNode = {
        id: m.key,
        label: labelOf(m.key),
        status,
        parentId: parent,
        dependsOn: m.dependsOn,
        depth,
        openedInRound: m.round,
      };
      if (status === "settled" && d) {
        node.answer = {
          round: d.round,
          questionId: d.key,
          label: d.answer,
          kind: d.kind,
          acceptedRecommendation: d.accepted_recommendation,
          ...(d.reopened ? { reopened: true } : {}),
        };
      } else if (status === "frontier") {
        node.questionId = m.key;
        node.questionIndex = frontier.get(m.key);
      } else if (status === "blocked") {
        node.waitsOn = m.dependsOn.filter((k) => !s.decisions[k]).map(labelOf);
      } else if (status === "stale") {
        node.staleReason = stale[m.key].reason;
      }
      nodes.push(node);
      walk(m.key, depth + 1);
    }
  };
  walk(ROOT_ID, 1);

  const settled = nodes.filter((n) => n.status === "settled").length;
  const openCount = nodes.filter((n) => n.status === "frontier" || n.status === "blocked" || n.status === "stale").length;
  return { rootId: ROOT_ID, nodes, counts: { settled, open: openCount }, heat: heatLevel(settled, openCount) };
}

/** Fallback label for agents that skip it: the title without the question mark, trimmed to a few words. */
export function shortLabel(title: string): string {
  const words = title.replace(/[?.!]+$/, "").split(/\s+/);
  return words.length <= 5 ? words.join(" ") : `${words.slice(0, 5).join(" ")}…`;
}
