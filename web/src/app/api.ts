import type { ActivityView, AppState, SessionView } from "./types";

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
  activity: (id: string, limit: number) => call<ActivityView>("GET", `/api/sessions/${encodeURIComponent(id)}/activity?limit=${limit}`),
  action: (id: string, action: string, body?: unknown) =>
    call<SessionView>("POST", `/api/sessions/${encodeURIComponent(id)}/${action}`, body),
};

export type ServerEvent =
  | { type: "session"; session: SessionView }
  | { type: "progress"; sessionId: string; label: string }
  /** A comment reply's text so far, where the agent streams (#97); "" when it starts over. */
  | { type: "reply-text"; sessionId: string; threadId: string; text: string }
  | { type: "app" };

/** Live updates. Calls `onDown` when the server is gone (Ctrl+C or Quit). */
export function subscribe(onEvent: (e: ServerEvent) => void, onDown: () => void): () => void {
  const source = new EventSource("/api/events");
  source.onmessage = (m) => {
    try {
      onEvent(JSON.parse(m.data));
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
