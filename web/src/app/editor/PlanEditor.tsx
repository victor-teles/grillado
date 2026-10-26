// The plan editor: a rich view (click a block to edit its Markdown in place) and a raw Markdown
// view, both editing the same text, autosaved to plan.md.
//
// Hooks (v1.2): .ped[data-mode], .ped-modes (segmented Rich | Markdown, lives in the plan toolbar),
// .ped-save[data-save], .blk[data-block][data-start] with .blk-act (keyboard Edit), .blk[data-editing]
// .blk-edit (.mono only for fences) and .blk-hint, .doc-raw .ced, .dz, mark.ctx, .mmd.
import { type ReactNode, useCallback, useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from "react";
import { ICheck } from "../icons";
import { type AnswerEdit, type DecisionFields, answerEdits, decisionProblems, parseDecisionBody, revertAnswerEdits } from "../../../../src/core/decision-block.ts";
import { textHash } from "../../../../src/core/text-hash.ts";
import { ApiError, api } from "../api";
import { reconcile } from "./reconcile";
import { Autosaver, type SaveState } from "./autosave";
import { type Block, parseBlocks, splice } from "./blocks";
import { CodeEditor } from "./CodeEditor";
import { Diagram } from "./Diagram";
import { type CiteRenderer, type FenceBlock, Markdown } from "../Markdown";

export type EditorMode = "rich" | "raw";

export interface PlanDraft {
  text: string;
  change: (text: string) => void;
  flush: () => Promise<void>;
  save: { state: SaveState | "idle"; error?: string; savedAt?: number };
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
    onState: (state, info) => setSave({ state, ...info }),
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
    setSave({ state: "idle" });
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
  return { text, change, flush, save, epoch, conflict, resolve, notice, answerChange, applyAnswerChange, cancelAnswerChange };
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
  const state = answerChange ? "held" : conflict ? "pending" : save.state === "saving" && !slow ? "pending" : save.state;
  const fresh = state === "idle" && !edited;
  const label = answerChange
    ? "Answer changed · not saved"
    : fresh
      ? "Plated · saved to plan.md"
      : state === "idle" || state === "saved"
        ? `Saved${open ? ` · ${open} open` : ""}`
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
  // Measure with a 0px height, but hold the space with min-height so nothing reflows around it.
  const was = el.getBoundingClientRect().height;
  el.style.minHeight = `${was}px`;
  el.style.height = "0px";
  const next = el.scrollHeight + 2;
  el.style.height = `${next}px`;
  el.style.minHeight = "";
  if (scroller && top !== undefined && scroller.scrollTop !== top) scroller.scrollTop = top;
  if (window.scrollY !== winY) window.scrollTo({ top: winY });
}

function BlockEditor({ text, kind, onChange, onDone }: { text: string; kind: Block["kind"]; onChange: (t: string) => void; onDone: (refocus: boolean) => void }) {
  const ref = useRef<HTMLTextAreaElement>(null);
  const hint = useId();
  useLayoutEffect(() => autosize(ref.current), [text]);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.focus({ preventScroll: true });
    el.setSelectionRange(el.value.length, el.value.length);
  }, []);
  const preview = parseBlocks(text).find((b) => b.kind === "fence" && b.lang === "mermaid");
  const level = kind === "heading" ? (/^#+/.exec(text)?.[0].length ?? 2) : 0;
  return (
    <div className="blk" data-editing="" data-block={kind}>
      <textarea
        ref={ref}
        // Prose is edited in Inter at its own size so nothing jumps; only fences are mono (#17).
        className={kind === "fence" ? "blk-edit mono" : `blk-edit${level ? ` h${Math.min(level, 4)}` : ""}`}
        aria-label="Edit block as Markdown. Escape to finish."
        aria-describedby={hint}
        spellCheck
        value={text}
        onChange={(e) => onChange(e.target.value)}
        onBlur={() => onDone(false)}
        onKeyDown={(e) => {
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
export type DecisionRenderer = (fields: DecisionFields, opts: { invalid: boolean; active: boolean; setActive: (on: boolean) => void }) => ReactNode;

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
}) {
  // The block being edited, as a range of the draft. `len` follows the edited text's length.
  const [editing, setEditing] = useState<{ start: number; len: number; text: string; kind: Block["kind"] } | null>(null);
  const [active, setActive] = useState<string | null>(null);
  const articleRef = useRef<HTMLDivElement>(null);
  // Rich mode shows the last valid version of a decision block that doesn't parse (§5).
  const lastValid = useRef(new Map<string, DecisionFields>());
  useEffect(() => setEditing(null), [draft.epoch, mode]);
  const problems = useMemo(() => decisionProblems(draft.text), [draft.text]);

  const startEdit = (b: Block) => !readOnly && setEditing({ start: b.start, len: b.end - b.start, text: b.raw, kind: b.kind });
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
    return decision(fields, { invalid: !parsed.ok, active: active === key, setActive: (on) => setActive((cur) => (on ? key : cur === key ? null : cur)) });
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
            active={active ?? highlight}
            edit={
              editing
                ? {
                    start: editing.start,
                    end: editing.start + editing.len,
                    node: (
                      <BlockEditor key={editing.start} text={editing.text} kind={editing.kind} onChange={editBlock} onDone={doneEditing} />
                    ),
                  }
                : undefined
            }
          />
        </div>
      ) : (
        <div className="doc doc-raw">
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
