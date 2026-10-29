// The HTTP side of "Send to issues" (v1.3 item 2), server-only for now (the sheet waits for its
// design handoff). Everything before /export is a read: gh version and auth, repo and label lists,
// the marker search and the 404 check, Linear's viewer, teams, projects and labels (#180).
import type http from "node:http";
import { textHash } from "../../core/text-hash.ts";
import { PARENT_KEY, type PlanIssues, type Slice, type SplitSource, type Tracker, agentSlices, buildItems, contentHash, fallbackSlices, groupsTodos, planChanges } from "../../core/issues.ts";
import { type Session, setIssues } from "../../core/session.ts";
import type { Store } from "../store.ts";
import { Gh, type GhOptions, GitHubTracker, projectRemotes } from "./gh.ts";
import { LINEAR_KEYS_URL, Linear, type LinearOptions, LinearTracker } from "./linear.ts";
import { linearView, readSecrets, writeSecrets } from "./secrets.ts";
import { ExportError, type ExportRun, checkItems, countExport, runExport, takeExportLock } from "./service.ts";
import type { IssueTracker } from "./tracker.ts";
import { TrackerError } from "./tracker.ts";

export interface IssuesHost {
  store: Store;
  /** The live session (the server's copy). */
  session(id: string): Session;
  /** Save the live copy and push it to the browser. */
  changed(s: Session): void;
  /** Push the session to the browser without a save (progress). */
  push(s: Session): void;
  /** Where the plan's project is: its imported project, else the launch folder. */
  projectDir(s: Session): string | undefined;
  /** {agent} splits the plan. null: no agent is ready. */
  split(s: Session, md: string, exported: { key: string; title: string }[], signal: AbortSignal): Promise<{ ok: true; slices: Slice[] } | { ok: false; code: string } | null>;
  /** Review r5: a decision-less plan's to-dos grouped by {agent}, already checked (each to-do in exactly one slice). */
  group(s: Session, md: string, todos: Slice[], signal: AbortSignal): Promise<{ ok: true; slices: Slice[] } | { ok: false; code: string } | null>;
}

export interface IssuesOptions {
  gh?: GhOptions;
  linear?: LinearOptions;
}

type Json = (res: http.ServerResponse, status: number, data: unknown) => void;

const REPO = /^[\w.-]+\/[\w.-]+$/;
const HOST = /^[a-z0-9.-]+$/i;
const ID = /^[\w-]{1,80}$/;
const STATUS: Record<string, number> = { busy: 409, draft: 409, filtered: 422, empty: 400, parent: 400, missing: 424, auth: 424, access: 403, bad_key: 401, rate: 429, failed: 502 };

const isDraft = (s: Session) => s.status !== "plated" || !s.plan;
const str = (v: unknown, max = 200) => (typeof v === "string" ? v.trim().slice(0, max) : "");
const strs = (v: unknown, max = 50) => (Array.isArray(v) ? v.map((x) => str(x, 100)).filter(Boolean).slice(0, max) : []);

export class IssuesRoutes {
  private runs = new Map<string, ExportRun>();
  private splits = new Map<string, AbortController>();
  /** The last export request per plan, for Retry failed. */
  private last = new Map<string, any>();
  private gh: Gh;

  constructor(
    private host: IssuesHost,
    private o: IssuesOptions = {},
  ) {
    this.gh = new Gh(o.gh);
  }

  /** What the session view carries: the live run, if any, so a re-opened sheet shows its progress (#174). */
  runView(id: string) {
    return this.runs.get(id);
  }

  running(id: string) {
    return this.runs.get(id)?.state === "running";
  }

  private linear(): Linear {
    const key = readSecrets(this.host.store.dir).linear?.key;
    if (!key) throw new TrackerError("bad_key", "Connect Linear first.");
    return new Linear(key, this.o.linear);
  }

  private fail(res: http.ServerResponse, json: Json, err: unknown) {
    if (err instanceof TrackerError || err instanceof ExportError) {
      const extra = err.code === "bad_key" ? { help: LINEAR_KEYS_URL } : {};
      return json(res, STATUS[err.code] ?? 400, { error: err.message, code: err.code, ...extra });
    }
    throw err;
  }

  // ---------------------------------------------------------------- /api/github, /api/linear

  async appRoutes(req: http.IncomingMessage, res: http.ServerResponse, parts: string[], body: any, q: URLSearchParams, json: Json) {
    const host = q.get("host") || "github.com";
    if (!HOST.test(host)) return json(res, 400, { error: "That isn’t a GitHub host." });
    try {
      const [what, sub] = parts;
      if (what === "github" && req.method === "GET") {
        if (sub === "status") return json(res, 200, await this.gh.status(host));
        if (sub === "repos") return json(res, 200, { repos: await this.gh.repos(host) });
        const repo = q.get("repo") ?? "";
        if (!REPO.test(repo)) return json(res, 400, { error: "A repository looks like owner/name." });
        if (sub === "repo") return json(res, 200, await this.gh.repo(repo, host));
        if (sub === "labels") return json(res, 200, { labels: await this.gh.labels(repo, host) });
      }
      if (what === "linear") {
        if (req.method === "GET" && !sub) return json(res, 200, linearView(this.host.store.dir));
        if (req.method === "POST" && sub === "connect") {
          const key = str(body?.key, 500);
          if (!key || /\s/.test(key)) return json(res, 400, { error: "Paste the whole key.", code: "bad_key", help: LINEAR_KEYS_URL });
          const me = await new Linear(key, this.o.linear).viewer();
          writeSecrets(this.host.store.dir, { ...readSecrets(this.host.store.dir), linear: { key, name: me.name, connectedAt: new Date().toISOString() } });
          return json(res, 200, linearView(this.host.store.dir));
        }
        if (req.method === "POST" && sub === "disconnect") {
          const { linear: _, ...rest } = readSecrets(this.host.store.dir);
          writeSecrets(this.host.store.dir, rest);
          return json(res, 200, linearView(this.host.store.dir));
        }
        if (req.method === "GET" && sub === "teams") return json(res, 200, { teams: await this.linear().teams() });
        const team = q.get("team") ?? "";
        if (!ID.test(team)) return json(res, 400, { error: "Pick a team." });
        if (req.method === "GET" && sub === "projects") return json(res, 200, { projects: await this.linear().projects(team) });
        if (req.method === "GET" && sub === "labels") return json(res, 200, { labels: await this.linear().labels(team) });
      }
      return json(res, 404, { error: "Not found" });
    } catch (err) {
      return this.fail(res, json, err);
    }
  }

  // ---------------------------------------------------------------- /api/sessions/:id/issues

  async sessionRoutes(req: http.IncomingMessage, res: http.ServerResponse, s: Session, op: string | undefined, body: any, json: Json) {
    try {
      if (req.method === "GET" && !op) return json(res, 200, await this.state(s));
      if (req.method !== "POST") return json(res, 404, { error: "Not found" });
      if (isDraft(s)) throw new ExportError("draft", "Finish the plan first.");
      if (op === "split") return json(res, 200, await this.split(s, body?.use === "fallback", body?.tracker === "linear" ? "linear" : "github"));
      if (op === "preview") return json(res, 200, await this.preview(s, body));
      if (op === "export") return json(res, 202, await this.export(s, body));
      if (op === "retry") {
        const prev = this.last.get(s.id);
        const failed = Object.keys(s.issues?.failed ?? {});
        if (!prev || !failed.length) return json(res, 409, { error: "Nothing failed to retry.", code: "empty" });
        return json(res, 202, await this.export(s, { ...prev, selected: failed, overwrite: [] }));
      }
      return json(res, 404, { error: "Not found" });
    } catch (err) {
      return this.fail(res, json, err);
    }
  }

  /** What the sheet opens with: the default destination (#179), the project's remotes, remembered labels (#177), the links. */
  private async state(s: Session) {
    const dir = this.host.projectDir(s);
    const remotes = dir ? await projectRemotes(dir) : {};
    const cfg = this.host.store.readConfig().issues ?? {};
    const remembered = dir ? cfg.byProject?.[dir] : undefined;
    let tracker: Tracker = "github";
    let why: "no-remote" | "no-gh" | undefined;
    if (remembered) tracker = remembered;
    else {
      const github = !!remotes.origin && /github/.test(remotes.origin.host);
      const gh = github ? (await this.gh.status(remotes.origin!.host)).state !== "missing" : false;
      if ((!github || !gh) && cfg.last === "linear") {
        tracker = "linear";
        why = github ? "no-gh" : "no-remote";
      }
    }
    const split = this.cachedSplit(s, this.md(s));
    return {
      destination: { tracker, ...(why ? { why } : {}) },
      github: { ...remotes, host: remotes.origin?.host ?? "github.com" },
      labels: cfg.labels ?? {},
      linear: linearView(this.host.store.dir),
      issues: s.issues ?? null,
      run: this.runs.get(s.id) ?? null,
      split: split ? { source: split.source, at: split.at } : null,
    };
  }

  private md(s: Session) {
    return this.host.store.readPlan(s.id) ?? s.plan!.markdown;
  }

  /** The split: {agent}'s slices (cached per plan text), or the fallback when asked, when it fails, or with no agent. */
  private async split(s: Session, fallback: boolean, tracker: Tracker) {
    const md = this.md(s);
    const planHash = textHash(md);
    this.splits.get(s.id)?.abort();
    let failed: string | undefined;
    // {agent} answered with no slices at all: the fallback stays, said plainly (not a failure).
    let empty = false;
    let out: { source: SplitSource; slices: Slice[] } | null = null;
    const fb = fallbackSlices(s, md);
    const grouping = groupsTodos(s, fb);
    // Imported to-dos can be split too, when asked (PO, review round 4).
    if (!fallback) {
      const c = new AbortController();
      this.splits.set(s.id, c);
      try {
        const exported = Object.keys(s.issues?.items ?? {}).map((key) => ({ key, title: s.issueTitles?.[key] ?? s.issueSplit?.slices.find((x) => x.key === key)?.title ?? key }));
        const r = grouping ? await this.host.group(s, md, fb.slices, c.signal) : await this.host.split(s, md, exported, c.signal);
        if (c.signal.aborted) return { stopped: true };
        const slices = r?.ok ? (grouping ? r.slices : agentSlices(s, r.slices)) : [];
        if (slices.length) out = { source: "agent", slices };
        else if (r?.ok && !r.slices.length) empty = true;
        // Slices that were all unusable (no titles) are a failed split, not "0 slices".
        else failed = r && !r.ok ? r.code : r ? "failed" : "missing";
      } finally {
        if (this.splits.get(s.id) === c) this.splits.delete(s.id);
      }
    }
    out ??= fb;
    // Only {agent}'s split is cached: the fallback is recomputed from the plan every time (it's cheap and exact).
    s.issueSplit = out.source === "agent" ? { planHash, source: out.source, slices: out.slices, at: new Date().toISOString() } : undefined;
    this.host.changed(s);
    return { ...this.items(s, tracker), ...(failed ? { failed } : {}), ...(empty ? { empty } : {}) };
  }

  /** {agent}'s split that still applies: made from this plan text, or the one the exported issues came from. */
  private cachedSplit(s: Session, md: string) {
    const c = s.issueSplit;
    if (!c || c.source !== "agent") return null;
    if (c.planHash === textHash(md)) return c;
    return s.issues && Object.keys(s.issues.items).some((k) => c.slices.some((x) => x.key === k)) ? c : null;
  }

  /**
   * The items for a destination: the cached split when the plan hasn't changed since, else the fallback.
   * Once exported, the split the issues were made from stays (until Split again), so editing the plan
   * updates those issues instead of reading every sub-issue as removed.
   */
  private items(s: Session, tracker: Tracker, titles: Record<string, string> = {}) {
    const md = this.md(s);
    const cached = this.cachedSplit(s, md);
    const fb = fallbackSlices(s, md);
    const { source, slices } = cached ?? fb;
    // `fallback`: what "Use … instead" gives; `stale`: {agent}'s split was made from an older plan text.
    const fallback = fb.source;
    const stale = !!cached && cached.planHash !== textHash(md);
    const title = (key: string) => cleanTitle(titles[key]) || cleanTitle(s.issueTitles?.[key]);
    const named = slices.map((x) => ({ ...x, title: title(x.key) || x.title }));
    const built = buildItems(s, md, tracker, named);
    const parentTitle = title(PARENT_KEY);
    if (parentTitle) built.items[0] = { ...built.items[0], title: parentTitle };
    // `grouping`: no decisions, so {agent} would group the to-dos (review r5).
    // The decision count: with none, the card offers to group the plan's work (review r5, #188).
    return { source, fallback, stale, decisions: Object.keys(s.decisions).length, ...built };
  }

  /** Read-only: the items and what each would do, checked against the tracker (404s and edits, #176, #182). */
  private async preview(s: Session, body: any) {
    // With no repository or team picked yet the sheet still shows the items; nothing is checked remotely.
    let dest: ReturnType<IssuesRoutes["destOf"]> | undefined;
    try {
      dest = this.destOf(body);
    } catch (err) {
      if (!(err instanceof ExportError)) throw err;
    }
    const tracker: Tracker = dest?.tracker ?? (body?.tracker === "linear" ? "linear" : "github");
    const { items, source, fallback, stale, decisions, dropped } = this.items(s, tracker, titlesOf(body));
    const linked = dest && s.issues && s.issues.tracker === dest.tracker && s.issues.target === dest.target ? s.issues : undefined;
    const remote: Record<string, string | null> = {};
    // Titles of exported issues no longer in the plan, for the "Removed from the plan" rows (#178).
    const removed: Record<string, string> = {};
    if (dest && linked) {
      const links = { ...linked.items, ...(linked.parent ? { [PARENT_KEY]: linked.parent } : {}) };
      try {
        const t = this.tracker(dest);
        for (const [key, l] of Object.entries(links)) {
          const x = await t.get(l);
          if (items.some((it) => it.key === key)) remote[key] = x ? contentHash(x.title, x.body) : null;
          else if (x) removed[key] = x.title;
        }
      } catch (err) {
        // gh missing or signed out, a bad key: the sheet's fix-it says so; the items still show, unchecked.
        if (!(err instanceof TrackerError)) throw err;
        for (const k of Object.keys(remote)) delete remote[k];
        for (const k of Object.keys(removed)) delete removed[k];
      }
    }
    return { source, fallback, stale, decisions, dropped, items, changes: planChanges(items, linked, remote), removed };
  }

  private destOf(body: any) {
    const tracker: Tracker = body?.tracker === "linear" ? "linear" : "github";
    const labels = strs(body?.labels);
    if (tracker === "github") {
      const target = str(body?.repo);
      const host = str(body?.host) || "github.com";
      if (!REPO.test(target)) throw new ExportError("empty", "Pick a repository.");
      if (!HOST.test(host)) throw new ExportError("empty", "That isn’t a GitHub host.");
      return { tracker, target, host, labels, targetName: undefined as string | undefined, projectId: undefined as string | undefined };
    }
    const target = str(body?.team);
    if (!ID.test(target)) throw new ExportError("empty", "Pick a team.");
    const projectId = str(body?.project);
    return { tracker, target, host: undefined as string | undefined, labels, targetName: str(body?.teamName) || target, projectId: ID.test(projectId) ? projectId : undefined };
  }

  private tracker(dest: ReturnType<IssuesRoutes["destOf"]>): IssueTracker {
    if (dest.tracker === "linear") return new LinearTracker(this.linear(), dest.target, dest.targetName!, dest.projectId);
    // The subIssues mode is settled in export(), after `gh --version`; reads don't need it.
    return new GitHubTracker(this.gh, dest.target, dest.host!, "api");
  }

  /** The confirm: the one place anything is written to a tracker. Runs in the background; progress is on the session view. */
  private async export(s: Session, body: any) {
    if (this.running(s.id)) throw new ExportError("busy", "Issues are already being created for this plan.");
    const dest = this.destOf(body);
    const { items } = this.items(s, dest.tracker, titlesOf(body));
    const selected = new Set(strs(body?.selected, 200));
    let chosen = items.filter((it) => selected.has(it.key));
    // The parent stays while any child is selected.
    if (chosen.some((it) => it.key !== PARENT_KEY) && !chosen.some((it) => it.key === PARENT_KEY)) chosen = [items[0], ...chosen];
    if (!chosen.length) throw new ExportError("empty", "Select at least one issue.");
    checkItems(s, chosen);
    this.keepTitles(s, dest.tracker, titlesOf(body));
    // gh is checked before anything starts, so a missing or signed-out gh is a fix-it, not a failed run.
    let tracker: IssueTracker;
    if (dest.tracker === "github") {
      const st = await this.gh.status(dest.host!);
      if (st.state === "missing") throw new TrackerError("missing", "gh isn’t installed.");
      if (st.state === "auth") throw new TrackerError("auth", `gh isn’t signed in to ${dest.host}.`);
      tracker = new GitHubTracker(this.gh, dest.target, dest.host!, st.subIssues);
    } else tracker = this.tracker(dest);
    if (this.running(s.id)) throw new ExportError("busy", "Issues are already being created for this plan.");
    const release = takeExportLock(this.host.store.sessionDir(s.id));
    const run: ExportRun = { state: "running", tracker: dest.tracker, target: dest.target, name: dest.tracker === "github" ? dest.target : `Linear · ${dest.targetName}`, rows: chosen.map((it) => ({ key: it.key, status: "waiting" })), startedAt: new Date().toISOString() };
    this.runs.set(s.id, run);
    this.last.set(s.id, body);
    this.remember(s, dest);
    const newLabels = dest.tracker === "github" ? strs(body?.newLabels).filter((l) => dest.labels.includes(l)) : [];
    void (async () => {
      try {
        const done = await runExport(
          s,
          { tracker, dest: { tracker: dest.tracker, target: dest.target, labels: dest.labels, ...(dest.host && dest.host !== "github.com" ? { host: dest.host } : {}), ...(dest.targetName ? { targetName: dest.targetName } : {}), ...(dest.projectId ? { projectId: dest.projectId } : {}) }, items: chosen, overwrite: strs(body?.overwrite, 200), newLabels },
          {
            save: (issues: PlanIssues) => {
              setIssues(s, issues);
              this.host.changed(s);
            },
            progress: (r) => {
              this.runs.set(s.id, r);
              this.host.push(s);
            },
          },
        );
        countExport(this.host.store, s.id, done);
      } catch (err) {
        const msg = (err as Error)?.message ?? String(err);
        run.rows = run.rows.map((r) => ({ ...r, status: "failed", message: msg }));
        run.state = "done";
        setIssues(s, { ...(s.issues ?? { tracker: dest.tracker, target: dest.target, labels: dest.labels, items: {}, exportedAt: new Date().toISOString() }), failed: Object.fromEntries(chosen.map((it) => [it.key, msg])) });
        this.host.changed(s);
        countExport(this.host.store, s.id, run);
      } finally {
        release();
        this.host.push(s);
      }
    })();
    return { run };
  }

  /** Titles edited in the sheet stay with the items they were sent as, so a later check doesn't read them as plan changes. */
  private keepTitles(s: Session, tracker: Tracker, titles: Record<string, string>) {
    // Only real edits: a title equal to the plan's own is dropped, so rewording the plan still renames it.
    const md = this.md(s);
    const plain = new Map(buildItems(s, md, tracker, (this.cachedSplit(s, md) ?? fallbackSlices(s, md)).slices).items.map((it) => [it.key, it.title]));
    const next = { ...(s.issueTitles ?? {}) };
    for (const [k, v] of Object.entries(titles)) {
      const t = cleanTitle(v);
      if (!t) continue;
      if (t === plain.get(k)) delete next[k];
      else next[k] = t;
    }
    s.issueTitles = Object.keys(next).length ? next : undefined;
  }

  /** #177, #179: the destination this project used, the last one anywhere, and the labels per target. */
  private remember(s: Session, dest: { tracker: Tracker; target: string; labels: string[] }) {
    const cfg = this.host.store.readConfig();
    const dir = this.host.projectDir(s);
    const i = cfg.issues ?? {};
    cfg.issues = {
      ...i,
      last: dest.tracker,
      byProject: dir ? { ...(i.byProject ?? {}), [dir]: dest.tracker } : i.byProject,
      labels: { ...(i.labels ?? {}), [`${dest.tracker}:${dest.target}`]: dest.labels },
    };
    this.host.store.writeConfig(cfg);
  }
}

/** An edited title: one line, at most 256 characters; empty keeps the original. */
const cleanTitle = (t: unknown) => (typeof t === "string" ? t.replace(/\s+/g, " ").trim().slice(0, 256) : "");

function titlesOf(body: any): Record<string, string> {
  const t = body?.titles;
  if (!t || typeof t !== "object") return {};
  return Object.fromEntries(Object.entries(t).filter(([k, v]) => /^[\w-]{1,60}$/.test(k) && typeof v === "string")) as Record<string, string>;
}
