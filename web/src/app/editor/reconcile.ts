// What to do when the server sends a plan text that isn't what the editor shows (Q5).
// DOM-free so the rules are unit-tested.

export type Incoming =
  /** Nothing new (what we last saved, or our own save echoing back over SSE). */
  | "ignore"
  /** No unsaved edits here: take the new text (and say so if it came from outside). */
  | "adopt"
  /** Both sides changed: ask which version to keep. */
  | "conflict";

export interface DraftState {
  /** Last text the server confirmed. */
  lastSaved: string;
  /** Edits not yet confirmed. */
  dirty: boolean;
  /** Texts this tab has sent and the server may echo back. */
  sent: ReadonlySet<string>;
  /** What the editor shows now. */
  text: string;
}

export function reconcile(d: DraftState, incoming: string): Incoming {
  if (incoming === d.lastSaved || incoming === d.text || d.sent.has(incoming)) return "ignore";
  return d.dirty ? "conflict" : "adopt";
}
