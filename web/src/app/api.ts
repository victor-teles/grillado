import type { AppState, SessionView } from "./types";

export class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}

async function call<T>(method: "GET" | "POST", path: string, body?: unknown): Promise<T> {
  let res: Response;
  try {
    res = await fetch(path, {
      method,
      credentials: "same-origin",
      headers: method === "POST" ? { "content-type": "application/json" } : undefined,
      body: method === "POST" ? JSON.stringify(body ?? {}) : undefined,
    });
  } catch {
    throw new ApiError("Grillado isn't running.", 0);
  }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new ApiError(data?.error ?? `Request failed (${res.status})`, res.status);
  return data as T;
}

export const api = {
  state: () => call<AppState>("GET", "/api/state"),
  rescan: () => call<AppState>("POST", "/api/rescan"),
  selectProvider: (id: string, remember: boolean) => call<AppState>("POST", "/api/provider", { id, remember }),
  quit: () => call<{ ok: true }>("POST", "/api/quit"),
  createSession: (idea: string, context: string) => call<SessionView>("POST", "/api/sessions", { idea, context }),
  session: (id: string) => call<SessionView>("GET", `/api/sessions/${encodeURIComponent(id)}`),
  action: (id: string, action: string, body?: unknown) =>
    call<SessionView>("POST", `/api/sessions/${encodeURIComponent(id)}/${action}`, body),
};

export type ServerEvent =
  | { type: "session"; session: SessionView }
  | { type: "progress"; sessionId: string; label: string }
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
