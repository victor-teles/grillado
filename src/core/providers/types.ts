import type { FailureCode } from "../classify.ts";

export type ProviderId = "claude" | "codex" | "grok" | "pi";
export const PROVIDER_IDS: ProviderId[] = ["claude", "codex", "grok", "pi"];

export type Detection =
  | { status: "ready"; version: string; path: string }
  | { status: "missing" }
  | { status: "broken" | "outdated"; version?: string; path?: string; reason: string };

export interface RunRequest {
  kind: "round" | "synthesis";
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
}

export type ProviderEvent =
  | { type: "progress"; label: string }
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
