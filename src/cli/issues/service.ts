// The export run (v1.3 item 2): parent first, then each child, saving links as it goes so a crash or
// a closed sheet never loses what was made. Writes happen only here, and only after the confirm.
import { closeSync, openSync, readFileSync, statSync, unlinkSync, writeSync } from "node:fs";
import path from "node:path";
import { findBanned } from "../../core/filter.ts";
import { type IssueItem, type IssueLink, PARENT_KEY, type PlanIssues, type Tracker, contentHash } from "../../core/issues.ts";
import { type Session, userText } from "../../core/session.ts";
import { type Store, withLock, writeAtomic } from "../store.ts";
import { type IssueTracker, type RemoteIssue, TrackerError } from "./tracker.ts";

export type RowStatus = "waiting" | "creating" | "updating" | "created" | "updated" | "unchanged" | "skipped" | "edited" | "failed";

export interface Row {
  key: string;
  status: RowStatus;
  url?: string;
  number?: number;
  identifier?: string;
  /** "GitHub said: …" / why it was skipped. */
  message?: string;
}

export interface ExportRun {
  state: "running" | "done";
  tracker: Tracker;
  target: string;
  name: string;
  rows: Row[];
  startedAt: string;
  ms?: number;
}

export interface ExportRequest {
  tracker: IssueTracker;
  /** What `session.issues` records about the destination. */
  dest: Pick<PlanIssues, "tracker" | "target" | "host" | "targetName" | "projectId" | "labels">;
  /** The selected items, parent first. */
  items: IssueItem[];
  /** Keys edited in the tracker since the export that the user chose to overwrite (#182). */
  overwrite: string[];
  /** Labels the user typed and confirmed (GitHub). */
  newLabels: string[];
}

export class ExportError extends Error {
  constructor(
    readonly code: "busy" | "draft" | "filtered" | "empty" | "parent",
    message: string,
  ) {
    super(message);
  }
}

/**
 * One export per plan at a time, across processes: `sessions/<id>/issues.lock` holds the pid. A lock
 * whose process is gone (or older than an hour) was left by a crash and is taken over.
 */
export function takeExportLock(dir: string): () => void {
  const file = path.join(dir, "issues.lock");
  for (let i = 0; i < 2; i++) {
    try {
      const fd = openSync(file, "wx", 0o600);
      writeSync(fd, String(process.pid));
      closeSync(fd);
      return () => {
        try {
          unlinkSync(file);
        } catch {}
      };
    } catch (err: any) {
      if (err?.code !== "EEXIST") throw err;
      let stale = false;
      try {
        const pid = Number(readFileSync(file, "utf8"));
        stale = Date.now() - statSync(file).mtimeMs > 3_600_000 || !alive(pid);
      } catch {
        stale = true;
      }
      if (!stale) break;
      try {
        unlinkSync(file);
      } catch {}
    }
  }
  throw new ExportError("busy", "Issues are already being created for this plan.");
}

function alive(pid: number) {
  if (!pid) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err: any) {
    return err?.code === "EPERM";
  }
}

const linkOf = (x: RemoteIssue, sent: { title: string; body: string }): IssueLink => ({
  id: x.id,
  ...(x.number !== undefined ? { number: x.number } : {}),
  ...(x.identifier ? { identifier: x.identifier } : {}),
  url: x.url,
  contentHash: contentHash(sent.title, sent.body),
});

const remoteHash = (x: RemoteIssue) => contentHash(x.title, x.body);

/** Every issue's title and body pass the banned-words check before anything is sent (spec acceptance). */
export function checkItems(s: Session, items: IssueItem[]) {
  const exempt = userText(s);
  for (const it of items) if (findBanned(`${it.title}\n${it.body}`, exempt)) throw new ExportError("filtered", `“${it.title.slice(0, 60)}” can't be sent as it is.`);
}

/**
 * Run the export. `save` is called after every write with the session's updated `issues`, `progress`
 * after every row change. Never throws for a tracker failure: those end up on their rows.
 */
export async function runExport(s: Session, req: ExportRequest, hooks: { save: (issues: PlanIssues) => void; progress: (run: ExportRun) => void }): Promise<ExportRun> {
  const t0 = Date.now();
  const { tracker, dest } = req;
  const same = s.issues && s.issues.tracker === dest.tracker && s.issues.target === dest.target;
  const issues: PlanIssues = {
    ...dest,
    parent: same ? s.issues!.parent : undefined,
    items: same ? { ...s.issues!.items } : {},
    failed: same ? { ...(s.issues!.failed ?? {}) } : {},
    exportedAt: new Date().toISOString(),
  };
  const run: ExportRun = { state: "running", tracker: dest.tracker, target: dest.target, name: tracker.name, rows: req.items.map((it) => ({ key: it.key, status: "waiting" })), startedAt: new Date(t0).toISOString() };
  const row = (key: string, patch: Partial<Row>) => {
    Object.assign(run.rows.find((r) => r.key === key)!, patch);
    hooks.progress(run);
  };
  const link = (key: string) => (key === PARENT_KEY ? issues.parent : issues.items[key]);
  const setLink = (key: string, l: IssueLink) => {
    if (key === PARENT_KEY) issues.parent = l;
    else issues.items[key] = l;
    delete issues.failed![key];
    hooks.save(issues);
  };
  const fail = (key: string, err: unknown) => {
    const msg = err instanceof TrackerError || err instanceof Error ? err.message : String(err);
    issues.failed![key] = msg;
    hooks.save(issues);
    row(key, { status: "failed", message: msg });
  };
  const shown = (l: IssueLink) => ({ url: l.url, ...(l.number !== undefined ? { number: l.number } : {}), ...(l.identifier ? { identifier: l.identifier } : {}) });
  const done = () => {
    run.state = "done";
    run.ms = Date.now() - t0;
    hooks.progress(run);
    return run;
  };

  // Dedupe (spec): an item with no local link may still be in the tracker from a run whose link was lost.
  if (req.items.some((it) => !link(it.key))) {
    try {
      const found = await tracker.findByMarker(s.id);
      for (const it of req.items) {
        const x = found.get(it.key);
        // Adopted with the hash of what's there, so a changed plan updates it and an unchanged one is skipped.
        if (x && !link(it.key)) setLink(it.key, { ...linkOf(x, x), contentHash: remoteHash(x) });
      }
    } catch (err) {
      for (const it of req.items) fail(it.key, err);
      return done();
    }
  }

  if (req.newLabels.length && tracker.createLabels) {
    try {
      await tracker.createLabels(req.newLabels);
    } catch (err) {
      for (const it of req.items) fail(it.key, err);
      return done();
    }
  }

  const labels = dest.labels;
  /** Create, update, skip or recreate one item. Returns false when it failed. */
  const one = async (it: IssueItem, parent?: IssueLink): Promise<boolean> => {
    const have = link(it.key);
    const sent = { title: it.title, body: it.body, labels };
    try {
      if (have) {
        const now = await tracker.get(have);
        if (now) {
          const mine = contentHash(it.title, it.body);
          if (have.unattached && parent) {
            await tracker.attach(have, parent);
            setLink(it.key, { ...have, unattached: undefined });
          }
          if (mine === have.contentHash) {
            row(it.key, { status: "unchanged", ...shown(have) });
            return true;
          }
          if (remoteHash(now) !== have.contentHash && remoteHash(now) !== mine && !req.overwrite.includes(it.key)) {
            row(it.key, { status: "edited", ...shown(have), message: "Changed in the tracker after the export, so it's left as is." });
            return true;
          }
          row(it.key, { status: "updating" });
          const x = await tracker.update(have, sent);
          setLink(it.key, { ...linkOf(x, sent), ...(have.unattached ? { unattached: true } : {}) });
          row(it.key, { status: "updated", ...shown(link(it.key)!) });
          return true;
        }
        // Gone from the tracker: recreated below (Recreate, #176).
      }
      row(it.key, { status: "creating" });
      const made = await tracker.create(sent, parent);
      setLink(it.key, { ...linkOf(made.issue, sent), ...(parent && !made.attached ? { unattached: true } : {}) });
      if (parent && !made.attached) {
        fail(it.key, new Error(`Created, but couldn't make it a sub-issue: ${made.attachError ?? "unknown error"}`));
        return false;
      }
      row(it.key, { status: "created", ...shown(link(it.key)!) });
      return true;
    } catch (err) {
      fail(it.key, err);
      return false;
    }
  };

  const parentItem = req.items.find((it) => it.key === PARENT_KEY);
  const kids = req.items.filter((it) => it.key !== PARENT_KEY);
  if (parentItem) {
    const before = issues.parent;
    const ok = await one(parentItem);
    if (!ok) {
      for (const k of kids) row(k.key, { status: "skipped", message: "Not created: the parent issue failed." });
      return done();
    }
    // A recreated parent (#176): the sub-issues that still exist are attached to the new one, nothing
    // else is made again. Selected ones attach in their own row; the rest here, quietly.
    if (before && issues.parent && issues.parent.id !== before.id) {
      for (const [key, l] of Object.entries(issues.items)) {
        if (kids.some((k) => k.key === key)) {
          setLink(key, { ...l, unattached: true });
          continue;
        }
        try {
          if (await tracker.get(l)) {
            await tracker.attach(l, issues.parent);
            setLink(key, { ...l, unattached: undefined });
          }
        } catch {
          setLink(key, { ...l, unattached: true });
        }
      }
    }
  }
  const parent = issues.parent;
  if (!parent && kids.length) {
    for (const k of kids) row(k.key, { status: "skipped", message: "Not created: there's no parent issue." });
    return done();
  }
  for (const k of kids) await one(k, parent);
  return done();
}

// ---------------------------------------------------------------- counters

export interface IssueStats {
  runs?: number;
  /** Runs with zero failed issues (the secondary target). */
  cleanRuns?: number;
  created?: number;
  updated?: number;
  failed?: number;
  github?: number;
  linear?: number;
  /** Plans exported at least once (the target's numerator; plated plans are the denominator). */
  plans?: string[];
}

/** Local counters for item 2's target (no telemetry, §14.4), in stats.json next to item 1's. */
export function countExport(store: Store, planId: string, run: ExportRun) {
  const file = path.join(store.dir, "stats.json");
  const n = (st: RowStatus) => run.rows.filter((r) => r.status === st).length;
  try {
    withLock(file, () => {
      let s: any = {};
      try {
        s = JSON.parse(readFileSync(file, "utf8"));
      } catch {}
      const f: IssueStats = (s.issues ??= {});
      f.runs = (f.runs ?? 0) + 1;
      if (!n("failed")) f.cleanRuns = (f.cleanRuns ?? 0) + 1;
      f.created = (f.created ?? 0) + n("created");
      f.updated = (f.updated ?? 0) + n("updated");
      f.failed = (f.failed ?? 0) + n("failed");
      f[run.tracker] = (f[run.tracker] ?? 0) + 1;
      if (n("created") + n("updated") + n("unchanged") > 0) f.plans = [...new Set([...(f.plans ?? []), planId])].slice(-1000);
      writeAtomic(file, `${JSON.stringify(s, null, 2)}\n`);
    });
  } catch {}
}
