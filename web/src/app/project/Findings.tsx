// Plan 002: what the agent read in the project. "Found in your code" lists the facts a round didn't
// need to ask; "From your code" on a card names the files that question rests on.
import { useId, useRef, useState } from "react";
import { COPY, fmt } from "../copy";
import { IChev } from "../icons";
import type { Evidence, Finding, SessionView } from "../types";

type Correction = NonNullable<SessionView["corrections"]>[number];
type Act = (action: string, body?: unknown) => Promise<void>;

/** A path shortened from the left so the file name always shows: "…/editor/autosave.ts". */
export function shortPath(p: string, max = 34): string {
  if (p.length <= max) return p;
  const parts = p.split("/");
  let out = parts.pop()!;
  while (parts.length && out.length + parts.at(-1)!.length + 3 <= max) out = `${parts.pop()}/${out}`;
  return parts.length ? `…/${out}` : out;
}

function FileChip({ path, onClick, expanded, controls }: { path: string; onClick?: () => void; expanded?: boolean; controls?: string }) {
  const label = shortPath(path);
  if (!onClick)
    return (
      <code className="fchip" title={path}>
        {label}
      </code>
    );
  return (
    <button type="button" className="fchip" title={path} aria-label={path} aria-expanded={expanded} aria-controls={controls} onClick={onClick}>
      {label}
    </button>
  );
}

/** Under a round's intro: the findings this round brought, closed until opened. Each can be corrected (plan 003). */
export function FoundInCode({ findings, round, corrections, act }: { findings?: Finding[]; round: number; corrections?: Correction[]; act?: Act }) {
  const mine = (findings ?? []).filter((f) => f.round === round);
  if (!mine.length) return null;
  const count = mine.length === 1 ? COPY.foundCountOne : fmt(COPY.foundCount, { n: mine.length });
  return (
    <details className="found-code" data-testid="found-in-code">
      <summary>
        <IChev s={14} />
        <span className="t">{COPY.foundInCode}</span>
        <span className="n">· {count}</span>
      </summary>
      <ul>
        {mine.map((f) => (
          <FindingRow key={f.id} f={f} round={round} correction={corrections?.find((c) => c.finding === f.id)} act={act} />
        ))}
      </ul>
    </details>
  );
}

function FindingRow({ f, round, correction, act }: { f: Finding; round: number; correction?: Correction; act?: Act }) {
  const [editing, setEditing] = useState(false);
  const [text, setText] = useState("");
  const [error, setError] = useState("");
  const opener = useRef<HTMLButtonElement>(null);
  const inputId = useId();
  const close = () => {
    setEditing(false);
    setError("");
    requestAnimationFrame(() => opener.current?.focus());
  };
  const save = async () => {
    if (!text.trim() || !act) return;
    try {
      await act("correct", { finding: f.id, text: text.trim() });
      setText("");
      close();
    } catch (err: any) {
      setError(String(err?.message ?? err));
    }
  };
  return (
    <li data-testid="finding" data-corrected={correction ? true : undefined}>
      <span className="k">{f.label}</span>
      <span className="v">
        {correction ? <del>{f.fact}</del> : f.fact}
        {correction ? (
          <span className="yours">
            <span className="who">{COPY.you}</span> {correction.text}
            {correction.round === round && act ? (
              <button type="button" className="btn quiet sm" onClick={() => void act("uncorrect", { finding: f.id }).catch(() => {})}>
                {COPY.correctionUndo}
              </button>
            ) : null}
          </span>
        ) : null}
      </span>
      <span className="files">
        {f.paths.map((p) => (
          <FileChip key={p} path={p} />
        ))}
        {act && !correction && !editing ? (
          <button ref={opener} type="button" className="btn quiet sm" aria-label={`${COPY.notRight}: ${f.label}`} onClick={() => setEditing(true)}>
            {COPY.notRight}
          </button>
        ) : null}
      </span>
      {editing ? (
        <span className="fix">
          <label htmlFor={inputId}>{COPY.whatsTrue}</label>
          <span className="in">
            <input
              id={inputId}
              autoFocus
              value={text}
              maxLength={500}
              aria-invalid={error ? true : undefined}
              onChange={(e) => setText(e.target.value)}
              onKeyDown={(e) => {
                // Inside the round's form: Enter saves this, never sends the round; Escape cancels.
                if (e.key === "Enter") {
                  e.preventDefault();
                  e.stopPropagation();
                  void save();
                } else if (e.key === "Escape") {
                  e.preventDefault();
                  e.stopPropagation();
                  close();
                }
              }}
            />
            <button type="button" className="btn soft sm" disabled={!text.trim()} onClick={() => void save()}>
              {COPY.correctionSave}
            </button>
          </span>
          {error ? (
            <span className="err" role="alert">
              {error}
            </span>
          ) : null}
        </span>
      ) : null}
    </li>
  );
}

const SHOWN = 3;

/** On a question card: the files it is based on. A chip shows its note beneath the line. */
export function FromYourCode({ evidence }: { evidence?: Evidence[] }) {
  const [open, setOpen] = useState<string | null>(null);
  const [all, setAll] = useState(false);
  const noteId = useId();
  if (!evidence?.length) return null;
  const shown = all ? evidence : evidence.slice(0, SHOWN);
  const note = evidence.find((e) => e.path === open);
  return (
    <div className="from-code" data-testid="from-code">
      <div className="fc-row">
        <span className="t">{COPY.fromYourCode}</span>
        {shown.map((e) => (
          <FileChip key={e.path} path={e.path} expanded={open === e.path} controls={noteId} onClick={() => setOpen((cur) => (cur === e.path ? null : e.path))} />
        ))}
        {!all && evidence.length > SHOWN ? (
          <button type="button" className="fchip more" onClick={() => setAll(true)}>
            {fmt(COPY.moreFiles, { n: evidence.length - SHOWN })}
          </button>
        ) : null}
      </div>
      <p id={noteId} className="note" aria-live="polite" hidden={!note?.note}>
        {note?.note}
      </p>
    </div>
  );
}
