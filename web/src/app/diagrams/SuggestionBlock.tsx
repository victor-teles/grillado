// Item 5 §5: a suggested diagram as a block (item 4's .sgb), or a removed + suggested pair when it
// replaces one. Edit opens the source with a live preview; finishing accepts it with your changes
// in one step, and leaving it unchanged keeps it a suggestion (#42).
import { useEffect, useId, useLayoutEffect, useRef, useState } from "react";
import { suggestedCode } from "../../../../src/core/diagrams.ts";
import type { Placed } from "../comments/model";
import { Diagram, LivePreview } from "../editor/Diagram";
import { accOf, kindName } from "../editor/diagram";
import { useMobile } from "../chrome";
import { type MermaidErr, MermaidError, SourcePreviewSwitch, useKeyboardDock, useSourcePreview } from "../editor/SourcePreview";
import { ICheck, IEdit, IMinus, IPlus, IX } from "../icons";

const MOD = /Mac|iPhone|iPad/.test(globalThis.navigator?.platform ?? "") ? "⌘" : "Ctrl+";

export function SuggestionBlock(p: {
  placed: Placed;
  index: number;
  total: number;
  focused: boolean;
  agentName: string;
  onAccept: (code?: string) => void;
  onReject: () => void;
  onFocus: () => void;
}) {
  const { s } = p.placed;
  const mobile = useMobile();
  const code = suggestedCode(s);
  const kind = kindName(code);
  const { title } = accOf(code);
  const [editing, setEditing] = useState<string | null>(null);
  const old = s.replace ? (/```mermaid\n([\s\S]*?)\n```/.exec(s.before)?.[1] ?? "") : null;
  const label = `Suggested ${kind.toLowerCase()} from ${p.agentName}${title ? `: ${title}` : ""}`;
  const block = (
    <div
      className={`sgb sgb5${p.focused ? " f" : ""}${s.replace ? " rep" : ""}`}
      role="group"
      aria-label={label}
      tabIndex={-1}
      data-sg={s.id}
      data-testid="diagram-suggestion"
      onFocus={(e) => e.target === e.currentTarget && !p.focused && p.onFocus()}
      onClick={(e) => {
        e.stopPropagation();
        if (!p.focused) p.onFocus();
      }}
    >
      <div className="hd">
        <span className="sgt">
          <IPlus s={14} />
          Suggested {kind.toLowerCase()} · {p.agentName}
        </span>
        <span className="sp" />
        {p.focused && !mobile ? (
          <span className="pos">
            {p.index + 1} of {p.total}
          </span>
        ) : null}
        {editing === null && mobile ? (
          // Phones (§11): the header is the title; Reject and Accept live in the bottom bar.
          <button type="button" className="icon-btn e44" aria-label="Edit diagram source" onClick={() => setEditing(code)}>
            <IEdit s={18} />
          </button>
        ) : editing === null ? (
          <>
            <button type="button" className="btn quiet sm" onClick={() => setEditing(code)}>
              <IEdit s={14} />
              Edit
            </button>
            <button type="button" className="btn quiet sm" aria-keyshortcuts="Meta+Backspace" onClick={p.onReject}>
              <IX s={14} />
              Reject{p.focused ? <span className="kb">{MOD}⌫</span> : null}
            </button>
            <button type="button" className="btn soft sm" aria-keyshortcuts="Meta+Enter" onClick={() => p.onAccept()}>
              <ICheck s={14} />
              Accept{p.focused ? <span className="kb">{MOD}↵</span> : null}
            </button>
          </>
        ) : null}
      </div>
      {editing === null ? (
        <>
          <Diagram code={code} bare />
          {title ? <div className="cap5">{title}</div> : null}
        </>
      ) : (
        <SourceEditor
          initial={code}
          onDone={(t) => {
            setEditing(null);
            // Unchanged keeps it a suggestion; changed accepts it with your changes.
            if (t.trim() && t.trim() !== code.trim()) p.onAccept(t);
          }}
        />
      )}
    </div>
  );
  if (old === null) return block;
  return (
    <div className="pair5">
      <div className="rmb" data-testid="diagram-removed">
        <div className="hd">
          <span className="sgt">
            <IMinus s={14} />
            Removed · {p.agentName}
          </span>
        </div>
        <Diagram code={old} bare />
      </div>
      {block}
    </div>
  );
}

function SourceEditor({ initial, onDone }: { initial: string; onDone: (t: string) => void }) {
  const [text, setText] = useState(initial);
  const [now, setNow] = useState(0);
  const [err, setErr] = useState<MermaidErr | null>(null);
  const errId = useId();
  const ref = useRef<HTMLTextAreaElement>(null);
  const ended = useRef(false);
  useEffect(() => {
    ref.current?.focus();
    // An open editor drops the Undo toast, so it never sits on the hint row.
    dispatchEvent(new Event("grillado:editor-open"));
  }, []);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${el.scrollHeight}px`;
  }, [text]);
  const finish = () => {
    if (ended.current) return;
    ended.current = true;
    onDone(ref.current?.value ?? text);
  };
  // Mobile: Source | Preview in the accessory row instead of the preview under the source (§11).
  const mobile = useMobile();
  const rootRef = useRef<HTMLDivElement>(null);
  const sp = useSourcePreview(mobile, rootRef, ref, finish);
  const dock = useKeyboardDock(mobile);
  return (
    <div ref={rootRef} className="ned5" data-view={mobile ? sp.view : undefined} onClick={(e) => e.stopPropagation()}>
      <textarea
        ref={ref}
        className="blk-edit mono"
        aria-label="Edit the suggested diagram as Mermaid. Escape to finish."
        spellCheck={false}
        aria-describedby={err ? errId : undefined}
        aria-invalid={err ? true : undefined}
        value={text}
        onChange={(e) => setText(e.target.value)}
        onBlur={(e) => {
          if (!sp.keeps(e.relatedTarget)) finish();
        }}
        onKeyDown={(e) => {
          e.stopPropagation();
          if (e.key === "Escape") {
            e.preventDefault();
            finish();
          } else if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
            e.preventDefault();
            setNow((n) => n + 1);
          }
        }}
      />
      {err ? <MermaidError id={errId} err={err} /> : null}
      <div className="blk-preview" role="group" aria-label="Live preview">
        <LivePreview code={text} now={now} onError={setErr} />
      </div>
      <p className="blk-hint" aria-hidden="true">
        {mobile ? (
          "Mermaid"
        ) : (
          <>
            Mermaid · <span className="kb4">⌘↵</span> draw now · <span className="kb4">Esc</span> finish
          </>
        )}
      </p>
      {mobile ? (
        <div className="acc4" role="toolbar" aria-label="Editing" style={{ bottom: dock }} onMouseDown={(e) => e.preventDefault()}>
          <SourcePreviewSwitch
            view={sp.view}
            onView={(v) => {
              sp.set(v);
              if (v === "preview") setNow((n) => n + 1);
            }}
          />
          <span className="sp" />
          <button type="button" className="btn quiet" onClick={finish}>
            Done
          </button>
        </div>
      ) : null}
    </div>
  );
}
