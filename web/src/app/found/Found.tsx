// v1.3 item 1 · Found in this project (handoff §1–§4, §7). The one component and the one mount
// point for the group: Home renders <Found> once, so moving the group (Q1) is a one-line change.
import { isValidElement, useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { reasonCode, reasonText, sourceLabel } from "../../../../src/core/activity.ts";
import { ApiError, api, foundListeners } from "../api";
import { IBranch, ICheck, IRetry, IX } from "../icons";
import type { FoundRow, FoundView } from "../types";

/** Rows shown before "Show n more" (#149). */
const FIRST = 3;
/** "✓ Imported" stays this long, then the row leaves Found for Recent (PO, #21). */
const HOLD_MS = 1500;
const EASE = "cubic-bezier(0.23,1,0.32,1)";

type Phase =
  | { p: "busy"; update: boolean }
  | { p: "done"; update: boolean; planId: string }
  | { p: "leaving"; update: boolean; planId: string }
  | { p: "failed"; reason: string; retry: "import" | "rescan" };

const kbd = () => document.documentElement.hasAttribute("data-kbd");
const reduced = () => typeof matchMedia === "function" && matchMedia("(prefers-reduced-motion: reduce)").matches;

function day(iso: string) {
  const d = new Date(iso);
  return d.toLocaleDateString("en-US", { month: "short", day: "numeric", ...(d.getFullYear() !== new Date().getFullYear() ? { year: "numeric" } : {}) });
}
function ago(iso: string) {
  const m = Math.max(1, Math.round((Date.now() - Date.parse(iso)) / 60000));
  return m < 60 ? `started ${m} min ago` : `started ${Math.round(m / 60)} h ago`;
}
const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
const titleOf = (r: FoundRow) => r.title.trim() || "Untitled session";

/** Words for a failed import: never the raw error (AC17). */
function importReason(err: unknown, agent: string): { reason: string; retry: "import" | "rescan" } {
  if (!(err instanceof ApiError)) return { reason: "Something went wrong", retry: "import" };
  const code = String(err.data.code ?? "");
  if (err.status === 0) return { reason: "Grillado isn’t running", retry: "import" };
  switch (code) {
    case "agent":
      return { reason: reasonText(reasonCode(String(err.data.reason ?? "")), agent), retry: "import" };
    case "unreadable":
      return { reason: "Couldn’t read the source", retry: "import" };
    case "busy":
      return { reason: `${agent} is working on this plan`, retry: "import" };
    case "in_progress":
      return { reason: "The session is still going", retry: "rescan" };
    case "unknown":
    case "not_qualified":
      return { reason: "The source changed since the scan", retry: "rescan" };
    case "filtered":
      return { reason: "It couldn’t be imported safely", retry: "import" };
    default:
      return { reason: "Something went wrong", retry: "import" };
  }
}

/** The meta segments of a row at rest (#140, #151): source · subfolder · branch · date · count. */
/**
 * A meta segment that may go when the line runs past 2 (review-pr21 #2, #151): the branch first, then
 * "in <subfolder>", then a plan file's path. The source, date and count always stay.
 */
function Drop({ p, children }: { p: 1 | 2 | 3; children: React.ReactNode }) {
  return <>{children}</>;
}

function restMeta(r: FoundRow, branch: string | undefined) {
  const segs: React.ReactNode[] = [sourceLabel(r.app, r.kind)];
  if (r.app === "file" && r.relPath) segs.push(<Drop p={3}>{r.relPath}</Drop>);
  if (r.subfolder) segs.push(<Drop p={2}>in {r.subfolder}</Drop>);
  if (r.branch && r.branch !== branch)
    segs.push(
      <Drop p={1}>
        <IBranch s={12} />
        {r.branch}
      </Drop>,
    );
  segs.push(r.status === "in_progress" ? ago(r.date) : day(r.date));
  if (r.kind === "plan") segs.push(plural(r.decisions, "decision"));
  else if (r.importable === "agent") segs.push(`${plural(r.answers ?? 0, "answer")} to turn into decisions`);
  else segs.push(`${r.questions} ${r.questions === 1 ? "question" : "questions"} answered`);
  return segs;
}

function Meta({ segs }: { segs: React.ReactNode[] }) {
  return (
    <span className="meta">
      {segs.map((x, i) => (
        <span className="sg" key={i} data-drop={isValidElement<{ p: number }>(x) && x.type === Drop ? x.props.p : undefined}>
          {x}
        </span>
      ))}
    </span>
  );
}

/** Every row's meta fits in 2 lines: drop the lowest-priority segments until it does (never the count). */
function fitMeta(root: HTMLElement | null) {
  if (!root) return;
  for (const m of root.querySelectorAll<HTMLElement>(".frow .meta")) {
    const drops = [...m.querySelectorAll<HTMLElement>(":scope > [data-drop]")].sort((a, b) => Number(a.dataset.drop) - Number(b.dataset.drop));
    for (const d of drops) d.hidden = false;
    for (const d of drops) {
      if (m.scrollHeight <= 33) break;
      d.hidden = true;
    }
  }
}

function ImportButton({ label, phase, onClick }: { label: "Import" | "Update"; phase: "a" | "b" | "c"; onClick: () => void }) {
  const busyText = label === "Update" ? "Updating…" : "Importing…";
  const doneText = label === "Update" ? "Updated" : "Imported";
  return (
    <button
      type="button"
      className="btn soft sm imp"
      data-l={phase}
      data-testid="found-import"
      aria-disabled={phase !== "a" ? true : undefined}
      onClick={() => phase === "a" && onClick()}
    >
      <span className="a" aria-hidden={phase !== "a"}>
        {label}
      </span>
      <span className="b" aria-hidden={phase !== "b"}>
        {busyText}
      </span>
      <span className="c" aria-hidden={phase !== "c"}>
        <ICheck s={14} />
        {doneText}
      </span>
    </button>
  );
}

export interface FoundHandoff {
  /** A new plan exists but its row still says "✓ Imported": Recent holds it back until the row leaves. */
  onImported?: (planId: string) => void;
  /** The row has left Found: Recent shows the plan now (focus moves there when it was on the row). */
  onSettled?: (planId: string, o: { focus: boolean; update: boolean }) => void;
}

export function Found({ agent, initial, onOpen, onImported, onSettled }: { agent: string; initial?: FoundView; onOpen: (id: string) => void } & FoundHandoff) {
  // The first app state carries the view (review-pr21 #1), so the group's space is right from the
  // first paint; /api/found and "found" events only refresh it.
  const [view, setView] = useState<FoundView | null>(initial ?? null);
  const [phases, setPhases] = useState<Record<string, Phase>>({});
  const [expanded, setExpanded] = useState(false);
  const [live, setLive] = useState("");
  const [looking, setLooking] = useState(false);
  const mount = useRef<HTMLDivElement>(null);
  const timers = useRef<number[]>([]);
  const focusAfter = useRef<string | null>(null);
  const stopped = useRef(new Set<string>());
  const announced = useRef<string>("");
  /** Row tops and the group's height just before a row leaves, so what's left can slide into place (FLIP). */
  const flip = useRef<{ tops: Map<string, number>; height: number } | null>(null);

  const load = useCallback(async () => {
    try {
      setView(await api.found());
    } catch {
      // A scan that fails shows nothing; it never stops Home.
    }
  }, []);
  useEffect(() => {
    void load();
    foundListeners.add(load);
    const t = timers.current;
    return () => {
      foundListeners.delete(load);
      for (const x of t) clearTimeout(x);
    };
  }, [load]);

  const on = view && view.enabled && !view.hidden ? view : null;
  const scanning = !!on && (on.state === "scanning" || on.state === "idle");
  const rows = (on?.rows ?? []).filter((r) => r.status !== "imported" || phases[r.id]);
  const skeleton = !!on && scanning && !on.cached && rows.length === 0;
  const empty = !!on && !scanning && rows.length === 0;
  const name = on?.project?.name ?? "this project";
  const branch = on?.project?.branch ?? on?.project?.sha;
  const shape = !on ? "none" : skeleton ? "skeleton" : empty ? "empty" : "rows";

  // One polite live region (a11y recap): the scan's result, then each import's.
  useEffect(() => {
    if (!on || scanning) return;
    const key = `${on.scannedAt}|${rows.length}`;
    if (announced.current === key) return;
    announced.current = key;
    setLive(rows.length ? `Found ${plural(rows.length, "plan")} in ${name}` : `No plans found in ${name}`);
  }, [on, scanning, rows.length, name]);
  useEffect(() => {
    if (!scanning) setLooking(false);
  }, [scanning]);

  // §7 height (0–2 results): the group eases from the skeleton's height to its own; Recent moves once.
  const lastShape = useRef(shape);
  const lastHeight = useRef(0);
  useLayoutEffect(() => {
    const el = mount.current;
    const from = lastHeight.current;
    const was = lastShape.current;
    lastShape.current = shape;
    lastHeight.current = el?.offsetHeight ?? 0;
    if (!el || was !== "skeleton" || shape === "skeleton") return;
    // Entrance (#135): each row fades in 160ms, 30ms apart; the bottom line comes with row 3.
    if (!kbd()) {
      const items = [...el.querySelectorAll<HTMLElement>(".found ul > li")].slice(0, FIRST);
      items.forEach((li, i) => li.animate([{ opacity: 0 }, { opacity: 1 }], { duration: 160, delay: 30 * i, easing: EASE, fill: "backwards" }));
      el.querySelector<HTMLElement>(".slot")?.animate([{ opacity: 0 }, { opacity: 1 }], { duration: 160, delay: 60, easing: EASE, fill: "backwards" });
    }
    const to = el.offsetHeight;
    if (kbd() || reduced() || !from || from === to) return;
    el.style.overflow = "hidden";
    const a = el.animate([{ height: `${from}px` }, { height: `${to}px` }], { duration: 220, easing: EASE });
    a.onfinish = a.oncancel = () => {
      el.style.overflow = "";
    };
  });
  useLayoutEffect(() => {
    fitMeta(mount.current);
    if (mount.current) lastHeight.current = mount.current.offsetHeight;
  });
  useEffect(() => {
    const el = mount.current;
    if (!el || typeof ResizeObserver === "undefined") return;
    let w = el.offsetWidth;
    const ro = new ResizeObserver(() => {
      if (el.offsetWidth === w) return;
      w = el.offsetWidth;
      fitMeta(el);
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, [view !== null]);
  // A row left (PO, #21): the rows below slide up into its place (220ms ease-out), a row brought in
  // from "Show n more" fades in, and the group eases to its new height, so Recent moves once, calmly.
  // Reduced motion: no movement, the newcomer only fades. data-kbd: everything is instant.
  useLayoutEffect(() => {
    const f = flip.current;
    const el = mount.current;
    if (!f || !el) return;
    flip.current = null;
    if (kbd()) return;
    const still = reduced();
    for (const li of el.querySelectorAll<HTMLElement>(".found ul > li[data-row]")) {
      const was = f.tops.get(li.dataset.row!);
      if (was === undefined) li.animate([{ opacity: 0 }, { opacity: 1 }], { duration: 160, delay: still ? 0 : 60, easing: EASE, fill: "backwards" });
      else if (!still && was !== li.offsetTop) li.animate([{ transform: `translateY(${was - li.offsetTop}px)` }, { transform: "none" }], { duration: 220, easing: EASE });
    }
    const to = el.offsetHeight;
    if (still || f.height === to) return;
    el.style.overflow = "hidden";
    const a = el.animate([{ height: `${f.height}px` }, { height: `${to}px` }], { duration: 220, easing: EASE });
    a.onfinish = a.oncancel = () => {
      el.style.overflow = "";
    };
  }, [phases]);

  // Focus follows the row through its import (#142), and onto the first new row after Show more.
  useLayoutEffect(() => {
    const id = focusAfter.current;
    if (!id || !mount.current) return;
    const li = mount.current.querySelector<HTMLElement>(`[data-row="${CSS.escape(id)}"]`);
    if (!li) return;
    // A row still showing Stop isn't settled yet: wait for its Import.
    if (li.querySelector("[data-stop]")) return;
    focusAfter.current = null;
    const target = li.querySelector<HTMLElement>("a, button") ?? li;
    target.focus();
  });

  const set = (id: string, p: Phase | null) =>
    setPhases((cur) => {
      const next = { ...cur };
      if (p) next[id] = p;
      else delete next[id];
      return next;
    });

  const doImport = async (r: FoundRow) => {
    const update = r.status === "changed";
    set(r.id, { p: "busy", update });
    try {
      const res = await api.foundImport(r.id);
      set(r.id, { p: "done", update, planId: res.planId });
      if (!update) onImported?.(res.planId);
      setLive(`${update ? "Updated" : "Imported"} ‘${titleOf(r)}’`);
      timers.current.push(
        window.setTimeout(() => {
          // After the hold the row leaves Found: it fades out in place (160ms), then is gone and the
          // plan shows in Recent only. Under data-kbd it goes at once.
          const li = mount.current?.querySelector<HTMLElement>(`[data-row="${CSS.escape(r.id)}"]`);
          const focus = !!li && (li.contains(document.activeElement) || document.activeElement === document.body);
          set(r.id, { p: "leaving", update, planId: res.planId });
          const gone = () => {
            const el = mount.current;
            if (el) flip.current = { tops: new Map([...el.querySelectorAll<HTMLElement>(".found ul > li[data-row]")].map((x) => [x.dataset.row!, x.offsetTop])), height: el.offsetHeight };
            set(r.id, null);
            onSettled?.(res.planId, { focus, update });
          };
          if (!li || kbd()) return gone();
          const a = li.animate([{ opacity: 1 }, { opacity: 0 }], { duration: 160, easing: EASE, fill: "forwards" });
          a.onfinish = gone;
          a.oncancel = gone;
        }, HOLD_MS),
      );
    } catch (err) {
      if (err instanceof ApiError && err.data.code === "stopped") {
        // Stopped: back to New, with focus on its Import (the Stop button it was on is gone).
        if (stopped.current.delete(r.id)) focusAfter.current = r.id;
        return set(r.id, null);
      }
      set(r.id, { p: "failed", ...importReason(err, agent) });
      setLive(`Couldn’t import ‘${titleOf(r)}’`);
    }
  };
  const lookAgain = async () => {
    setLooking(true);
    setPhases((cur) => Object.fromEntries(Object.entries(cur).filter(([, p]) => p.p !== "failed")));
    try {
      setView(await api.foundRescan());
    } finally {
      setLooking(false);
    }
  };
  const stop = async (id: string) => {
    const li = mount.current?.querySelector(`[data-row="${CSS.escape(id)}"]`);
    if (li?.contains(document.activeElement)) stopped.current.add(id);
    try {
      setView(await api.foundStop(id));
    } catch {
      // the row stays as it is
    }
  };

  if (!on) return null;
  const visible = expanded ? rows : rows.slice(0, FIRST);
  const more = rows.length - visible.length;
  const busyHead = looking || (scanning && !on.cached);

  const row = (r: FoundRow) => {
    const ph = phases[r.id];
    const open = (planId: string) => (e: React.MouseEvent) => {
      e.preventDefault();
      onOpen(planId);
    };
    const agentRun = r.importable === "agent" && r.status !== "changed" ? r.importable : null;
    const running = on.agent.running === r.id;
    const waiting = on.agent.waiting.includes(r.id);
    const failedCode = on.agent.failed[r.id];
    const failed = ph?.p === "failed" ? ph : !ph && failedCode ? { reason: reasonText(reasonCode(failedCode), agent), retry: "import" as const } : null;
    let nm: React.ReactNode = titleOf(r);
    let segs = restMeta(r, branch);
    let act: React.ReactNode = null;
    if (failed) {
      segs = [<span className="er">Couldn’t import</span>, failed.reason, "Nothing was saved"];
      act = (
        <button type="button" className="btn quiet sm" onClick={() => (failed.retry === "rescan" ? void lookAgain() : void doImport(r))}>
          <IRetry s={14} />
          Try again
        </button>
      );
    } else if (agentRun && running) {
      segs = [
        <>
          <span className="dot" aria-hidden="true" />
          {agent} is turning {plural(r.answers ?? 0, "answer")} into decisions
        </>,
      ];
      act = (
        <button type="button" className="btn quiet sm" data-stop onClick={() => void stop(r.id)}>
          Stop
        </button>
      );
    } else if (agentRun && waiting) {
      act = <span className="txt">Waiting</span>;
    } else if (r.status === "error") {
      segs = [<span className="er">Couldn’t read this {r.kind === "plan" ? "plan" : "session"}</span>, ...restMeta(r, branch).slice(0, r.app === "file" ? 3 : 2)];
      act = (
        <button type="button" className="btn quiet sm" onClick={() => void lookAgain()}>
          <IRetry s={14} />
          Try again
        </button>
      );
    } else if (r.status === "in_progress") {
      act = <span className="txt">In progress</span>;
    } else if ((r.status === "changed" || (ph && ph.p !== "failed" && ph.update)) && r.planId) {
      const planId = r.planId;
      nm = (
        <a href={`/s/${planId}`} onClick={open(planId)}>
          {titleOf(r)}
        </a>
      );
      segs = [<span className="ch">Source changed</span>, ...segs];
      act = <ImportButton label="Update" phase={ph?.p === "busy" ? "b" : ph?.p === "done" || ph?.p === "leaving" ? "c" : "a"} onClick={() => void doImport(r)} />;
    } else {
      act = <ImportButton label="Import" phase={ph?.p === "busy" ? "b" : ph?.p === "done" || ph?.p === "leaving" ? "c" : "a"} onClick={() => void doImport(r)} />;
    }
    return (
      <div className="frow">
        <span className="tt">
          <span className="nm">{nm}</span>
          <Meta segs={segs} />
        </span>
        <span className="act">{act}</span>
      </div>
    );
  };

  const liveRegion = (
    <span className="sr-only" role="status" aria-live="polite" data-testid="found-live">
      {live}
    </span>
  );

  if (empty)
    return (
      <div className="fmount e" ref={mount} data-testid="found">
        <p className="fempty">
          <span>No plans found in {name}</span>
          <span aria-hidden="true">·</span>
          <button type="button" className="lnk" onClick={() => void lookAgain()} aria-disabled={looking || undefined}>
            {looking ? "Looking…" : "Look again"}
          </button>
          <button type="button" className="icon-btn x" aria-label="Hide for this project" onClick={() => void api.foundDismiss(true).then(setView, () => {})}>
            <IX s={14} />
          </button>
        </p>
        {liveRegion}
      </div>
    );

  return (
    <div className="fmount" ref={mount} data-testid="found">
      <section className="found" aria-labelledby="found-title" aria-busy={skeleton || undefined}>
        <div className="fh">
          <h2 id="found-title">Found in this project</h2>
          {on.project ? (
            <span className="proj">
              · <b>{on.project.name}</b>
              {branch ? (
                <>
                  <IBranch s={12} />
                  {branch}
                </>
              ) : null}
            </span>
          ) : null}
          <span className="sp" />
          {busyHead ? (
            <span className="busy">Looking for plans…</span>
          ) : on.partial ? null : (
            <button type="button" className="btn quiet sm look" onClick={() => void lookAgain()}>
              Look again
            </button>
          )}
        </div>
        <ul>
          {skeleton
            ? [0, 1, 2].map((i) => (
                <li key={i} aria-hidden="true">
                  <div className="frow">
                    <span className="tt skt">
                      <span className="sk" style={{ width: `${[46, 34, 40][i]}%` }} />
                      <span className="sk" style={{ width: `${[30, 38, 26][i]}%`, height: 10 }} />
                    </span>
                  </div>
                </li>
              ))
            : visible.map((r) => (
                <li key={r.id} data-row={r.id} tabIndex={-1} data-testid="found-row">
                  {row(r)}
                </li>
              ))}
        </ul>
        {skeleton || (more === 0 && !on.partial) ? (
          skeleton || (rows.length && !expanded) ? <div className="slot" /> : null
        ) : (
          <div className="slot">
            {more > 0 ? (
              <button
                type="button"
                className="more"
                onClick={() => {
                  focusAfter.current = rows[FIRST]?.id ?? null;
                  setExpanded(true);
                }}
              >
                Show {more} more
              </button>
            ) : null}
            {on.partial ? (
              <>
                {more > 0 ? <span aria-hidden="true">·</span> : null}
                <span>Showing what we found in 1.5 s</span>
                <span aria-hidden="true">·</span>
                {busyHead ? (
                  <span>Looking…</span>
                ) : (
                  <button type="button" className="lnk" onClick={() => void lookAgain()}>
                    Look again
                  </button>
                )}
              </>
            ) : null}
          </div>
        )}
      </section>
      {liveRegion}
    </div>
  );
}
