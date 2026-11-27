// Option previews ("See before you choose"): a question's options can each carry a UI mock, a code
// sketch or a diagram. This file shows them: small under the question, full size in Compare.
//
// The preview's source is written by the agent and is not trusted. A UI mock is only ever put in
// a frame with an empty `sandbox` (an origin of its own, no scripts, no forms, no way out of the
// frame) and a content security policy that loads nothing. Code is shown as text. Diagrams go
// through the same Mermaid renderer as the plan's.
import { useEffect, useId, useMemo, useRef, useState } from "react";
import { Dialog } from "radix-ui";
import { MAX_OPTIONS } from "../../../../src/core/previews.ts";
import { COPY, fmt } from "../copy";
import { DiagramSketch } from "../editor/DiagramView";
import { ICheck, IX } from "../icons";
import type { Option, Preview, Question, SessionView } from "../types";
import { tokenize } from "./highlight";

type Act = (action: string, body?: unknown) => Promise<void>;

/** Nothing loads: no scripts, no requests, no forms. Inline CSS and data: images are all a mock gets. */
const kw = (word: string) => `${String.fromCharCode(39)}${word}${String.fromCharCode(39)}`;
export const FRAME_CSP = `default-src ${kw("none")}; style-src ${kw("unsafe-inline")}; img-src data:; font-src data:; form-action ${kw("none")}; base-uri ${kw("none")}`;

/**
 * The document a UI mock is shown in. Tags that would send the frame elsewhere are taken out; the
 * sandbox and the policy are what hold. A mock writes its dark colors under a prefers-color-scheme
 * query, which follows the system, not Grillado's own theme: those queries are rewritten to always
 * or never apply, so the mock matches the theme it is shown in.
 */
export function uiDocument(source: string, dark = false): string {
  const scheme = dark ? "dark" : "light";
  const body = source
    .replace(/<meta\b[^>]*>/gi, "")
    .replace(/<base\b[^>]*>/gi, "")
    .replace(/\(\s*prefers-color-scheme\s*:\s*(dark|light)\s*\)/gi, (_, s: string) => (s.toLowerCase() === scheme ? "(min-width:0)" : "(max-width:0)"));
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="${FRAME_CSP}"><meta name="viewport" content="width=device-width,initial-scale=1"><style>:root{color-scheme:${scheme}}html,body{margin:0}body{font:14px/1.45 system-ui,sans-serif;background:Canvas;color:CanvasText}</style></head><body>${body}</body></html>`;
}

/** Whether Grillado is in its dark theme (the class on the root element), kept current when it is switched. */
function useDark(): boolean {
  const read = () => document.documentElement.classList.contains("dark");
  const [dark, setDark] = useState(read);
  useEffect(() => {
    const o = new MutationObserver(() => setDark(read()));
    o.observe(document.documentElement, { attributes: true, attributeFilter: ["class"] });
    return () => o.disconnect();
  }, []);
  return dark;
}

function Code({ preview }: { preview: Preview }) {
  const tokens = useMemo(() => tokenize(preview.source, preview.lang), [preview.source, preview.lang]);
  return (
    <pre className="pv-code" data-lang={preview.lang || undefined}>
      <code>
        {tokens.map((t, i) =>
          t.kind ? (
            <span key={i} className={`tk-${t.kind}`}>
              {t.text}
            </span>
          ) : (
            t.text
          ),
        )}
      </code>
    </pre>
  );
}

/** One preview. `thumb`: a look, not a thing to use (it can't be focused or scrolled). */
export function PreviewView({ preview, label, thumb = false }: { preview: Preview; label: string; thumb?: boolean }) {
  const dark = useDark();
  if (preview.kind === "ui")
    return (
      <iframe
        className="pv-frame"
        title={fmt(COPY.previewOf, { option: label })}
        sandbox=""
        referrerPolicy="no-referrer"
        loading="lazy"
        tabIndex={thumb ? -1 : 0}
        srcDoc={uiDocument(preview.source, dark)}
      />
    );
  if (preview.kind === "code") return <Code preview={preview} />;
  return (
    <div className="pv-diagram">
      <DiagramSketch code={preview.source} />
    </div>
  );
}

function Unavailable() {
  return <p className="pv-none">{COPY.previewUnavailable}</p>;
}

/** Choose the question's option at `index` the way a number key does: through the question's own control. */
export function pickOption(key: string, index: number) {
  const item = document.querySelector(`[data-slot=agent-question-item][data-key="${CSS.escape(key)}"]`);
  item?.querySelectorAll<HTMLElement>("[data-slot=agent-question-option] [data-index]")[index]?.click();
}

export const hasPreviews = (q: Question) => q.options.some((o) => o.preview);

/**
 * Under a question whose options have previews: a small look at each, in the options' order, then
 * Compare and Show me another. A click on one chooses that option; the option rows below stay as
 * they are, so number keys and Enter work as on any question.
 */
export function PreviewStrip({ q, selected, session, act, onCompare }: { q: Question; selected: string; session: SessionView; act: Act; onCompare: () => void }) {
  const run = session.anotherRun?.question === q.key ? session.anotherRun : undefined;
  const [asking, setAsking] = useState(false);
  const [failed, setFailed] = useState("");
  const full = q.options.length >= MAX_OPTIONS;
  const busy = asking || run?.state === "running";
  const hintId = useId();
  // When an option arrives: bring its tile into view and say so. The choice made so far stays as it is.
  const count = useRef(q.options.length);
  const row = useRef<HTMLUListElement>(null);
  const [said, setSaid] = useState("");
  useEffect(() => {
    if (q.options.length > count.current) {
      setSaid(fmt(COPY.anotherAdded, { n: String(q.options.length), option: q.options.at(-1)!.label }));
      const still = matchMedia("(prefers-reduced-motion: reduce)").matches;
      row.current?.lastElementChild?.scrollIntoView({ block: "nearest", inline: "nearest", behavior: still ? "auto" : "smooth" });
    }
    count.current = q.options.length;
  }, [q.options]);
  const another = async () => {
    setAsking(true);
    setFailed("");
    try {
      await act("another", { key: q.key });
    } catch (err) {
      setFailed((err as Error).message);
    } finally {
      setAsking(false);
    }
  };
  const error = failed || (run?.state === "error" ? COPY.anotherFailed : "");
  return (
    <div className="pv" data-testid="previews">
      <ul className="pv-row" ref={row}>
        {q.options.map((o, i) => (
          <li key={o.id} className="pv-tile" data-selected={o.id === selected || undefined} data-testid="preview-tile">
            <div className="pv-view" inert aria-hidden="true">
              {o.preview ? <PreviewView preview={o.preview} label={o.label} thumb /> : <Unavailable />}
            </div>
            <button type="button" className="pv-pick" aria-pressed={o.id === selected} onClick={() => pickOption(q.key, i)}>
              <kbd>{i + 1}</kbd>
              <span className="nm">{o.label}</span>
              {o.id === q.recommendedOptionId ? <span className="rec">{COPY.suggested}</span> : null}
            </button>
          </li>
        ))}
      </ul>
      <div className="pv-acts">
        <button type="button" className="btn soft sm" data-testid="compare" onClick={onCompare}>
          {COPY.compare}
        </button>
        <button type="button" className="btn quiet sm" data-testid="another" disabled={busy || full} aria-describedby={full ? hintId : undefined} onClick={() => void another()}>
          {busy ? COPY.anotherBusy : COPY.another}
        </button>
        {full ? (
          <span className="meta" id={hintId}>
            {fmt(COPY.anotherFull, { n: String(MAX_OPTIONS) })}
          </span>
        ) : null}
        {error && !busy ? (
          <span className="err" role="alert" data-testid="another-error">
            {error}{" "}
            <button type="button" className="lnk" onClick={() => void another()}>
              {COPY.tryAgain}
            </button>
          </span>
        ) : null}
      </div>
      <span className="sr-only" aria-live="polite">
        {said}
      </span>
    </div>
  );
}

function Column({ q, o, index, selected }: { q: Question; o: Option; index: number; selected: boolean }) {
  return (
    <section className="cmp-col" data-selected={selected || undefined} data-testid="compare-col" aria-label={o.label}>
      <header>
        <kbd>{index + 1}</kbd>
        <b>{o.label}</b>
        {o.id === q.recommendedOptionId ? <span className="rec">{COPY.suggested}</span> : null}
        {o.description ? <p>{o.description}</p> : null}
      </header>
      <div className="cmp-view">{o.preview ? <PreviewView preview={o.preview} label={o.label} /> : <Unavailable />}</div>
      <footer>
        <button type="button" className={selected ? "btn primary sm" : "btn soft sm"} aria-pressed={selected} data-testid="compare-choose" onClick={() => pickOption(q.key, index)}>
          {selected ? <ICheck s={14} /> : null}
          {selected ? COPY.chosen : COPY.choose}
        </button>
      </footer>
    </section>
  );
}

/**
 * Compare: every option's preview at full size, side by side; on a phone one at a time, with
 * Previous and Next. Choosing here only chooses: the round is sent as always (Enter, or Send round).
 */
export function Compare({ q, selected, mobile, onClose }: { q: Question; selected: string; mobile: boolean; onClose: () => void }) {
  const [at, setAt] = useState(() => Math.max(0, q.options.findIndex((o) => o.id === selected)));
  const n = q.options.length;
  const shown = Math.min(at, n - 1);
  const go = (d: number) => setAt((v) => Math.min(n - 1, Math.max(0, Math.min(v, n - 1) + d)));
  const content = useRef<HTMLDivElement>(null);
  return (
    <Dialog.Root open onOpenChange={(o) => !o && onClose()}>
      <Dialog.Portal>
        <Dialog.Overlay className="scrim fsx" />
        <Dialog.Content
          ref={content}
          className={`fs5 cmp${mobile ? " m" : ""}`}
          data-testid="compare-dialog"
          aria-describedby={undefined}
          onCloseAutoFocus={(e) => {
            // Opened from the question's Compare button, which is outside this dialog's tree: focus goes back to it.
            e.preventDefault();
            document.querySelector<HTMLElement>(`[data-slot=agent-question-item][data-key="${CSS.escape(q.key)}"] [data-testid=compare]`)?.focus();
          }}
          onOpenAutoFocus={(e) => {
            // Focus the dialog itself, so number keys choose and Enter sends from the first frame.
            e.preventDefault();
            content.current?.focus();
          }}
          onKeyDown={(e) => {
            if (e.metaKey || e.ctrlKey || e.altKey) return;
            const digit = /^[1-9]$/.test(e.key) ? Number(e.key) : 0;
            if (digit && digit <= n) {
              e.preventDefault();
              pickOption(q.key, digit - 1);
              if (mobile) setAt(digit - 1);
            } else if (mobile && (e.key === "ArrowLeft" || e.key === "ArrowRight")) {
              e.preventDefault();
              go(e.key === "ArrowRight" ? 1 : -1);
            } else if (e.key === "Enter" && !(e.target as HTMLElement).closest("button, a, iframe")) {
              // Enter sends the round, as it does on the question itself.
              e.preventDefault();
              onClose();
              document.querySelector<HTMLButtonElement>("[data-slot=agent-question-continue]")?.click();
            }
          }}
        >
          <div className="fh">
            <Dialog.Title asChild>
              <b>{q.title}</b>
            </Dialog.Title>
            <span className="sp" />
            <Dialog.Close asChild>
              <button type="button" className="icon-btn" aria-label={COPY.compareClose}>
                <IX s={16} />
              </button>
            </Dialog.Close>
          </div>
          {mobile ? (
            <div className="cmp-one">
              <Column q={q} o={q.options[shown]} index={shown} selected={q.options[shown].id === selected} />
            </div>
          ) : (
            <div className="cmp-grid" style={{ ["--cols" as string]: String(n) }}>
              {q.options.map((o, i) => (
                <Column key={o.id} q={q} o={o} index={i} selected={o.id === selected} />
              ))}
            </div>
          )}
          <div className="cmp-foot">
            {mobile ? (
              <>
                <button type="button" className="btn soft sm" disabled={shown === 0} onClick={() => go(-1)} data-testid="compare-prev">
                  {COPY.previous}
                </button>
                <span className="meta" aria-live="polite" data-testid="compare-pos">
                  {fmt(COPY.position, { at: String(shown + 1), n: String(n) })}
                </span>
                <button type="button" className="btn soft sm" disabled={shown === n - 1} onClick={() => go(1)} data-testid="compare-next">
                  {COPY.next}
                </button>
              </>
            ) : (
              <span className="meta">{COPY.compareKeys}</span>
            )}
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
