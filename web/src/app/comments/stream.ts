// Streamed reply text (#97), outside React state: a delta must never re-render the whole thread
// (or the plan), so the server's "reply-text" events land here and the streaming message appends
// text nodes itself, at most once per frame.

type Listener = (text: string) => void;
const texts = new Map<string, string>();
const listeners = new Map<string, Set<Listener>>();
/** Threads whose current reply streamed at least once, so "done" is announced once (§1 Done). */
const streamed = new Set<string>();

export function setReplyText(threadId: string, text: string) {
  if (texts.get(threadId) === text) return;
  texts.set(threadId, text);
  if (text) streamed.add(threadId);
  for (const l of listeners.get(threadId) ?? []) l(text);
}

export function replyText(threadId: string): string {
  return texts.get(threadId) ?? "";
}

export function onReplyText(threadId: string, l: Listener): () => void {
  let set = listeners.get(threadId);
  if (!set) listeners.set(threadId, (set = new Set()));
  set.add(l);
  return () => set!.delete(l);
}

/** True once per streamed reply: the caller announces "{agent} replied". */
export function takeStreamed(threadId: string): boolean {
  texts.delete(threadId);
  return streamed.delete(threadId);
}
