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

// Scroll anchoring (§1 #97 rendering): the rail follows the streamed text only if it was already at
// the bottom. "Already" means before the user's message and the replying row grew the rail, so the
// answer is kept per scroll box from its own scroll events (and noted when a reply is sent), not
// measured at paint time.
const pinned = new WeakMap<Element, boolean>();
const atBottom = (box: HTMLElement) => box.scrollHeight - box.scrollTop - box.clientHeight < 4;
if (typeof document !== "undefined")
  document.addEventListener(
    "scroll",
    (e) => {
      if (e.target instanceof HTMLElement) pinned.set(e.target, atBottom(e.target));
    },
    { capture: true, passive: true },
  );

/** The scrolling box around `el` (the rail, or the phone sheet). */
export function scrollBox(el: Element | null): HTMLElement | null {
  for (let p = el?.parentElement; p; p = p.parentElement) {
    const o = getComputedStyle(p).overflowY;
    if (o === "auto" || o === "scroll") return p;
  }
  return null;
}

/** Call before a reply is sent, while the rail still shows where the reader is. */
export function notePinned(el: Element | null) {
  const box = scrollBox(el);
  if (box) pinned.set(box, atBottom(box));
}

/** Whether the box was at the bottom when the reader last left it. */
export function wasPinned(box: HTMLElement): boolean {
  return pinned.get(box) ?? atBottom(box);
}
