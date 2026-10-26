// v1.1 item 3: comments on the plan, Apply feedback, and suggestions to review.
//
// The selection toolbar (Comment ⌘⌥M · Edit, #27), the composer, the 368px Comments | Activity
// rail, anchors and suggestions drawn over the plan (via Markdown's DocMarks), the review bar and
// the mobile review bar (#30). Suggestions never touch the draft: the server writes an accepted one
// to plan.md and the draft adopts it, so plan.md, Copy and Download only ever hold accepted text.
//
// Styling hooks: .seltb .composer .cmk(.on) .rail.cm .rtabs .th(.on) .th .row .rempty .racc
//   ins.sg del.sg(.f) .ipill .review .toast .sheet .scrim .mtb .mbar
import { type MutableRefObject, type ReactNode, type RefObject, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { api } from "../api";
import type { DocMarks } from "../Markdown";
import { type EditorMode, type PlanDraft } from "../editor/PlanEditor";
import { cleanSelection, sourceRange } from "../editor/selection";
import { ICheck, IChev, IDown, IEdit, IMore, IMsg, IUndo, IUp, IX } from "../icons";
import type { CommentThread, SessionView, Suggestion } from "../types";
import { CCOPY, type Placed, type Row, anchorOf, canApply, fill, place, plainQuote, rowText, sectionOf, statusRow } from "./model";

const mac = typeof navigator !== "undefined" && /Mac|iPhone|iPad/.test(navigator.platform);
const MOD = mac ? "⌘" : "Ctrl+";
const ALT = mac ? "⌥" : "Alt+";
const SHIFT = mac ? "⇧" : "Shift+";
const ENTER = mac ? "↵" : "Enter";
const inField = (el: EventTarget | null) => el instanceof HTMLElement && !!el.closest("textarea, input, [contenteditable=true], .cm-editor");
const time = (iso: string) => new Date(iso).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });

interface Sel {
  quote: string;
  at: number;
  end: number;
  rect: { top: number; bottom: number; left: number; right: number };
}

/** The rendered selection inside the plan → its source range, or null (§2). */
function readSelection(root: HTMLElement, text: string): Sel | null {
  const sel = getSelection();
  if (!sel || sel.isCollapsed || !sel.rangeCount) return null;
  const range = sel.getRangeAt(0);
  const node = (n: Node) => (n instanceof HTMLElement ? n : n.parentElement);
  const a = node(range.startContainer);
  if (!a || !root.contains(a) || !root.contains(range.endContainer) || inField(a)) return null;
  if (a.closest(".blk-edit, .ped[data-readonly]")) return null;
  const blk = a.closest<HTMLElement>(".blk[data-start]");
  const hint = blk ? Number(blk.dataset.start) : 0;
  // Text without the controls and labels the plan draws over its source.
  const box = document.createElement("div");
  box.append(range.cloneContents());
  box.querySelectorAll(".blk-act, .gut, .sr-only, button, .ipill, ins.sg, .dz-meta").forEach((x) => x.remove());
  let words = cleanSelection(box.textContent ?? "").split(" ").filter(Boolean);
  if (!words.length) return null;
  // Across a decision card, the labels aren't in the source: keep the longest leading run that is.
  let r: [number, number] | null = null;
  while (words.length && !(r = sourceRange(text, words.join(" "), hint))) words = words.slice(0, -1);
  if (!r) return null;
  const rects = range.getClientRects();
  const first = rects[0] ?? range.getBoundingClientRect();
  const last = rects[rects.length - 1] ?? first;
  return { quote: text.slice(r[0], r[1]), at: r[0], end: r[1], rect: { top: first.top, bottom: last.bottom, left: first.left, right: last.right } };
}

interface Opts {
  session: SessionView;
  draft: PlanDraft;
  mode: EditorMode;
  tab: "doc" | "decisions";
  mobile: boolean;
  agentName: string;
  readOnly: boolean;
  docRef: RefObject<HTMLDivElement | null>;
  editRef: MutableRefObject<((start: number, end: number) => void) | null>;
  onShowDecision: (key: string) => void;
  setNote: (t: string) => void;
}

export function useComments(o: Opts) {
  const { session, draft, mobile, agentName } = o;
  const A = (t: string) => fill(t, agentName);
  const threads = session.comments ?? [];
  const list = session.suggestions ?? [];
  const open = threads.filter((t) => !t.resolved);
  const resolved = threads.filter((t) => t.resolved);
  const docMode = o.tab === "doc" && o.mode === "rich";

  // The rail stays open once opened, per session.
  const railKey = `grillado-rail-${session.id}`;
  const [railOpen, setRailRaw] = useState(() => !mobile && (sessionStorage.getItem(railKey) === "1" || threads.length > 0));
  const setRail = (v: boolean) => {
    sessionStorage.setItem(railKey, v ? "1" : "0");
    setRailRaw(v);
  };
  const [railTab, setRailTab] = useState<"comments" | "activity">("comments");
  const [activeId, setActive] = useState<string | null>(null);
  const [hoverId, setHover] = useState<string | null>(null);
  const [focusId, setFocus] = useState<string | null>(null);
  const [live, setLive] = useState("");
  const [toast, setToast] = useState<{ text: string; undo: boolean } | null>(null);
  const [bar, setBar] = useState("");
  const drafts = useRef(new Map<string, string>());

  // ---------- where things are in the current text ----------
  const placed = useMemo(() => place(draft.text, list), [draft.text, list]);
  const anchors = useMemo(() => open.map((t) => ({ t, r: anchorOf(draft.text, t) })), [draft.text, open]);
  const focused = placed.find((p) => p.s.id === focusId) ?? null;
  const index = focused ? placed.indexOf(focused) : -1;

  // ---------- selection toolbar + composer ----------
  const [sel, setSel] = useState<Sel | null>(null);
  const [composing, setComposing] = useState<Sel | null>(null);
  useEffect(() => {
    if (!docMode || o.readOnly) return setSel(null);
    let t: ReturnType<typeof setTimeout> | undefined;
    const read = () => {
      clearTimeout(t);
      // 120ms settle so the toolbar doesn't chase a drag (§2.1).
      t = setTimeout(() => setSel(o.docRef.current ? readSelection(o.docRef.current, draft.text) : null), 120);
    };
    const hide = () => setSel(null);
    document.addEventListener("selectionchange", read);
    const scroller = o.docRef.current;
    scroller?.addEventListener("scroll", hide, { passive: true });
    addEventListener("resize", hide);
    return () => {
      clearTimeout(t);
      document.removeEventListener("selectionchange", read);
      scroller?.removeEventListener("scroll", hide);
      removeEventListener("resize", hide);
    };
  }, [docMode, o.readOnly, draft.text, o.docRef]);

  const startComment = useCallback(
    (s: Sel | null = sel) => {
      if (!s) return;
      setComposing(s);
      setSel(null);
      if (!mobile) setRail(true);
    },
    [sel, mobile],
  );
  const editSel = () => {
    if (!sel) return;
    getSelection()?.removeAllRanges();
    o.editRef.current?.(sel.at, sel.end);
    setSel(null);
  };

  const act = async (path: string, body?: unknown) => {
    try {
      await api.action(session.id, path, body);
      return true;
    } catch (e) {
      o.setNote(String((e as Error).message));
      return false;
    }
  };
  const send = async (text: string) => {
    if (!composing) return;
    const c = composing;
    const ok = await act("comments", { quote: c.quote, at: c.at, text });
    if (ok) {
      drafts.current.delete(`${c.at}:${c.quote}`);
      setComposing(null);
      getSelection()?.removeAllRanges();
      setRailTab("comments");
    }
  };

  // ---------- review ----------
  const review = async (op: "accept" | "reject" | "undo", ids?: string[] | "all") => {
    await draft.flush();
    const next = op === "undo" || ids === "all" ? null : placed.find((p) => !ids?.includes(p.s.id) && placed.indexOf(p) > index) ?? placed.find((p) => !ids?.includes(p.s.id)) ?? null;
    const ok = await act("suggestions", { op, ids });
    if (!ok) return;
    const n = ids === "all" ? placed.length : (ids?.length ?? 0);
    if (op === "undo") {
      setBar("");
      setToast(null);
      setLive("Undone");
    } else if (ids === "all") {
      setToast({ text: CCOPY.bulk(n, op === "accept" ? "accepted" : "rejected"), undo: true });
      setFocus(null);
      setLive(CCOPY.bulk(n, op === "accept" ? "accepted" : "rejected"));
    } else {
      setBar(op === "accept" ? "Accepted" : "Rejected");
      setLive(op === "accept" ? "Accepted" : "Rejected");
      setFocus(next?.s.id ?? null);
    }
  };
  useEffect(() => {
    if (!toast) return;
    const t = setTimeout(() => setToast(null), 5000);
    return () => clearTimeout(t);
  }, [toast]);
  useEffect(() => {
    if (!bar) return;
    const t = setTimeout(() => setBar(""), 4000);
    return () => clearTimeout(t);
  }, [bar]);
  // Focus follows the focused suggestion, so a screen reader reads it (§4.3).
  useEffect(() => {
    if (!focusId) return;
    requestAnimationFrame(() => {
      const el = o.docRef.current?.querySelector<HTMLElement>(`[data-sg="${CSS.escape(focusId)}"]`);
      el?.scrollIntoView({ block: "center" });
      el?.focus({ preventScroll: true });
    });
  }, [focusId]);
  const go = (d: 1 | -1) => {
    if (!placed.length) return;
    const i = index < 0 ? (d > 0 ? 0 : placed.length - 1) : (index + d + placed.length) % placed.length;
    setFocus(placed[i].s.id);
  };
  const reviewThread = (t: CommentThread) => {
    const first = placed.find((p) => p.s.threadId === t.id);
    if (first) setFocus(first.s.id);
  };

  // A new batch of suggestions is announced (§4.2).
  const ready = useRef(new Set<string>());
  useEffect(() => {
    for (const t of threads) {
      const k = `${t.id}:${t.run?.startedAt}`;
      if (t.run?.kind === "apply" && t.run.state === "done" && !ready.current.has(k)) {
        ready.current.add(k);
        if (t.run.edits) setLive(A(CCOPY.readyLive(t.run.edits)));
      } else if (t.run?.kind === "apply" && t.run.state === "running") setLive(A(CCOPY.writingLive));
    }
  }, [threads]);

  // ---------- keyboard ----------
  const keys = useRef<(e: KeyboardEvent) => void>(() => {});
  keys.current = (e) => {
    const mod = e.metaKey || e.ctrlKey;
    if (mod && e.altKey && e.code === "KeyM") {
      e.preventDefault();
      if (o.mode === "raw") return o.setNote(CCOPY.rtfHint);
      const s = sel ?? (o.docRef.current ? readSelection(o.docRef.current, draft.text) : null);
      if (s) startComment(s);
      return;
    }
    if (e.key === "F10" && e.altKey && sel) {
      e.preventDefault();
      document.querySelector<HTMLElement>(".seltb button")?.focus();
      return;
    }
    if (!docMode || inField(e.target)) return;
    if (e.altKey && !mod && (e.key === "ArrowDown" || e.key === "ArrowUp") && placed.length) {
      e.preventDefault();
      return go(e.key === "ArrowDown" ? 1 : -1);
    }
    if (mod && e.key === "Enter" && placed.length) {
      e.preventDefault();
      if (e.shiftKey) return void review("accept", "all");
      if (focused) return void review("accept", [focused.s.id]);
    }
    if (mod && e.key === "Backspace" && placed.length) {
      e.preventDefault();
      if (e.shiftKey) return void review("reject", "all");
      if (focused) return void review("reject", [focused.s.id]);
    }
    if (mod && !e.shiftKey && e.key.toLowerCase() === "z" && session.reviewUndo && !o.docRef.current?.querySelector(".blk-edit")) {
      e.preventDefault();
      void review("undo");
    }
  };
  useEffect(() => {
    const on = (e: KeyboardEvent) => keys.current(e);
    document.addEventListener("keydown", on);
    return () => document.removeEventListener("keydown", on);
  }, []);

  // ---------- marks ----------
  const railShown = railOpen && o.tab === "doc";
  const openThread = (id: string) => {
    setActive(id);
    setRailTab("comments");
    setRail(true);
    requestAnimationFrame(() => {
      const el = document.getElementById(`th-${id}`);
      el?.scrollIntoView({ block: "nearest" });
      el?.focus({ preventScroll: true });
    });
  };
  const marks: DocMarks | undefined =
    anchors.length || placed.length || composing
      ? {
          anchors: [
            ...anchors.filter((x) => x.r).map(({ t, r }) => ({ id: t.id, start: r!.start, end: r!.end, active: activeId === t.id || hoverId === t.id, label: `Comment: ${t.messages[0]?.text.slice(0, 80) ?? ""}`, details: railShown ? `th-${t.id}` : undefined })),
            ...(composing ? [{ id: "new", start: composing.at, end: composing.end, active: true, label: "New comment" }] : []),
          ],
          edits: placed.map((p) => ({ id: p.s.id, start: p.start, end: p.end, after: p.after, focused: p.s.id === focusId })),
          onAnchor: (id) => id !== "new" && openThread(id),
          onAnchorHover: setHover,
          onEdit: (id) => setFocus(id),
          pill: (id) =>
            mobile ? null : (
              <span className="ipill" role="group" aria-label={`Suggestion ${index + 1} of ${placed.length}`} contentEditable={false}>
                <span className="ix">
                  {index + 1}/{placed.length}
                </span>
                <button type="button" className="btn quiet" aria-keyshortcuts="Meta+Enter" onClick={() => void review("accept", [id])}>
                  <ICheck s={14} />
                  Accept
                </button>
                <button type="button" className="btn quiet" aria-keyshortcuts="Meta+Backspace" onClick={() => void review("reject", [id])}>
                  <IX s={14} />
                  Reject
                </button>
              </span>
            ),
        }
      : undefined;

  // ---------- pieces ----------
  const toolbar =
    sel && docMode && !composing ? (
      <SelectionToolbar sel={sel} mobile={mobile} onComment={() => startComment()} onEdit={editSel} onClose={() => setSel(null)} />
    ) : null;
  const composer = composing ? (
    <Composer
      sel={composing}
      mobile={mobile}
      agentName={agentName}
      draftText={drafts.current.get(`${composing.at}:${composing.quote}`) ?? ""}
      onDraft={(t) => drafts.current.set(`${composing.at}:${composing.quote}`, t)}
      onCancel={() => setComposing(null)}
      onSend={send}
    />
  ) : null;

  const railBody = (
    <Rail
      tab={railTab}
      setTab={setRailTab}
      open={open}
      resolved={resolved}
      md={draft.text}
      list={list}
      agentName={agentName}
      activeId={activeId}
      hoverId={hoverId}
      setActive={setActive}
      setHover={setHover}
      act={act}
      onReview={reviewThread}
      onShowDecision={o.onShowDecision}
      pending={placed.length}
    />
  );
  const rail = !mobile && railOpen && o.tab === "doc" ? railBody : null;
  const sheet =
    mobile && railOpen ? (
      <>
        <div className="cscrim" onClick={() => setRail(false)} />
        <div className="csheet" role="dialog" aria-label="Comments" aria-modal="true">
          <div className="grab" />
          <div className="sh">
            <b>Comments</b>
            <button type="button" className="icon-btn" aria-label="Close comments" onClick={() => setRail(false)}>
              <IX s={18} />
            </button>
          </div>
          {railBody}
        </div>
      </>
    ) : null;

  const reviewBar =
    docMode && (placed.length || bar) && !composing ? (
      mobile ? (
        placed.length ? <MobileBar placed={placed} index={index} go={go} review={review} agentName={agentName} /> : null
      ) : (
        <div className="review" role="toolbar" aria-label="Review suggestions">
          {placed.length ? (
            <>
              <span className="lbl">{A(CCOPY.from(placed.length))}</span>
              <span className="nav">
                <button type="button" className="icon-btn" aria-label="Previous suggestion" aria-keyshortcuts="Alt+ArrowUp" onClick={() => go(-1)}>
                  <IUp s={16} />
                </button>
                <span className="ix">{index >= 0 ? `${index + 1} of ${placed.length}` : `– of ${placed.length}`}</span>
                <button type="button" className="icon-btn" aria-label="Next suggestion" aria-keyshortcuts="Alt+ArrowDown" onClick={() => go(1)}>
                  <IDown s={16} />
                </button>
              </span>
              {bar ? (
                <span className="note">
                  <b>{bar}</b> · {MOD}Z to undo
                </span>
              ) : null}
              <button type="button" className="btn quiet" aria-keyshortcuts="Meta+Shift+Backspace" onClick={() => void review("reject", "all")}>
                Reject all
              </button>
              <button type="button" className="btn primary" aria-keyshortcuts="Meta+Shift+Enter" onClick={() => void review("accept", "all")}>
                Accept all <span className="kb">{`${MOD}${SHIFT}${ENTER}`}</span>
              </button>
            </>
          ) : (
            <span className="note">
              <b>{bar}</b> · {MOD}Z to undo
            </span>
          )}
        </div>
      )
    ) : null;
  const toastEl = toast ? (
    <div className="toast" role="status">
      <ICheck s={16} />
      <span>{toast.text}</span>
      {toast.undo && session.reviewUndo ? (
        <button type="button" className="btn quiet" onClick={() => void review("undo")}>
          <IUndo s={14} />
          Undo
        </button>
      ) : null}
    </div>
  ) : null;
  const rawNote =
    o.tab === "doc" && o.mode === "raw" && placed.length ? (
      <div className="pbanner" data-tone="info" data-testid="raw-suggestions">
        <IMsg s={16} />
        <span>{CCOPY.notInFile(placed.length)} · Review in Rich</span>
      </div>
    ) : null;

  const railButton =
    o.tab === "doc" && !mobile ? (
      <button
        type="button"
        className="icon-btn railbtn"
        aria-label={`Comments ${open.length || ""}`.trim()}
        aria-pressed={railOpen}
        title={railOpen ? "Hide comments" : "Show comments"}
        onClick={() => setRail(!railOpen)}
      >
        <IMsg s={16} />
        {open.length ? <span className="ct">{open.length}</span> : null}
      </button>
    ) : null;
  const menuItem = mobile ? (
    <DropdownMenuItem onSelect={() => setRail(true)}>
      <IMsg s={16} />
      Comments{open.length ? ` (${open.length})` : ""}
    </DropdownMenuItem>
  ) : null;

  return {
    marks: docMode ? marks : undefined,
    pending: placed.length,
    composing: !!composing,
    rail,
    railButton,
    menuItem,
    rawNote,
    overlay: (
      <>
        {toolbar}
        {composer}
        {sheet}
        {reviewBar ?? toastEl}
        <span className="sr-only" role="status" aria-live="polite">
          {live}
        </span>
      </>
    ),
  };
}

// ---------- selection toolbar (§2.1): Comment ⌘⌥M · Edit, nothing else (#27) ----------
function SelectionToolbar({ sel, mobile, onComment, onEdit, onClose }: { sel: Sel; mobile: boolean; onComment: () => void; onEdit: () => void; onClose: () => void }) {
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<{ top: number; left: number } | null>(null);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const w = el.offsetWidth;
    const h = el.offsetHeight;
    // 8px above the selection's start; below its end when there's no room (mobile always below).
    const above = sel.rect.top - h - 8;
    const top = mobile || above < 56 ? sel.rect.bottom + 8 : above;
    const left = Math.max(8, Math.min(innerWidth - w - 8, mobile ? (sel.rect.left + sel.rect.right) / 2 - w / 2 : sel.rect.left));
    setPos({ top, left });
  }, [sel, mobile]);
  useEffect(() => {
    const down = (e: PointerEvent) => !ref.current?.contains(e.target as Node) && !(e.target as HTMLElement).closest?.(".doc") && onClose();
    const esc = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    document.addEventListener("pointerdown", down);
    document.addEventListener("keydown", esc);
    return () => {
      document.removeEventListener("pointerdown", down);
      document.removeEventListener("keydown", esc);
    };
  }, [onClose]);
  const rove = (e: React.KeyboardEvent) => {
    if (e.key !== "ArrowRight" && e.key !== "ArrowLeft") return;
    const bs = [...(ref.current?.querySelectorAll<HTMLElement>("button") ?? [])];
    const i = bs.indexOf(document.activeElement as HTMLElement);
    bs[(i + (e.key === "ArrowRight" ? 1 : -1) + bs.length) % bs.length]?.focus();
  };
  return (
    <div
      ref={ref}
      className={mobile ? "mtb" : "seltb"}
      role="toolbar"
      aria-label="Selection"
      style={pos ? { top: pos.top, left: pos.left } : { visibility: "hidden", top: 0, left: 0 }}
      onKeyDown={rove}
      onPointerDown={(e) => e.preventDefault()}
    >
      <button type="button" className="btn quiet" aria-keyshortcuts="Meta+Alt+M" onClick={onComment}>
        <IMsg s={16} />
        Comment
        {mobile ? null : <span className="kb">{`${MOD}${ALT}M`}</span>}
      </button>
      {mobile ? null : (
        <>
          <span className="sep" />
          <button type="button" className="btn quiet" tabIndex={-1} onClick={onEdit}>
            <IEdit s={16} />
            Edit
          </button>
        </>
      )}
    </div>
  );
}

// ---------- composer (§2.2) ----------
function Composer({
  sel,
  mobile,
  agentName,
  draftText,
  onDraft,
  onCancel,
  onSend,
}: {
  sel: Sel;
  mobile: boolean;
  agentName: string;
  draftText: string;
  onDraft: (t: string) => void;
  onCancel: () => void;
  onSend: (t: string) => Promise<void>;
}) {
  const [text, setText] = useState(draftText);
  const [busy, setBusy] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const ta = useRef<HTMLTextAreaElement>(null);
  const [pos, setPos] = useState<{ top: number; left: number } | null>(null);
  useLayoutEffect(() => {
    ta.current?.focus();
    if (mobile || !ref.current) return;
    const h = ref.current.offsetHeight;
    const below = sel.rect.bottom + 8;
    setPos({ top: below + h > innerHeight - 8 ? Math.max(8, sel.rect.top - h - 8) : below, left: Math.max(8, Math.min(innerWidth - 380, sel.rect.left)) });
  }, [sel, mobile]);
  const submit = async () => {
    const t = text.trim();
    if (!t || busy) return;
    setBusy(true);
    await onSend(t);
    setBusy(false);
  };
  const body = (
    <>
      {mobile ? <blockquote>“{plainQuote(sel.quote)}”</blockquote> : null}
      <textarea
        ref={ta}
        aria-label="Comment"
        placeholder={fill(CCOPY.placeholder, agentName)}
        value={text}
        maxLength={2000}
        onChange={(e) => {
          setText(e.target.value);
          onDraft(e.target.value);
        }}
        onKeyDown={(e) => {
          if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
            e.preventDefault();
            void submit();
          } else if (e.key === "Escape") {
            e.preventDefault();
            e.stopPropagation();
            onCancel();
          }
        }}
      />
      <div className="cf">
        {mobile ? null : <span className="hint" />}
        <button type="button" className="btn quiet" onClick={onCancel}>
          Cancel
        </button>
        <button type="button" className="btn primary" disabled={!text.trim() || busy} aria-keyshortcuts="Meta+Enter" onClick={() => void submit()}>
          Comment {mobile ? null : <span className="kb">{`${MOD}${ENTER}`}</span>}
        </button>
      </div>
    </>
  );
  if (mobile)
    return (
      <>
        <div className="cscrim" onClick={onCancel} />
        <div className="csheet" role="dialog" aria-label="New comment" aria-modal="true">
          <div className="grab" />
          <div className="composer2">{body}</div>
        </div>
      </>
    );
  return (
    <div ref={ref} className="composer" role="dialog" aria-label="New comment" style={pos ?? { visibility: "hidden", top: 0, left: 0 }}>
      {body}
    </div>
  );
}

// ---------- rail (§3) ----------
type Act2 = (path: string, body?: unknown) => Promise<boolean>;

function Rail(p: {
  tab: "comments" | "activity";
  setTab: (t: "comments" | "activity") => void;
  open: CommentThread[];
  resolved: CommentThread[];
  md: string;
  list: Suggestion[];
  agentName: string;
  activeId: string | null;
  hoverId: string | null;
  setActive: (id: string | null) => void;
  setHover: (id: string | null) => void;
  act: Act2;
  onReview: (t: CommentThread) => void;
  onShowDecision: (key: string) => void;
  pending: number;
}) {
  const [showResolved, setShowResolved] = useState(false);
  const running = p.open.some((t) => t.run?.state === "running");
  const tabs = [
    { id: "comments" as const, label: "Comments", n: p.open.length },
    { id: "activity" as const, label: "Activity", n: 0 },
  ];
  // Open threads in plan order.
  const ordered = [...p.open].sort((a, b) => (anchorOf(p.md, a)?.start ?? a.at) - (anchorOf(p.md, b)?.start ?? b.at));
  return (
    <aside className="crail" aria-label="Comments">
      <div className="rtabs" role="tablist" aria-label="Comments and activity">
        {tabs.map((t, i) => (
          <button
            key={t.id}
            type="button"
            role="tab"
            id={`rtab-${t.id}`}
            aria-selected={p.tab === t.id}
            aria-controls={`rpanel-${t.id}`}
            tabIndex={p.tab === t.id ? 0 : -1}
            onClick={() => p.setTab(t.id)}
            onKeyDown={(e) => {
              if (e.key !== "ArrowRight" && e.key !== "ArrowLeft") return;
              e.preventDefault();
              const other = tabs[(i + 1) % 2];
              document.getElementById(`rtab-${other.id}`)?.focus();
            }}
          >
            {t.label}
            {t.id === "comments" && t.n ? <span className="c">{t.n}</span> : null}
            {t.id === "activity" && running ? <span className="dot" aria-label="running" /> : null}
          </button>
        ))}
      </div>
      <div className="rscroll" id={`rpanel-${p.tab}`} role="tabpanel" aria-labelledby={`rtab-${p.tab}`}>
        {p.tab === "activity" ? (
          <div className="rempty">
            <b>{CCOPY.activityEmpty}</b>
            <p>{CCOPY.activityBody}</p>
          </div>
        ) : !p.open.length && !p.resolved.length ? (
          <div className="rempty" data-testid="comments-empty">
            <IMsg s={20} />
            <b>{CCOPY.emptyTitle}</b>
            <p>{fill(CCOPY.emptyBody, p.agentName)}</p>
          </div>
        ) : (
          <>
            {ordered.map((t) => (
              <Thread key={t.id} t={t} {...p} />
            ))}
            {p.resolved.length ? (
              <>
                <button type="button" className="racc" aria-expanded={showResolved} onClick={() => setShowResolved(!showResolved)}>
                  <IChev s={16} />
                  Resolved {p.resolved.length}
                </button>
                {showResolved
                  ? p.resolved.map((t) => (
                      <div key={t.id} className="th col res" data-thread={t.id}>
                        <div className="one">
                          <b>{t.messages[0]?.text}</b>
                          <button type="button" className="btn quiet" onClick={() => void p.act(`comments/${t.id}/resolve`, { resolved: false })}>
                            Reopen
                          </button>
                        </div>
                        <p>“{plainQuote(t.quote)}”</p>
                      </div>
                    ))
                  : null}
              </>
            ) : null}
          </>
        )}
      </div>
    </aside>
  );
}

function Thread({ t, md, list, agentName, activeId, hoverId, setActive, setHover, act, onReview, onShowDecision }: Parameters<typeof Rail>[0] & { t: CommentThread }) {
  const A = (s: string) => fill(s, agentName);
  const [reply, setReply] = useState("");
  const lost = !anchorOf(md, t);
  const row = statusRow(t, list);
  const replying = t.run?.kind === "reply" && t.run.state === "running";
  const replyFailed = t.run?.kind === "reply" && t.run.state === "error";
  const pendingHere = list.some((s) => s.threadId === t.id && s.status === "pending");
  // After an apply run, a new reply is needed before applying again; Stop and errors have Try again.
  const applyOk = canApply(t) && !pendingHere && t.run?.kind !== "apply";
  const dropped = t.run?.kind === "apply" && t.run.state === "done" ? (t.run.dropped ?? 0) : 0;
  const sendReply = async () => {
    const text = reply.trim();
    if (!text) return;
    if (await act(`comments/${t.id}/reply`, { text })) setReply("");
  };
  return (
    <section
      id={`th-${t.id}`}
      className={`th${activeId === t.id || hoverId === t.id ? " on" : ""}`}
      data-thread={t.id}
      tabIndex={-1}
      aria-label={`Comment on ${sectionOf(md, t)}`}
      onPointerEnter={() => setHover(t.id)}
      onPointerLeave={() => setHover(null)}
      onFocus={() => setActive(t.id)}
    >
      <div className="on-l">
        <span>On “{sectionOf(md, t)}”</span>
        <span className="ia">
          <button type="button" className="btn quiet sm" onClick={() => void act(`comments/${t.id}/resolve`, { resolved: true })}>
            <ICheck s={14} />
            Resolve
          </button>
        </span>
      </div>
      <blockquote>“{plainQuote(t.quote)}”</blockquote>
      {lost ? (
        <p className="lost">
          <IMsg s={14} />
          {A(CCOPY.lost)}
        </p>
      ) : null}
      {t.messages.map((m) => (
        <div key={m.id} className="msg">
          <div className="who">
            <b>{m.by === "you" ? "You" : agentName}</b>
            <span className="m">{time(m.at)}</span>
          </div>
          <p>{m.text}</p>
        </div>
      ))}
      {replying ? (
        <div className="msg" aria-live="polite">
          <div className="who">
            <b className="m">{A(CCOPY.replying)}</b>
            <button type="button" className="btn quiet stop" onClick={() => void act(`comments/${t.id}/stop`)}>
              Stop
            </button>
          </div>
        </div>
      ) : null}
      {replyFailed ? (
        <div className="crow" role="alert">
          <span className="t m">{CCOPY.couldntReply}</span>
          <button type="button" className="btn quiet" onClick={() => void act(`comments/${t.id}/retry`)}>
            Try again
          </button>
        </div>
      ) : null}
      {row ? <StatusRow row={row} t={t} act={act} onReview={onReview} onShowDecision={onShowDecision} /> : null}
      {dropped ? (
        <div className="crow">
          <span className="t m">{CCOPY.noFit(dropped)}</span>
          <button type="button" className="btn quiet" onClick={() => void act(`comments/${t.id}/apply`)}>
            Ask again
          </button>
        </div>
      ) : null}
      {applyOk ? (
        <div className="acts">
          <button type="button" className="btn primary apply" onClick={() => void act(`comments/${t.id}/apply`)}>
            Apply feedback
          </button>
        </div>
      ) : null}
      <textarea
        className="reply"
        aria-label="Reply"
        placeholder="Reply…"
        rows={1}
        value={reply}
        disabled={replying}
        onChange={(e) => setReply(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter" && !e.shiftKey) {
            e.preventDefault();
            void sendReply();
          }
        }}
      />
    </section>
  );
}

function StatusRow({ row, t, act, onReview, onShowDecision }: { row: Row; t: CommentThread; act: Act2; onReview: (t: CommentThread) => void; onShowDecision: (k: string) => void }) {
  const ok = row.kind === "accepted" || row.kind === "done" || row.kind === "ready";
  let button: ReactNode = null;
  if (row.kind === "writing")
    button = (
      <button type="button" className="btn quiet" onClick={() => void act(`comments/${t.id}/stop`)}>
        Stop
      </button>
    );
  else if (row.kind === "ready" || row.kind === "partial")
    button = (
      <button type="button" className="btn quiet" onClick={() => onReview(t)}>
        Review
      </button>
    );
  else if (row.kind === "accepted")
    // All accepted: Resolve is offered, never done for you (#28).
    button = (
      <button type="button" className="btn quiet" onClick={() => void act(`comments/${t.id}/resolve`, { resolved: true })}>
        Resolve
      </button>
    );
  else if (row.kind === "decision")
    button = (
      <button type="button" className="btn quiet" onClick={() => onShowDecision(row.key)}>
        Show decision
      </button>
    );
  else if (row.kind === "stopped" || row.kind === "failed")
    button = (
      <button type="button" className="btn quiet" onClick={() => void act(`comments/${t.id}/retry`)}>
        Try again
      </button>
    );
  return (
    <div className="crow" data-row={row.kind} role={row.kind === "failed" ? "alert" : undefined}>
      <span className="t">
        {row.kind === "writing" ? <span className="live" /> : ok ? <ICheck s={16} className="ok" /> : null}
        <span className={ok || row.kind === "writing" ? "" : "m"}>{rowText(row)}</span>
      </span>
      {button}
    </div>
  );
}

// ---------- mobile review bar (§5, #30): Accept for the focused suggestion is the blue one ----------
function MobileBar({ placed, index, go, review, agentName }: { placed: Placed[]; index: number; go: (d: 1 | -1) => void; review: (op: "accept" | "reject", ids: string[] | "all") => void; agentName: string }) {
  const cur = placed[index] ?? placed[0];
  const i = index < 0 ? 0 : index;
  return (
    <div className="mbar" role="toolbar" aria-label="Review suggestions">
      <div className="r1">
        <b>
          {i + 1} of {placed.length} suggestions
        </b>
        <button type="button" className="icon-btn" aria-label="Previous suggestion" onClick={() => go(-1)}>
          <IUp s={18} />
        </button>
        <button type="button" className="icon-btn" aria-label="Next suggestion" onClick={() => go(1)}>
          <IDown s={18} />
        </button>
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <button type="button" className="icon-btn" aria-label="More review actions">
              <IMore s={18} />
            </button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="pmenu">
            <DropdownMenuItem onSelect={() => review("accept", "all")}>Accept all</DropdownMenuItem>
            <DropdownMenuItem onSelect={() => review("reject", "all")}>Reject all</DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
      <div className="r2">
        <button type="button" className="btn quiet" onClick={() => review("reject", [cur.s.id])}>
          Reject
        </button>
        <button type="button" className="btn primary" onClick={() => review("accept", [cur.s.id])} aria-label={`Accept suggestion from ${agentName}`}>
          Accept
        </button>
      </div>
    </div>
  );
}
