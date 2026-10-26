// 6 · Plan (v1.2): one toolbar row (Document | Decisions, save status, Rich | Markdown, Copy
// Markdown, ⋯ Plan actions), the plan editor with inline decision blocks, and neutral banners:
// waiting, "plan.md changed outside Grillado", and "You changed the answer to …" (DECISIONS #22).
//
// Styling hooks: .planv[data-waiting] .dtb .ptabs[role=tablist] .ptab[aria-selected] .ptab-ct
//   .pbanner[data-tone] .dtab .dgrp .drow .acc .acc-h[aria-expanded] .copy-md
import { type ReactNode, useEffect, useMemo, useRef, useState } from "react";
import { api } from "./api";
import { useMobile } from "./chrome";
import { COPY, fmt } from "./copy";
import { CopyButton, copy } from "./CopyButton";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel, DropdownMenuRadioGroup, DropdownMenuRadioItem, DropdownMenuSeparator, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { DecisionCard } from "./editor/DecisionCard";
import { passages as findPassages } from "./editor/blocks";
import { type DecisionRenderer, type EditorMode, ModeToggle, PlanEditor, SaveStatus, usePlanDraft } from "./editor/PlanEditor";
import { IAlert, IDl, IFolder, IInfo, IMore } from "./icons";
import { type Act, dependentsOf } from "./Session";
import type { Decision, Question, SessionView } from "./types";

const nameOf = (d: { label?: string; title: string }) => d.label || d.title;

function questionFor(s: SessionView, key: string): Question | undefined {
  for (let i = s.rounds.length - 1; i >= 0; i--) {
    const q = s.rounds[i].questions.find((x) => x.key === key);
    if (q) return q;
  }
  return undefined;
}

type Tab = "doc" | "decisions";

export function PlanView({ session, act, agentName, banner }: { session: SessionView; act: Act; agentName: string; banner?: ReactNode }) {
  const plan = session.plan!;
  const mobile = useMobile();
  const waiting = session.status !== "plated" ? (plan.waiting ?? []) : [];
  const readOnly = session.status !== "plated" || session.busy;
  const answers = useMemo(() => Object.fromEntries(Object.entries(session.decisions).map(([k, d]) => [k, d.answer])), [session.decisions]);
  const draft = usePlanDraft(session.id, plan.markdown, plan.reloadedAt, answers);
  const [mode, setModeRaw] = useState<EditorMode>("rich");
  // Switching views saves first (the editor closes any open block on a mode change).
  const setMode = (m: EditorMode) => {
    void draft.flush();
    setModeRaw(m);
  };
  const [tab, setTab] = useState<Tab>("doc");
  const [flash, setFlash] = useState<string | null>(null);
  const [note, setNote] = useState("");
  const docRef = useRef<HTMLDivElement>(null);
  const decisions = Object.values(session.decisions);
  const qIndex = useMemo(() => {
    const m = new Map<string, number>();
    for (const r of session.rounds) r.questions.forEach((q, i) => m.set(`${r.n}:${q.key}`, i));
    return m;
  }, [session.rounds]);
  const psg = useMemo(() => findPassages(draft.text), [draft.text]);
  // Decisions still open in the plan (wrapped up early, not answered since).
  const openKeys = useMemo(() => {
    const keys: string[] = [];
    for (const m of draft.text.matchAll(/^```decision\n([\s\S]*?)^```/gm)) {
      const body = m[1];
      const key = /^key:\s*(.+)$/m.exec(body)?.[1]?.trim();
      if (key && /^status:\s*open\s*$/m.test(body) && !session.decisions[key]) keys.push(key);
    }
    return keys;
  }, [draft.text, session.decisions]);
  const openCount = openKeys.length + plan.openDecisions.filter((t) => !session.rounds.some((r) => r.questions.some((q) => q.title === t))).length;

  useEffect(() => {
    if (!flash) return;
    const t = setTimeout(() => setFlash(null), 1200);
    return () => clearTimeout(t);
  }, [flash]);
  useEffect(() => {
    if (!note) return;
    const t = setTimeout(() => setNote(""), 4000);
    return () => clearTimeout(t);
  }, [note]);

  const goToDecision = (key: string) => {
    const el = docRef.current?.querySelector<HTMLElement>(`.dz[data-key="${CSS.escape(key)}"]`);
    el?.scrollIntoView({ block: "center" });
    el?.focus({ preventScroll: true });
  };
  const showInPlan = (key: string) => {
    setTab("doc");
    setModeRaw("rich");
    requestAnimationFrame(() =>
      requestAnimationFrame(() => {
        const id = psg.find((p) => p.keys.includes(key))?.id;
        const el = id ? document.getElementById(id) : null;
        if (el) el.scrollIntoView({ block: "center" });
        else goToDecision(key);
        setFlash(key);
      }),
    );
  };
  const reveal = async () => {
    try {
      const r = await api.action(session.id, "reveal");
      const out = r as unknown as { opened: boolean; path: string };
      if (out.opened) return setNote("Opened the folder with plan.md");
    } catch {
      // fall through to copying the path
    }
    await copy(plan.path);
    setNote("Copied the path to plan.md");
  };
  const save = async (key: string, open: boolean, pick: { optionId: string; text?: string }) => {
    await draft.flush();
    await draft.track(act(open ? "answer-open" : "change", { key, ...pick }));
  };

  const renderDecision: DecisionRenderer = (fields, { invalid, setActive }) => {
    const key = fields.key ?? "";
    const stale = waiting.includes(key) || (!!session.stale?.[key] && !session.decisions[key] && fields.status !== "open");
    const open = fields.status === "open" && !session.decisions[key];
    const deps = dependentsOf(session, key).map((k) => nameOf(session.decisions[k]));
    return (
      <DecisionCard
        key={`${key}-${fields.answer ?? ""}`}
        fields={fields}
        state={stale ? "stale" : open ? "open" : "settled"}
        question={questionFor(session, key)}
        dependents={deps}
        passages={psg.filter((p) => p.keys.includes(key)).map((p) => p.id)}
        invalid={invalid}
        readOnly={readOnly}
        onActive={setActive}
        onSave={(pick) => save(key, open, pick)}
      />
    );
  };

  const tabs: { id: Tab; label: string; count: string; hot: boolean }[] = [
    { id: "doc", label: "Document", count: "", hot: false },
    { id: "decisions", label: "Decisions", count: openCount ? `${openCount} open` : String(decisions.length), hot: openCount > 0 },
  ];

  return (
    <div className="planv" data-waiting={waiting.length ? "" : undefined}>
      <div className="dtb">
        <div className="ptabs" role="tablist" aria-label="Plan">
          {tabs.map((t, i) => (
            <button
              key={t.id}
              type="button"
              role="tab"
              id={`ptab-${t.id}`}
              className="ptab"
              aria-selected={tab === t.id}
              aria-controls={`ppanel-${t.id}`}
              tabIndex={tab === t.id ? 0 : -1}
              onClick={() => setTab(t.id)}
              onKeyDown={(e) => {
                // Manual activation (§6): arrows and Home/End move focus; Enter/Space selects.
                const list = e.currentTarget.parentElement!.querySelectorAll<HTMLElement>("[role=tab]");
                let n = -1;
                if (e.key === "ArrowRight") n = (i + 1) % tabs.length;
                else if (e.key === "ArrowLeft") n = (i - 1 + tabs.length) % tabs.length;
                else if (e.key === "Home") n = 0;
                else if (e.key === "End") n = tabs.length - 1;
                if (n >= 0) {
                  e.preventDefault();
                  list[n]?.focus();
                }
              }}
            >
              {t.label}
              {t.count ? (
                <span className="ptab-ct" data-open={t.hot ? "" : undefined}>
                  {t.count}
                </span>
              ) : null}
            </button>
          ))}
        </div>
        <div className="dtb-r">
          {mobile ? null : (
            <SaveStatus
              save={draft.save}
              onRetry={() => void draft.flush()}
              conflict={!!draft.conflict}
              answerChange={!!draft.answerChange}
              edited={!!plan.editedAt}
              open={openCount}
            />
          )}
          {mobile || tab !== "doc" ? null : <ModeToggle mode={mode} onMode={setMode} />}
          <CopyButton
            text={draft.text}
            label={mobile ? "Copy" : "Copy Markdown"}
            ariaLabel={mobile ? "Copy Markdown" : undefined}
            tone="primary"
            className="copy-md"
          />
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <button type="button" className="icon-btn" aria-label="Plan actions" onPointerDown={() => void draft.flush()}>
                <IMore s={16} />
              </button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="pmenu">
              {mobile && tab === "doc" ? (
                <>
                  <DropdownMenuRadioGroup value={mode} onValueChange={(v) => setMode(v as EditorMode)}>
                    <DropdownMenuRadioItem value="rich">Rich</DropdownMenuRadioItem>
                    <DropdownMenuRadioItem value="raw">Markdown</DropdownMenuRadioItem>
                  </DropdownMenuRadioGroup>
                  <DropdownMenuSeparator />
                </>
              ) : null}
              <DropdownMenuItem asChild>
                <a href={`/api/sessions/${session.id}/plan.md`} download>
                  <IDl s={16} />
                  Download .md
                </a>
              </DropdownMenuItem>
              <DropdownMenuItem onSelect={() => void reveal()}>
                <IFolder s={16} />
                Show file location
              </DropdownMenuItem>
              <DropdownMenuSeparator />
              <DropdownMenuLabel className="pmenu-path">
                <span data-testid="plan-path">{plan.path}</span>
              </DropdownMenuLabel>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      </div>
      {banner}
      {waiting.length ? (
        <div className="pbanner" data-tone="info" role="status">
          <IInfo s={16} />
          <span>{fmt(COPY.waiting, { list: waiting.map((k) => session.stale?.[k]?.label ?? k).join(", "), agent: agentName })}</span>
        </div>
      ) : null}
      {draft.answerChange ? <AnswerChangeBanner session={session} edits={draft.answerChange} onCancel={draft.cancelAnswerChange} onSave={draft.applyAnswerChange} /> : null}
      {draft.conflict ? (
        <div className="pbanner" data-tone="warn" role="alert" aria-labelledby="conflict-t" aria-describedby="conflict-d">
          <IAlert s={16} />
          <span>
            <strong id="conflict-t">plan.md changed outside Grillado</strong>
            <span id="conflict-d">You have edits here too. Pick which version to keep; the other is saved as plan.conflict.md.</span>
          </span>
          <span className="pbanner-acts">
            <button type="button" className="btn quiet" onClick={() => void draft.resolve("mine")}>
              Keep mine
            </button>
            <button type="button" className="btn primary" onClick={() => void draft.resolve("file")}>
              Load the file
            </button>
          </span>
        </div>
      ) : null}
      {mobile && draft.save.state === "error" && !draft.conflict && !draft.answerChange ? (
        <div className="pbanner" data-tone="warn">
          <IAlert s={16} />
          <span>Couldn't save to plan.md.</span>
          <span className="pbanner-acts">
            <button type="button" className="btn quiet" onClick={() => void draft.flush()}>
              Retry
            </button>
          </span>
        </div>
      ) : null}
      <span className="sr-only" role="status">
        {draft.notice || note}
      </span>
      {note ? <span className="pnote">{note}</span> : null}
      <div className="docwrap" ref={docRef}>
        <div id="ppanel-doc" role="tabpanel" aria-labelledby="ptab-doc" hidden={tab !== "doc"}>
          <PlanEditor
            draft={draft}
            mode={mode}
            setMode={setMode}
            readOnly={readOnly}
            decision={renderDecision}
            highlight={flash}
            afterTitle={
              <p className="sub">
                {decisions.length} decisions{openCount ? ` · ${openCount} open` : ""}{plan.editedAt ? " · edited" : ""}
              </p>
            }
            openBadge={openCount ? <span className="ct">{openCount}</span> : null}
            cite={(round, key, n) => {
              const i = qIndex.get(`${round}:${key}`);
              const label = `R${round}·${i === undefined ? "?" : i + 1}`;
              const d = session.decisions[key];
              return (
                <button
                  key={n}
                  type="button"
                  className="cite"
                  data-cite={key}
                  aria-label={`${label}: ${d ? nameOf(d) : key}, go to the decision`}
                  onClick={() => goToDecision(key)}
                >
                  {label}
                </button>
              );
            }}
          />
        </div>
        <div id="ppanel-decisions" role="tabpanel" aria-labelledby="ptab-decisions" hidden={tab !== "decisions"} className="dtab">
          {tab === "decisions" ? <DecisionsTab session={session} openKeys={openKeys} agentName={agentName} onShow={showInPlan} renderOpen={renderDecision} /> : null}
        </div>
      </div>
    </div>
  );
}

function DecisionsTab({
  session,
  openKeys,
  agentName,
  onShow,
  renderOpen,
}: {
  session: SessionView;
  openKeys: string[];
  agentName: string;
  onShow: (key: string) => void;
  renderOpen: DecisionRenderer;
}) {
  const [expanded, setExpanded] = useState(true);
  const decisions = Object.values(session.decisions);
  const byRound = useMemo(() => {
    const m = new Map<number, Decision[]>();
    for (const d of decisions) m.set(d.round, [...(m.get(d.round) ?? []), d]);
    return [...m.entries()].sort((a, b) => b[0] - a[0]);
  }, [decisions]);
  const label = (d: Decision) => {
    const r = session.rounds.find((x) => x.n === d.round);
    const i = r ? r.questions.findIndex((q) => q.key === d.key) : -1;
    return `R${d.round}·${i + 1}`;
  };
  return (
    <div className="doc">
      <h1>Decisions</h1>
      <p className="sub">{COPY.decisionsLead}</p>
      {openKeys.length ? (
        <section className="dgrp" aria-labelledby="still-open">
          <h2 id="still-open">Still open · {openKeys.length}</h2>
          <p className="sub">{fmt(COPY.openLead, { agent: agentName })}</p>
          {openKeys.map((key) => {
            const q = questionFor(session, key)!;
            const r = session.rounds.find((x) => x.questions.includes(q));
            const i = r ? r.questions.indexOf(q) + 1 : 0;
            return <div key={key}>{renderOpen({ id: `R${r?.n ?? 0}·${i}`, key, question: q.title, status: "open" }, { invalid: false, active: false, setActive: () => {} })}</div>;
          })}
        </section>
      ) : null}
      <section className="acc">
        <h2>
          <button type="button" className="acc-h" aria-expanded={expanded} aria-controls="acc-resolved" onClick={() => setExpanded(!expanded)}>
            {decisions.length} resolved
          </button>
        </h2>
        <div id="acc-resolved" hidden={!expanded}>
          {byRound.map(([round, ds]) => (
            <div key={round} className="dgrp">
              <h3>Round {round}</h3>
              <ul className="dlist">
                {ds.map((d) => (
                  <li key={d.key} className="drow">
                    <span className="drow-id">{label(d)}</span>
                    <span className="drow-t">{nameOf(d)}</span>
                    <span className="drow-a">{d.answer}</span>
                    {/* Only the rows where the user overrode the suggestion are marked (v1.2 review). */}
                    <span className={d.accepted_recommendation ? "drow-by" : "drow-by yc"}>{d.accepted_recommendation ? null : "Your call"}</span>
                    <button type="button" className="btn quiet sm" aria-label={`Show in plan: ${nameOf(d)}`} onClick={() => onShow(d.key)}>
                      Show in plan
                    </button>
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </div>
      </section>
    </div>
  );
}

/** DECISIONS #22: a hand-edited `answer:` is a Change — warn with what depends on it, then save and re-ask. */
function AnswerChangeBanner({
  session,
  edits,
  onCancel,
  onSave,
}: {
  session: SessionView;
  edits: { key: string; from: string; to: string }[];
  onCancel: () => void;
  onSave: () => Promise<void>;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const deps = [...new Set(edits.flatMap((e) => dependentsOf(session, e.key)))].filter((k) => !edits.some((e) => e.key === k));
  const depNames = deps.map((k) => (session.decisions[k] ? nameOf(session.decisions[k]) : k));
  const one = edits.length === 1 ? edits[0] : null;
  const name = (key: string) => (session.decisions[key] ? nameOf(session.decisions[key]) : key);
  const title = one ? `You changed the answer to ${name(one.key)}` : `You changed ${edits.length} answers`;
  const what = one ? `${one.from} → ${one.to}. ` : "";
  const then = depNames.length
    ? `${listOf(depNames)} ${depNames.length === 1 ? "depends" : "depend"} on it, so ${depNames.length === 1 ? "it" : "they"} will be asked again in a new round.`
    : "Nothing depends on it.";
  return (
    <div className="pbanner" data-tone="warn" role="alert" aria-labelledby="answer-t" aria-describedby="answer-d" data-testid="answer-change">
      <IAlert s={16} />
      <span>
        <strong id="answer-t">{title}</strong>
        <span id="answer-d">
          {what}
          {then}
        </span>
        {error ? <span className="pbanner-err">{error}</span> : null}
      </span>
      <span className="pbanner-acts">
        <button type="button" className="btn quiet" disabled={busy} onClick={onCancel}>
          Cancel
        </button>
        <button
          type="button"
          className="btn primary"
          disabled={busy}
          onClick={async () => {
            setBusy(true);
            setError("");
            try {
              await onSave();
            } catch (e) {
              setError(e instanceof Error ? e.message : String(e));
            } finally {
              setBusy(false);
            }
          }}
        >
          {deps.length ? `Save and re-ask ${deps.length}` : "Save answer"}
        </button>
      </span>
    </div>
  );
}

function listOf(names: string[]): string {
  return names.length <= 2 ? names.join(" and ") : `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`;
}
