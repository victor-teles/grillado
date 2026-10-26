// A ```decision block in the rich view (v1.1 §3): a compact card you change in place.
//
// v1.2 (HANDOFF-ENGINEER §3): a --sel surface, no border. Question muted, answer 15/600.
//   .dz[data-state=rest|changing|open|stale][data-invalid]
//   .dz-q .dz-a (+ .dz-badge[data-kind=yours] "Your call" after the answer) .dz-n
//   .dz-h: one muted meta line ("R3·1 · Affects 2 passages"), revealed on hover / keyboard focus-within
//   .dz-opts[role=radiogroup] .dz-opt[aria-checked]: the round's radio rows; .dz-tag muted inline
//   .dz-warn muted text, .dz-err destructive text, .dz-act buttons on the right
import { useEffect, useId, useRef, useState } from "react";
import type { DecisionFields } from "../../../../src/core/decision-block.ts";
import { OTHER_OPTION, type Question } from "../types";

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
}) {
  const ref = useRef<HTMLDivElement>(null);
  const changeBtn = useRef<HTMLButtonElement>(null);
  const uid = useId();
  const options = question?.options ?? [];
  const currentId = state === "open" ? undefined : options.find((o) => o.label === fields.answer)?.id ?? (fields.answer ? OTHER_OPTION : undefined);
  // Open decisions start collapsed with a quiet "Answer" so Copy Markdown keeps the only blue (v1.2 review).
  const [expanded, setExpanded] = useState(false);
  const [pick, setPick] = useState<string | undefined>(currentId ?? question?.recommendedOptionId);
  const [other, setOther] = useState(currentId === OTHER_OPTION ? fields.answer ?? "" : "");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [aff, setAff] = useState<{ above: number; below: number } | null>(null);
  // Number-key hints show only after the first number press, as in the round.
  const [keys, setKeys] = useState(false);

  useEffect(() => {
    if (!expanded) setPick(currentId ?? question?.recommendedOptionId);
  }, [currentId, question?.recommendedOptionId, expanded]);

  const canChange = !!question && !readOnly && state !== "stale";
  const differs = pick !== currentId || (pick === OTHER_OPTION && other.trim() !== (fields.answer ?? ""));
  const reasks = state === "settled" && differs && dependents.length > 0;
  const ready = !!pick && (pick !== OTHER_OPTION || !!other.trim()) && (state === "open" || differs);

  const measure = () => {
    const scroller = ref.current?.closest(".docwrap") as HTMLElement | null;
    const box = scroller?.getBoundingClientRect() ?? { top: 0, bottom: window.innerHeight };
    let above = 0;
    let below = 0;
    for (const id of passages) {
      const r = document.getElementById(id)?.getBoundingClientRect();
      if (!r) continue;
      if (r.bottom < box.top) above++;
      else if (r.top > box.bottom) below++;
    }
    setAff({ above, below });
  };
  const activate = (on: boolean) => {
    onActive(on);
    if (on) measure();
  };
  const jump = () => {
    const scroller = ref.current?.closest(".docwrap") as HTMLElement | null;
    const box = scroller?.getBoundingClientRect() ?? { top: 0, bottom: window.innerHeight };
    const els = passages.map((id) => document.getElementById(id)).filter((x): x is HTMLElement => !!x);
    const next = els.find((e) => e.getBoundingClientRect().top > box.bottom) ?? [...els].reverse().find((e) => e.getBoundingClientRect().bottom < box.top);
    next?.scrollIntoView({ block: "center" });
    requestAnimationFrame(measure);
  };

  // The Change/Answer button unmounts on expand; keep focus in the card (as with Enter) so Escape and 1–9 reach it.
  const expand = () => {
    setExpanded(true);
    ref.current?.focus({ preventScroll: true });
  };
  const cancel = () => {
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
      setExpanded(false);
      requestAnimationFrame(() => ref.current?.focus());
    } catch (err: any) {
      setError(String(err?.message ?? err));
    } finally {
      setBusy(false);
    }
  };

  const view = expanded ? (state === "open" ? "open" : "changing") : state === "stale" ? "stale" : state === "open" ? "open" : "rest";
  const badge =
    state === "stale"
      ? { kind: "stale", text: "Will be asked again" }
      : state === "open"
        ? { kind: "open", text: "Open" }
        : fields.kept_suggestion
          ? { kind: "kept", text: "Kept the suggestion" }
          : { kind: "yours", text: "Your call" };
  const allOptions = [...options.map((o) => ({ id: o.id, label: o.label })), { id: OTHER_OPTION, label: "Something else" }];

  return (
    <div
      ref={ref}
      className="dz"
      data-state={view}
      data-invalid={invalid ? "" : undefined}
      data-key={fields.key}
      role="group"
      aria-roledescription="decision"
      aria-label={`Decision ${fields.id}`}
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
              <span className="dz-av">{fields.answer}</span>
              {badge.kind === "yours" ? (
                <span className="dz-badge yc" data-kind="yours">
                  Your call
                </span>
              ) : null}
              {badge.kind === "stale" ? (
                <span className="dz-badge" data-kind="stale">
                  Will be asked again
                </span>
              ) : null}
            </div>
          ) : null}
          {fields.note ? <div className="dz-n">{fields.note}</div> : null}
          {invalid ? <div className="dz-n">This block has a mistake in plan.md. Showing the last version that worked.</div> : null}
        </>
      ) : null}
      <div className="dz-h">
        <span className="dz-lbl">Decision</span>
        <span className="dz-id">{fields.id}</span>
        {badge.kind === "kept" ? (
          <span className="dz-badge" data-kind="kept">
            Kept the suggestion
          </span>
        ) : null}
        {passages.length ? (
          <button type="button" className="dz-aff" onClick={jump} tabIndex={-1} aria-hidden="true">
            Affects {passages.length} {passages.length === 1 ? "passage" : "passages"}
            {aff?.below ? ` · ${aff.below} below ↓` : aff?.above ? ` · ${aff.above} above ↑` : ""}
          </button>
        ) : null}
      </div>
      {(view === "rest" || view === "stale" || (view === "open" && !expanded)) && canChange ? (
        <div className="dz-act">
          {view === "open" ? (
            <button type="button" className="btn quiet sm" onClick={expand}>
              Answer
            </button>
          ) : (
            <button ref={changeBtn} type="button" className="btn quiet sm" onClick={expand} aria-label={`Change ${fields.id}`}>
              Change
            </button>
          )}
        </div>
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
            <button type="button" className="btn primary sm" disabled={!ready || busy} aria-describedby={reasks ? `${uid}-warn` : undefined} onClick={() => void submit()}>
              {reasks ? `Save and re-ask ${dependents.length}` : "Save answer"}
            </button>
          </div>
        </>
      ) : null}
    </div>
  );
}
