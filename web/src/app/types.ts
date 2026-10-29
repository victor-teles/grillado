import type { CommentThread, Suggestion } from "../../../src/core/comments.ts";
import type { Entry } from "../../../src/core/activity.ts";
import type { DiagramRun } from "../../../src/core/diagrams.ts";
import type { AddPlanRun } from "../../../src/core/addplan.ts";
// Mirrors of what the local server sends. Kept separate from server code on purpose.
export type ProviderId = "claude" | "codex" | "grok" | "pi";
export type FailureCode = "auth" | "rate_limit" | "timeout" | "not_found" | "malformed" | "unknown";

export interface ProviderView {
  id: ProviderId;
  displayName: string;
  installHint: string;
  loginHint: string;
  status: "ready" | "missing" | "broken" | "outdated";
  version?: string;
  reason?: string;
}

export interface SessionSummary {
  id: string;
  idea: string;
  /** Imported plans: the title the row had in Found (Recent shows it instead of the idea). */
  title?: string;
  status: SessionStatus;
  rounds: number;
  decisions: number;
  /** Open decisions listed in the plan (wrapped up early). */
  open?: number;
  updatedAt: string;
  /** The MCP client that started it with start_plan (v1.2 item 1). */
  from?: string;
  /** Started over MCP and not opened yet: its first round starts when it is. */
  queued?: boolean;
  /** Imported from a source found in the project (v1.3 item 1 §6). */
  source?: { app: SourceApp; kind: SourceKind };
  /** The plan's export (friction 26): its parent issue, else how many issues it sent. */
  issues?: { parent: { number?: number; identifier?: string } | null; items: Record<string, unknown> } | null;
}

// ---------------------------------------------------------------- found in this project (v1.3 item 1)
export type SourceApp = "claude" | "codex" | "cursor" | "file";
export type SourceKind = "session" | "plan";
export interface FoundRow {
  id: string;
  app: SourceApp;
  kind: SourceKind;
  title: string;
  path: string;
  relPath?: string;
  subfolder?: string;
  branch?: string;
  date: string;
  questions: number;
  decisions: number;
  answers?: number;
  hasPlan: boolean;
  status: "new" | "imported" | "changed" | "in_progress" | "error";
  importable: "structured" | "agent";
  planId?: string;
  compacted?: boolean;
  unanswered?: number;
  error?: string;
}
export interface FoundProject {
  root: string;
  name: string;
  git: boolean;
  branch?: string;
  sha?: string;
}
export type FoundView =
  | { enabled: false; reason: string }
  | {
      enabled: true;
      state: "off" | "idle" | "scanning" | "done";
      /** The rows are the last launch's, re-checked quietly. */
      cached: boolean;
      project: FoundProject | null;
      hidden: boolean;
      partial: boolean;
      scannedAt: string | null;
      ms: number | null;
      paths: number | null;
      rows: FoundRow[];
      agent: { running: string | null; waiting: string[]; failed: Record<string, string> };
    };
export interface ImportReply {
  planId: string;
  result: "created" | "updated" | "unchanged" | "conflict";
  url: string;
}

/** How an editor starts `grillado mcp` (server-provided, handoff §2a). */
export interface McpLaunch {
  command: string;
  args: string[];
  env?: { GRILLADO_HOME: string };
  line: string;
}

export interface AppState {
  providers: ProviderView[];
  selected: ProviderId | null;
  needsPicker: boolean;
  remembered: ProviderId | null;
  sessions: SessionSummary[];
  dataDir: string;
  /** Found in this project, sent with the first state so Home paints its space at once (v1.3 item 1). */
  found?: FoundView;
  /** How an editor starts `grillado mcp`; always sent. */
  mcp: McpLaunch;
}

export type SessionStatus = "asking" | "answering" | "confirm" | "synthesizing" | "plated";

export interface Option {
  id: string;
  label: string;
  description: string;
}
export interface Question {
  key: string;
  /** Short noun phrase for the tree and decision lists ("Sync", "Who can join"). */
  label: string;
  title: string;
  body: string;
  options: Option[];
  recommendedOptionId: string;
  dependsOn: string[];
}
export interface Answer {
  questionId: string;
  optionId: string;
  text?: string;
  accepted_recommendation: boolean;
}
export interface Upcoming {
  key: string;
  label: string;
  dependsOn: string[];
}
export interface Round {
  n: number;
  questions: Question[];
  summary: string;
  upcoming?: Upcoming[];
  answers?: Answer[];
  askedAt: string;
  answeredAt?: string;
  /** A re-ask of reopened or stale decisions: it doesn't count toward the cap (#33). */
  reask?: boolean;
}
export interface Decision {
  key: string;
  round: number;
  label?: string;
  title: string;
  answer: string;
  kind: "option" | "other" | "unknown";
  accepted_recommendation: boolean;
  dependsOn: string[];
  reopened?: boolean;
}
export interface StaleDecision {
  key: string;
  label: string;
  title: string;
  answer: string;
  round: number;
  dependsOn: string[];
  reason: string;
}

export type NodeStatus = "settled" | "frontier" | "blocked" | "stale" | "idea";
export interface DecisionNode {
  id: string;
  label: string;
  status: NodeStatus;
  parentId: string | null;
  dependsOn: string[];
  depth: number;
  openedInRound: number;
  questionId?: string;
  questionIndex?: number;
  answer?: { round: number; questionId: string; label: string; kind: "option" | "other" | "unknown"; acceptedRecommendation: boolean; reopened?: boolean };
  waitsOn?: string[];
  staleReason?: string;
}
export type HeatLevel = 1 | 2 | 3 | 4 | 5;
export interface TreeState {
  rootId: string;
  nodes: DecisionNode[];
  counts: { settled: number; open: number };
  heat: HeatLevel;
}
export interface SessionView {
  id: string;
  /** Snapshot order from the server: a higher one is newer. */
  rev?: number;
  /** When the agent's current turn started (a send or a retry); only while busy. */
  runAt?: string;
  createdAt: string;
  updatedAt: string;
  provider: ProviderId;
  idea: string;
  context: string;
  status: SessionStatus;
  rounds: Round[];
  decisions: Record<string, Decision>;
  reopened: string[];
  stale?: Record<string, StaleDecision>;
  wrappedUp: boolean;
  /** Why Confirm opened without a wrap (#33): the cap, or the agent had nothing left to ask. */
  stop?: "cap" | "empty";
  /** Ask 1 more round was granted (#37). */
  extra?: boolean;
  keepGoing?: boolean;
  summary: string;
  error?: { code: FailureCode; message: string };
  plan?: {
    title: string;
    markdown: string;
    path: string;
    openDecisions: string[];
    createdAt?: string;
    editedAt?: string;
    /** Decisions being asked again after an inline change; the plan is read-only meanwhile. */
    waiting?: string[];
    /** Set when plan.md was reloaded after a change made outside Grillado. */
    reloadedAt?: string;
    /** `answer:` lines changed outside Grillado, waiting for the user (DECISIONS #26). */
    external?: { key: string; from: string; to: string; deps: string[] }[];
  };
  busy: boolean;
  /** "Apply feedback" is running: the plan is read-only until it's done. */
  applying?: boolean;
  comments?: CommentThread[];
  suggestions?: Suggestion[];
  reviewUndo?: { action: "accept" | "reject"; items: Suggestion[] };
  /** "Add diagrams" (item 5): the last run, and whether one is going now. */
  diagramRun?: DiagramRun;
  drawing?: boolean;
  /** "Add to plan" (#104): the last run, and whether one is going now. */
  addPlanRun?: AddPlanRun;
  adding?: boolean;
  progress?: string;
  /** The activity log (item 6): the latest entries, newest first. */
  activity?: ActivityView;
  /** Imported from a source found in the project (v1.3 item 1). */
  source?: { app: SourceApp; kind: SourceKind; importedAt: string; questions: number; compacted?: boolean; viaAgent?: boolean };
  /** §5: whether that source is still the same, changed, or gone; `row` is what Update re-imports. */
  sourceInfo?: { state: "current" | "changed" | "gone"; row: string; date?: string } | null;
  /** "Using Grok · Claude Code isn’t installed": an import running on a stand-in agent (demo finding MUST 2). */
  agentNote?: string;
  tree: TreeState;
  /** `--max-rounds` of the running app (#32). */
  maxRounds: number;
  /** "Send to issues" (v1.3 item 2): the plan's links, and the run going now or last finished. */
  issues?: PlanIssues | null;
  issuesRun?: ExportRun;
}

// Mirrors src/core/issues.ts (importing it would pull session.ts and node types into the web build).
export type Tracker = "github" | "linear";
export type SplitSource = "agent" | "todos" | "stories" | "none";
export interface IssueItem {
  key: string;
  title: string;
  body: string;
  covers: string[];
  sections: string[];
  cut?: boolean;
}
export interface IssueLink {
  id: string;
  number?: number;
  identifier?: string;
  url: string;
  contentHash: string;
  unattached?: boolean;
}
export interface PlanIssues {
  tracker: Tracker;
  target: string;
  host?: string;
  targetName?: string;
  projectId?: string;
  labels: string[];
  parent?: IssueLink;
  items: Record<string, IssueLink>;
  failed?: Record<string, string>;
  exportedAt: string;
}
export interface Planned {
  key: string;
  change: "new" | "unchanged" | "update" | "edited" | "missing" | "removed";
  link?: IssueLink;
  failed?: string;
}
/** Mirrors src/cli/issues/service.ts ExportRun. */
export type RowStatus = "waiting" | "creating" | "updating" | "created" | "updated" | "unchanged" | "skipped" | "edited" | "failed";
export interface ExportRun {
  state: "running" | "done";
  tracker: Tracker;
  target: string;
  name: string;
  rows: { key: string; status: RowStatus; url?: string; number?: number; identifier?: string; message?: string }[];
  startedAt: string;
  ms?: number;
}

export type { AddPlanRun, CommentThread, DiagramRun, Suggestion };
export type { Entry as ActivityEntry };
export interface ActivityView {
  entries: Entry[];
  total: number;
  /** The session started before 1.1: earlier work wasn't logged. */
  legacy: boolean;
}

export const UNKNOWN_OPTION = "__unknown";
export const OTHER_OPTION = "__other";
