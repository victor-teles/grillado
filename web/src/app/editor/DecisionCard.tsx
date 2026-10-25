// A ```decision block in the rich view (v1.1 §3): a compact card you change in place.
//
// Styling hooks (visuals are being redesigned; structure only):
//   .dz[data-state=rest|changing|open|stale][data-invalid]   the card
//   .dz-h (label row) .dz-id .dz-badge[data-kind=yours|kept|open|stale]
//   .dz-q (question) .dz-a (answer) .dz-n (note) .dz-m (meta)
//   .dz-aff (Affects n passages chip) .dz-opts[role=radiogroup] .dz-opt[aria-checked] .dz-tag
//   .dz-other (free text) .dz-warn (dependents note) .dz-act (buttons)
import { useEffect, useId, useRef, useState } from "react";
import type { DecisionFields } from "../../../../src/core/decision-block.ts";
import { OTHER_OPTION, type Question } from "../types";

export interface Pick {
  optionId: string;
  text?: string;
}

export type CardState = "settled" | "open" | "stale";

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
  const [expanded, setExpanded] = useState(state === "open" && !readOnly);
  const [pick, setPick] = useState<string | undefined>(currentId ?? question?.recommendedOptionId);
  const [other, setOther] = useState(currentId === OTHER_OPTION ? fields.answer ?? "" : "");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [aff, setAff] = useState<{ above: number; below: number } | null>(null);

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
      onMouseEnter={() => activate(true)}
      onMouseLeave={() => !ref.current?.contains(document.activeElement) && activate(false)}
      onFocus={() => activate(true)}
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
            setPick(o.id);
          }
        } else if (e.key === "Enter" && !(e.target as HTMLElement).matches("button")) {
          e.preventDefault();
          void submit();
        }
      }}
    >
      <div className="dz-h">
        <span className="dz-lbl sub">Decision</span>
        <span className="dz-id mono">{fields.id}</span>
        <span className="dz-badge" data-kind={badge.kind}>
          {badge.text}
        </span>
        {passages.length ? (
          <button type="button" className="dz-aff" onClick={jump} tabIndex={-1} aria-hidden="true">
            Affects {passages.length} {passages.length === 1 ? "passage" : "passages"}
            {aff?.below ? ` · ${aff.below} below ↓` : aff?.above ? ` · ${aff.above} above ↑` : ""}
          </button>
        ) : null}
      </div>
      <div className="dz-q">{fields.question}</div>
      {view === "rest" || view === "stale" ? (
        <>
          {fields.answer ? <div className="dz-a">{fields.answer}</div> : null}
          {fields.note ? <div className="dz-n">{fields.note}</div> : null}
          {invalid ? <div className="dz-n">This block has a mistake in plan.md. Showing the last version that worked.</div> : null}
          {canChange ? (
            <div className="dz-act">
              <button ref={changeBtn} type="button" className="pill secondary sm" onClick={() => setExpanded(true)} aria-label={`Change ${fields.id}`}>
                Change
              </button>
            </div>
          ) : null}
        </>
      ) : null}
      {view === "open" && !expanded ? (
        <div className="dz-act">
          {canChange ? (
            <button type="button" className="pill secondary sm" onClick={() => setExpanded(true)}>
              Answer
            </button>
          ) : null}
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
                <kbd className="mono" aria-hidden="true">
                  {i + 1}
                </kbd>
                <span>{o.label}</span>
                {o.id === currentId ? <span className="dz-tag">Current</span> : null}
                {o.id === question?.recommendedOptionId ? <span className="dz-tag">Recommended</span> : null}
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
            <button type="button" className="pill secondary sm" onClick={cancel}>
              {state === "open" ? "Leave open" : "Cancel"}
            </button>
            <button type="button" className="pill primary sm" disabled={!ready || busy} aria-describedby={reasks ? `${uid}-warn` : undefined} onClick={() => void submit()}>
              {reasks ? `Save and re-ask ${dependents.length}` : "Save answer"}
            </button>
          </div>
        </>
      ) : null}
    </div>
  );
}
