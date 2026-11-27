import type { FailureCode } from "../classify.ts";

export type ProviderId = "claude" | "codex" | "grok" | "pi";
export const PROVIDER_IDS: ProviderId[] = ["claude", "codex", "grok", "pi"];

export type Detection =
  | { status: "ready"; version: string; path: string; /** Name the binary reports for itself, e.g. "2.1.3 (Claude Code)". */ name?: string }
  | { status: "missing" }
  | { status: "broken" | "outdated"; version?: string; path?: string; reason: string };

export interface RunRequest {
  kind: "round" | "synthesis" | "comment" | "edit" | "diagram" | "addplan" | "import" | "split" | "another";
  /** Hidden method, server-only. */
  systemPrompt: string;
  /** Compact tree state + latest answers. */
  userPrompt: string;
  /** Derived from the Zod schema. */
  jsonSchema: object;
  /** Empty temp dir per session, or the project's read root when `access` is "read" (plan 002). */
  cwd: string;
  /**
   * "read": the agent may read files under `cwd` and nothing more (no writes, no commands Grillado
   * gives it, no network). Absent or "none": tools off, as always. Only rounds and the plan use "read".
   */
  access?: "none" | "read";
  model?: string;
  timeoutMs: number;
  /**
   * Stream this top-level string field of the reply as `text-delta` events, where the provider gives
   * real deltas (#97: Claude Code only for now). Providers that can't ignore it and reply whole.
   */
  stream?: { field: string };
  /**
   * Report the agent's file reads and searches as `activity` events while it works (plan 003), where
   * the CLI prints its tool calls (Claude Code only for now). Others ignore it.
   */
  watch?: boolean;
}

/** What a reading agent is doing right now: a file it opened, or a search or listing it ran. */
export type Activity = { action: "read" | "search" | "list"; target: string };

export type ProviderEvent =
  | { type: "progress"; label: string }
  /** More of the streamed field's text, appended to what came before (#97). Provider-agnostic. */
  | { type: "text-delta"; text: string }
  /** The provider started the reply over (e.g. its own schema retry): drop the streamed text. */
  | { type: "text-reset" }
  /** A file read or search the agent started (plan 003). The target is untrusted: paths are checked by the caller. */
  | ({ type: "activity" } & Activity)
  | { type: "result"; raw: unknown }
  | { type: "error"; code: FailureCode; message: string };

export interface ProviderAdapter {
  id: ProviderId;
  displayName: string;
  bin: string;
  installHint: string;
  loginHint: string;
  /** How long one run may take before it times out, unless GRILLADO_TIMEOUT_MS overrides it. */
  defaultTimeoutMs?: number;
  /** The CLI can be limited to read-only file tools, so sessions may read the project (plan 002). Absent: it can't. */
  canRead?: boolean;
  detect(): Promise<Detection>;
  run(req: RunRequest, signal: AbortSignal): AsyncIterable<ProviderEvent>;
}

/** Files an adapter writes for one run; argv builders take them as input so argv stays testable. */
export interface RunFiles {
  dir: string;
  systemPromptFile: string;
  promptFile: string;
  schemaFile: string;
  outputFile: string;
}
