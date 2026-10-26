// The plan editor: a rich view (click a block to edit its Markdown in place) and a raw Markdown
// view, both editing the same text, autosaved to plan.md.
//
// Hooks (v1.2): .ped[data-mode], .ped-modes (segmented Rich | Markdown, lives in the plan toolbar),
// .ped-save[data-save], .blk[data-block][data-start] with .blk-act (keyboard Edit), .blk[data-editing]
// .blk-edit (.mono only for fences) and .blk-hint, .doc-raw .ced, .dz, mark.ctx, .mmd.
import { type MutableRefObject, type ReactNode, useCallback, useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from "react";
import { ICheck } from "../icons";
import { type AnswerEdit, type DecisionFields, answerEdits, decisionProblems, parseDecisionBody, revertAnswerEdits } from "../../../../src/core/decision-block.ts";
import { textHash } from "../../../../src/core/text-hash.ts";
import { ApiError, api } from "../api";
import { reconcile } from "./reconcile";
import { Autosaver, type SaveState } from "./autosave";
import { type Block, parseBlocks, splice } from "./blocks";
import { CodeEditor } from "./CodeEditor";
import { Diagram } from "./Diagram";
import { type CiteRenderer, type DocMarks, type FenceBlock, Markdown, type PassageLink } from "../Markdown";
import { canHover, selecting } from "./link";
import { formatEdit, formatKey } from "./selection";

export type EditorMode = "rich" | "raw";

export interface PlanDraft {
  text: string;
  change: (text: string) => void;
  flush: () => Promise<void>;
  save: { state: SaveState | "idle"; error?: string; savedAt?: number; /** A decision card's save: "Saving…" right away. */ card?: boolean };
  /** Show a save made outside the text (a decision card's Save answer) in the status: Saving…, then Saved. */
  track: <T>(p: Promise<T>) => Promise<T>;
  /** Bumps when the text was replaced from outside (another tab, a new plan, plan.md on disk). */
  epoch: number;
  /** plan.md changed on disk while there were unsaved edits here (Q5). */
  conflict: { disk: string } | null;
  resolve: (keep: "mine" | "file") => Promise<void>;
  /** Polite announcement ("Reloaded plan.md"), cleared after a while. */
  notice: string;
  /**
   * Hand edits changed settled answers (DECISIONS #22). Saving holds until the user picks:
   * `applyAnswerChange` saves through the Change path ("Save and re-ask n"), `cancelAnswerChange`
   * puts the answers back and saves everything else.
   */
  answerChange: AnswerEdit[] | null;
  applyAnswerChange: () => Promise<void>;
  cancelAnswerChange: () => void;
}

/**
 * Local draft of the plan, autosaved. Server updates are adopted when nothing is unsaved here;
 * when both sides changed, saving stops and `conflict` asks which version to keep.
 */
export function usePlanDraft(sessionId: string, serverMarkdown: string, reloadedAt?: string, answers?: Record<string, string>): PlanDraft {
  const [text, setText] = useState(serverMarkdown);
  const [epoch, setEpoch] = useState(0);
  const [save, setSave] = useState<PlanDraft["save"]>({ state: "idle" });
  const [conflict, setConflict] = useState<{ disk: string } | null>(null);
  const [notice, setNotice] = useState("");
  const [answerChange, setAnswerChange] = useState<AnswerEdit[] | null>(null);
  const answersRef = useRef(answers);
  answersRef.current = answers;
  // Saving is held for a changed answer (DECISIONS #22), separately from a disk conflict.
  const answerHold = useRef(false);
  const conflictRef = useRef(false);
  const textRef = useRef(serverMarkdown);
  // The server version our edits start from; sent with every save so the server can refuse a
  // save made on top of an older plan.md.
  const base = useRef(serverMarkdown);
  const sent = useRef(new Set<string>());
  const seenReload = useRef(reloadedAt);
  const saver = useRef<Autosaver | null>(null);
  // A decision card's save runs outside the autosaver; while it shows (Saving…/Saved), the autosaver resetting to
  // the server's echo must not blank it. Cleared by the next autosaver activity or an outside reload.
  const cardSave = useRef(false);
  const openConflict = useCallback((disk: string) => {
    saver.current!.hold();
    conflictRef.current = true;
    setConflict({ disk });
  }, []);
  const holdForAnswers = useCallback((edits: AnswerEdit[]) => {
    answerHold.current = true;
    saver.current!.hold();
    setAnswerChange(edits);
  }, []);
  const clearAnswerHold = useCallback(() => {
    answerHold.current = false;
    setAnswerChange(null);
  }, []);
  saver.current ??= new Autosaver(serverMarkdown, {
    save: async (t) => {
      sent.current.add(t);
      if (sent.current.size > 8) sent.current.delete(sent.current.values().next().value!);
      try {
        await api.savePlan(sessionId, t, textHash(base.current));
        base.current = t;
      } catch (err) {
        if (err instanceof ApiError && err.status === 409 && typeof err.data.markdown === "string") openConflict(err.data.markdown);
        else if (err instanceof ApiError && err.status === 409 && Array.isArray(err.data.answerEdits)) holdForAnswers(err.data.answerEdits);
        throw err;
      }
    },
    onState: (state, info) => {
      if (state === "saved" && cardSave.current) return; // reset() to the card save's echo, not a save of typing
      cardSave.current = false;
      setSave({ state, ...info });
    },
  });

  useEffect(() => {
    const s = saver.current!;
    const external = reloadedAt !== seenReload.current;
    seenReload.current = reloadedAt;
    const what = reconcile({ lastSaved: s.lastSaved, dirty: s.dirty, sent: sent.current, text: textRef.current }, serverMarkdown);
    if (what === "ignore") {
      if (!s.dirty) base.current = serverMarkdown;
      if (!s.dirty && serverMarkdown !== s.lastSaved && serverMarkdown === textRef.current) s.reset(serverMarkdown);
      return;
    }
    if (what === "conflict") return openConflict(serverMarkdown);
    base.current = serverMarkdown;
    s.reset(serverMarkdown);
    clearAnswerHold();
    textRef.current = serverMarkdown;
    setText(serverMarkdown);
    setEpoch((n) => n + 1);
    // The echo of a card's save must not wipe its Saving…/Saved status.
    if (external) cardSave.current = false;
    if (!cardSave.current) setSave({ state: "idle" });
    if (external) setNotice("Reloaded plan.md");
  }, [serverMarkdown, reloadedAt, openConflict, clearAnswerHold]);

  useEffect(() => {
    if (!notice) return;
    const t = setTimeout(() => setNotice(""), 4000);
    return () => clearTimeout(t);
  }, [notice]);

  useEffect(() => {
    const s = saver.current!;
    const onHide = () => void s.flush();
    window.addEventListener("pagehide", onHide);
    return () => {
      window.removeEventListener("pagehide", onHide);
      void s.flush().finally(() => s.dispose());
    };
  }, []);

  const change = useCallback(
    (t: string) => {
      textRef.current = t;
      setText(t);
      const s = saver.current!;
      const edits = answersRef.current ? answerEdits(t, answersRef.current) : [];
      if (edits.length) {
        holdForAnswers(edits);
        s.change(t);
      } else {
        s.change(t);
        if (answerHold.current) {
          clearAnswerHold();
          if (!conflictRef.current) s.release();
        }
      }
    },
    [holdForAnswers, clearAnswerHold],
  );
  const flush = useCallback(() => saver.current!.flush(), []);
  const resolve = useCallback(
    async (keep: "mine" | "file") => {
      const c = conflict;
      if (!c) return;
      const s = saver.current!;
      const mine = textRef.current;
      // The version that loses is kept next to plan.md as plan.conflict.md.
      await api.action(sessionId, "plan-conflict", { markdown: keep === "mine" ? c.disk : mine }).catch(() => undefined);
      setConflict(null);
      conflictRef.current = false;
      clearAnswerHold();
      base.current = c.disk;
      s.reset(c.disk);
      if (keep === "file") {
        textRef.current = c.disk;
        setText(c.disk);
        setEpoch((n) => n + 1);
        setSave({ state: "idle" });
      } else {
        change(mine);
        await s.flush();
      }
    },
    [conflict, sessionId, change, clearAnswerHold],
  );
  const applyAnswerChange = useCallback(async () => {
    const s = saver.current!;
    const t = textRef.current;
    try {
      const r = await api.savePlan(sessionId, t, textHash(base.current), true);
      const md = r.markdown ?? t;
      clearAnswerHold();
      base.current = md;
      s.reset(md);
      textRef.current = md;
      setText(md);
      setEpoch((n) => n + 1);
      setSave({ state: "saved", savedAt: Date.now() });
    } catch (err) {
      if (err instanceof ApiError && err.status === 409 && typeof err.data.markdown === "string") openConflict(err.data.markdown);
      throw err;
    }
  }, [sessionId, clearAnswerHold, openConflict]);
  const cancelAnswerChange = useCallback(() => {
    if (!answersRef.current) return;
    setEpoch((n) => n + 1); // closes a block editor showing the old text
    change(revertAnswerEdits(textRef.current, answersRef.current));
  }, [change]);
  const track = useCallback(async <T,>(p: Promise<T>): Promise<T> => {
    cardSave.current = true;
    setSave({ state: "saving", card: true });
    try {
      const r = await p;
      setSave({ state: "saved", savedAt: Date.now(), card: true });
      return r;
    } catch (err) {
      cardSave.current = false;
      setSave({ state: "idle" }); // the card shows what went wrong, next to the answer
      throw err;
    }
  }, []);
  return { text, change, flush, save, epoch, conflict, resolve, notice, answerChange, applyAnswerChange, cancelAnswerChange, track };
}

/**
 * Save status in the plan toolbar (v1.2 §3): muted meta text. The live region only speaks up for
 * failures and recovery.
 */
export function SaveStatus({
  save,
  onRetry,
  conflict,
  answerChange,
  edited,
  open,
  reasking,
  review,
}: {
  save: PlanDraft["save"];
  onRetry: () => void;
  conflict: boolean;
  /** Saving is held for a changed answer (DECISIONS #22). */
  answerChange?: boolean;
  /** The plan was edited at some point (otherwise it's the plan as plated). */
  edited?: boolean;
  /** Decisions still open in the plan. */
  open?: number;
  /** Decisions being asked again after a change (§3.5: "Saved · re-asking 1"). */
  reasking?: number;
  /** Suggestions waiting for review: "Saved · 3 to review" (item 3 §4.4). */
  review?: number;
}) {
  const [slow, setSlow] = useState(false);
  const failedRef = useRef(false);
  const [announce, setAnnounce] = useState("");
  useEffect(() => {
    if (save.state !== "saving") return setSlow(false);
    const t = setTimeout(() => setSlow(true), 400);
    return () => clearTimeout(t);
  }, [save.state]);
  useEffect(() => {
    if (save.state === "error" && !conflict && !answerChange) {
      failedRef.current = true;
      setAnnounce("Couldn't save");
    } else if (save.state === "saved" && failedRef.current) {
      failedRef.current = false;
      setAnnounce("Saved again");
    }
  }, [save.state, conflict, answerChange]);
  const state = answerChange ? "held" : conflict ? "pending" : save.state === "saving" && !slow && !save.card ? "pending" : save.state;
  // With open decisions the status reads "Saved · n open" from the start (v1.2 §3).
  const fresh = state === "idle" && !edited && !open && !reasking && !review;
  const label = answerChange
    ? "Answer changed · not saved"
    : fresh
      ? "Plated · saved to plan.md"
      : state === "idle" || state === "saved"
        ? `Saved${reasking ? ` · re-asking ${reasking}` : review ? ` · ${review} to review` : open ? ` · ${open} open` : ""}`
        : state === "pending"
          ? "Edited · saving soon"
          : state === "saving"
            ? "Saving…"
            : "Couldn't save to plan.md";
  return (
    <span className="ped-save" data-save={state} data-fresh={fresh ? "" : undefined} data-testid="save-status">
      {fresh ? <ICheck s={14} /> : null}
      <span>{label}</span>
      {state === "error" ? (
        <>
          <span className="sr-only">{save.error}</span>
          <button type="button" className="btn quiet sm" onClick={onRetry}>
            Retry
          </button>
        </>
      ) : null}
      <span className="sr-only" role="status">
        {announce}
      </span>
    </span>
  );
}

/** Rich | Markdown, a segmented radio group (⌘⇧M toggles it too). */
export function ModeToggle({ mode, onMode }: { mode: EditorMode; onMode: (m: EditorMode) => void }) {
  return (
    <div className="ped-modes" role="radiogroup" aria-label="Plan view">
      {(["rich", "raw"] as const).map((m) => (
        <button
          key={m}
          type="button"
          role="radio"
          className="ped-mode"
          aria-checked={mode === m}
          tabIndex={mode === m ? 0 : -1}
          onClick={() => onMode(m)}
          onKeyDown={(e) => {
            if (e.key === "ArrowLeft" || e.key === "ArrowRight" || e.key === "ArrowUp" || e.key === "ArrowDown") {
              e.preventDefault();
              const group = e.currentTarget.parentElement;
              onMode(m === "rich" ? "raw" : "rich");
              requestAnimationFrame(() => (group?.querySelector(`[aria-checked="true"]`) as HTMLElement | null)?.focus());
            }
          }}
        >
          {m === "rich" ? "Rich" : "Markdown"}
        </button>
      ))}
    </div>
  );
}

/** Grow a textarea to fit its text without the page jumping (the old height: auto reset collapsed the layout and scrolled to the top). */
export function autosize(el: HTMLTextAreaElement | null) {
  if (!el) return;
  const scroller = el.closest(".docwrap") as HTMLElement | null;
  const top = scroller?.scrollTop;
  const winY = window.scrollY;
  // Measure with a 0px height, but hold the space on the parent so nothing reflows around it.
  // (Holding it on the textarea itself made scrollHeight never shrink: an extra empty row.)
  const holder = el.parentElement;
  if (holder) holder.style.minHeight = `${holder.getBoundingClientRect().height}px`;
  el.style.height = "0px";
  const next = el.scrollHeight;
  el.style.height = `${next}px`;
  if (holder) holder.style.minHeight = "";
  if (scroller && top !== undefined && scroller.scrollTop !== top) scroller.scrollTop = top;
  if (window.scrollY !== winY) window.scrollTo({ top: winY });
}

function BlockEditor({
  text,
  kind,
  sel,
  onChange,
  onDone,
}: {
  text: string;
  kind: Block["kind"];
  /** Range to select on open (the selection toolbar's Edit, item 3 §2). */
  sel?: [number, number];
  onChange: (t: string) => void;
  onDone: (refocus: boolean) => void;
}) {
  const ref = useRef<HTMLTextAreaElement>(null);
  const hint = useId();
  // After ⌘B / ⌘I the words stay selected, so a second shortcut stacks (or undoes) the mark.
  const keep = useRef<[number, number] | null>(null);
  useLayoutEffect(() => {
    autosize(ref.current);
    if (keep.current) ref.current?.setSelectionRange(...keep.current);
    keep.current = null;
  }, [text]);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.focus({ preventScroll: true });
    el.setSelectionRange(sel?.[0] ?? el.value.length, sel?.[1] ?? el.value.length);
  }, []);
  const preview = parseBlocks(text).find((b) => b.kind === "fence" && b.lang === "mermaid");
  const level = kind === "heading" ? (/^#+/.exec(text)?.[0].length ?? 2) : 0;
  return (
    <div className="blk" data-editing="" data-block={kind}>
      <textarea
        ref={ref}
        // Prose is edited in Inter at its own size so nothing jumps; only fences are mono (#17).
        className={kind === "fence" ? "blk-edit mono" : `blk-edit${level ? ` h${Math.min(level, 4)}` : ""}`}
        rows={1}
        aria-label="Edit block as Markdown. Escape to finish."
        aria-describedby={hint}
        spellCheck
        value={text}
        onChange={(e) => onChange(e.target.value)}
        onBlur={() => onDone(false)}
        onKeyDown={(e) => {
          // ⌘B / ⌘I keep working here: the selection toolbar has no formatting buttons (#27).
          const f = formatKey(e);
          const el = e.currentTarget;
          if (f && el.selectionStart !== el.selectionEnd) {
            e.preventDefault();
            const out = formatEdit(el.value, el.selectionStart, el.selectionEnd, f);
            keep.current = [out.start, out.end];
            onChange(out.text);
            return;
          }
          if (e.key === "Escape" || (e.key === "Enter" && (e.metaKey || e.ctrlKey))) {
            e.preventDefault();
            e.stopPropagation();
            onDone(true);
          }
        }}
      />
      <p className="blk-hint" id={hint} aria-hidden="true">
        Markdown · Esc to finish
      </p>
      {preview && preview.kind === "fence" ? (
        <div className="blk-preview" aria-label="Live preview">
          <Diagram code={preview.body} />
        </div>
      ) : null}
    </div>
  );
}

/** Renders a decision block from its last valid fields. */
export type DecisionRenderer = (
  fields: DecisionFields,
  opts: { invalid: boolean; active: boolean; setActive: (on: boolean) => void; lit?: boolean; litFrom?: string | null },
) => ReactNode;

/** Right-margin cites of one passage; `label` is the decision lit from this passage (label mode, §2.2). */
export type GutRenderer = (keys: string[], o: { passage: string; on: string | null; label: string | null }) => ReactNode;

export function PlanEditor({
  draft,
  mode,
  setMode,
  cite,
  afterTitle,
  openBadge,
  decision,
  readOnly,
  highlight,
  gut,
  staleKeys,
  marks,
  editRef,
}: {
  draft: PlanDraft;
  mode: EditorMode;
  setMode: (m: EditorMode) => void;
  cite: CiteRenderer;
  afterTitle?: ReactNode;
  openBadge?: ReactNode;
  decision?: DecisionRenderer;
  /** Waiting for re-asked decisions: the plan shows, but isn't edited. */
  readOnly?: boolean;
  /** "Show in plan": highlight this decision's passages for a moment. */
  highlight?: string | null;
  gut?: GutRenderer;
  /** Decisions being asked again: their passages go muted (§3 Reasked). */
  staleKeys?: Set<string>;
  /** Comment anchors and pending suggestions (item 3). */
  marks?: DocMarks;
  /** Opens the block editor at a source range (the selection toolbar's Edit). */
  editRef?: MutableRefObject<((start: number, end: number) => void) | null>;
}) {
  // The block being edited, as a range of the draft. `len` follows the edited text's length.
  const [editing, setEditing] = useState<{ start: number; len: number; text: string; kind: Block["kind"]; sel?: [number, number] } | null>(null);
  const [active, setActive] = useState<string | null>(null);
  // Text → decision (§2.2): the hovered passage, after a 120ms intent; leaving clears after 200ms,
  // and moving to another passage within that grace swaps at once.
  const [hover, setHover] = useState<{ id: string; keys: string[] } | null>(null);
  const hoverT = useRef<{ on?: ReturnType<typeof setTimeout>; off?: ReturnType<typeof setTimeout> }>({});
  const hoverRef = useRef(hover);
  hoverRef.current = hover;
  const link: PassageLink = {
    active: active ?? highlight ?? null,
    hover: hover?.id ?? null,
    stale: staleKeys ?? new Set(),
    onEnter: (id, keys) => {
      clearTimeout(hoverT.current.on);
      clearTimeout(hoverT.current.off);
      if (!canHover() || selecting() || editing) return;
      if (hoverRef.current) return setHover({ id, keys });
      hoverT.current.on = setTimeout(() => !selecting() && setHover({ id, keys }), 120);
    },
    onLeave: () => {
      clearTimeout(hoverT.current.on);
      hoverT.current.off = setTimeout(() => setHover(null), 200);
    },
    gut: gut ? (keys, id) => gut(keys, { passage: id, on: active, label: hover?.id === id ? hover.keys[0] : null }) : undefined,
  };
  useEffect(() => () => {
    clearTimeout(hoverT.current.on);
    clearTimeout(hoverT.current.off);
  }, []);
  const articleRef = useRef<HTMLDivElement>(null);
  // Rich mode shows the last valid version of a decision block that doesn't parse (§5).
  const lastValid = useRef(new Map<string, DecisionFields>());
  useEffect(() => setEditing(null), [draft.epoch, mode]);
  const problems = useMemo(() => decisionProblems(draft.text), [draft.text]);

  const startEdit = (b: Block) => !readOnly && setEditing({ start: b.start, len: b.end - b.start, text: b.raw, kind: b.kind });
  if (editRef)
    editRef.current = (start, end) => {
      const b = parseBlocks(draft.text).find((x) => start >= x.start && start < x.end);
      if (!b || readOnly || (b.kind === "fence" && b.lang === "decision")) return;
      setEditing({ start: b.start, len: b.end - b.start, text: b.raw, kind: b.kind, sel: [start - b.start, Math.min(end, b.end) - b.start] });
    };
  const editBlock = (t: string) => {
    if (!editing) return;
    draft.change(splice(draft.text, editing.start, editing.start + editing.len, t));
    setEditing({ ...editing, len: t.length, text: t });
  };
  const doneEditing = (refocus = false) => {
    const start = editing?.start;
    setEditing(null);
    void draft.flush();
    if (!refocus) return;
    // Back to the block's Edit button (v1.2 §1), or the document when the block is gone.
    requestAnimationFrame(() => {
      const btn = start === undefined ? null : articleRef.current?.querySelector<HTMLElement>(`.blk[data-start="${start}"] > .blk-act`);
      (btn ?? articleRef.current)?.focus({ preventScroll: true });
    });
  };
  // `setMode` flushes; the effect above closes the block editor.
  const switchMode = (m: EditorMode) => m !== mode && setMode(m);
  // ⌘⇧M toggles the view, ⌘S saves now (§6).
  const modeRef = useRef(mode);
  modeRef.current = mode;
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!(e.metaKey || e.ctrlKey)) return;
      if (e.shiftKey && e.key.toLowerCase() === "m") {
        e.preventDefault();
        switchModeRef.current(modeRef.current === "rich" ? "raw" : "rich");
      } else if (!e.shiftKey && e.key.toLowerCase() === "s") {
        e.preventDefault();
        void draft.flush();
      }
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [draft]);
  const switchModeRef = useRef(switchMode);
  switchModeRef.current = switchMode;

  const renderDecision = (b: FenceBlock, n: number) => {
    const parsed = parseDecisionBody(b.body);
    const slot = `${n}`;
    if (parsed.ok) lastValid.current.set(slot, parsed.fields);
    const fields = parsed.ok ? parsed.fields : lastValid.current.get(slot);
    if (!fields || !decision)
      return (
        <pre className="dz-raw">
          <code>{b.body}</code>
        </pre>
      );
    const key = fields.key ?? "";
    return decision(fields, {
      invalid: !parsed.ok,
      active: active === key,
      setActive: (on) => setActive((cur) => (on ? (selecting() ? cur : key) : cur === key ? null : cur)),
      lit: !!hover?.keys.includes(key),
      litFrom: hover?.keys.includes(key) ? hover.id : null,
    });
  };

  return (
    <div className="ped" data-mode={mode} data-readonly={readOnly ? "" : undefined}>
      {mode === "rich" ? (
        <div
          ref={articleRef}
          className="doc"
          data-testid="plan"
          role="document"
          aria-label="Plan document"
          tabIndex={-1}
          onKeyDown={(e) => {
            if (e.key === "Escape" && editing) doneEditing(true);
            // ↑/↓ from a block's Edit button or a decision card moves to the previous or next stop.
            const t = e.target as HTMLElement;
            if ((e.key === "ArrowDown" || e.key === "ArrowUp") && !e.altKey && !e.metaKey && (t.matches(".blk-act") || t.matches(".dz:not([data-state=changing])"))) {
              const stops = [...(articleRef.current?.querySelectorAll<HTMLElement>(".blk-act, .dz") ?? [])];
              const next = stops[stops.indexOf(t) + (e.key === "ArrowDown" ? 1 : -1)];
              if (next) {
                e.preventDefault();
                next.focus();
                next.scrollIntoView({ block: "nearest" });
              }
            }
          }}
        >
          <Markdown
            source={draft.text}
            cite={cite}
            afterTitle={afterTitle}
            openBadge={openBadge}
            onBlock={readOnly ? undefined : startEdit}
            decision={renderDecision}
            link={link}
            marks={editing && marks ? outside(marks, editing.start, editing.start + editing.len) : marks}
            edit={
              editing
                ? {
                    start: editing.start,
                    end: editing.start + editing.len,
                    node: (
                      <BlockEditor key={editing.start} text={editing.text} kind={editing.kind} sel={editing.sel} onChange={editBlock} onDone={doneEditing} />
                    ),
                  }
                : undefined
            }
          />
        </div>
      ) : (
        <div className="doc doc-raw">
          {/* The page keeps its heading in the Markdown view; the source shows it as "# …". */}
          <h1 className="sr-only">{/^# (.+)$/m.exec(draft.text)?.[1] ?? "plan.md"}</h1>
          <CodeEditor
            key={readOnly ? "ro" : "rw"}
            value={draft.text}
            onChange={(t) => !readOnly && draft.change(t)}
            onBlur={() => void draft.flush()}
            label="plan.md, Markdown source"
            errors={problems}
            testId="plan-raw"
          />
        </div>
      )}
    </div>
  );
}

/** Marks outside the block being edited: only that block's suggestions and anchors hide while you edit it (item 3 §4.7). */
function outside(marks: DocMarks, start: number, end: number): DocMarks {
  const out = (a: { start: number; end: number }) => a.end < start || a.start > end;
  return { ...marks, anchors: marks.anchors.filter(out), edits: marks.edits.filter(out) };
}
