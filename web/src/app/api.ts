import type { ActivityView, AppState, ExportRun, FoundView, ImportReply, IssueItem, PlanIssues, Planned, SessionView, SplitSource, Tracker } from "./types";

export class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly data: Record<string, unknown> = {},
  ) {
    super(message);
  }
}

async function call<T>(method: "GET" | "POST", path: string, body?: unknown, init?: RequestInit): Promise<T> {
  let res: Response;
  try {
    res = await fetch(path, {
      ...init,
      method,
      credentials: "same-origin",
      headers: method === "POST" ? { "content-type": "application/json" } : undefined,
      body: method === "POST" ? JSON.stringify(body ?? {}) : undefined,
    });
  } catch {
    throw new ApiError("Grillado isn't running.", 0);
  }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new ApiError(data?.error ?? `Request failed (${res.status})`, res.status, data ?? {});
  return data as T;
}

export const api = {
  state: () => call<AppState>("GET", "/api/state"),
  rescan: () => call<AppState>("POST", "/api/rescan"),
  selectProvider: (id: string, remember: boolean) => call<AppState>("POST", "/api/provider", { id, remember }),
  quit: () => call<{ ok: true }>("POST", "/api/quit"),
  createSession: (idea: string, context: string) => call<SessionView>("POST", "/api/sessions", { idea, context }),
  session: (id: string) => call<SessionView>("GET", `/api/sessions/${encodeURIComponent(id)}`),
  /** Autosave of the edited plan. Small bodies use `keepalive` so a save started while leaving the page still lands. */
  savePlan: (id: string, markdown: string, base?: string, reask?: boolean) =>
    call<{ ok: true; savedAt: string; reasked?: string[]; markdown?: string }>(
      "POST",
      `/api/sessions/${encodeURIComponent(id)}/plan`,
      { markdown, base, ...(reask ? { reask: true } : {}) },
      { keepalive: markdown.length < 60_000 },
    ),
  found: () => call<FoundView>("GET", "/api/found"),
  foundRescan: () => call<FoundView>("POST", "/api/found/rescan"),
  foundDismiss: (hidden: boolean) => call<FoundView>("POST", "/api/found/dismiss", { hidden }),
  foundImport: (id: string) => call<ImportReply>("POST", "/api/found/import", { id }),
  foundStop: (id: string) => call<FoundView>("POST", "/api/found/stop", { id }),
  activity: (id: string, limit: number) => call<ActivityView>("GET", `/api/sessions/${encodeURIComponent(id)}/activity?limit=${limit}`),
  action: (id: string, action: string, body?: unknown) =>
    call<SessionView>("POST", `/api/sessions/${encodeURIComponent(id)}/${action}`, body),
};

const sid = (id: string) => `/api/sessions/${encodeURIComponent(id)}/issues`;
const qs = (o: Record<string, string | undefined>) => new URLSearchParams(Object.entries(o).filter((e): e is [string, string] => !!e[1])).toString();
/** "Send to issues" (v1.3 item 2). Only `export` and `retry` write to a tracker; everything else reads. */
export const issuesApi = {
  state: (id: string) => call<IssuesState>("GET", sid(id)),
  split: (id: string, tracker: Tracker, fallback?: boolean) => call<Preview & { failed?: string; empty?: boolean; stopped?: boolean }>("POST", `${sid(id)}/split`, { tracker, ...(fallback ? { use: "fallback" } : {}) }),
  preview: (id: string, body: DestBody) => call<Preview>("POST", `${sid(id)}/preview`, body),
  export: (id: string, body: DestBody & { selected: string[]; overwrite: string[]; newLabels: string[] }) => call<{ run: ExportRun }>("POST", `${sid(id)}/export`, body),
  retry: (id: string) => call<{ run: ExportRun }>("POST", `${sid(id)}/retry`),
  ghStatus: (host: string) => call<GhStatus>("GET", `/api/github/status?${qs({ host })}`),
  ghRepos: (host: string) => call<{ repos: string[] }>("GET", `/api/github/repos?${qs({ host })}`),
  ghRepo: (repo: string, host: string) => call<RepoInfo>("GET", `/api/github/repo?${qs({ repo, host })}`),
  ghLabels: (repo: string, host: string) => call<{ labels: { name: string; color?: string }[] }>("GET", `/api/github/labels?${qs({ repo, host })}`),
  linearConnect: (key: string) => call<LinearView>("POST", "/api/linear/connect", { key }),
  linearDisconnect: () => call<LinearView>("POST", "/api/linear/disconnect"),
  linearTeams: () => call<{ teams: { id: string; name: string; key?: string }[] }>("GET", "/api/linear/teams"),
  linearProjects: (team: string) => call<{ projects: { id: string; name: string }[] }>("GET", `/api/linear/projects?${qs({ team })}`),
  linearLabels: (team: string) => call<{ labels: { id: string; name: string; color?: string }[] }>("GET", `/api/linear/labels?${qs({ team })}`),
};
export type LinearView = { connected: false } | { connected: true; name: string; last4: string };
export type GhStatus = { state: "missing" } | { state: "auth"; version: string; host: string; command: string } | { state: "ready"; version: string; host: string; user: string; subIssues: string };
export interface RepoInfo {
  repo: string;
  visibility: string;
  access: boolean;
  upstream?: string;
}
export interface IssuesState {
  destination: { tracker: Tracker; why?: "no-remote" | "no-gh" };
  github: { origin?: { host: string; repo: string }; upstream?: { host: string; repo: string }; host: string };
  labels: Record<string, string[]>;
  linear: LinearView;
  issues: PlanIssues | null;
  run: ExportRun | null;
  split: { source: SplitSource; at: string } | null;
}
export interface Preview {
  source: SplitSource;
  /** What "Use … instead" gives: the stories, the to-dos, or the parent alone. */
  fallback?: SplitSource;
  /** {agent}'s split was made from an older version of the plan. */
  stale?: boolean;
  /** The plan's decision count: with none, {agent} groups the plan's work into slices (review r5, #188). */
  decisions: number;
  dropped: number;
  items: IssueItem[];
  changes: Planned[];
  removed?: Record<string, string>;
}
export interface DestBody {
  tracker: Tracker;
  repo?: string;
  host?: string;
  team?: string;
  teamName?: string;
  project?: string;
  labels: string[];
  titles?: Record<string, string>;
}

export type ServerEvent =
  | { type: "session"; session: SessionView }
  | { type: "progress"; sessionId: string; label: string }
  /** A comment reply's text so far, where the agent streams (#97); "" when it starts over. */
  | { type: "reply-text"; sessionId: string; threadId: string; text: string }
  | { type: "app" }
  /** The project scan or an agent import changed (v1.3 item 1). */
  | { type: "found" };

/** Found in this project listens here; the one event stream feeds it (no second connection). */
export const foundListeners = new Set<() => void>();

/** Live updates. Calls `onDown` when the server is gone (Ctrl+C or Quit). */
export function subscribe(onEvent: (e: ServerEvent) => void, onDown: () => void): () => void {
  const source = new EventSource("/api/events");
  source.onmessage = (m) => {
    try {
      const e = JSON.parse(m.data) as ServerEvent;
      if (e.type === "found") for (const f of foundListeners) f();
      onEvent(e);
    } catch {
      // ignore malformed frames
    }
  };
  source.onerror = () => {
    api.state().then(
      () => {},
      (err) => {
        if (err instanceof ApiError && err.status === 0) {
          source.close();
          onDown();
        }
      },
    );
  };
  return () => source.close();
}
