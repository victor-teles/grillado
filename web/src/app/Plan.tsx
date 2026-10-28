// 6 · Plan (v1.2): one toolbar row (Document | Decisions, save status, Rich | Markdown, Copy
// Markdown, ⋯ Plan actions), the plan editor with inline decision blocks, and neutral banners:
// waiting, "plan.md changed outside Grillado", and "You changed the answer to …" (DECISIONS #22).
//
// Styling hooks: .planv[data-waiting] [data-landing] .dtb .ptabs[role=tablist] .ptab[aria-selected] .ptab-ct
//   .pbanner[data-tone] .dtab .dgrp .drow .acc .acc-h[aria-expanded] .copy-md
import { type ReactNode, useEffect, useId, useMemo, useRef, useState } from "react";
import { api } from "./api";
import { useMedia, useMobile } from "./chrome";
import { COPY, fmt } from "./copy";
import { CopyButton, copy } from "./CopyButton";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel, DropdownMenuRadioGroup, DropdownMenuRadioItem, DropdownMenuSeparator, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { useComments } from "./comments/Comments";
import { useDiagrams } from "./diagrams/AddDiagrams";
import { DecisionCard, listOf } from "./editor/DecisionCard";
import { jumpTo, offscreen } from "./editor/link";
import { countText, planCounts } from "./counts";
import { passages as findPassages } from "./editor/blocks";
import { type DecisionRenderer, type EditorMode, type GutRenderer, ModeToggle, PlanEditor, SaveStatus, usePlanDraft } from "./editor/PlanEditor";
import { IAlert, ICheck, IChev, IDl, IDown, IFolder, IMore, IPlug } from "./icons";
import { type Act, dependentsOf } from "./Session";
import type { Decision, McpLaunch, Question, SessionView } from "./types";
import { UCOPY, UseInEditor } from "./mcp/UseInEditor";
import { type DecisionFields, findDecisionBlocks, updateDecisionBlock } from "../../../src/core/decision-block.ts";
import { Provenance } from "./found/Provenance";
import { AddPlanButton, AddPlanLine, AddPlanLive, addPlanFor } from "./addplan/AddPlan";
import { useIssues } from "./issues/Issues";

const nameOf = (d: { label?: string; title: string }) => d.label || d.title;

function questionFor(s: SessionView, key: string): Question | undefined {
  for (let i = s.rounds.length - 1; i >= 0; i--) {
    const q = s.rounds[i].questions.find((x) => x.key === key);
    if (q) return q;
  }
  return undefined;
}

/** A decision you added yourself (U id, item 4): the card asks its own question, answered in the text. */
const ownKey = (s: SessionView, key: string) => /^u\d+$/.test(key) && !s.decisions[key];
const ownQuestion = (key: string, title: string): Question => ({ key, label: title, title, body: "", options: [], recommendedOptionId: "", dependsOn: [] });

function questionRound(s: SessionView, key: string): number | undefined {
  return s.rounds.find((r) => r.questions.some((q) => q.key === key))?.n;
}

type Tab = "doc" | "decisions";

export function PlanView({ session, act, agentName, agentNameOf, banner, mcp }: { session: SessionView; act: Act; agentName: string; agentNameOf?: (id: string) => string; banner?: ReactNode; mcp: McpLaunch }) {
  const plan = session.plan!;
  const mobile = useMobile();
  const waiting = session.status !== "plated" ? (plan.waiting ?? []) : [];
  const readOnly = session.status !== "plated" || session.busy;
  // Answers changed outside Grillado and waiting for the user (#26) already read their new value here.
  const answers = useMemo(() => {
    const out = Object.fromEntries(Object.entries(session.decisions).map(([k, d]) => [k, d.answer]));
    for (const e of plan.external ?? []) if (e.key in out) out[e.key] = e.to;
    return out;
  }, [session.decisions, plan.external]);
  const draft = usePlanDraft(session.id, plan.markdown, plan.reloadedAt, answers);
  const [mode, setModeRaw] = useState<EditorMode>("rich");
  // Switching views saves first (the editor closes any open block on a mode change).
  const setMode = (m: EditorMode) => {
    void draft.flush();
    setModeRaw(m);
  };
  const [tab, setTab] = useState<Tab>("doc");
  const [note, setNote] = useState("");
  // The block you last changed here (re-ask line goes under it) and what it said before.
  const [touched, setTouched] = useState<{ key: string; was: string } | null>(null);
  const docRef = useRef<HTMLDivElement>(null);
  const room = useGutRoom(docRef, !mobile && tab === "doc" && mode === "rich");
  const editRef = useRef<((start: number, end: number) => void) | null>(null);
  const psg = useMemo(() => findPassages(draft.text), [draft.text]);
  const counts = planCounts(session, draft.text);
  const openKeys = useMemo(
    // Newest first everywhere (§10).
    () => [...counts.openKeys].sort((a, b) => (questionRound(session, b) ?? 0) - (questionRound(session, a) ?? 0)),
    [counts.openKeys.join(" "), session.rounds],
  );
  const openCount = counts.open;
  const text = countText(counts, mobile);
  const staleKeys = useMemo(() => new Set([...waiting, ...(waiting.length && touched ? [touched.key] : [])]), [waiting.join(" "), touched]);
  const reaskLine = useMemo(() => {
    if (!waiting.length) return null;
    const qs = waiting.map((k) => `“${session.stale?.[k]?.title ?? k}”`);
    const n = psg.filter((p) => p.keys.some((k) => staleKeys.has(k))).length;
    const anchor = touched && session.decisions[touched.key] ? touched.key : waiting[0];
    return { anchor, text: fmt(COPY.reasking, { agent: agentName, questions: listOf(qs), n: `${n} ${n === 1 ? "passage" : "passages"}` }) };
  }, [waiting.join(" "), psg, staleKeys, touched, agentName, session.stale, session.decisions]);
  const external = useMemo(() => new Map((plan.external ?? []).map((e) => [e.key, e])), [plan.external]);
  const ownBlocks = useMemo(() => {
    const out = new Map<string, DecisionFields>();
    for (const b of findDecisionBlocks(draft.text)) if (b.parsed.ok && b.parsed.fields.key && /^U\d+$/.test(b.parsed.fields.id)) out.set(b.parsed.fields.key, b.parsed.fields);
    return out;
  }, [draft.text]);
  const ownDecisions = useMemo(
    () =>
      [...ownBlocks.values()]
        .filter((f) => f.status !== "open" && f.answer && !session.decisions[f.key!])
        .map((f): Decision => ({ key: f.key!, round: 0, title: f.question, answer: f.answer!, kind: "other", accepted_recommendation: false, dependsOn: [] })),
    [ownBlocks, session.decisions],
  );
  const label = (key: string) => {
    const mine = ownBlocks.get(key);
    if (mine) return mine.id;
    const r = session.rounds.find((x) => x.questions.some((q) => q.key === key));
    return r ? `R${r.n}·${r.questions.findIndex((q) => q.key === key) + 1}` : "";
  };

  useEffect(() => {
    if (!note) return;
    const t = setTimeout(() => setNote(""), 4000);
    return () => clearTimeout(t);
  }, [note]);

  // §2.4: a decision jump scrolls it to the middle, flashes it and puts focus on the block.
  const goToDecision = (key: string) => {
    const el = docRef.current?.querySelector<HTMLElement>(`.dz[data-key="${CSS.escape(key)}"]`) ?? null;
    jumpTo(el, el);
  };
  // Activity's "Asked" chips open the Decisions tab on that row (item 6 handoff §6).
  const [rowJump, setRowJump] = useState<{ key: string; n: number } | null>(null);
  const showDecisionRow = (key: string) => {
    setTab("decisions");
    setRowJump((x) => ({ key, n: (x?.n ?? 0) + 1 }));
  };
  useEffect(() => {
    if (tab !== "decisions") setRowJump(null);
  }, [tab]);
  const decisionInfo = (key: string) => {
    const d = session.decisions[key] ?? ownDecisions.find((x) => x.key === key);
    const q = questionFor(session, key);
    if (!d && !(q && openKeys.includes(key))) return null;
    return { label: label(key) || key, title: d?.title ?? q!.title };
  };
  const showInPlan = (key: string) => {
    setTab("doc");
    setModeRaw("rich");
    requestAnimationFrame(() => requestAnimationFrame(() => goToDecision(key)));
  };
  // "Add to plan" → Review (#104): the plan, with that suggestion focused and the normal bar and pill.
  const reviewSuggestion = (id: string) => {
    void draft.flush();
    setTab("doc");
    setModeRaw("rich");
    requestAnimationFrame(() => requestAnimationFrame(() => cmRef.current?.review(id)));
  };
  const cmRef = useRef<{ review: (id: string) => void } | null>(null);
  const reveal = async () => {
    try {
      const r = await api.action(session.id, "reveal");
      const out = r as unknown as { opened: boolean; path: string };
      if (out.opened) return setNote("Opened the folder with plan.md");
    } catch {
      // fall through to copying the path
    }
    setNote((await copy(plan.path)) ? "Copied the path to plan.md" : `Couldn’t reach the clipboard. plan.md is at ${plan.path}`);
  };
  const save = async (key: string, open: boolean, pick: { optionId: string; text?: string }) => {
    await draft.flush();
    const was = session.decisions[key]?.answer;
    await draft.track(act(open ? "answer-open" : "change", { key, ...pick }));
    if (!open && was !== undefined) setTouched({ key, was });
  };
  // Answering a Question you added is a plain edit of its block (#34): no round, no re-ask.
  const saveOwn = async (key: string, pick: { optionId: string; text?: string }) => {
    const answer = pick.text?.trim();
    if (!answer) throw new Error("Type an answer first.");
    draft.change(updateDecisionBlock(draft.text, key, { status: undefined, answer, by: "you", at: new Date().toISOString() }));
    await draft.flush();
  };
  const onExternal = async (confirm: boolean) => {
    await draft.flush();
    await act(confirm ? "external-confirm" : "external-dismiss");
  };

  // Item 3: comments, Apply feedback and suggestions.
  const moreRef = useRef<HTMLButtonElement>(null);
  // v1.2 item 1: "Use in your editor…" in ⋯, anchored to ⋯ like Add diagrams (handoff §3).
  const [ue, setUe] = useState(false);
  // Opens once the ⋯ menu has returned focus, so its focus trap can't take focus off the tab.
  const ueNext = useRef(false);
  const dg = useDiagrams({ session, draft, agentName, mobile, enabled: !readOnly && tab === "doc", moreRef, setNote });
  // v1.3 item 2: Send to issues (⋯ item, strip under the title, chips on decisions, the sheet).
  const phone = useMedia("(max-width: 640px)");
  const iss = useIssues({ session, agentName, phone, draft: session.status !== "plated" || openCount > 0, idOf: label, moreRef });
  const cm = useComments({ session, draft, mode, tab, mobile, agentName, readOnly, docRef, editRef, onShowDecision: showInPlan, decisionInfo, onDecisionRow: showDecisionRow, agentNameOf, setNote, inserts: dg.inserts, hideReviewBar: dg.hideReviewBar });
  cmRef.current = cm;

  const renderDecision: DecisionRenderer = (fields, { invalid, setActive, lit }) => {
    const key = fields.key ?? "";
    const stale = waiting.includes(key) || (!!session.stale?.[key] && !session.decisions[key] && fields.status !== "open");
    const open = fields.status === "open" && !session.decisions[key];
    const deps = dependentsOf(session, key).map((k) => nameOf(session.decisions[k]));
    const ext = external.get(key);
    const own = ownKey(session, key);
    const changed = touched?.key === key && session.decisions[key] && session.decisions[key].answer !== touched.was ? touched.was : undefined;
    return (
      <DecisionCard
        key={`${key}-${fields.answer ?? ""}`}
        fields={fields}
        state={stale ? "stale" : open ? "open" : "settled"}
        question={own ? ownQuestion(key, fields.question) : questionFor(session, key)}
        own={own}
        dependents={deps}
        passages={psg.filter((p) => p.keys.includes(key)).map((p) => p.id)}
        invalid={invalid}
        readOnly={readOnly}
        onActive={setActive}
        onSave={(pick) => (own ? saveOwn(key, pick) : save(key, open, pick))}
        agentName={agentName}
        lit={lit}
        was={changed}
        feedback={reaskLine?.anchor === key ? reaskLine.text : undefined}
        external={ext ? { from: ext.from, to: ext.to, deps: ext.deps.map((k) => (session.decisions[k] ? nameOf(session.decisions[k]) : k)) } : undefined}
        onExternal={ext ? onExternal : undefined}
        onReask={stale && !waiting.includes(key) && session.status === "plated" ? () => act("reask", { key }).then(() => undefined) : undefined}
        addPlan={session.decisions[key] && session.status === "plated" && !own ? addPlanFor(session, key, act) : undefined}
        onReview={reviewSuggestion}
        chips={iss.chipsFor(key)}
      />
    );
  };

  // Right-margin cites (§2.3), one per cited decision, hidden on mobile (§5).
  const gut: GutRenderer = (keys, { on, label: litKey }) =>
    keys.map((k) => (
      <GutCite
        key={k}
        id={label(k)}
        decision={session.decisions[k]}
        fallback={session.stale?.[k]?.title ?? k}
        agentName={agentName}
        on={on === k || litKey === k || cm.focusedSource === k}
        labelMode={litKey === k && room === "full"}
        stale={staleKeys.has(k)}
        dzKey={k}
        onJump={() => goToDecision(k)}
      />
    ));

  const tabs: { id: Tab; label: ReactNode; name?: string }[] = [
    { id: "doc", label: "Document" },
    {
      id: "decisions",
      label: (
        <>
          Decisions{" "}
          <span className="ptab-ct">
            {mobile && counts.open ? null : counts.total}
            {counts.open ? <span className="ptab-open">{mobile ? "· " : " · "}{counts.open} open</span> : null}
          </span>
        </>
      ),
    },
  ];

  return (
    <div className="planv" data-tab={tab} data-waiting={waiting.length ? "" : undefined} data-reviewing={cm.pending ? "" : undefined} data-composing={cm.composing ? "" : undefined} data-landing={cm.landing ? "" : undefined}>
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
              aria-label={t.name}
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
              reasking={waiting.length}
              review={cm.pending}
            />
          )}
          {mobile || tab !== "doc" ? null : <ModeToggle mode={mode} onMode={setMode} />}
          {cm.railButton}
          <CopyButton
            text={draft.text}
            label={mobile ? "Copy" : "Copy Markdown"}
            ariaLabel={mobile ? "Copy Markdown" : undefined}
            tone="primary"
            className="copy-md"
          />
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <button ref={moreRef} type="button" className={`icon-btn${dg.open || ue ? " on5" : ""}`} aria-label="Plan actions" onPointerDown={() => void draft.flush()}>
                <IMore s={16} />
              </button>
            </DropdownMenuTrigger>
            <DropdownMenuContent
              align="end"
              className="pmenu"
              onCloseAutoFocus={(e) => {
                if (iss.onMenuClosed(e)) return;
                if (!ueNext.current) return;
                ueNext.current = false;
                e.preventDefault();
                setUe(true);
              }}
            >
              {dg.menuItem}
              {mobile && tab === "doc" ? (
                <>
                  <DropdownMenuRadioGroup value={mode} onValueChange={(v) => setMode(v as EditorMode)}>
                    <DropdownMenuRadioItem value="rich">Rich</DropdownMenuRadioItem>
                    <DropdownMenuRadioItem value="raw">Markdown</DropdownMenuRadioItem>
                  </DropdownMenuRadioGroup>
                  <DropdownMenuSeparator />
                </>
              ) : null}
              {cm.menuItem}
              {mobile && cm.menuItem ? <DropdownMenuSeparator /> : null}
              <DropdownMenuItem onSelect={() => (ueNext.current = true)}>
                <IPlug s={16} />
                {UCOPY.menu}
              </DropdownMenuItem>
              {iss.menuItem}
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
      {cm.rawNote}
      <div className="pvrow">
        <div className="pvmain">
      <div className="docwrap" ref={docRef}>
        <div id="ppanel-doc" role="tabpanel" aria-labelledby="ptab-doc" hidden={tab !== "doc"}>
          <PlanEditor
            draft={draft}
            mode={mode}
            setMode={setMode}
            agentName={agentName}
            readOnly={readOnly}
            decision={renderDecision}
            gut={mobile ? undefined : gut}
            gutInline={room === "inline"}
            staleKeys={staleKeys}
            marks={cm.marks}
            editRef={editRef}
            onAgentDiagram={dg.onAgentDiagram}
            afterTitle={
              <>
                {session.source ? (
                  <Provenance session={session} head={text.titleMeta} edited={!!plan.editedAt} />
                ) : (
                  <p className="sub" data-testid="plan-meta">
                    {text.titleMeta}
                    {plan.editedAt ? " · edited" : ""}
                  </p>
                )}
                {iss.strip}
              </>
            }
            openBadge={openCount ? <span className="ct"> {openCount}</span> : null}
            // Cites live in the right margin now (§2.3); on mobile there are none (§5).
            cite={() => null}
          />
        </div>
        <div id="ppanel-decisions" role="tabpanel" aria-labelledby="ptab-decisions" hidden={tab !== "decisions"} className="dtab">
          {tab === "decisions" ? (
            <DecisionsTab session={session} openKeys={openKeys} agentName={agentName} mobile={mobile} psg={psg} label={label} own={ownDecisions} titleOf={(k) => ownBlocks.get(k)?.question ?? k} onShow={showInPlan} renderOpen={renderDecision} save={save} jump={rowJump} act={act} onReview={reviewSuggestion} />
          ) : null}
        </div>
      </div>
          {cm.overlay}
          <AddPlanLive session={session} />
          {dg.bar}
          {dg.popover}
          {iss.sheet}
          {ue ? (
            <UseInEditor
              launch={mcp}
              agent={session.provider}
              planTitle={plan.title || session.idea.split("\n")[0]}
              mobile={mobile}
              anchor={moreRef}
              onClose={(focus) => {
                setUe(false);
                if (focus) moreRef.current?.focus();
              }}
            />
          ) : null}
        </div>
        {cm.rail}
      </div>
    </div>
  );
}

/** A right-margin cite (§2.3): shows on hover, focus or a lit link; preview popover after 300ms (0 on focus). */
function GutCite({
  id,
  decision,
  fallback,
  agentName,
  on,
  labelMode,
  stale,
  dzKey,
  onJump,
}: {
  id: string;
  decision?: Decision;
  fallback: string;
  agentName: string;
  on: boolean;
  labelMode: boolean;
  stale: boolean;
  dzKey: string;
  onJump: () => void;
}) {
  const [peek, setPeek] = useState<null | { up: boolean; dx: number }>(null);
  const t = useRef<ReturnType<typeof setTimeout>>(undefined);
  const ref = useRef<HTMLSpanElement>(null);
  const pid = useId();
  const question = decision?.title ?? fallback;
  const answer = decision?.answer ?? "";
  const show = (delay: number) => {
    clearTimeout(t.current);
    t.current = setTimeout(() => {
      const r = ref.current?.getBoundingClientRect();
      // #118: the popover never crosses the plan's right edge; it right-aligns to it (minus 8) over the column.
      const wrap = ref.current?.closest<HTMLElement>(".docwrap");
      const edge = wrap ? wrap.getBoundingClientRect().left + wrap.clientWidth - 8 : window.innerWidth - 8;
      setPeek({ up: !!r && r.bottom + 200 > window.innerHeight, dx: r ? Math.min(0, edge - (r.left + PEEK_W)) : 0 });
    }, delay);
  };
  const hide = () => {
    clearTimeout(t.current);
    t.current = setTimeout(() => setPeek(null), 80);
  };
  useEffect(() => () => clearTimeout(t.current), []);
  // Label mode points at an off-screen decision with ↑/↓; hover never scrolls on its own.
  const where = labelMode ? offscreen(document.querySelector(`.dz[data-key="${CSS.escape(dzKey)}"]`)) : null;
  return (
    <span
      ref={ref}
      className="gut-i"
      onPointerEnter={() => show(warm() ? 0 : 300)}
      onPointerLeave={hide}
      onFocus={() => show(0)}
      onBlur={(e) => !ref.current?.contains(e.relatedTarget as Node) && hide()}
      onKeyDown={(e) => {
        if (e.key === "Escape" && peek) {
          e.stopPropagation();
          setPeek(null);
        }
      }}
    >
      <button
        type="button"
        className={`gut-cite${on ? " on" : ""}${stale ? " st" : ""}`}
        // The visible text ("R3·1", or "R3·1 answer" in label mode) leads the name (WCAG 2.5.3).
        aria-label={labelMode && answer ? `${id} ${answer}, decision: ${question}. Show decision` : `Decision ${id}: ${question}${answer ? ` ${answer}` : ""}. Show decision`}
        aria-describedby={peek ? pid : undefined}
        onClick={onJump}
      >
        {id}
        {labelMode && answer ? <span className="an"> {answer}</span> : null}
        {where ? (
          <span className="ar" aria-hidden="true">
            {where === "above" ? "↑" : "↓"}
          </span>
        ) : null}
      </button>
      {peek ? (
        <span className="peekcard" id={pid} role="tooltip" data-up={peek.up ? "" : undefined} style={peek.dx ? { left: peek.dx } : undefined} onPointerLeave={() => (lastClose = performance.now())}>
          <span className="pq">{question}</span>
          {answer ? (
            <span className="a">
              {answer}
              {decision && !decision.accepted_recommendation ? <span className="yc">{COPY.yourCall}</span> : null}
            </span>
          ) : null}
          <span className="m">
            {id}
            {decision ? "" : " · Will be asked again"}
          </span>
          <span className="f">
            <button type="button" className="btn quiet sm" onClick={onJump}>
              Show decision <span className="k" aria-hidden="true">↵</span>
            </button>
          </span>
        </span>
      ) : null}
    </span>
  );
}

/** The preview popover's width (`.peekcard`, §2.3). */
const PEEK_W = 300;

/**
 * How much the right margin holds (#118), measured as the visible `.docwrap` right edge minus the
 * column's right edge, again on every resize or rail toggle:
 * - "full": ≥240px (12 gap + 220 label + 8), the cite plus its answer label on hover or a lit link;
 * - "cite": under 240px, the cite only ("R1·1"); the answer stays in the popover;
 * - "inline": the measure is under 480px, so the cite goes inline at the end of its passage.
 */
type GutRoom = "full" | "cite" | "inline";
const GUT_FULL = 240;
const GUT_MIN_MEASURE = 480;
function useGutRoom(wrapRef: { current: HTMLElement | null }, on: boolean): GutRoom {
  const [room, setRoom] = useState<GutRoom>("full");
  useEffect(() => {
    const wrap = wrapRef.current;
    if (!on || !wrap) return;
    const measure = () => {
      const doc = wrap.querySelector<HTMLElement>(".doc");
      if (!doc || !doc.offsetWidth) return;
      const d = doc.getBoundingClientRect();
      const cs = getComputedStyle(doc);
      const left = d.left + parseFloat(cs.paddingLeft || "0");
      const right = d.right - parseFloat(cs.paddingRight || "0");
      const margin = wrap.getBoundingClientRect().left + wrap.clientWidth - right;
      setRoom(right - left < GUT_MIN_MEASURE ? "inline" : margin < GUT_FULL ? "cite" : "full");
    };
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(wrap);
    const doc = wrap.querySelector(".doc");
    if (doc) ro.observe(doc);
    return () => ro.disconnect();
  }, [on, wrapRef]);
  return room;
}

// Within 600ms of one popover closing, the next opens at once (§2.3 warm window).
let lastClose = 0;
const warm = () => performance.now() - lastClose < 600;

function DecisionsTab({
  session,
  openKeys,
  agentName,
  mobile,
  psg,
  label,
  own,
  titleOf,
  onShow,
  renderOpen,
  save,
  jump,
  act,
  onReview,
}: {
  session: SessionView;
  openKeys: string[];
  agentName: string;
  mobile: boolean;
  psg: { id: string; keys: string[] }[];
  label: (key: string) => string;
  /** Decisions you added yourself and answered (U ids, item 4), listed after the rounds. */
  own: Decision[];
  titleOf: (key: string) => string;
  onShow: (key: string) => void;
  renderOpen: DecisionRenderer;
  save: (key: string, open: boolean, pick: { optionId: string; text?: string }) => Promise<void>;
  /** Scroll to, flash and focus this decision's row (Activity's Asked chips). */
  jump: { key: string; n: number } | null;
  act: Act;
  onReview: (suggestion: string) => void;
}) {
  // With decisions still open they come first and the resolved log starts collapsed (§4).
  const [expanded, setExpanded] = useState(!openKeys.length);
  const [changing, setChanging] = useState<string | null>(null);
  const [saved, setSaved] = useState("");
  const [cur, setCur] = useState(0);
  const listRef = useRef<HTMLDivElement>(null);
  const openBefore = useRef(openKeys);
  // Answering an open one here says so inline (§4, board 5).
  useEffect(() => {
    const done = openBefore.current.filter((k) => !openKeys.includes(k) && session.decisions[k]);
    openBefore.current = openKeys;
    if (done.length) setSaved(fmt(COPY.savedQuestion, { question: session.decisions[done[0]].title }));
  }, [openKeys.join(" ")]);
  const byRound = useMemo(() => {
    const m = new Map<number, Decision[]>();
    for (const d of [...Object.values(session.decisions), ...own]) m.set(d.round, [...(m.get(d.round) ?? []), d]);
    for (const ds of m.values()) ds.sort((a, b) => label(a.key).localeCompare(label(b.key), undefined, { numeric: true }));
    return [...m.entries()].sort((a, b) => b[0] - a[0]);
  }, [session.decisions, session.rounds, own]);
  const flat = byRound.flatMap(([, ds]) => ds);
  const resolved = flat.length;
  const rows = () => [...(listRef.current?.querySelectorAll<HTMLElement>("[data-row]") ?? [])];
  const move = (i: number) => {
    const n = Math.max(0, Math.min(flat.length - 1, i));
    setCur(n);
    rows()[n]?.focus();
  };
  const rootRef = useRef<HTMLDivElement>(null);
  // Add to plan swaps its controls as the run moves on (button → Stop → Review / Try again). When
  // the focused one goes away, focus moves to what took its place in the same row, else the row.
  const apFocus = useRef<string | null>(null);
  const apRun = session.addPlanRun;
  const apKey = `${apRun?.decision}:${apRun?.startedAt}:${apRun?.state}:${(session.suggestions ?? []).find((x) => x.id === apRun?.suggestion)?.status}`;
  useEffect(() => {
    const key = apFocus.current;
    if (!key) return;
    let n = 0;
    const tick = () => {
      const row = rootRef.current?.querySelector<HTMLElement>(`.drow[data-key="${CSS.escape(key)}"]`);
      const a = document.activeElement as HTMLElement | null;
      const lost = !a || a === document.body || !a.isConnected || !a.checkVisibility({ visibilityProperty: true });
      if (!row || !lost) return;
      const next = [...row.querySelectorAll<HTMLElement>(".apl .lnk, .apb button")].find((b) => b.checkVisibility({ visibilityProperty: true }));
      if (next) next.focus();
      else if (++n < 10) requestAnimationFrame(tick);
      else row.focus();
    };
    requestAnimationFrame(tick);
  }, [apKey]);
  useEffect(() => {
    if (!jump) return;
    const i = flat.findIndex((d) => d.key === jump.key);
    if (i >= 0) {
      setExpanded(true);
      setCur(i);
    }
    // Item 2's jump: center, flash, focus. Wait a frame for the tab and the expanded list to paint.
    requestAnimationFrame(() =>
      requestAnimationFrame(() => {
        const el = rootRef.current?.querySelector<HTMLElement>(i >= 0 ? `.drow[data-key="${CSS.escape(jump.key)}"]` : `.dz[data-key="${CSS.escape(jump.key)}"]`) ?? null;
        jumpTo(el, el);
      }),
    );
  }, [jump?.n]);
  return (
    <div className="doc" ref={rootRef}>
      <h1>Decisions</h1>
      <p className="sub">{COPY.decisionsLead}</p>
      {saved ? (
        <p className="fb" role="status">
          <ICheck s={14} />
          {saved}
        </p>
      ) : null}
      {openKeys.length ? (
        <section className="dgrp-open" aria-labelledby="still-open">
          <h2 id="still-open">
            Open<span className="ct"> {openKeys.length}</span>
          </h2>
          <p className="sub">{fmt(COPY.openLead, { agent: agentName })}</p>
          {openKeys.map((key) => {
            const title = questionFor(session, key)?.title ?? titleOf(key);
            return <div key={key}>{renderOpen({ id: label(key), key, question: title, status: "open" }, { invalid: false, active: false, setActive: () => {} })}</div>;
          })}
        </section>
      ) : null}
      <section className="acc">
        <h2>
          <button type="button" className="acc-h" aria-expanded={expanded} aria-controls="acc-resolved" onClick={() => setExpanded(!expanded)}>
            <IDown s={14} />
            {resolved} resolved{" "}
            <span className="acc-sub">
              {expanded || !byRound.length
                ? COPY.resolvedNewest
                : byRound.length === 1
                  ? `Round ${byRound[0][0]}`
                  : fmt(COPY.resolvedRounds, { first: byRound[byRound.length - 1][0], last: byRound[0][0] })}
            </span>
          </button>
        </h2>
        <div id="acc-resolved" hidden={!expanded} ref={listRef}>
          {byRound.map(([round, ds]) => (
            <div key={round} className="dgrp">
              <h3>{round ? `Round ${round}` : COPY.addedByYou}</h3>
              <ul className="dlist">
                {ds.map((d) => {
                  const i = flat.indexOf(d);
                  const orphan = !psg.some((p) => p.keys.includes(d.key));
                  // Add to plan (#104): only on a decision from a round, once the plan is written.
                  const ap = orphan && session.decisions[d.key] && session.status === "plated" ? addPlanFor(session, d.key, act) : null;
                  const q = questionFor(session, d.key);
                  const by = d.accepted_recommendation ? null : COPY.yourCall;
                  if (changing === d.key && q)
                    return (
                      <li key={d.key} className="drow-chg">
                        <DecisionCard
                          fields={{ id: label(d.key), key: d.key, question: d.title, answer: d.answer }}
                          state="settled"
                          question={q}
                          dependents={dependentsOf(session, d.key).map((k) => nameOf(session.decisions[k]))}
                          passages={psg.filter((p) => p.keys.includes(d.key)).map((p) => p.id)}
                          onActive={() => {}}
                          onSave={(pick) => save(d.key, false, pick)}
                          agentName={agentName}
                          startExpanded
                          onClose={() => {
                            setChanging(null);
                            requestAnimationFrame(() => rows()[i]?.focus());
                          }}
                        />
                      </li>
                    );
                  return (
                    <li
                      key={d.key}
                      className={ap ? "drow ap" : "drow"}
                      data-row
                      data-key={d.key}
                      tabIndex={i === cur ? 0 : -1}
                      aria-label={`${d.title} ${d.answer}${by ? `, ${by}` : ""}`}
                      onFocus={() => setCur(i)}
                      onClick={mobile ? () => onShow(d.key) : undefined}
                      onFocusCapture={(e) => {
                        if (e.target !== e.currentTarget && (e.target as HTMLElement).closest(".apl, .apb")) apFocus.current = d.key;
                      }}
                      onKeyDown={(e) => {
                        // ArrowRight/Left walk the row's own controls: the Add to plan line's link, then the action area.
                        const ctl = [...e.currentTarget.querySelectorAll<HTMLElement>(".apl .lnk, .drow-ra button")].filter((b) => b.checkVisibility({ visibilityProperty: true }));
                        if (e.target !== e.currentTarget) {
                          const at = ctl.indexOf(e.target as HTMLElement);
                          if (e.key === "ArrowLeft") {
                            e.preventDefault();
                            (at > 0 ? ctl[at - 1] : e.currentTarget).focus();
                          } else if (e.key === "ArrowRight" && at >= 0 && at < ctl.length - 1) {
                            e.preventDefault();
                            ctl[at + 1].focus();
                          }
                          return;
                        }
                        if (e.key === "ArrowDown") move(i + 1);
                        else if (e.key === "ArrowUp") move(i - 1);
                        else if (e.key === "Home") move(0);
                        else if (e.key === "End") move(flat.length - 1);
                        else if (e.key === "Enter") onShow(d.key);
                        else if (e.key === "ArrowRight") (ap ? ctl[0] : e.currentTarget.querySelector<HTMLElement>(".drow-chg-btn"))?.focus();
                        else return;
                        e.preventDefault();
                      }}
                    >
                      <span className="drow-q">{d.title}</span>
                      <span className="drow-a">
                        {d.answer}
                        {by ? <span className="yc">{by}</span> : null}
                        {orphan && (!ap || ap.state === "rest") ? (
                          <span className="orph">
                            <IAlert s={12} />
                            Not in the plan text yet
                          </span>
                        ) : null}
                        {ap ? <AddPlanLine ap={ap} agentName={agentName} onReview={onReview} tabIndex={-1} /> : null}
                      </span>
                      <span className="drow-m">
                        {label(d.key)} · {d.accepted_recommendation ? COPY.youKept : COPY.you}
                      </span>
                      {mobile ? (
                        // Phones: Add to plan takes the chevron's place, and leaves no chevron while it runs (#104).
                        ap ? (
                          ap.state === "rest" ? (
                            <AddPlanButton ap={ap} agentName={agentName} className="mapl" label={`Add to plan: ${nameOf(d)}`} onDone={() => (apFocus.current = d.key)} />
                          ) : null
                        ) : (
                          <IChev s={14} />
                        )
                      ) : (
                        <span className="drow-ra">
                          {ap ? (
                            <AddPlanButton ap={ap} agentName={agentName} className="btn quiet sm drow-ap-btn" tabIndex={-1} label={`Add to plan: ${nameOf(d)}`} onDone={() => (apFocus.current = d.key)} />
                          ) : (
                            <button type="button" className="btn quiet sm" tabIndex={-1} aria-label={`Show in plan: ${nameOf(d)}`} onClick={() => onShow(d.key)}>
                              Show in plan
                            </button>
                          )}
                          {q && session.status === "plated" && !session.busy ? (
                            <button type="button" className="btn quiet sm drow-chg-btn" tabIndex={-1} aria-label={`Change ${nameOf(d)}`} onClick={() => setChanging(d.key)}>
                              Change
                            </button>
                          ) : null}
                        </span>
                      )}
                    </li>
                  );
                })}
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
