// The plan editor: a rich view (click a block to edit its Markdown in place) and a raw Markdown
// view, both editing the same text, autosaved to plan.md.
//
// Styling hooks for Designer (no final visuals yet):
//   .ped[data-mode=rich|raw]                 editor root
//   .ped-bar, .ped-modes, .ped-mode[aria-pressed]   view toggle
//   .ped-save[data-save=idle|pending|saving|saved|error]   autosave status
//   .blk[data-block=heading|list|fence|para], .blk[data-editing]   blocks in the rich view
//   .blk-edit (textarea), .blk-preview (live diagram under a ```mermaid block being edited)
//   .ped-raw (raw Markdown textarea)
//   .mmd[data-state=loading|ok|error], .mmd-svg, .mmd-err   diagrams
import { type ReactNode, useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { api } from "../api";
import { Autosaver, type SaveState } from "./autosave";
import { type Block, parseBlocks, splice } from "./blocks";
import { Diagram } from "./Diagram";
import { Markdown, type CiteRenderer } from "../Markdown";

export type EditorMode = "rich" | "raw";

export interface PlanDraft {
  text: string;
  change: (text: string) => void;
  flush: () => Promise<void>;
  save: { state: SaveState | "idle"; error?: string; savedAt?: number };
  /** Bumps when the text was replaced from outside (another tab, a new plan). */
  epoch: number;
}

/** Local draft of the plan, autosaved. Server updates are adopted only when nothing is unsaved. */
export function usePlanDraft(sessionId: string, serverMarkdown: string): PlanDraft {
  const [text, setText] = useState(serverMarkdown);
  const [epoch, setEpoch] = useState(0);
  const [save, setSave] = useState<PlanDraft["save"]>({ state: "idle" });
  const saver = useRef<Autosaver | null>(null);
  saver.current ??= new Autosaver(serverMarkdown, {
    save: (t) => api.savePlan(sessionId, t).then(() => undefined),
    onState: (state, info) => setSave({ state, ...info }),
  });

  useEffect(() => {
    const s = saver.current!;
    if (serverMarkdown === s.lastSaved || s.dirty) return;
    s.reset(serverMarkdown);
    setText(serverMarkdown);
    setEpoch((n) => n + 1);
    setSave({ state: "idle" });
  }, [serverMarkdown]);

  useEffect(() => {
    const s = saver.current!;
    const onHide = () => void s.flush();
    window.addEventListener("pagehide", onHide);
    return () => {
      window.removeEventListener("pagehide", onHide);
      void s.flush().finally(() => s.dispose());
    };
  }, []);

  const change = useCallback((t: string) => {
    setText(t);
    saver.current!.change(t);
  }, []);
  const flush = useCallback(() => saver.current!.flush(), []);
  return { text, change, flush, save, epoch };
}

function SaveStatus({ save, onRetry }: { save: PlanDraft["save"]; onRetry: () => void }) {
  const label =
    save.state === "idle"
      ? "Edits save to plan.md"
      : save.state === "pending"
        ? "Edited"
        : save.state === "saving"
          ? "Saving…"
          : save.state === "saved"
            ? `Saved${save.savedAt ? ` ${new Date(save.savedAt).toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" })}` : ""}`
            : "Couldn't save";
  return (
    <span className="ped-save sub" data-save={save.state} data-testid="save-status">
      <span role="status">{label}</span>
      {save.state === "error" ? (
        <>
          <span className="sr-only">{save.error}</span>
          <button type="button" className="ro" onClick={onRetry}>
            Retry
          </button>
        </>
      ) : null}
    </span>
  );
}

function autosize(el: HTMLTextAreaElement | null) {
  if (!el) return;
  el.style.height = "auto";
  el.style.height = `${el.scrollHeight + 2}px`;
}

function BlockEditor({ text, onChange, onDone }: { text: string; onChange: (t: string) => void; onDone: () => void }) {
  const ref = useRef<HTMLTextAreaElement>(null);
  useLayoutEffect(() => autosize(ref.current), [text]);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.focus({ preventScroll: true });
    el.setSelectionRange(el.value.length, el.value.length);
  }, []);
  const preview = parseBlocks(text).find((b) => b.kind === "fence" && b.lang === "mermaid");
  return (
    <div className="blk" data-editing="">
      <textarea
        ref={ref}
        className="blk-edit mono"
        aria-label="Edit block as Markdown. Escape to finish."
        spellCheck
        value={text}
        onChange={(e) => onChange(e.target.value)}
        onBlur={onDone}
        onKeyDown={(e) => {
          if (e.key === "Escape" || (e.key === "Enter" && (e.metaKey || e.ctrlKey))) {
            e.preventDefault();
            e.stopPropagation();
            onDone();
          }
        }}
      />
      {preview && preview.kind === "fence" ? (
        <div className="blk-preview" aria-label="Diagram preview">
          <Diagram code={preview.body} />
        </div>
      ) : null}
    </div>
  );
}

export function PlanEditor({
  draft,
  mode,
  setMode,
  cite,
  afterTitle,
  openBadge,
}: {
  draft: PlanDraft;
  mode: EditorMode;
  setMode: (m: EditorMode) => void;
  cite: CiteRenderer;
  afterTitle?: ReactNode;
  openBadge?: ReactNode;
}) {
  // The block being edited, as a range of the draft. `len` follows the edited text's length.
  const [editing, setEditing] = useState<{ start: number; len: number; text: string } | null>(null);
  const articleRef = useRef<HTMLElement>(null);
  const rawRef = useRef<HTMLTextAreaElement>(null);
  useEffect(() => setEditing(null), [draft.epoch]);
  useLayoutEffect(() => autosize(rawRef.current), [mode, draft.text]);

  const startEdit = (b: Block) => setEditing({ start: b.start, len: b.end - b.start, text: b.raw });
  const editBlock = (t: string) => {
    if (!editing) return;
    draft.change(splice(draft.text, editing.start, editing.start + editing.len, t));
    setEditing({ ...editing, len: t.length, text: t });
  };
  const doneEditing = () => {
    setEditing(null);
    void draft.flush();
  };
  const switchMode = (m: EditorMode) => {
    if (m === mode) return;
    setEditing(null);
    void draft.flush();
    setMode(m);
  };

  return (
    <div className="ped" data-mode={mode}>
      <div className="ped-bar">
        <div className="ped-modes" role="group" aria-label="Plan view">
          <button type="button" className="ped-mode" aria-pressed={mode === "rich"} onClick={() => switchMode("rich")}>
            Document
          </button>
          <button type="button" className="ped-mode" aria-pressed={mode === "raw"} onClick={() => switchMode("raw")}>
            Markdown
          </button>
        </div>
        <SaveStatus save={draft.save} onRetry={() => void draft.flush()} />
      </div>
      {mode === "rich" ? (
        <article
          ref={articleRef}
          className="doc"
          data-testid="plan"
          aria-label="Plan"
          tabIndex={-1}
          onKeyDown={(e) => {
            if (e.key === "Escape" && editing) {
              doneEditing();
              articleRef.current?.focus();
            }
          }}
        >
          <Markdown
            source={draft.text}
            cite={cite}
            afterTitle={afterTitle}
            openBadge={openBadge}
            onBlock={startEdit}
            edit={
              editing
                ? {
                    start: editing.start,
                    end: editing.start + editing.len,
                    node: (
                      <BlockEditor
                        text={editing.text}
                        onChange={editBlock}
                        onDone={() => {
                          doneEditing();
                          requestAnimationFrame(() => articleRef.current?.focus({ preventScroll: true }));
                        }}
                      />
                    ),
                  }
                : undefined
            }
          />
        </article>
      ) : (
        <div className="doc">
          <textarea
            ref={rawRef}
            className="ped-raw mono"
            aria-label="Plan Markdown"
            data-testid="plan-raw"
            spellCheck={false}
            value={draft.text}
            onChange={(e) => draft.change(e.target.value)}
            onBlur={() => void draft.flush()}
          />
        </div>
      )}
    </div>
  );
}
