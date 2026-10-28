// "Send to issues" sheet (v1.3 item 2, handoff §2–§7): destination, labels, the item preview, the
// approval card, then progress and the run summary. Everything before the confirm only reads (#180);
// the one write is the confirm (export) or Retry failed. The live run comes in on the session (SSE).
//
// Styling hooks (styles/issues.css): .ish .ischrim .ish-h .ish-b .ish-d .isw .ifl .isel .ichips .ichip
//   .ilist .ifix .ikey .ierr .iconn .ipv .ipl .ir(.par,.gone) .icb .ir-ti/.ir-tt .ir-meta .ist[data-k]
//   .ir-why .ir-body .ish-f .iac[data-k] .iac-t .iac-n .iac-b
import { type ReactNode, useCallback, useEffect, useId, useMemo, useRef, useState } from "react";
import { ApiError, type DestBody, type GhStatus, type IssuesState, type LinearView, type Preview, type RepoInfo, issuesApi } from "../api";
import { CopyButton } from "../CopyButton";
import { IAlert, ICheck, IChev, ICircleAlert, IExt, IGlobe, IKey, ILock, IPlus, IRetry, IX } from "../icons";
import type { ExportRun, IssueItem, Planned, SessionView, Tracker } from "../types";
import { ICOPY, TNAME, labelsLine, plural } from "./copy";
import { ListBox, type Opt, Select } from "./Pick";

/**
 * BIG-3, whether the split runs by itself: option B, "Split only when I ask" (DECISIONS #186; Victor chose B on
 * 2026-10-28). The sheet opens on one issue per user story (or the parent alone), and the agent runs only from
 * "Split with {agent}" (frame d-q-split-ask). `true` would be option A: split on open, once per plan version.
 */
const SPLIT_ON_OPEN = false;

const PARENT = "plan";
const REPO = /^[\w.-]+\/[\w.-]+$/;
const LINEAR_KEYS = "https://linear.app/settings/account/security";
const kbd = () => document.documentElement.hasAttribute("data-kbd");
const isMac = () => /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent);
const isWin = () => /Win/.test(navigator.platform || navigator.userAgent);

type Err = { code: string; message: string; help?: string };
/** The last confirmed body per session, so "Try again" after a failed parent sends exactly that again. */
const lastSent = new Map<string, Parameters<typeof issuesApi.export>[1]>();
const errOf = (e: unknown): Err => (e instanceof ApiError ? { code: String(e.data.code ?? ""), message: e.message, help: e.data.help as string | undefined } : { code: "failed", message: String((e as Error)?.message ?? e) });

export function IssuesSheet(p: {
  session: SessionView;
  agentName: string;
  phone: boolean;
  /** Decision key → "R1·2" (the plan's own ids). */
  idOf: (key: string) => string;
  onClose: () => void;
}) {
  const s = p.session;
  const titleId = useId();
  const sheet = useRef<HTMLDivElement>(null);
  const live = s.issuesRun;
  const [showRun, setShowRun] = useState(live?.state === "running");
  // The run this sheet just started, until the session's own copy catches up (never the previous run's result).
  const [started, setStarted] = useState<ExportRun | null>(null);
  const run = !showRun ? undefined : started && !(live && live.startedAt >= started.startedAt) ? started : live;

  // ---------------------------------------------------------------- destination
  const [st, setSt] = useState<IssuesState | null>(null);
  const [tracker, setTracker] = useState<Tracker>(live?.state === "running" ? live.tracker : (s.issues?.tracker ?? "github"));
  const [why, setWhy] = useState<string | undefined>();
  const [gh, setGh] = useState<GhStatus | null>(null);
  const [checking, setChecking] = useState(false);
  const [repo, setRepo] = useState("");
  const [host, setHost] = useState("github.com");
  const [info, setInfo] = useState<RepoInfo | null>(null);
  const [repos, setRepos] = useState<string[] | null>(null);
  const [lin, setLin] = useState<LinearView>({ connected: false });
  const [teams, setTeams] = useState<{ id: string; name: string }[] | null>(null);
  const [team, setTeam] = useState<{ id: string; name: string } | null>(null);
  const [projects, setProjects] = useState<{ id: string; name: string }[] | null>(null);
  const [project, setProject] = useState<{ id: string; name: string } | null>(null);
  const [labels, setLabels] = useState<string[]>([]);
  const [newLabels, setNewLabels] = useState<string[]>([]);
  const [known, setKnown] = useState<Opt[] | null>(null);
  const [openList, setOpenList] = useState<"" | "repo" | "label" | "team" | "project">("");
  const [key, setKey] = useState("");
  const [keyErr, setKeyErr] = useState<Err | null>(null);
  const [connecting, setConnecting] = useState(false);
  const [askDisc, setAskDisc] = useState(false);

  useEffect(() => {
    let off = false;
    void issuesApi.state(s.id).then((x) => {
      if (off) return;
      setSt(x);
      setLin(x.linear);
      if (!(live?.state === "running")) {
        setTracker(x.destination.tracker);
        setWhy(x.destination.why);
      }
      const linked = x.issues;
      const origin = x.github.origin && /github/.test(x.github.origin.host) ? x.github.origin : undefined;
      const r = linked?.tracker === "github" ? linked.target : (origin?.repo ?? "");
      setRepo(r);
      setHost(linked?.tracker === "github" ? (linked.host ?? "github.com") : x.github.host);
      if (linked?.tracker === "linear") setTeam({ id: linked.target, name: linked.targetName ?? linked.target });
    });
    return () => {
      off = true;
    };
  }, [s.id]);

  // gh: status for the host; the repo's access and visibility once one is picked.
  const checkGh = useCallback(async () => {
    setChecking(true);
    try {
      setGh(await issuesApi.ghStatus(host));
    } catch {
      setGh({ state: "missing" });
    } finally {
      setChecking(false);
    }
  }, [host]);
  useEffect(() => {
    if (st && tracker === "github") void checkGh();
  }, [st, tracker, checkGh]);
  useEffect(() => {
    setInfo(null);
    if (tracker !== "github" || gh?.state !== "ready" || !REPO.test(repo)) return;
    let off = false;
    void issuesApi
      .ghRepo(repo, host)
      .then((x) => !off && setInfo(x))
      .catch(() => !off && setInfo({ repo, visibility: "private", access: false }));
    return () => {
      off = true;
    };
  }, [tracker, gh?.state, repo, host]);
  useEffect(() => {
    if (info && !info.access) setOpenList("repo");
  }, [info]);

  // Linear: teams once connected; projects per team.
  useEffect(() => {
    if (tracker !== "linear" || !lin.connected || teams) return;
    void issuesApi
      .linearTeams()
      .then((x) => {
        setTeams(x.teams);
        setTeam((t) => (t && x.teams.some((y) => y.id === t.id) ? (x.teams.find((y) => y.id === t.id) ?? t) : (x.teams[0] ?? null)));
      })
      .catch((e) => {
        if (errOf(e).code === "bad_key") setLin({ connected: false });
      });
  }, [tracker, lin.connected, teams]);
  useEffect(() => {
    setProjects(null);
    if (tracker !== "linear" || !team || !lin.connected) return;
    let off = false;
    void issuesApi.linearProjects(team.id).then((x) => {
      if (off) return;
      setProjects(x.projects);
      const want = s.issues?.tracker === "linear" && s.issues.target === team.id ? s.issues.projectId : undefined;
      setProject(x.projects.find((y) => y.id === want) ?? null);
    });
    return () => {
      off = true;
    };
  }, [tracker, team?.id, lin.connected]);

  // Labels (#177): the ones last used on this target; empty the first time.
  const target = tracker === "github" ? repo : (team?.id ?? "");
  useEffect(() => {
    if (!st) return;
    setLabels(st.labels[`${tracker}:${target}`] ?? []);
    setNewLabels([]);
    setKnown(null);
  }, [st, tracker, target]);
  const loadKnown = () => {
    if (known) return;
    if (tracker === "github") void issuesApi.ghLabels(repo, host).then((x) => setKnown(x.labels.map((l) => ({ value: l.name, label: l.name, color: l.color, meta: "in repo" })))).catch(() => setKnown([]));
    else if (team) void issuesApi.linearLabels(team.id).then((x) => setKnown(x.labels.map((l) => ({ value: l.id, label: l.name, color: l.color })))).catch(() => setKnown([]));
  };
  useEffect(() => {
    // Linear chips show names, so its labels load with the team.
    if (tracker === "linear" && team && lin.connected && labels.length) loadKnown();
  }, [tracker, team?.id, lin.connected, labels.length]);
  const labelName = (v: string) => known?.find((o) => o.value === v)?.label ?? (tracker === "linear" ? "" : v);

  // ---------------------------------------------------------------- preview
  const [pv, setPv] = useState<Preview | null>(null);
  const [splitting, setSplitting] = useState(false);
  const [splitFailed, setSplitFailed] = useState(false);
  const [askSplit, setAskSplit] = useState(false);
  const [titles, setTitles] = useState<Record<string, string>>({});
  const [sel, setSel] = useState<Set<string>>(new Set());
  const [over, setOver] = useState<Set<string>>(new Set());
  const [bodies, setBodies] = useState<Set<string>>(new Set());
  const [err, setErr] = useState<Err | null>(null);
  const [sending, setSending] = useState(false);

  const dest = (): DestBody =>
    tracker === "github"
      ? { tracker, repo, host, labels }
      : { tracker, team: team?.id, teamName: team?.name, project: project?.id, labels };
  const destKey = `${tracker}|${repo}|${host}|${team?.id ?? ""}|${project?.id ?? ""}|${lin.connected}|${gh?.state ?? ""}`;
  const adopt = useCallback((x: Preview, keepTitles = false) => {
    setPv(x);
    setTitles((t) => (keepTitles ? { ...Object.fromEntries(x.items.map((it) => [it.key, it.title])), ...t } : Object.fromEntries(x.items.map((it) => [it.key, it.title]))));
    setSel(new Set(x.changes.filter((c) => c.change === "new" || c.change === "update" || c.change === "missing").map((c) => c.key)));
    setOver(new Set());
  }, []);
  useEffect(() => {
    if (!st) return;
    let off = false;
    void issuesApi
      .preview(s.id, dest())
      .then((x) => !off && adopt(x, true))
      .catch((e) => !off && setErr(errOf(e)));
    return () => {
      off = true;
    };
  }, [st, destKey]);

  // Starting a split, asking first, or taking the way out removes the control that had focus: hand focus on
  // to what replaces it (the way out while it splits, Split while it asks, then "Split with {agent}",
  // Split again or Try again, else the destination tab).
  const askBtn = useRef<HTMLButtonElement>(null);
  const wayBtn = useRef<HTMLButtonElement>(null);
  const srcBtn = useRef<HTMLButtonElement>(null);
  const yesBtn = useRef<HTMLButtonElement>(null);
  const [refocus, setRefocus] = useState<"way" | "ask" | "after" | null>(null);
  useEffect(() => {
    if (!refocus) return;
    setRefocus(null);
    const a = document.activeElement;
    // (the #179 effect may have parked it on the destination tab meanwhile)
    if (a && a !== document.body && a !== sheet.current && !a.closest("[role=tablist]")) return;
    (refocus === "way" ? wayBtn.current : refocus === "ask" ? yesBtn.current : (askBtn.current ?? srcBtn.current ?? firstFocus.current))?.focus({ preventScroll: true });
  }, [refocus]);
  const split = async (fallback = false) => {
    // The way out removes the link that had focus: give it back to something visible once the list is back.
    const back = !!sheet.current?.contains(document.activeElement) && document.activeElement !== sheet.current;
    if (back) setRefocus(fallback ? "after" : "way");
    setAskSplit(false);
    setSplitFailed(false);
    setSplitting(!fallback);
    try {
      const x = await issuesApi.split(s.id, tracker, fallback);
      if (x.stopped) return;
      setSplitFailed(!!x.failed);
      // The split's items, checked against the tracker again.
      adopt(await issuesApi.preview(s.id, { ...dest(), titles: undefined }));
    } catch (e) {
      setErr(errOf(e));
    } finally {
      setSplitting(false);
      if (back) setRefocus("after");
    }
  };

  const autoSplit = useRef(SPLIT_ON_OPEN);
  useEffect(() => {
    if (!autoSplit.current || !pv || !st || run) return;
    autoSplit.current = false;
    // Once exported, the issues' split stays until "Split again" (the agent would re-key them).
    if (!st.split && !st.issues && pv.source !== "agent" && pv.source !== "todos") void split();
  }, [pv, st]);

  const items = pv?.items ?? [];
  const change = useMemo(() => new Map((pv?.changes ?? []).map((c) => [c.key, c])), [pv]);
  const linked = (pv?.changes ?? []).some((c) => c.link);
  const kids = items.filter((it) => it.key !== PARENT);
  const selectable = (k: string) => {
    const c = change.get(k)?.change;
    return c === "new" || c === "update" || c === "missing" || c === "edited";
  };
  const chosen = (k: string) => sel.has(k) && (change.get(k)?.change !== "edited" || over.has(k));
  const anyKid = kids.some((it) => chosen(it.key));
  // The parent is locked on while any child is chosen (only when the parent itself would be sent).
  const parentLocked = anyKid && selectable(PARENT) && change.get(PARENT)?.change !== "edited";
  const isChosen = (k: string) => (k === PARENT && parentLocked) || chosen(k);
  const toggle = (k: string) => {
    if (k === PARENT && parentLocked) return;
    const c = change.get(k)?.change;
    if (c === "edited") {
      setOver((o) => {
        const n = new Set(o);
        if (n.has(k)) n.delete(k);
        else n.add(k);
        return n;
      });
      setSel((x) => new Set(x).add(k));
      return;
    }
    setSel((x) => {
      const n = new Set(x);
      if (n.has(k)) n.delete(k);
      else n.add(k);
      return n;
    });
  };

  // ---------------------------------------------------------------- the card
  const T = TNAME[tracker];
  const destName = tracker === "github" ? repo : team ? `Linear · Team ${team.name}` : "Linear";
  const count = items.filter((it) => isChosen(it.key)).length;
  const cnt = (c: Planned["change"], pick = true) => items.filter((it) => change.get(it.key)?.change === c && (!pick || isChosen(it.key))).length;
  const nNew = cnt("new");
  const nUpd = cnt("update");
  const nOver = cnt("edited");
  const nSkip = items.filter((it) => change.get(it.key)?.change === "edited" && !isChosen(it.key)).length;
  const nMiss = cnt("missing");
  const nSame = cnt("unchanged", false);

  const ghBlock = tracker === "github" && gh ? (gh.state === "missing" ? "missing" : gh.state === "auth" ? "auth" : null) : null;
  let blocked: string | null = null;
  if (splitting) blocked = ICOPY.blocked.split;
  else if (tracker === "github") {
    if (ghBlock) blocked = ICOPY.blocked[ghBlock];
    else if (!REPO.test(repo)) blocked = ICOPY.blocked.repo;
    else if (info && !info.access) blocked = ICOPY.blocked.access;
  } else if (!lin.connected) blocked = ICOPY.blocked.linear;
  else if (!team) blocked = ICOPY.blocked.team;
  if (!blocked && pv && !count) blocked = linked ? null : ICOPY.blocked.none;
  const ready = !!pv && !!st && !blocked && count > 0 && (tracker === "linear" || gh?.state === "ready") && !sending;
  const where = destName ? ` in ${destName}` : "";
  let button: string;
  if (linked) {
    const made = nNew + nMiss;
    const upd = nUpd + nOver;
    if (!made && !upd) button = ICOPY.nothing;
    else if (nMiss && !nNew && !upd) button = `Recreate ${plural(nMiss, "issue")}${where}`;
    else if (made && upd) button = `Create ${made} and update ${upd}${where}`;
    else if (upd) button = `Update ${plural(upd, "issue")}${where}`;
    else button = `Create ${plural(made, "issue")}${where}`;
  } else button = `Create ${plural(count || items.length, "issue")}${blocked && !REPO.test(repo) && tracker === "github" ? "" : where}`;
  const labelNames = labels.map(labelName).filter(Boolean);
  let what: string;
  if (linked) {
    const parts = [nNew ? `${nNew} new` : "", nUpd + nOver ? `${plural(nUpd + nOver, "update")}${nOver ? ` (${nOver} overwrite${nOver === 1 ? "s" : ""} edits made in ${T})` : ""}` : "", nMiss ? `${nMiss} recreated` : "", nSkip ? `${nSkip} edited in ${T}, skipped` : "", nSame ? `${nSame} unchanged` : ""];
    what = parts.filter(Boolean).join(" · ");
  } else {
    const k = kids.filter((it) => isChosen(it.key)).length;
    what = isChosen(PARENT) && k ? `1 parent and ${plural(k, "sub-issue")}` : "Only the parent issue";
  }
  const extras = [tracker === "linear" && project ? `project ${project.name}` : "", labelsLine(labelNames), newLabels.length ? `also creates the ${newLabels.length === 1 ? "label" : "labels"} ${newLabels.join(", ")}` : ""].filter(Boolean);
  if (extras.length && (!linked || what)) what = [what, ...extras].join(" · ");
  const how = tracker === "github" ? (gh?.state === "ready" ? ICOPY.howGh(gh.user) : "") : ICOPY.howLinear;
  const pub = tracker === "github" && info?.visibility.toLowerCase() === "public";

  const confirm = async () => {
    if (!ready) return;
    setErr(null);
    setSending(true);
    try {
      const sentTitles = Object.fromEntries(items.map((it) => [it.key, (titles[it.key] ?? it.title).trim() || it.title]));
      const body = { ...dest(), titles: sentTitles, selected: items.filter((it) => isChosen(it.key)).map((it) => it.key), overwrite: [...over], newLabels };
      setStarted((await issuesApi.export(s.id, body)).run);
      lastSent.set(s.id, body);
      setShowRun(true);
    } catch (e) {
      const x = errOf(e);
      setErr(x);
      if (x.code === "missing" || x.code === "auth") void checkGh();
      if (x.code === "bad_key") setLin({ connected: false });
    } finally {
      setSending(false);
    }
  };
  const retry = async (again = false) => {
    setErr(null);
    try {
      const body = lastSent.get(s.id);
      setStarted((again && body ? await issuesApi.export(s.id, body) : await issuesApi.retry(s.id)).run);
      setShowRun(true);
    } catch (e) {
      setErr(errOf(e));
    }
  };

  // ---------------------------------------------------------------- run
  const rowOf = (k: string) => run?.rows.find((r) => r.key === k);
  const done = run?.rows.filter((r) => r.status !== "waiting" && r.status !== "creating" && r.status !== "updating").length ?? 0;
  const failed = run?.rows.filter((r) => r.status === "failed") ?? [];
  const parentFailed = run?.state === "done" && rowOf(PARENT)?.status === "failed";
  const created = run?.rows.filter((r) => r.status === "created").length ?? 0;
  const updated = run?.rows.filter((r) => r.status === "updated").length ?? 0;
  const parentUrl = rowOf(PARENT)?.url ?? s.issues?.parent?.url;
  const runT = run ? TNAME[run.tracker] : T;
  const sumText = [created ? `${created} created` : "", updated ? `${updated} updated` : "", !created && !updated ? "Up to date" : ""].filter(Boolean).join(", ");

  // Announcements (§5): "Created #143", "Failed: <title>", the summary once.
  const [say, setSay] = useState("");
  const said = useRef(new Set<string>());
  useEffect(() => {
    if (!run) return;
    for (const r of run.rows) {
      const id = `${run.startedAt}:${r.key}:${r.status}`;
      if (said.current.has(id)) continue;
      if (r.status === "created" || r.status === "updated") {
        said.current.add(id);
        setSay(`${r.status === "created" ? "Created" : "Updated"} ${r.identifier ?? `#${r.number}`}`);
      } else if (r.status === "failed") {
        said.current.add(id);
        setSay(`Failed: ${titles[r.key] ?? items.find((it) => it.key === r.key)?.title ?? ""}`);
      }
    }
    const id = `${run.startedAt}:done`;
    if (run.state === "done" && !said.current.has(id)) {
      said.current.add(id);
      setSay(parentFailed ? `Couldn’t create the parent issue` : failed.length ? `${sumText} · ${failed.length} failed` : `${sumText} · ${run.name}`);
    }
  }, [run]);

  // The summary's primary takes focus (§9).
  const primary = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (run?.state === "done") requestAnimationFrame(() => primary.current?.focus({ preventScroll: true }));
  }, [run?.state, run?.startedAt]);

  // ---------------------------------------------------------------- shell: focus, keys, Copy Markdown
  // Closing fades out (160ms) before the sheet goes; keyboard mode closes at once.
  const [leaving, setLeaving] = useState(false);
  const leave = () => {
    if (leaving) return;
    if (kbd()) return p.onClose();
    setLeaving(true);
    setTimeout(p.onClose, 160);
  };
  const firstFocus = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    document.documentElement.classList.add("ish-open");
    requestAnimationFrame(() => (run?.state === "done" ? primary.current : firstFocus.current)?.focus({ preventScroll: true }));
    return () => document.documentElement.classList.remove("ish-open");
  }, []);
  // #179: the saved destination comes with the state, after the first focus; focus follows it while still on the switch.
  useEffect(() => {
    if (!st || run?.state === "done") return;
    requestAnimationFrame(() => {
      const a = document.activeElement;
      if (!a || a === document.body || a === sheet.current || a.closest("[role=tablist]")) firstFocus.current?.focus({ preventScroll: true });
    });
  }, [st]);
  const keys = (e: React.KeyboardEvent) => {
    if (e.key === "Escape") {
      e.preventDefault();
      if (openList) setOpenList("");
      else leave();
    } else if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
      e.preventDefault();
      if (!run) void confirm();
    } else if (e.key === "Tab") {
      // Modal: focus stays in the sheet.
      const f = [...(sheet.current?.querySelectorAll<HTMLElement>('button:not([disabled]),[href],input,textarea,[tabindex="0"]') ?? [])].filter((x) => x.offsetParent !== null);
      if (!f.length) return;
      const first = f[0];
      const last = f[f.length - 1];
      if (e.shiftKey && document.activeElement === first) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && document.activeElement === last) {
        e.preventDefault();
        first.focus();
      }
    }
  };
  // A link that goes away when used (Use … instead, Split again) drops focus to the page: the sheet still owns Esc and Tab.
  const keysRef = useRef(keys);
  keysRef.current = keys;
  useEffect(() => {
    const lost = (e: KeyboardEvent) => {
      if (e.target !== document.body || (e.key !== "Escape" && e.key !== "Tab")) return;
      if (e.key === "Tab") {
        e.preventDefault();
        sheet.current?.focus({ preventScroll: true });
      } else keysRef.current(e as unknown as React.KeyboardEvent);
    };
    document.addEventListener("keydown", lost);
    return () => document.removeEventListener("keydown", lost);
  }, []);
  // Phones: a swipe down on the grab or the header closes.
  const y0 = useRef<number | null>(null);
  const [dy, setDy] = useState(0);
  const swipe = p.phone
    ? {
        onTouchStart: (e: React.TouchEvent) => (y0.current = e.touches[0].clientY),
        onTouchMove: (e: React.TouchEvent) => y0.current !== null && setDy(Math.max(0, e.touches[0].clientY - y0.current)),
        onTouchEnd: () => {
          if (dy > 80) leave();
          y0.current = null;
          setDy(0);
        },
      }
    : {};

  // ---------------------------------------------------------------- parts
  const tabs: Tracker[] = ["github", "linear"];
  const switcher = (
    <div className="ifl">
      <div className="isw" role="tablist" aria-label="Destination" aria-describedby={why ? `${titleId}-why` : undefined}>
        {tabs.map((t, i) => (
          <button
            key={t}
            ref={t === tracker ? firstFocus : undefined}
            type="button"
            role="tab"
            aria-selected={t === tracker}
            tabIndex={t === tracker ? 0 : -1}
            disabled={!!run}
            onClick={() => {
              setTracker(t);
              setWhy(undefined);
              setErr(null);
              setOpenList("");
            }}
            onKeyDown={(e) => {
              if (e.key !== "ArrowLeft" && e.key !== "ArrowRight") return;
              e.preventDefault();
              const n = tabs[(i + 1) % 2];
              setTracker(n);
              setWhy(undefined);
              setErr(null);
              const el = e.currentTarget.parentElement?.children[(i + 1) % 2] as HTMLElement | undefined;
              el?.focus();
            }}
          >
            {TNAME[t]}
          </button>
        ))}
      </div>
      {why ? (
        <p className="ihn" id={`${titleId}-why`}>
          {ICOPY.why[why as "no-remote" | "no-gh"]}
        </p>
      ) : null}
    </div>
  );

  const fixIt = (kind: "missing" | "auth" | "host" | "access") => {
    const [head, body] =
      kind === "missing" ? ICOPY.fix.missing : kind === "access" ? ICOPY.fix.access(repo, gh?.state === "ready" ? gh.user : "you") : ICOPY.fix[kind](host);
    const cmds: [string, string][] =
      kind === "missing"
        ? isWin()
          ? [["Windows", "winget install GitHub.cli"], ["macOS", "brew install gh"]]
          : [["macOS", "brew install gh"], ["Windows", "winget install GitHub.cli"]]
        : kind === "access"
          ? []
          : [["", gh?.state === "auth" ? gh.command : host === "github.com" ? "gh auth login" : `gh auth login --hostname ${host}`]];
    return (
      <div className="ifix" role="status" data-k={kind}>
        <IAlert s={18} />
        <div className="ifix-m">
          <strong>{head}</strong>
          <span>{body}</span>
          {cmds.map(([os, cmd]) => (
            <div key={cmd} style={{ display: "contents" }}>
              {os ? <span className="ios">{os}</span> : null}
              <div className="well">
                <pre>{cmd}</pre>
                <CopyButton text={cmd} icon tone="quiet" className="sm" ariaLabel={`Copy ${cmd}`} />
              </div>
            </div>
          ))}
          {kind === "missing" ? (
            <span className="ifix-o">
              Other systems:{" "}
              <a className="lnk" href="https://cli.github.com" target="_blank" rel="noreferrer">
                cli.github.com <IExt s={12} />
              </a>
            </span>
          ) : null}
          {kind === "access" ? null : (
            <div className="ifix-a">
              <button type="button" className="btn soft sm" onClick={() => void checkGh()} disabled={checking}>
                {checking ? "Checking…" : "Check again"}
              </button>
            </div>
          )}
        </div>
      </div>
    );
  };

  const repoOpts = (): Opt[] => {
    const o: Opt[] = [];
    const origin = st?.github.origin && /github/.test(st.github.origin.host) ? st.github.origin.repo : undefined;
    const up = st?.github.upstream?.repo ?? info?.upstream;
    if (origin) o.push({ value: origin, label: origin, meta: "origin" });
    if (up && up !== origin) o.push({ value: up, label: up, meta: "upstream" });
    for (const r of repos ?? []) if (!o.some((x) => x.value === r)) o.push({ value: r, label: r });
    if (repo && !o.some((x) => x.value === repo)) o.unshift({ value: repo, label: repo });
    return o;
  };
  const fromWhere = () => {
    const origin = st?.github.origin?.repo === repo ? "origin" : st?.github.upstream?.repo === repo ? "upstream" : "";
    return [origin ? `From ${origin}` : "", host, pub ? "public" : "", gh?.state === "ready" ? `gh as @${gh.user}` : ""].filter(Boolean).join(" · ");
  };
  const repoField = (
    <Select
      id={`${titleId}-repo`}
      label="Repository"
      value={repo}
      placeholder="Pick a repository"
      open={openList === "repo"}
      setOpen={(v) => {
        setOpenList(v ? "repo" : "");
        if (v && !repos) void issuesApi.ghRepos(host).then((x) => setRepos(x.repos)).catch(() => setRepos([]));
      }}
      hint={info && !info.access ? null : <p className="ihn">{repo ? fromWhere() : ICOPY.repoHintNone}</p>}
      list={(close) => (
        <ListBox
          label="Repositories"
          search="Search, or type owner/repo"
          options={repoOpts()}
          selected={repo}
          loading={!repos}
          onCreate={(q) => (REPO.test(q) ? { value: q, label: `Use ${q}` } : null)}
          onPick={(o) => {
            setRepo(o.value);
            close(true);
          }}
          onClose={close}
        />
      )}
    />
  );

  const labelField = (
    <div className="ifl">
      <span className="ilb" id={`${titleId}-lab`}>
        Labels
      </span>
      <div className="ichips" role="group" aria-labelledby={`${titleId}-lab`}>
        {labels.map((l) => (
          <span key={l} className="ichip">
            {labelName(l) || "…"}
            {newLabels.includes(l) ? <span className="nw">new</span> : null}
            <button
              type="button"
              aria-label={`Remove ${labelName(l)}`}
              disabled={!!run}
              onClick={() => {
                setLabels((x) => x.filter((y) => y !== l));
                setNewLabels((x) => x.filter((y) => y !== l));
              }}
            >
              <IX s={14} />
            </button>
          </span>
        ))}
        <button
          type="button"
          className="ichip add"
          aria-haspopup="listbox"
          aria-expanded={openList === "label"}
          disabled={!!run || !target}
          onClick={() => {
            setOpenList(openList === "label" ? "" : "label");
            loadKnown();
          }}
        >
          <IPlus s={14} />
          Add label
        </button>
      </div>
      {openList === "label" ? (
        <ListBox
          label="Labels"
          search={tracker === "github" ? "Find or create a label" : "Find a label"}
          options={(known ?? []).filter((o) => !labels.includes(o.value))}
          loading={!known}
          onCreate={tracker === "github" ? (q) => (q.length <= 50 && !labels.includes(q) ? { value: q, label: `Create label “${q}”`, meta: "on confirm" } : null) : undefined}
          onPick={(o) => {
            setLabels((x) => [...x, o.value]);
            if (o.label.startsWith("Create label")) setNewLabels((x) => [...x, o.value]);
            setOpenList("");
            (sheet.current?.querySelector(".ichip.add") as HTMLElement | null)?.focus();
          }}
          onClose={(refocus) => {
            setOpenList("");
            if (refocus) (sheet.current?.querySelector(".ichip.add") as HTMLElement | null)?.focus();
          }}
        />
      ) : null}
    </div>
  );

  const connect = async () => {
    setConnecting(true);
    setKeyErr(null);
    try {
      const v = await issuesApi.linearConnect(key.trim());
      setLin(v);
      setKey("");
      setTeams(null);
    } catch (e) {
      setKeyErr(errOf(e));
    } finally {
      setConnecting(false);
    }
  };
  const linearDest = !lin.connected ? (
    <div className="ifl">
      <label className="ilb" htmlFor={`${titleId}-key`}>
        Linear API key
      </label>
      <form
        className="ikey"
        onSubmit={(e) => {
          e.preventDefault();
          if (key.trim()) void connect();
        }}
      >
        <input
          id={`${titleId}-key`}
          className={`in5${keyErr ? " bad" : ""}`}
          type="password"
          value={key}
          placeholder="lin_api_…"
          autoComplete="off"
          spellCheck={false}
          aria-describedby={`${titleId}-keyh`}
          aria-invalid={keyErr ? true : undefined}
          onChange={(e) => {
            setKey(e.target.value);
            setKeyErr(null);
          }}
        />
        <button type="submit" className="btn primary" disabled={!key.trim() || connecting}>
          {connecting ? "Connecting…" : "Connect"}
        </button>
      </form>
      {keyErr ? (
        <p className="ierr" id={`${titleId}-keyh`} role="alert">
          <ICircleAlert s={14} />
          {keyErr.code === "bad_key" ? ICOPY.badKey : `${TNAME.linear} said: ${keyErr.message}`}{" "}
          <a className="lnk" href={keyErr.help ?? LINEAR_KEYS} target="_blank" rel="noreferrer">
            Check it in Linear’s API key settings <IExt s={12} />
          </a>
        </p>
      ) : (
        <p className="ihn" id={`${titleId}-keyh`}>
          Make a personal key in{" "}
          <a className="lnk" href={LINEAR_KEYS} target="_blank" rel="noreferrer">
            Linear · Settings · Security &amp; access <IExt s={12} />
          </a>
          . {ICOPY.keyHint}
        </p>
      )}
    </div>
  ) : (
    <>
      {askDisc ? (
        <div className="iconn ask">
          <span>{ICOPY.disconnectAsk}</span>
          <span className="sp" />
          <button type="button" className="btn quiet sm" onClick={() => setAskDisc(false)} autoFocus>
            Keep
          </button>
          <button
            type="button"
            className="btn soft sm dz2"
            onClick={async () => {
              setLin(await issuesApi.linearDisconnect());
              setAskDisc(false);
              setTeams(null);
              setTeam(null);
            }}
          >
            Disconnect
          </button>
        </div>
      ) : (
        <div className="iconn">
          <IKey s={16} />
          <span>
            Connected as <b>{lin.name}</b>
            <span className="dt">·</span>
            <span className="mono-n">••••{lin.last4}</span>
          </span>
          <span className="sp" />
          <button type="button" className="btn quiet sm" onClick={() => setAskDisc(true)} disabled={!!run}>
            Disconnect
          </button>
        </div>
      )}
      <div className="igrid">
        <Select
          id={`${titleId}-team`}
          label="Team"
          value={team?.name}
          placeholder="Pick a team"
          open={openList === "team"}
          setOpen={(v) => setOpenList(v ? "team" : "")}
          list={(close) => (
            <ListBox
              label="Teams"
              options={(teams ?? []).map((t) => ({ value: t.id, label: t.name }))}
              selected={team?.id}
              loading={!teams}
              onPick={(o) => {
                setTeam({ id: o.value, name: o.label });
                close(true);
              }}
              onClose={close}
            />
          )}
        />
        <Select
          id={`${titleId}-proj`}
          label={
            <>
              Project <span className="opt">optional</span>
            </>
          }
          value={project?.name}
          placeholder="No project"
          open={openList === "project"}
          setOpen={(v) => setOpenList(v ? "project" : "")}
          list={(close) => (
            <ListBox
              label="Projects"
              options={[{ value: "", label: "No project" }, ...(projects ?? []).map((t) => ({ value: t.id, label: t.name }))]}
              selected={project?.id ?? ""}
              loading={!projects}
              onPick={(o) => {
                setProject(o.value ? { id: o.value, name: o.label } : null);
                close(true);
              }}
              onClose={close}
            />
          )}
        />
      </div>
      {labelField}
    </>
  );

  const ghFix = tracker === "github" && gh ? (gh.state === "missing" ? "missing" : gh.state === "auth" ? (host === "github.com" ? "auth" : "host") : info && !info.access ? "access" : null) : null;
  const destination =
    tracker === "github" ? (
      <>
        {ghFix ? fixIt(ghFix) : null}
        {ghFix && ghFix !== "access" ? null : (
          <>
            {repoField}
            {labelField}
          </>
        )}
      </>
    ) : (
      linearDest
    );

  // Where the list came from (§3), and the split link (BIG-3: SPLIT_ON_OPEN).
  const editedTitles = items.some((it) => (titles[it.key] ?? it.title) !== it.title);
  const inSheet = () => !!sheet.current?.contains(document.activeElement) && document.activeElement !== sheet.current;
  /** Split, but ask first when it would replace title edits. */
  const trySplit = () => {
    if (!editedTitles || askSplit) return void split();
    if (inSheet()) setRefocus("ask");
    setAskSplit(true);
  };
  const splitLink = (label: string) => (
    <button ref={srcBtn} type="button" className="lnk" onClick={trySplit}>
      {label}
    </button>
  );
  let source: ReactNode = null;
  if (!run && pv) {
    if (splitting)
      source = (
        <p className="ipv-src" role="status">
          {p.agentName} is splitting the plan into slices…<span className="dt">·</span>
          <button ref={wayBtn} type="button" className="lnk" onClick={() => void split(true)}>
            {pv.fallback === "none" ? "Use the parent issue alone" : pv.fallback === "todos" ? "Use the plan’s to-dos instead" : "Use the user stories instead"}
          </button>
        </p>
      );
    else if (askSplit)
      source = (
        <p className="ipv-src" role="status">
          {ICOPY.splitAsk(p.agentName, pv.source === "agent")}
          <span className="dt">·</span>
          <button ref={yesBtn} type="button" className="lnk" onClick={() => void split()}>
            {pv.source === "agent" ? "Split again" : "Split"}
          </button>
          <span className="dt">·</span>
          <button
            type="button"
            className="lnk"
            onClick={() => {
              if (inSheet()) setRefocus("after");
              setAskSplit(false);
            }}
          >
            Keep
          </button>
        </p>
      );
    else if (splitFailed)
      source = (
        <p className="ipv-src warn" role="status">
          <span className="iw1">
            <IAlert s={14} />
            Couldn’t
          </span>{" "}
          split with {p.agentName}, so it’s {pv.source === "stories" ? "one issue per user story" : pv.source === "todos" ? "one issue per to-do" : "the parent alone"}
          <span className="dt">·</span>
          {splitLink("Try again")}
        </p>
      );
    else if (pv.source === "agent")
      source = pv.stale ? (
        <>
          <p className="ipv-src">Split by {p.agentName} into {plural(kids.length, "slice")}</p>
          <p className="ipv-src stale" data-testid="split-stale">
            The plan changed since this split
            <span className="dt">·</span>
            {splitLink("Split again")}
          </p>
        </>
      ) : (
        <p className="ipv-src">
          Split by {p.agentName} into {plural(kids.length, "slice")}
          <span className="dt">·</span>
          {splitLink("Split again")}
        </p>
      );
    else
      source = (
        <div className="iask">
          <span>
            {pv.source === "todos" ? "Right now it’s one issue per to-do." : pv.source === "stories" ? "Right now it’s one issue per user story." : "Right now it’s only the parent issue."}{" "}
            {p.agentName} can split the plan into {pv.source === "none" ? "slices" : "thinner slices"} that each cover their decisions.
          </span>
          <button ref={askBtn} type="button" className="btn soft sm" onClick={trySplit}>
            Split with {p.agentName}
          </button>
        </div>
      );
  }

  const status = (it: IssueItem): ReactNode => {
    const r = rowOf(it.key);
    const c = change.get(it.key);
    const ref = (n?: number, id?: string) => id ?? (n !== undefined ? `#${n}` : "");
    if (r) {
      if (r.status === "waiting") return <span className="ist" data-k="wait">Waiting</span>;
      if (r.status === "creating" || r.status === "updating") return <span className="ist" data-k="run">{r.status === "creating" ? "Creating…" : "Updating…"}</span>;
      if (r.status === "failed")
        return (
          <span className="ist" data-k="fail">
            <ICircleAlert s={14} />
            Failed
          </span>
        );
      if (r.status === "skipped") return <span className="ist" data-k="wait">Not created</span>;
      if (r.status === "edited") return <span className="ist" data-k="wait">Edited in {runT} · skipped</span>;
      if (r.status === "unchanged") return <span className="ist" data-k="wait">Unchanged · {ref(r.number, r.identifier)}</span>;
      return (
        <a className="ist" data-k="ok" href={r.url} target="_blank" rel="noreferrer" aria-label={`${r.status === "created" ? "Created" : "Updated"} ${ref(r.number, r.identifier)}, opens in a new tab`}>
          <ICheck s={14} />
          {ref(r.number, r.identifier)}
        </a>
      );
    }
    if (run || !c || !linked) return null;
    const l = c.link;
    if (c.change === "unchanged") return <span className="ist" data-k="wait">Unchanged · {ref(l?.number, l?.identifier)}</span>;
    if (c.change === "update") return <span className="ist" data-k="will">Will update</span>;
    if (c.change === "new") return <span className="ist" data-k="new">New</span>;
    if (c.change === "missing") return <span className="ist" data-k="fail">Missing in {T} · will recreate</span>;
    if (c.change === "edited") return over.has(it.key) ? <span className="ist" data-k="will">Edited in {T} · overwrite</span> : <span className="ist" data-k="wait">Edited in {T} · skip</span>;
    return null;
  };

  const titleRefs = useRef<(HTMLTextAreaElement | null)[]>([]);
  const row = (it: IssueItem, i: number) => {
    const parent = it.key === PARENT;
    const c = change.get(it.key);
    const ro = !!run || (linked && !selectable(it.key));
    const on = isChosen(it.key);
    const locked = parent && parentLocked && !run;
    const r = rowOf(it.key);
    const bodyId = `${titleId}-b${i}`;
    const title = titles[it.key] ?? it.title;
    const reason = r?.status === "failed" ? `${runT} said: ${r.message ?? ""}` : r?.status === "edited" ? r.message : undefined;
    const covers = parent ? (
      <span className="cov">
        {[it.sections.join(", "), it.covers.length ? plural(it.covers.length, "decision") : ""].filter(Boolean).join(" · ")}
      </span>
    ) : it.covers.length ? (
      <span className="cov">
        Covers{" "}
        {it.covers.map((k) => (
          <b key={k}>{p.idOf(k) || k}</b>
        ))}
      </span>
    ) : (
      <span className="cov">Covers {it.sections.join(", ") || "the plan"}</span>
    );
    return (
      <li key={it.key} className={`ir${parent ? " par" : ""}${run || (linked && !selectable(it.key)) ? " ro" : ""}`} data-off={!run && !on ? "" : undefined} data-testid={`issue-row-${it.key}`}>
        {run || ro ? (
          <span className="icb" aria-hidden="true" style={{ visibility: "hidden" }} />
        ) : (
          <span
            className="icb"
            role="checkbox"
            tabIndex={0}
            aria-checked={on}
            aria-disabled={locked || undefined}
            aria-describedby={locked ? `${titleId}-lock` : undefined}
            aria-label={`Include ${parent ? "the parent issue" : title}`}
            title={locked ? ICOPY.parentLocked : undefined}
            onClick={() => toggle(it.key)}
            onKeyDown={(e) => {
              if (e.key === " " || e.key === "Enter") {
                e.preventDefault();
                toggle(it.key);
              }
            }}
          >
            {on ? <ICheck s={14} /> : null}
          </span>
        )}
        <div className="ir-m">
          <div className="ir-top">
            {run || ro ? (
              <span className="ir-tt">{title}</span>
            ) : (
              <textarea
                ref={(el) => {
                  titleRefs.current[i] = el;
                }}
                className="ir-ti"
                rows={1}
                spellCheck={false}
                maxLength={256}
                aria-label={parent ? "Parent issue title" : "Issue title"}
                value={title}
                onChange={(e) => setTitles((t) => ({ ...t, [it.key]: e.target.value.replace(/[\r\n]+/g, " ") }))}
                onKeyDown={(e) => {
                  if (e.key === "Enter" && !e.metaKey && !e.ctrlKey) {
                    e.preventDefault();
                    const next = titleRefs.current.slice(i + 1).find(Boolean);
                    if (next) next.focus();
                    else e.currentTarget.blur();
                  }
                }}
                onBlur={() => {
                  if (!title.trim()) setTitles((t) => ({ ...t, [it.key]: it.title }));
                }}
              />
            )}
          </div>
          <div className="ir-meta">
            {parent ? (
              <span className="itag" title={locked ? ICOPY.parentLocked : undefined}>
                {locked ? <ILock s={12} /> : null}
                Parent
              </span>
            ) : null}
            <button
              type="button"
              className="ir-x"
              aria-expanded={bodies.has(it.key)}
              aria-controls={bodyId}
              aria-label={`Body of ${parent ? "the parent issue" : title}`}
              onClick={() =>
                setBodies((b) => {
                  const n = new Set(b);
                  if (n.has(it.key)) n.delete(it.key);
                  else n.add(it.key);
                  return n;
                })
              }
            >
              <IChev s={14} />
              Body
            </button>
            {covers}
            {it.cut ? <span>{ICOPY.cut(tracker)}</span> : null}
            {status(it)}
          </div>
          {reason ? <p className="ir-why">{reason}</p> : null}
          {!run && c?.change === "edited" ? (
            <p className="ir-why">
              {over.has(it.key) ? `Replaces the edits made in ${T} with the plan’s version. ` : `Changed in ${T} after the export, so it’s left as is. `}
              <button type="button" className="ir-ow" onClick={() => toggle(it.key)}>
                {over.has(it.key) ? "Skip instead" : "Overwrite with the plan’s version"}
              </button>
            </p>
          ) : null}
          {bodies.has(it.key) ? (
            <div className="ir-body" id={bodyId}>
              <pre>{it.body}</pre>
            </div>
          ) : null}
        </div>
      </li>
    );
  };
  const removed = (pv?.changes ?? []).filter((c) => c.change === "removed" && !run);

  const preview = (
    <section className="ipv" aria-labelledby={`${titleId}-pv`}>
      <div className="ipv-h">
        <h3 id={`${titleId}-pv`}>Preview</h3>
        {pv && !run ? <span className="ipv-n">{linked ? `${count} to send` : `${count} of ${items.length}`}</span> : null}
      </div>
      {source}
      {pv?.dropped ? <p className="ipv-src">{ICOPY.over100}</p> : null}
      <ol className="ipl" aria-busy={splitting || !pv || undefined} data-arrive="">
        {splitting && items[0] ? (
          <>
            {row(items[0], 0)}
            {[1, 2, 3].map((n) => (
              <li key={`sk${n}`} className="ir sk" aria-hidden="true">
                <span className="icb" />
                <div className="ir-m">
                  <i />
                  <i className="s" />
                </div>
              </li>
            ))}
          </>
        ) : (
          items.map(row)
        )}
        {!splitting
          ? removed.map((c) => (
              <li key={c.key} className="ir gone">
                <span className="icb" aria-hidden="true" />
                <div className="ir-m">
                  <div className="ir-top">
                    <span className="ir-tt">{pv?.removed?.[c.key] ?? (c.link?.identifier ?? `#${c.link?.number}`)}</span>
                  </div>
                  <div className="ir-meta">
                    <span className="ist" data-k="wait">
                      Removed from the plan · {c.link?.identifier ?? `#${c.link?.number}`} stays in {T}
                    </span>
                  </div>
                </div>
              </li>
            ))
          : null}
        {!pv
          ? [0, 1, 2].map((n) => (
              <li key={`ld${n}`} className="ir sk" aria-hidden="true">
                <span className="icb" />
                <div className="ir-m">
                  <i />
                  <i className="s" />
                </div>
              </li>
            ))
          : null}
      </ol>
      <span id={`${titleId}-lock`} hidden>
        {ICOPY.parentLocked}
      </span>
    </section>
  );

  // Server errors keyed on their code (VERDICT r2): fix-its and the Connect state cover missing, auth
  // and bad_key; the rest read as the tracker's words or Grillado's own sentence.
  const errLine = err && !["missing", "auth", "bad_key", "draft"].includes(err.code) ? (
    <p className="iac-n bad" role="alert" style={{ color: "var(--destructive-ink)" }}>
      {err.code === "failed" || err.code === "rate" || err.code === "access" ? `${T} said: ${err.message}` : err.message}
    </p>
  ) : null;

  let footer: ReactNode;
  if (run && run.state === "running")
    footer = (
      <div className="iac" data-k="send" role="status">
        <p className="iac-t">
          {linked ? "Sending issues" : "Creating issues"} in {run.name} · {done} of {run.rows.length}
        </p>
        <p className="iac-n">{ICOPY.running}</p>
        <div className="iac-b">
          <button type="button" className="btn soft" onClick={leave}>
            Hide
          </button>
        </div>
      </div>
    );
  else if (run && parentFailed)
    footer = (
      <div className="iac" data-k="pfail" role="alert">
        <p className="iac-t sum">
          <ICircleAlert s={16} className="bad" />
          <span>Couldn’t create the parent issue</span>
        </p>
        <p className="iac-n">
          Nothing else was created. {runT} said: {rowOf(PARENT)?.message}
        </p>
        <div className="iac-b">
          <button type="button" className="btn quiet" onClick={leave}>
            Close
          </button>
          <button ref={primary} type="button" className="btn primary" onClick={() => void retry(true)}>
            <IRetry s={16} />
            Try again
          </button>
        </div>
        {errLine}
      </div>
    );
  else if (run && failed.length)
    footer = (
      <div className="iac" data-k="partial" role="status">
        <p className="iac-t sum">
          <ICircleAlert s={16} className="bad" />
          <span>{sumText}</span>
          <span className="dt">·</span>
          <span>{failed.length} failed</span>
          <span className="dt">·</span>
          <span className="m">{run.name}</span>
        </p>
        <div className="iac-b">
          <button type="button" className="btn quiet" onClick={leave}>
            Close
          </button>
          <button ref={primary} type="button" className="btn primary" onClick={() => void retry()}>
            <IRetry s={16} />
            Retry failed
          </button>
        </div>
        {errLine}
      </div>
    );
  else if (run)
    footer = (
      <div className="iac" data-k="done" role="status">
        <p className="iac-t sum">
          <ICheck s={16} className="ok" />
          <span>{sumText}</span>
          <span className="dt">·</span>
          <span className="m">{run.name}</span>
        </p>
        <div className="iac-b">
          {parentUrl ? (
            <a className="btn soft" href={parentUrl} target="_blank" rel="noreferrer">
              Open parent issue <IExt s={14} />
            </a>
          ) : null}
          <button ref={primary} type="button" className="btn primary" onClick={leave}>
            Done
          </button>
        </div>
      </div>
    );
  else {
    const ok = ready && button !== ICOPY.nothing;
    footer = (
      <div className="iac" data-k={ok ? "ready" : "blocked"}>
        <p className="iac-t">{blocked ?? (what || "\u00a0")}</p>
        {ok && pub ? (
          <p className="iac-n">
            <span className="pub">
              <IGlobe s={14} />
              {ICOPY.pub}
            </span>
          </p>
        ) : null}
        {ok && how ? <p className="iac-n">{how}</p> : null}
        {errLine}
        <div className="iac-b">
          {p.phone ? null : (
            <button type="button" className="btn quiet" onClick={leave}>
              Cancel
            </button>
          )}
          <button type="button" className={`btn ${ok ? "primary" : "soft"} go`} disabled={!ok} onClick={() => void confirm()} data-testid="issues-confirm">
            {button}
          </button>
        </div>
      </div>
    );
  }

  const issuesRef = s.issues?.parent ? (s.issues.parent.identifier ?? `#${s.issues.parent.number}`) : "";
  return (
    <>
      <div className="cscrim ischrim" data-leaving={leaving || undefined} onClick={leave} />
      <div
        ref={sheet}
        className="ish"
        data-leaving={leaving || undefined}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        data-testid="issues-sheet"
        tabIndex={-1}
        onKeyDown={keys}
        style={dy ? { transform: `translateY(${dy}px)`, transition: "none" } : undefined}
      >
        {p.phone ? <div className="grab" {...swipe} /> : null}
        <header className="ish-h" {...swipe}>
          <b id={titleId}>{linked ? ICOPY.titleUpdate : ICOPY.titleCreate}</b>
          <button type="button" className="icon-btn" aria-label="Close" onClick={leave}>
            <IX s={18} />
          </button>
        </header>
        <div className="ish-b">
          {linked && s.issues?.parent ? (
            <p className="ish-d">
              Already in{" "}
              <a className="lnk" href={s.issues.parent.url} target="_blank" rel="noreferrer">
                {s.issues.tracker === "github" ? s.issues.target : `Linear · Team ${s.issues.targetName ?? ""}`} {issuesRef} <IExt s={12} />
              </a>
              . Changed items are updated and new ones created. Issues edited in {T} are skipped unless you choose to overwrite them. Nothing is sent until you confirm.
            </p>
          ) : linked ? null : (
            <p className="ish-d">{ICOPY.intro}</p>
          )}
          {switcher}
          {destination}
          {preview}
        </div>
        <footer className="ish-f">{footer}</footer>
        <span className="sr-only" role="status" aria-live="polite">
          {say}
        </span>
      </div>
    </>
  );
}

export const kbdMode = kbd;
export const platform = { isMac, isWin };
