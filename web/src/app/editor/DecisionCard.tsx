// A ```decision block in the rich view (v1.1 §3): a compact card you change in place.
//
// v1.2 (HANDOFF-ENGINEER §3): a --sel surface, no border. Question muted, answer 15/600.
//   .dz[data-state=rest|changing|open|stale][data-invalid]
//   .dz-q .dz-a (+ .dz-badge[data-kind=yours] "Your call" after the answer) .dz-n
//   .dz-h: one muted meta line ("R3·1 · Affects 2 passages"), revealed on hover / keyboard focus-within
//   .dz-opts[role=radiogroup] .dz-opt[aria-checked]: the round's radio rows; .dz-tag muted inline
//   .dz-warn muted text, .dz-err destructive text, .dz-act buttons on the right
// Item 2: .dz.lk (lit from its plan text), [data-fl] (jump flash), .dz-who ("Picked by {agent}" at rest),
//   .dz-orph (no passage cites it), .fb.wait (re-ask line under the block), .fb.ext (#26 outside edit).
import { useEffect, useId, useRef, useState } from "react";
import type { DecisionFields } from "../../../../src/core/decision-block.ts";
import { COPY, fmt } from "../copy";
import { OTHER_OPTION, type Question } from "../types";
import { IAlert, IRefresh } from "../icons";
import { noteAdds, restTag, whoLine } from "./decision-meta";
import { jumpTo, offscreen } from "./link";

export interface Pick {
  optionId: string;
  text?: string;
}

export type CardState = "settled" | "open" | "stale";

// A citation jump scrolls a card into view and focuses it; the card that lands under a resting pointer gets a
// mouseenter without the pointer moving, and must not take the highlight from the one just focused.
let lastFocus: { el: HTMLElement | null; at: number } = { el: null, at: 0 };
const justFocusedElsewhere = (el: HTMLElement | null) =>
  !!lastFocus.el && lastFocus.el !== el && lastFocus.el.contains(document.activeElement) && performance.now() - lastFocus.at < 300;

export function DecisionCard({
  fields,
  state,
  question,
  dependents,
  passages,
  invalid,
  readOnly,
  onActive,
  onSave,
  agentName,
  own,
  lit,
  was,
  feedback,
  external,
  onExternal,
  onReask,
  startExpanded,
  onClose,
}: {
  fields: DecisionFields;
  state: CardState;
  question?: Question;
  /** Names of the decisions that are asked again when this one changes. */
  dependents: string[];
  /** DOM ids of the passages that cite this decision. */
  passages: string[];
  /** The block in plan.md doesn't parse; this is its last valid version. */
  invalid?: boolean;
  readOnly?: boolean;
  onActive: (on: boolean) => void;
  onSave: (pick: Pick) => Promise<void>;
  /** The selected agent's display name, for "Picked by …" when `by: agent`. */
  agentName: string;
  /** A decision you added yourself (U id, item 4): open ones say the agent asks them next round. */
  own?: boolean;
  /** Lit from a hovered passage (§2.2): background only. */
  lit?: boolean;
  /** The answer before a change made here a moment ago ("Changed just now · was …"). */
  was?: string;
  /** One inline sentence under the block (re-ask, §3.5). */
  feedback?: string;
  /** DECISIONS #26: plan.md's answer changed outside Grillado; `deps` will be asked again. */
  external?: { from: string; to: string; deps: string[] };
  onExternal?: (confirm: boolean) => Promise<void>;
  /** A stale decision nobody is asking yet: a quiet "Re-ask". */
  onReask?: () => Promise<void>;
  /** Open on mount (Change from a Decisions tab row). */
  startExpanded?: boolean;
  onClose?: () => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const changeBtn = useRef<HTMLButtonElement>(null);
  const uid = useId();
  const options = question?.options ?? [];
  const currentId = state === "open" ? undefined : options.find((o) => o.label === fields.answer)?.id ?? (fields.answer ? OTHER_OPTION : undefined);
  // Open decisions start collapsed with a quiet "Answer" so Copy Markdown keeps the only blue (v1.2 review).
  const [expanded, setExpanded] = useState(!!startExpanded);
  const [pick, setPick] = useState<string | undefined>(currentId ?? question?.recommendedOptionId);
  const [other, setOther] = useState(currentId === OTHER_OPTION ? fields.answer ?? "" : "");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [aff, setAff] = useState<{ above: number; below: number } | null>(null);
  const [cycle, setCycle] = useState(-1);
  const [say, setSay] = useState("");
  // Number-key hints show only after the first number press, as in the round.
  const [keys, setKeys] = useState(false);

  useEffect(() => {
    if (!expanded) setPick(currentId ?? question?.recommendedOptionId);
  }, [currentId, question?.recommendedOptionId, expanded]);

  const canChange = !!question && !readOnly && state !== "stale" && !external;
  const differs = pick !== currentId || (pick === OTHER_OPTION && other.trim() !== (fields.answer ?? ""));
  const reasks = state === "settled" && differs && dependents.length > 0;
  const ready = !!pick && (pick !== OTHER_OPTION || !!other.trim()) && (state === "open" || differs);

  const measure = () => {
    let above = 0;
    let below = 0;
    for (const id of passages) {
      const where = offscreen(document.getElementById(id));
      if (where === "above") above++;
      else if (where === "below") below++;
    }
    setAff({ above, below });
  };
  const activate = (on: boolean) => {
    onActive(on);
    if (on) measure();
  };
  // §2.4: "Affects" cycles through the passages in document order, announcing "Passage 2 of 2".
  const jump = () => {
    if (!passages.length) return;
    const i = (cycle + 1) % passages.length;
    setCycle(i);
    jumpTo(document.getElementById(passages[i]));
    setSay(`Passage ${i + 1} of ${passages.length}`);
    setTimeout(measure, 400);
  };
  // The Change/Answer button unmounts on expand; keep focus in the card (as with Enter) so Escape and 1–9 reach it.
  const expand = () => {
    setExpanded(true);
    ref.current?.focus({ preventScroll: true });
  };
  const cancel = () => {
    if (onClose) return onClose();
    setExpanded(false);
    setError("");
    setPick(currentId ?? question?.recommendedOptionId);
    requestAnimationFrame(() => ref.current?.focus());
  };
  const submit = async () => {
    if (!ready || !pick || busy) return;
    setBusy(true);
    setError("");
    try {
      await onSave({ optionId: pick, text: pick === OTHER_OPTION ? other.trim() : undefined });
      if (onClose) return onClose();
      setExpanded(false);
      requestAnimationFrame(() => ref.current?.focus());
    } catch (err: any) {
      setError(String(err?.message ?? err));
    } finally {
      setBusy(false);
    }
  };

  const view = expanded ? (state === "open" ? "open" : "changing") : state === "stale" ? "stale" : state === "open" ? "open" : "rest";
  const tag = state === "settled" ? restTag(fields, agentName) : null;
  const who = state === "settled" ? whoLine(fields, agentName, { was }) : own && state === "open" ? fmt(COPY.ownOpen, { agent: agentName }) : null;
  const orphan = state === "settled" && !passages.length;
  const run = async (f: () => Promise<void>) => {
    setBusy(true);
    setError("");
    try {
      await f();
    } catch (err: any) {
      setError(String(err?.message ?? err));
    } finally {
      setBusy(false);
    }
  };
  const allOptions = [...options.map((o) => ({ id: o.id, label: o.label })), { id: OTHER_OPTION, label: "Something else" }];

  return (
    <div
      ref={ref}
      className={lit ? "dz lk" : "dz"}
      data-state={view}
      data-invalid={invalid ? "" : undefined}
      data-key={fields.key}
      role="group"
      aria-roledescription="decision"
      aria-label={`Decision ${fields.id}: ${fields.question}${fields.answer && state !== "open" ? ` ${fields.answer}` : ""}`}
      aria-describedby={passages.length ? passages.join(" ") : undefined}
      contentEditable={false}
      tabIndex={0}
      onMouseEnter={() => !justFocusedElsewhere(ref.current) && activate(true)}
      onMouseLeave={() => !ref.current?.contains(document.activeElement) && activate(false)}
      onFocus={() => {
        lastFocus = { el: ref.current, at: performance.now() };
        activate(true);
      }}
      onBlur={(e) => !ref.current?.contains(e.relatedTarget as Node) && activate(false)}
      onKeyDown={(e) => {
        if (e.target === ref.current && e.key === "Enter" && canChange && !expanded) {
          e.preventDefault();
          setExpanded(true);
          return;
        }
        if (!expanded) return;
        if (e.key === "Escape") {
          e.preventDefault();
          e.stopPropagation();
          cancel();
        } else if (/^[1-9]$/.test(e.key) && !(e.target as HTMLElement).matches("input,textarea")) {
          const o = allOptions[Number(e.key) - 1];
          if (o) {
            e.preventDefault();
            setKeys(true);
            setPick(o.id);
          }
        } else if (e.key === "Enter" && !(e.target as HTMLElement).matches("button")) {
          e.preventDefault();
          void submit();
        }
      }}
    >
      <div className="dz-q">
        {state === "open" ? <span className="sr-only">Open: </span> : null}
        {fields.question}
      </div>
      {view === "rest" || view === "stale" ? (
        <>
          {fields.answer ? (
            <div className="dz-a">
              {state === "stale" ? <s className="dz-av">{fields.answer}</s> : <span className="dz-av">{fields.answer}</span>}
              {tag ? (
                <span className={tag.kind === "yours" ? "dz-badge yc" : "dz-badge dz-who"} data-kind={tag.kind}>
                  {tag.text}
                </span>
              ) : null}
              {state === "stale" ? (
                <span className="dz-badge" data-kind="stale">
                  {onReask ? "Depends on a changed answer" : "Will be asked again"}
                </span>
              ) : null}
            </div>
          ) : null}
          {noteAdds(fields.note, fields.answer) ? <div className="dz-n">{fields.note}</div> : null}
          {invalid ? <div className="dz-n">This block has a mistake in plan.md. Showing the last version that worked.</div> : null}
        </>
      ) : null}
      <div className="dz-h">
        <span className="dz-id">{fields.id}</span>
        {who ? <span className="dz-when">{who}</span> : null}
        {orphan ? (
          <span className="dz-orph">
            <IAlert s={12} />
            Not in the plan text yet
          </span>
        ) : passages.length ? (
          <button type="button" className="dz-aff" onClick={jump} tabIndex={-1} aria-hidden="true">
            Affects {passages.length} {passages.length === 1 ? "passage" : "passages"}
            {aff?.below ? ` · ${aff.below} below ↓` : aff?.above ? ` · ${aff.above} above ↑` : ""}
          </button>
        ) : null}
      </div>
      <span className="sr-only" role="status">
        {say}
      </span>
      {(view === "rest" || view === "stale" || (view === "open" && !expanded)) && canChange ? (
        <div className="dz-act">
          {view === "open" ? (
            <button type="button" className="btn quiet sm" onClick={expand}>
              Answer
            </button>
          ) : view === "stale" ? null : (
            <button ref={changeBtn} type="button" className="btn quiet sm" onClick={expand} aria-label={`Change ${fields.id}`}>
              Change
            </button>
          )}
        </div>
      ) : null}
      {view === "stale" && onReask && !readOnly ? (
        <div className="dz-act">
          <button type="button" className="btn quiet sm" disabled={busy} aria-label={`Re-ask ${fields.question}`} onClick={() => void run(onReask)}>
            Re-ask
          </button>
        </div>
      ) : null}
      {external && onExternal && !expanded ? (
        <div className="fb ext" role="status">
          <span>{fmt(COPY.external, { to: external.to, from: external.from, list: listOf(external.deps) })}</span>
          <span className="fb-acts">
            <button type="button" className="btn quiet sm" disabled={busy || readOnly} onClick={() => void run(() => onExternal(false))}>
              Not now
            </button>
            <button type="button" className="btn primary sm" disabled={busy || readOnly} onClick={() => void run(() => onExternal(true))}>
              Re-ask {external.deps.length}
            </button>
          </span>
        </div>
      ) : null}
      {error && !expanded ? (
        <p className="dz-err" role="alert">
          {error}
        </p>
      ) : null}
      {feedback ? (
        <p className="fb wait" role="status">
          <IRefresh s={14} />
          <span>{feedback}</span>
        </p>
      ) : null}
      {expanded ? (
        <>
          <div className="dz-opts" role="radiogroup" aria-label={fields.question}>
            {allOptions.map((o, i) => (
              <button
                key={o.id}
                type="button"
                role="radio"
                className="dz-opt"
                aria-checked={pick === o.id}
                tabIndex={pick === o.id || (!pick && i === 0) ? 0 : -1}
                onClick={() => setPick(o.id)}
                onKeyDown={(e) => {
                  if (e.key !== "ArrowDown" && e.key !== "ArrowUp") return;
                  e.preventDefault();
                  const n = allOptions[(i + (e.key === "ArrowDown" ? 1 : allOptions.length - 1)) % allOptions.length];
                  setPick(n.id);
                  (e.currentTarget.parentElement?.children[allOptions.indexOf(n)] as HTMLElement | undefined)?.focus();
                }}
              >
                <span className="rd" aria-hidden="true" />
                <span className="lb">
                  <span>{o.label}</span>
                  {o.id === currentId ? <span className="dz-tag">Current</span> : null}
                  {o.id === question?.recommendedOptionId ? <span className="dz-tag">Recommended</span> : null}
                </span>
                {keys ? (
                  <kbd className="n" aria-hidden="true">
                    {i + 1}
                  </kbd>
                ) : (
                  <span />
                )}
              </button>
            ))}
          </div>
          {pick === OTHER_OPTION ? (
            <input
              className="dz-other"
              aria-label="Your answer"
              value={other}
              autoFocus
              maxLength={2000}
              onChange={(e) => setOther(e.target.value)}
            />
          ) : null}
          {reasks ? (
            <p className="dz-warn" id={`${uid}-warn`}>
              {dependents.length === 1 ? "This decision depends on it and will be asked again: " : "These decisions depend on it and will be asked again: "}
              {dependents.join(", ")}.
            </p>
          ) : null}
          {error ? (
            <p className="dz-err" role="alert">
              {error}
            </p>
          ) : null}
          <div className="dz-act">
            <button type="button" className="btn quiet sm" onClick={cancel}>
              {state === "open" ? "Leave open" : "Cancel"}
            </button>
            {/* Not ready yet: a quiet disabled button, so the screen's one blue stays on Copy (PR #2 review). */}
            <button
              type="button"
              className={ready && !busy ? "btn primary sm" : "btn sm dz-off"}
              disabled={!ready || busy}
              aria-describedby={reasks ? `${uid}-warn` : undefined}
              onClick={() => void submit()}
            >
              {reasks ? `Save and re-ask ${dependents.length}` : "Save answer"}
            </button>
          </div>
        </>
      ) : null}
    </div>
  );
}

export function listOf(names: string[]): string {
  return names.length <= 2 ? names.join(" and ") : `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`;
}
