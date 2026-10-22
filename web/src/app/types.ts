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
  status: SessionStatus;
  rounds: number;
  decisions: number;
  updatedAt: string;
}

export interface AppState {
  providers: ProviderView[];
  selected: ProviderId | null;
  needsPicker: boolean;
  remembered: ProviderId | null;
  sessions: SessionSummary[];
  dataDir: string;
}

export type SessionStatus = "asking" | "answering" | "confirm" | "synthesizing" | "plated";

export interface Option {
  id: string;
  label: string;
  description: string;
}
export interface Question {
  key: string;
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
export interface Round {
  n: number;
  questions: Question[];
  summary: string;
  answers?: Answer[];
}
export interface Decision {
  key: string;
  round: number;
  title: string;
  answer: string;
  kind: "option" | "other" | "unknown";
  accepted_recommendation: boolean;
  dependsOn: string[];
}
export interface SessionView {
  id: string;
  provider: ProviderId;
  idea: string;
  context: string;
  status: SessionStatus;
  rounds: Round[];
  decisions: Record<string, Decision>;
  reopened: string[];
  wrappedUp: boolean;
  summary: string;
  error?: { code: FailureCode; message: string };
  plan?: { title: string; markdown: string; path: string; openDecisions: string[] };
  busy: boolean;
  progress?: string;
}

export const UNKNOWN_OPTION = "__unknown";
export const OTHER_OPTION = "__other";
