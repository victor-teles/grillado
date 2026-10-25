// 6 · Plan: run summary, the plan document with citation chips, and the decisions log.
import { useEffect, useMemo, useRef, useState } from "react";
import { useMobile } from "./chrome";
import { CopyButton } from "./CopyButton";
import { ICheck, IDl, IFolder, IPlate, IX } from "./icons";
import { type EditorMode, PlanEditor, usePlanDraft } from "./editor/PlanEditor";
import { type Act, ReopenDialog } from "./Session";
import type { Decision, SessionView } from "./types";

const nameOf = (d: Decision) => d.label || d.title;
const logId = (key: string) => `log-${key.replace(/[^\w-]/g, "_")}`;

function written(iso?: string) {
  if (!iso) return "";
  const d = new Date(iso);
  return `written ${d.toLocaleDateString(undefined, { month: "short", day: "numeric" })}, ${d.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" })}`;
}

export function PlanView({ session, act }: { session: SessionView; act: Act }) {
  const plan = session.plan!;
  const mobile = useMobile();
  const [hl, setHl] = useState<string | null>(null);
  const [sheet, setSheet] = useState(false);
  const [reopening, setReopening] = useState<Decision | null>(null);
  const [justPlated] = useState(() => !!plan.createdAt && Date.now() - Date.parse(plan.createdAt) < 8000);
  const docRef = useRef<HTMLDivElement>(null);
  const draft = usePlanDraft(session.id, plan.markdown);
  const [mode, setMode] = useState<EditorMode>("rich");
  const decisions = Object.values(session.decisions);
  const early = plan.openDecisions.length > 0;
  // Question position inside its round, for "R2·1" labels.
  const qIndex = useMemo(() => {
    const m = new Map<string, number>();
    for (const r of session.rounds) r.questions.forEach((q, i) => m.set(`${r.n}:${q.key}`, i));
    return m;
  }, [session.rounds]);
  const byRound = useMemo(() => {
    const m = new Map<number, Decision[]>();
    for (const d of decisions) m.set(d.round, [...(m.get(d.round) ?? []), d]);
    return [...m.entries()].sort((a, b) => b[0] - a[0]);
  }, [decisions]);
  const risks = decisions.filter((d) => d.kind === "unknown").length;

  const showLog = (key: string) => {
    setHl(key);
    if (mobile) setSheet(true);
    requestAnimationFrame(() => document.getElementById(logId(key))?.scrollIntoView({ block: "nearest" }));
  };
  const scrollToCite = (key: string) => {
    const el = docRef.current?.querySelector<HTMLElement>(`[data-cite="${CSS.escape(key)}"]`);
    el?.scrollIntoView({ block: "center" });
    el?.focus({ preventScroll: true });
  };
  const showCite = (key: string) => {
    setHl(key);
    setSheet(false);
    if (mode === "rich") return scrollToCite(key);
    // Chips only exist in the document view.
    setMode("rich");
    requestAnimationFrame(() => requestAnimationFrame(() => scrollToCite(key)));
  };
  useEffect(() => {
    if (!sheet) return;
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && setSheet(false);
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [sheet]);

  const log = (
    <ol className="tl" aria-label="Decisions by round">
      {byRound.flatMap(([round, ds]) => [
        <li key={`r${round}`} className="rd">
          Round {round}
        </li>,
        ...ds.map((d) => (
          <li key={d.key} id={logId(d.key)} data-hl={hl === d.key ? "" : undefined}>
            <span className={`dt${d.accepted_recommendation ? "" : " y"}`} aria-hidden="true" />
            <div style={{ minWidth: 0, display: "grid" }}>
              <span className="t">{nameOf(d)}</span>
              <span className="a">
                {d.answer}
                {d.accepted_recommendation ? "" : " · your call"}
              </span>
              <span style={{ display: "flex", gap: 10 }}>
                {decisionCited(draft.text, d) ? (
                  <button type="button" className="ro" onClick={() => showCite(d.key)}>
                    Show in plan
                  </button>
                ) : null}
                <button type="button" className="ro" aria-label={`Reopen ${nameOf(d)}`} onClick={() => setReopening(d)}>
                  Reopen
                </button>
              </span>
            </div>
          </li>
        )),
      ])}
    </ol>
  );

  return (
    <div className="planv">
      <div className="runsum">
        <span className={`plate${early ? " early" : ""}`} aria-hidden="true">
          <IPlate s={18} />
        </span>
        <div style={{ minWidth: 0 }}>
          <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
            <h1 style={{ fontSize: 15, lineHeight: "20px", fontWeight: 620, margin: 0 }}>{early ? "Plan written early" : "Plated"}</h1>
            {justPlated ? (
              <span className="fb sm" role="status">
                <ICheck s={12} />
                Saved to disk
              </span>
            ) : null}
          </div>
          <div className="sub mono" style={{ fontSize: 11.5, display: "flex", gap: 6, alignItems: "center", minWidth: 0 }}>
            <IFolder s={12} />
            <code data-testid="plan-path" style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", background: "none" }}>
              {plan.path}
            </code>
          </div>
        </div>
        <div className="acts">
          {mobile ? null : (
            <dl className="st" style={{ margin: "0 12px 0 0" }}>
              <div>
                <dt className="k" style={{ display: "inline" }}>Decisions</dt>
                <dd className="v" style={{ display: "inline" }}>{decisions.length}</dd>
              </div>
              <div>
                <dt className="k" style={{ display: "inline" }}>{early ? "Open" : "Risks"}</dt>
                <dd className="v" style={{ display: "inline" }}>{early ? plan.openDecisions.length : risks}</dd>
              </div>
              <div>
                <dt className="k" style={{ display: "inline" }}>Rounds</dt>
                <dd className="v" style={{ display: "inline" }}>{session.rounds.length}</dd>
              </div>
            </dl>
          )}
          <CopyButton text={draft.text} label="Copy Markdown" />
          {mobile ? null : (
            <>
              <a className="pill secondary sm" href={`/api/sessions/${session.id}/plan.md`} download onPointerDown={() => void draft.flush()}>
                <IDl s={14} />
                Download .md
              </a>
              <CopyButton text={plan.path} label="Copy file path" />
            </>
          )}
        </div>
      </div>
      <div className="split">
        <div className="docwrap" ref={docRef}>
          <PlanEditor
            draft={draft}
            mode={mode}
            setMode={setMode}
            afterTitle={
              <p className="sub">
                Plan · {decisions.length} decisions{plan.createdAt ? ` · ${written(plan.createdAt)}` : ""}
                {plan.editedAt ? ` · edited` : ""}
              </p>
            }
            openBadge={<span className="badge2">Still raw · {plan.openDecisions.length}</span>}
            cite={(round, key, n) => {
              const i = qIndex.get(`${round}:${key}`);
              const label = `R${round}·${i === undefined ? "?" : i + 1}`;
              return (
                <button
                  key={n}
                  type="button"
                  className="cite"
                  data-cite={key}
                  aria-pressed={hl === key}
                  aria-label={`${label}: ${session.decisions[key] ? nameOf(session.decisions[key]) : key}, show in decisions log`}
                  onClick={() => showLog(key)}
                >
                  {label}
                </button>
              );
            }}
          />
        </div>
        {mobile ? null : (
          <aside className="side2" aria-labelledby="log-title" style={{ gridTemplateRows: "auto minmax(0,1fr)" }}>
            <div className="side-h">
              <h2 id="log-title">Decisions log</h2>
              <span className="sub mono">
                {session.rounds.length} {session.rounds.length === 1 ? "round" : "rounds"}
              </span>
            </div>
            {log}
          </aside>
        )}
      </div>
      {mobile ? (
        <>
          <div className="mbar">
            <button type="button" className="pill secondary" style={{ flex: 1 }} aria-expanded={sheet} onClick={() => setSheet(true)}>
              Decisions log · {decisions.length}
            </button>
            <CopyButton text={plan.path} label="File" />
          </div>
          {sheet ? (
            <>
              <button type="button" className="sheet-scrim" aria-label="Close decisions log" tabIndex={-1} onClick={() => setSheet(false)} />
              <aside className="side" data-sheet="" role="dialog" aria-modal="true" aria-labelledby="mlog-title" style={{ gridTemplateRows: "auto minmax(0,1fr)" }}>
                <div className="side-h">
                  <h2 id="mlog-title">Decisions log</h2>
                  <button type="button" className="ghost x" aria-label="Close" autoFocus onClick={() => setSheet(false)}>
                    <IX s={14} />
                  </button>
                </div>
                {log}
              </aside>
            </>
          ) : null}
        </>
      ) : null}
      {reopening ? <ReopenDialog session={session} d={reopening} act={act} onClose={() => setReopening(null)} /> : null}
    </div>
  );
}

function decisionCited(md: string, d: Decision) {
  return md.includes(`:${d.key}]`) || md.includes(`:${d.key},`);
}
