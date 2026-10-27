// v1.1 item 6: the Activity tab (DECISIONS #51–66). Newest first, one row per entry, grouped in
// work sessions. No clock: a running row says when it started, finished steps and runs show their
// duration. One polite live region, run-level only, mounted only while the tab is visible.
// Styling hooks: .act6, .grp6 (sticky .gh6), .ev6[data-status][data-open], .evb (row button),
// .st6 (step), .chip6, .more6, .pill6, .ft6, .empty6.
import { type ReactNode, useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from "react";
import { type Entry, type Group, accName, copyText, fmt, groupLabel, groupMeta, groups, liveMessage, meta, say, stepText, time, title } from "../../../../src/core/activity.ts";
import { api } from "../api";
import { ICheck2, IChev, ICircleAlert, ICopy, IActivity, IFile, IFileDiff, IFlow, IHelp, IMsg, IOut, IEdit, IRetry, ISq, IUser } from "../icons";
import type { ActivityView, Suggestion } from "../types";

/** Run bars and status rows open Activity on their run (#66). */
export type ActivityFocus = { run?: string; kind?: string; comment?: string };
export const openActivity = (f: ActivityFocus) => window.dispatchEvent(new CustomEvent<ActivityFocus>("grillado:activity", { detail: f }));

const PAGE = 50;
const VIRTUAL_AFTER = 200;

export interface ActivityProps {
  sessionId: string;
  view: ActivityView | undefined;
  agentName: string;
  agentId: string;
  agentNameOf: (id: string) => string;
  suggestions: Suggestion[];
  /** A run to open and focus (from a run bar's label, #66): its id or its kind. */
  focus: { run?: string; kind?: string; comment?: string; n: number } | null;
  act: (path: string, body?: unknown) => Promise<boolean>;
  /** Jump to a suggestion still to review (item 3 keys work from there). */
  onSuggestion: (id: string) => void;
  /** Jump to a section of the plan (accepted text, "Wrote"); `figure` flashes its diagram instead. False when it's gone. */
  onSection: (section: string, probe?: boolean, figure?: boolean) => boolean;
  /** A decision asked in a round: its label ("R2·1") and question, or null when it's gone. */
  decision: (key: string) => { label: string; title: string } | null;
  /** Open the Decisions tab on that row (item 2's jump). */
  onDecision: (key: string) => void;
  onToast: (text: string) => void;
  /** Esc: back to the plan. */
  onLeave: () => void;
  mobile: boolean;
}

// The sheet reopens with the same scroll and open rows (§14).
const kept = new Map<string, { open: Record<string, boolean>; groups: Record<string, boolean>; top: number }>();

function icon(e: Entry): ReactNode {
  if (e.status === "running") return <i className="live" aria-hidden="true" />;
  if (e.status === "failed") return <ICircleAlert className="bad" />;
  if (e.status === "stopped" || e.status === "interrupted") return <ISq />;
  if (e.type === "review") return <ICheck2 />;
  if (e.type === "user") return <IUser />;
  if (e.type === "file") return <IFileDiff />;
  return { round: <IHelp />, plan: <IFile />, reply: <IMsg />, apply: <IEdit />, diagrams: <IFlow />, addplan: <IEdit /> }[e.kind ?? "diagrams"];
}

export function ActivityPanel(p: ActivityProps) {
  const A = p.agentName;
  const secOf = useMemo(() => {
    const m = new Map<string, string>();
    for (const e of p.view?.entries ?? []) for (const x of e.suggestions ?? []) if (x.section) m.set(x.id, x.section);
    return m;
  }, [p.view]);
  const o = { agent: A, agentId: p.agentId, agentNameOf: p.agentNameOf, sectionOf: (id: string) => secOf.get(id) };
  const memo = kept.get(p.sessionId) ?? { open: {}, groups: {}, top: 0 };
  kept.set(p.sessionId, memo);
  const [limit, setLimit] = useState(PAGE);
  const [more, setMore] = useState<ActivityView | null>(null);
  const [open, setOpenRaw] = useState<Record<string, boolean>>(memo.open);
  const [gOpen, setGOpenRaw] = useState<Record<string, boolean>>(memo.groups);
  const [say1, setSay] = useState("");
  const [pill, setPill] = useState(false);
  const [cursor, setCursor] = useState<string | null>(null);
  const root = useRef<HTMLDivElement>(null);
  const setOpen = (id: string, v: boolean) => setOpenRaw((x) => (memo.open = { ...x, [id]: v }));
  const setGOpen = (id: string, v: boolean) => setGOpenRaw((x) => (memo.groups = { ...x, [id]: v }));

  // Older pages come from the route; the live view always carries the latest 50.
  const view = limit > PAGE && more ? more : p.view;
  useEffect(() => {
    if (limit <= PAGE) return;
    let gone = false;
    api.activity(p.sessionId, limit).then((v) => !gone && setMore(v), () => {});
    return () => {
      gone = true;
    };
  }, [limit, p.view, p.sessionId]);
  const entries = view?.entries ?? [];
  const grs = useMemo(() => groups(entries), [entries]);
  const latestRun = entries.find((e) => e.type === "run");
  // Open by default: the live run, then the last finished run until the next one starts. No timers.
  const isOpen = (e: Entry) => open[e.id] ?? (e.type === "run" && e.id === latestRun?.id);
  const isGOpen = (g: Group, i: number) => gOpen[g.key] ?? i === 0;

  // Live region: run-level messages only (#61).
  const seen = useRef<Map<string, string> | null>(null);
  useEffect(() => {
    const now = new Map(entries.filter((e) => e.type === "run").map((e) => [e.id, e.status ?? "running"]));
    if (seen.current) {
      for (const e of entries) {
        if (e.type !== "run") continue;
        const was = seen.current.get(e.id);
        if (was !== e.status && (was || e.status === "running")) {
          setSay(liveMessage(e, A));
          break;
        }
      }
    }
    seen.current = now;
  }, [entries, A]);

  // "New run above" when a run starts while the list is scrolled down; no auto-scroll (#62).
  const scroller = () => root.current?.closest<HTMLElement>(".rscroll") ?? null;
  const lastTop = useRef(latestRun?.id);
  useEffect(() => {
    if (latestRun?.id && latestRun.id !== lastTop.current && (scroller()?.scrollTop ?? 0) > 48) setPill(true);
    lastTop.current = latestRun?.id;
  }, [latestRun?.id]);
  useLayoutEffect(() => {
    const sc = scroller();
    if (!sc) return;
    sc.scrollTop = memo.top;
    const on = () => {
      memo.top = sc.scrollTop;
      if (sc.scrollTop <= 48) setPill(false);
    };
    sc.addEventListener("scroll", on, { passive: true });
    return () => sc.removeEventListener("scroll", on);
  }, []);

  // A run bar's label opens Activity on that run (#66).
  useEffect(() => {
    if (!p.focus) return;
    const f = p.focus;
    const e = entries.find((x) => x.type === "run" && (f.run ? x.id === f.run : x.kind === f.kind && (!f.comment || x.target?.comment === f.comment)));
    if (!e) return;
    setOpen(e.id, true);
    const gi = grs.findIndex((g) => g.entries.includes(e));
    if (gi > 0) setGOpen(grs[gi].key, true);
    setCursor(e.id);
    requestAnimationFrame(() => {
      const b = root.current?.querySelector<HTMLElement>(`[data-entry="${CSS.escape(e.id)}"] .evb`);
      b?.scrollIntoView({ block: "nearest" });
      b?.focus({ preventScroll: true });
    });
  }, [p.focus?.n]);

  // Roving tabindex over the visible row and group headers (#61).
  const heads = () => [...(root.current?.querySelectorAll<HTMLElement>(".evb, .gh6 button") ?? [])];
  const current = cursor ?? entries[0]?.id ?? null;
  const onKey = (e: React.KeyboardEvent, id: string, toggle: (v?: boolean) => void, isOpenNow: boolean) => {
    const list = heads();
    const i = list.indexOf(e.currentTarget as HTMLElement);
    const go = (j: number) => {
      const t = list[Math.max(0, Math.min(list.length - 1, j))];
      if (!t) return;
      e.preventDefault();
      setCursor(t.dataset.id ?? null);
      t.focus();
    };
    if (e.key === "ArrowDown") go(i + 1);
    else if (e.key === "ArrowUp") go(i - 1);
    else if (e.key === "Home") go(0);
    else if (e.key === "End") go(list.length - 1);
    else if (e.key === "ArrowRight") {
      e.preventDefault();
      if (!isOpenNow) toggle(true);
      else (e.currentTarget.closest(".ev6")?.querySelector<HTMLElement>(".evbody button:not(:disabled)") ?? null)?.focus();
    } else if (e.key === "ArrowLeft") {
      e.preventDefault();
      if (isOpenNow) toggle(false);
    } else if (e.key === "Escape") {
      e.preventDefault();
      p.onLeave();
    }
    void id;
  };

  if (!entries.length)
    return (
      <div ref={root} className="act6">
        <Live text={say1} />
        <div className="empty6" data-testid="activity-empty">
          <IActivity s={20} />
          <b>No activity yet</b>
          <p>When {A} works on this plan, each run shows up here with its steps and how long each one took. Your reviews show up here too.</p>
          {view?.legacy ? <p className="m">Work from before this version wasn’t logged.</p> : null}
        </div>
      </div>
    );

  const virt = entries.length + grs.length > VIRTUAL_AFTER;
  return (
    <div ref={root} className={`act6${virt ? " virt" : ""}`} data-testid="activity">
      <Live text={say1} />
      {pill ? (
        <button
          type="button"
          className="pill6"
          onClick={(ev) => {
            const sc = scroller();
            sc?.scrollTo({ top: 0, behavior: ev.detail === 0 || matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth" });
            setPill(false);
          }}
        >
          New run above
        </button>
      ) : null}
      {grs.map((g, gi) => {
        const gl = groupLabel(g);
        const gm = groupMeta(g);
        const on = isGOpen(g, gi);
        const hid = `g6-${g.key}`;
        return (
          <section key={g.key} className="grp6" aria-labelledby={hid}>
            <div className="gh6" id={hid}>
              {gi === 0 ? (
                <>
                  <b>{gl.label}</b>
                  <span className="m">{gm}</span>
                </>
              ) : (
                <button
                  type="button"
                  aria-expanded={on}
                  data-id={g.key}
                  tabIndex={current === g.key ? 0 : -1}
                  onClick={() => setGOpen(g.key, !on)}
                  onKeyDown={(e) => onKey(e, g.key, (v) => setGOpen(g.key, v ?? !on), on)}
                >
                  <IChev s={14} className="chev" />
                  <b>{gl.label}</b>
                  <span className="m">{gm}</span>
                </button>
              )}
            </div>
            {on ? (
              <ol>
                {g.entries.map((e) => {
                  return (
                    <Row
                      key={e.id}
                      e={e}
                      p={p}
                      o={o}
                      open={isOpen(e)}
                      tab={current === e.id}
                      setOpen={(v) => setOpen(e.id, v)}
                      onKey={(ev) => onKey(ev, e.id, (v) => setOpen(e.id, v ?? !isOpen(e)), isOpen(e))}
                      onFocus={() => setCursor(e.id)}
                    />
                  );
                })}
              </ol>
            ) : null}
          </section>
        );
      })}
      {view && view.total > entries.length ? (
        <div className="ft6">
          <button type="button" className="btn quiet sm" onClick={() => setLimit(limit + PAGE)}>
            Show {Math.min(PAGE, view.total - entries.length)} earlier entries
          </button>
          <span className="m">
            Showing the latest {entries.length} of {view.total}
          </span>
        </div>
      ) : null}
      {view?.legacy && !(view.total > entries.length) ? <p className="ft6 m">Work from before this version wasn’t logged.</p> : null}
    </div>
  );
}

function Live({ text }: { text: string }) {
  return (
    <div className="sr-only" role="status" aria-live="polite" data-testid="activity-live">
      {text}
    </div>
  );
}

type MetaOpts = Parameters<typeof meta>[1] & { agent: string };
const reduced = () => typeof matchMedia === "function" && matchMedia("(prefers-reduced-motion: reduce)").matches;
const EASE = "cubic-bezier(0.23,1,0.32,1)";

/** The meta line as parts; the "·" is drawn between parts and clipped at a line start (#83). */
function Meta({ text }: { text: string }) {
  return (
    <span className="m mt6">
      {text.split(" · ").map((x, i) => (
        <span key={i}>{x}</span>
      ))}
    </span>
  );
}

function Row({ e, p, o, open, tab, setOpen, onKey, onFocus }: { e: Entry; p: ActivityProps; o: MetaOpts; open: boolean; tab: boolean; setOpen: (v: boolean) => void; onKey: (e: React.KeyboardEvent) => void; onFocus: () => void }) {
  const A = o.agent;
  const running = e.status === "running";
  const hasBody = e.type === "run";
  const bodyId = `evb-${e.id}`;
  const tipId = `tip-${e.id}`;
  // Only a pointer toggle animates the body; default-open, restored and keyboard opens don't (#81).
  const [anim, setAnim] = useState(false);
  useEffect(() => {
    if (!open) setAnim(false);
  }, [open]);
  const toggle = (ev: React.MouseEvent) => {
    if (!hasBody) return;
    setAnim(!open && ev.detail > 0 && !document.documentElement.hasAttribute("data-kbd"));
    setOpen(!open);
  };
  const stop = running ? (e.kind === "diagrams" || e.kind === "addplan" ? () => p.act(e.kind!, { op: "stop" }) : e.kind === "apply" && e.target?.comment ? () => p.act(`comments/${e.target!.comment}/stop`) : null) : null;
  const done = e.type === "run" && e.ms !== undefined && !running;
  return (
    <li className="ev6" data-entry={e.id} data-status={e.status ?? e.type} data-open={open && hasBody ? "" : undefined}>
      <div className="evh">
        <span className="ic">{icon(e)}</span>
        <span className="tx" aria-hidden="true">
          <b>{title(e)}</b>
          <Meta text={meta(e, o)} />
        </span>
        {stop ? (
          <button type="button" className="btn quiet sm stop6" onClick={() => void stop()}>
            <ISq s={12} />
            Stop
          </button>
        ) : done ? (
          // The visible number is hidden: the row's name already says it; the tip is its description (#80).
          <span className="dur" aria-hidden="true" onClick={toggle}>
            {fmt(e.ms!)}
            <span className="tip6" id={tipId} role="tooltip">
              Started {time(e.at, true)} · took {fmt(e.ms!)}
            </span>
          </span>
        ) : (
          <span />
        )}
        {hasBody ? <IChev s={14} className="chev" /> : <span />}
        <button
          type="button"
          className="evb"
          data-id={e.id}
          aria-label={accName(e, o)}
          aria-describedby={done ? tipId : undefined}
          aria-expanded={hasBody ? open : undefined}
          aria-controls={hasBody && open ? bodyId : undefined}
          tabIndex={tab ? 0 : -1}
          onClick={toggle}
          onKeyDown={onKey}
          onFocus={onFocus}
        />
      </div>
      {hasBody && open ? <Body id={bodyId} e={e} p={p} A={A} animate={anim} /> : null}
    </li>
  );
}

function Steps({ e, A }: { e: Entry; A: string }) {
  const [all, setAll] = useState(false);
  const s = e.steps;
  // Steps already there when the body opened don't move; only ones that arrive while it's open fade in (#81).
  const base = useRef(s.length);
  const long = s.length > 12 && !all;
  const idx = s.map((_, i) => i);
  const shown = long ? [...idx.slice(0, 6), -1, ...idx.slice(-4)] : idx;
  return (
    <ul className="steps6">
      {shown.map((i) => {
        if (i < 0)
          return (
            <li key="more" className="more6">
              <button type="button" className="lnk" onClick={() => setAll(true)}>
                Show {s.length - 10} more steps
              </button>
            </li>
          );
        const x = s[i];
        const fresh = i >= base.current;
        return (
          <li
            key={i}
            className="st6"
            data-state={x.state}
            data-new={fresh ? "" : undefined}
            ref={(el) => {
              if (!el || !fresh || el.dataset.in) return;
              el.dataset.in = "1";
              // Not user-initiated, so it fades from the keyboard too; reduced motion: opacity only.
              el.animate(reduced() ? [{ opacity: 0 }, { opacity: 1 }] : [{ opacity: 0, translate: "0 4px" }, { opacity: 1, translate: "0 0" }], { duration: 160, easing: EASE });
            }}
          >
            <span className="g" aria-hidden="true">
              {x.state === "running" ? <i className="live s6" /> : x.state === "failed" ? <ICircleAlert s={14} /> : x.state === "stopped" ? <ISq s={12} /> : null}
            </span>
            <span className="l">{stepText(x.label, A)}</span>
            {x.ms !== undefined ? (
              <>
                <span className="dur" aria-hidden="true">
                  {fmt(x.ms)}
                </span>
                <span className="sr-only">{say(x.ms)}</span>
              </>
            ) : null}
          </li>
        );
      })}
    </ul>
  );
}

function Chips({ label, children }: { label: string; children: ReactNode }) {
  const id = useId();
  return (
    <div className="chips6" role="group" aria-labelledby={id} data-k={label}>
      <span className="k" id={id}>
        {label}
      </span>
      <div className="cl6">{children}</div>
    </div>
  );
}

function Body({ id, e, p, A, animate }: { id: string; e: Entry; p: ActivityProps; A: string; animate: boolean }) {
  const ref = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    if (!animate || !ref.current) return;
    ref.current.animate(reduced() ? [{ opacity: 0 }, { opacity: 1 }] : [{ gridTemplateRows: "0fr", opacity: 0 }, { gridTemplateRows: "1fr", opacity: 1 }], { duration: 220, easing: EASE });
  }, []);
  const statusOf = (sid: string) => {
    const s = p.suggestions.find((x) => x.id === sid);
    return s?.status === "accepted" ? "accepted" : s?.status === "rejected" ? "rejected" : s ? "to review" : "no longer in the plan";
  };
  const done = e.status !== "running";
  const retry = e.status === "failed" ? (e.kind === "diagrams" || e.kind === "addplan" ? () => p.act(e.kind!, { op: "retry" }) : e.kind === "apply" && e.target?.comment ? () => p.act(`comments/${e.target!.comment}/retry`) : null) : null;
  return (
    <div className="evbody" id={id} ref={ref} data-anim={animate ? "" : undefined}>
      <div>
        <Steps e={e} A={A} />
        {done ? (
          <div className="fin6">
            {e.read?.length ? (
              <p className="kv">
                <span className="k">Read</span> plan.md · {e.read.join(", ")}
              </p>
            ) : null}
            {e.notDone?.length ? (
              <p className="kv">
                <span className="k">Not done</span> {e.notDone.join(", ")} {e.notDone.length === 1 ? "wasn’t" : "weren’t"} started
              </p>
            ) : null}
            {e.status === "failed" && (e.kind === "apply" || e.kind === "reply") ? <p className="why">Your comment and {A}’s reply are kept. Try again later, or switch agent from the top bar.</p> : null}
            {e.asked?.length ? (
              <Chips label="Asked">
                {e.asked.map((k) => {
                  const d = p.decision(k);
                  return (
                    <button key={k} type="button" className="chip6" data-key={k} disabled={!d} onClick={() => p.onDecision(k)}>
                      {d ? <b>{d.label}</b> : null}
                      <span className="m">{d ? d.title : "no longer in the plan"}</span>
                      {d ? <IOut s={14} /> : null}
                    </button>
                  );
                })}
              </Chips>
            ) : null}
            {e.suggestions?.length ? (
              <Chips label="Suggestions">
                {e.suggestions.map((s) => {
                  const st = statusOf(s.id);
                  const fig = e.kind === "diagrams";
                  const gone = st === "no longer in the plan" || (st === "accepted" && !!s.section && !p.onSection(s.section, true, fig));
                  return (
                    <button key={s.id} type="button" className="chip6" disabled={gone} onClick={() => (st === "to review" ? p.onSuggestion(s.id) : s.section && p.onSection(s.section, false, fig && st === "accepted"))}>
                      <b>{s.section ?? "Plan"}</b>
                      <span className="m">{gone ? "no longer in the plan" : st}</span>
                      {gone ? null : <IOut s={14} />}
                    </button>
                  );
                })}
              </Chips>
            ) : null}
            {e.wrote?.length ? (
              <Chips label="Wrote">
                {e.wrote.map((w) => {
                  const gone = !p.onSection(w, true);
                  return (
                    <button key={w} type="button" className="chip6" disabled={gone} onClick={() => p.onSection(w)}>
                      <b>{w}</b>
                      {gone ? <span className="m">removed since</span> : <IOut s={14} />}
                    </button>
                  );
                })}
              </Chips>
            ) : null}
            <div className="acts6">
              {retry ? (
                <button type="button" className="btn soft sm" onClick={() => void retry()}>
                  <IRetry s={14} />
                  Try again
                </button>
              ) : null}
              <button
                type="button"
                className="btn quiet sm"
                onClick={async () => {
                  await navigator.clipboard?.writeText(copyText(e, { agent: A, statusOf })).catch(() => {});
                  p.onToast(`Copied the log of “${title(e).replace(/[“”]/g, "")}”`);
                }}
              >
                <ICopy s={14} />
                Copy log
              </button>
            </div>
          </div>
        ) : null}
      </div>
    </div>
  );
}
