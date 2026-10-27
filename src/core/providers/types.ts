import type { FailureCode } from "../classify.ts";

export type ProviderId = "claude" | "codex" | "grok" | "pi";
export const PROVIDER_IDS: ProviderId[] = ["claude", "codex", "grok", "pi"];

export type Detection =
  | { status: "ready"; version: string; path: string; /** Name the binary reports for itself, e.g. "2.1.3 (Claude Code)". */ name?: string }
  | { status: "missing" }
  | { status: "broken" | "outdated"; version?: string; path?: string; reason: string };

export interface RunRequest {
  kind: "round" | "synthesis" | "comment" | "edit" | "diagram" | "addplan";
  /** Hidden method, server-only. */
  systemPrompt: string;
  /** Compact tree state + latest answers. */
  userPrompt: string;
  /** Derived from the Zod schema. */
  jsonSchema: object;
  /** Empty temp dir per session. */
  cwd: string;
  model?: string;
  timeoutMs: number;
  /**
   * Stream this top-level string field of the reply as `text-delta` events, where the provider gives
   * real deltas (#97: Claude Code only for now). Providers that can't ignore it and reply whole.
   */
  stream?: { field: string };
}

export type ProviderEvent =
  | { type: "progress"; label: string }
  /** More of the streamed field's text, appended to what came before (#97). Provider-agnostic. */
  | { type: "text-delta"; text: string }
  /** The provider started the reply over (e.g. its own schema retry): drop the streamed text. */
  | { type: "text-reset" }
  | { type: "result"; raw: unknown }
  | { type: "error"; code: FailureCode; message: string };

export interface ProviderAdapter {
  id: ProviderId;
  displayName: string;
  bin: string;
  installHint: string;
  loginHint: string;
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
