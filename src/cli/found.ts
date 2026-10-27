// v1.3 item 1, "Found in this project": at launch, look in the project the app was started in for
// planning work done with a coding agent (Claude Code and Codex transcripts, Cursor plans, plan
// files) and offer each as a one-click import. Read-only on every source; no network; bounded by a
// wall-time and size budget; results cached by path + mtime + size so a second launch re-reads only
// what changed. sources.json remembers what was imported, so nothing imports twice.
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readFileSync, realpathSync } from "node:fs";
import { open, readdir, readFile, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { redact } from "../core/filter.ts";
import { type Extract, codexMeta, contentHash, exportedPlanId, isPlanCandidate, mentionedPaths, parseClaude, parseCodex, parsePlanFile } from "../core/found/extract.ts";
import { type AgentDecision, ImportError, sessionFromSource, updateFromSource } from "../core/found/import.ts";
import type { ProviderId } from "../core/providers/types.ts";
import type { Session } from "../core/session.ts";
import { type Store, withLock, writeAtomic } from "./store.ts";

// ---------------------------------------------------------------- project

export interface Project {
  root: string;
  name: string;
  git: boolean;
  branch?: string;
  /** Short SHA when HEAD is detached. */
  sha?: string;
}

export type SkipReason = "off" | "home" | "root" | "data-dir";

const run = (cmd: string, args: string[], cwd: string, timeout = 1500) =>
  new Promise<string | null>((resolve) => {
    execFile(cmd, args, { cwd, timeout, maxBuffer: 64 * 1024 * 1024, env: { ...process.env, GIT_OPTIONAL_LOCKS: "0" } }, (err, out) => resolve(err ? null : out));
  });

const real = (p: string) => {
  try {
    return realpathSync(p);
  } catch {
    return path.resolve(p);
  }
};
const norm = (p: string) => (process.platform === "win32" ? real(p).toLowerCase() : real(p));
/** `p` is `root` or a folder below it (after realpath; case-insensitive on Windows). */
export const isUnder = (root: string, p: string) => {
  const a = norm(root);
  const b = norm(p);
  return b === a || b.startsWith(a.endsWith(path.sep) ? a : a + path.sep);
};

/** No scan from the home folder, a filesystem root, or Grillado's own data folder (or when turned off). */
export function skipReason(cwd: string, o: { home: string; dataDir: string; off?: boolean }): SkipReason | null {
  if (o.off) return "off";
  const c = norm(cwd);
  if (c === path.parse(c).root) return "root";
  if (c === norm(o.home)) return "home";
  if (isUnder(o.dataDir, c)) return "data-dir";
  return null;
}

/** The project root is the git top level, or the folder itself outside git. */
export async function resolveProject(cwd: string): Promise<Project> {
  const top = (await run("git", ["rev-parse", "--show-toplevel"], cwd))?.trim();
  if (!top) return { root: real(cwd), name: path.basename(real(cwd)), git: false };
  const root = real(top);
  const branch = (await run("git", ["symbolic-ref", "--short", "-q", "HEAD"], root))?.trim();
  const sha = branch ? undefined : (await run("git", ["rev-parse", "--short", "HEAD"], root))?.trim() || undefined;
  return { root, name: path.basename(root), git: true, ...(branch ? { branch } : {}), ...(sha ? { sha } : {}) };
}

// ---------------------------------------------------------------- rows

export type RowStatus = "new" | "imported" | "changed" | "in_progress" | "error";

/** One thing found in the project, as the UI and `list_project_sources` show it. */
export interface Row {
  id: string;
  app: Extract["app"];
  kind: Extract["kind"];
  title: string;
  /** Absolute path of the transcript or plan file. */
  path: string;
  /** Plan files: the path relative to the project root. */
  relPath?: string;
  /** A session started in a subfolder of the root (monorepos). */
  subfolder?: string;
  branch?: string;
  /** The source's own date (last record, else mtime), ISO. */
  date: string;
  /** Answered structured questions (sessions). */
  questions: number;
  /** ```decision blocks (plan files). */
  decisions: number;
  /** Free-text sessions: the answers {agent} would turn into decisions (§4). */
  answers?: number;
  hasPlan: boolean;
  status: RowStatus;
  /** "structured" imports as is; "agent" needs {agent} to turn free-text answers into decisions (§4). */
  importable: "structured" | "agent";
  planId?: string;
  compacted?: boolean;
  /** Questions with no answer (a session cut short). */
  unanswered?: number;
  error?: string;
}

export interface Budget {
  ms: number;
  paths: number;
  planBytes: number;
  transcriptBytes: number;
}
export const BUDGET: Budget = { ms: 1500, paths: 5000, planBytes: 1 << 20, transcriptBytes: 16 << 20 };
const IN_PROGRESS_MS = 2 * 60_000;
const CODEX_DAYS = 90;
const SKIP_DIRS = new Set(["node_modules", ".git", "dist", "build", "out", ".next", "target", "vendor", ".venv"]);
const PLAN_FOLDERS = [".cursor/plans", ".claude/plans", "docs/plans", "plans"];

interface CacheEntry {
  mtimeMs: number;
  size: number;
  /** null: read and doesn't qualify, so it isn't read again until it changes. Absent: only the first line was read (Codex, another project). */
  extract?: Extract | null;
  /** Codex: the rollout's cwd from its first line. */
  cwd?: string;
  seen: number;
}
/** The last scan's rows for a launch folder, shown at once on the next launch while it re-checks (§1). */
interface CachedResult {
  project: Project;
  rows: Row[];
  partial: boolean;
  scannedAt: string;
  /** Row id → sources.json key, so a cached row that was imported since reads as imported. */
  fps: Record<string, string>;
}
interface Cache {
  /** 2: extracts carry free-text pairs (§4), and `results` holds the last rows per launch folder. */
  v: 2;
  entries: Record<string, CacheEntry>;
  results?: Record<string, CachedResult>;
}

interface SourceEntry {
  planId: string;
  contentHash: string;
  importedAt: string;
  app: Extract["app"];
  path: string;
  sessionId?: string;
  project: string;
}
interface Sources {
  v: 1;
  sources: Record<string, SourceEntry>;
}

export interface ScanStats {
  paths: number;
  read: number;
  cached: number;
}

export interface ScanResult {
  project: Project;
  rows: Row[];
  /** The budget ran out: these are the rows found so far. */
  partial: boolean;
  scannedAt: string;
  ms: number;
  stats: ScanStats;
}

export const fingerprint = (app: string, file: string, sessionId?: string) => `${app}:${file}${sessionId ? `#${sessionId}` : ""}`;
export const rowId = (fp: string) => createHash("sha256").update(fp).digest("hex").slice(0, 16);

export interface FoundOptions {
  store: Store;
  cwd: string;
  home?: string;
  env?: NodeJS.ProcessEnv;
  /** --no-scan / GRILLADO_NO_SCAN=1. */
  off?: boolean;
  budget?: Partial<Budget>;
  now?: () => number;
}

/** §4: {agent} turns a free-text session's answers into decisions. Resolves with them, or a failure code. */
export type AgentRun = (x: Extract, signal: AbortSignal) => Promise<{ ok: true; decisions: AgentDecision[] } | { ok: false; code: string }>;

/** What an import wrote, for the caller (the server keeps its live copy in step). */
export interface Writer {
  load(id: string): Session | null;
  create(s: Session, markdown: string | null): void;
  save(s: Session, markdown: string | null, conflict: string | null): void;
}

export interface ImportResult {
  planId: string;
  result: "created" | "updated" | "unchanged" | "conflict";
  /** plan.conflict.md, when the user had edited the plan since the import. */
  conflictPath?: string;
  /** What was read, for the plan's Activity entry (§5). */
  source?: { app: Extract["app"]; kind: Extract["kind"]; path: string; date: string; answers: number; hasPlan: boolean; compacted: boolean; ideaFromSummary: boolean; viaAgent: boolean; project: string };
}

export class FoundService {
  readonly home: string;
  readonly env: NodeJS.ProcessEnv;
  readonly skip: SkipReason | null;
  private budget: Budget;
  private now: () => number;
  project: Project | null = null;
  state: "off" | "idle" | "scanning" | "done" = "idle";
  last: ScanResult | null = null;
  private running: Promise<ScanResult> | null = null;
  private importing = new Map<string, Promise<ImportResult>>();
  private launchedAt: number;
  private importedThisLaunch = false;
  /** Rows' source data from the last scan, by row id (paths, extracts), for import. */
  private found = new Map<string, { row: Row; extract: Extract | null; fp: string }>();
  /** The last scan from an earlier launch in this folder, until this launch's scan is done (§1). */
  private cached: CachedResult | null = null;
  /** §4: one agent import at a time; the rest wait in click order. */
  private agentRunning: { id: string; controller: AbortController } | null = null;
  private agentQueue: { id: string; go: () => void; controller: AbortController }[] = [];
  onChange?: () => void;

  constructor(private o: FoundOptions) {
    this.home = o.home ?? os.homedir();
    this.env = o.env ?? process.env;
    this.budget = { ...BUDGET, ...o.budget };
    this.now = o.now ?? Date.now;
    this.launchedAt = this.now();
    this.skip = skipReason(o.cwd, { home: this.home, dataDir: o.store.dir, off: o.off });
    if (this.skip) this.state = "off";
    else {
      const c = this.readCache().results?.[norm(o.cwd)];
      if (c) {
        this.cached = c;
        this.project = c.project;
      }
    }
  }

  private readCache(): Cache {
    try {
      const v = JSON.parse(readFileSync(this.cacheFile, "utf8"));
      return v && v.v === 2 ? v : { v: 2, entries: {} };
    } catch {
      return { v: 2, entries: {} };
    }
  }

  private get cacheFile() {
    return path.join(this.o.store.dir, "scan-cache.json");
  }
  private get sourcesFile() {
    return path.join(this.o.store.dir, "sources.json");
  }
  private get claudeDir() {
    return this.env.CLAUDE_CONFIG_DIR || path.join(this.home, ".claude");
  }
  private get codexDir() {
    return this.env.CODEX_HOME || path.join(this.home, ".codex");
  }

  private readJson<T>(file: string, empty: T): T {
    try {
      const v = JSON.parse(readFileSync(file, "utf8"));
      return v && v.v === 1 ? v : empty;
    } catch {
      return empty;
    }
  }
  readSources(): Sources {
    return this.readJson<Sources>(this.sourcesFile, { v: 1, sources: {} });
  }
  private updateSources(fn: (s: Sources) => void) {
    withLock(this.sourcesFile, () => {
      const s = this.readSources();
      fn(s);
      writeAtomic(this.sourcesFile, `${JSON.stringify(s, null, 2)}\n`);
    });
  }

  /** Scan now (or join the scan in progress). The first scan of a launch counts toward stats.json. */
  scan(): Promise<ScanResult> {
    if (this.skip) return Promise.reject(new Error("The scan is off here."));
    if (this.running) return this.running;
    const first = !this.last;
    this.state = "scanning";
    this.onChange?.();
    this.running = this.doScan()
      .then((r) => {
        this.last = r;
        this.state = "done";
        if (first) this.stat((f) => (f.projectLaunches = (f.projectLaunches ?? 0) + 1));
        return r;
      })
      .finally(() => {
        this.running = null;
        this.onChange?.();
      });
    return this.running;
  }

  private async doScan(): Promise<ScanResult> {
    const t0 = this.now();
    const deadline = t0 + this.budget.ms;
    // Resolved again on every scan: the branch may have changed since the cached result.
    this.project = await resolveProject(this.o.cwd);
    const project = this.project;
    const cache = this.readCache();
    const stats: ScanStats = { paths: 0, read: 0, cached: 0 };
    let partial = false;
    const out = () => {
      if (this.now() > deadline || stats.paths >= this.budget.paths) partial = true;
      return partial;
    };
    const found: { file: string; extract: Extract | null; mtimeMs: number; error?: string }[] = [];
    const seen = this.now();

    /**
     * Read (or take from the cache) one file. The cache holds what the file says, never whether it
     * belongs to this project (one cache serves every project): `parse` is project-free, `accept`
     * decides. `peek` (Codex) reads only the first line to learn the cwd, and the rest only if it fits.
     */
    const take = async (
      file: string,
      cap: number,
      o: { parse: (text: string, truncated: boolean) => Extract | null; accept?: (x: Extract) => boolean; peek?: (firstLine: string) => string | undefined; fits?: (cwd: string) => boolean },
    ) => {
      let st;
      try {
        st = await stat(file);
      } catch {
        return;
      }
      const keep = (extract: Extract | null) => {
        if (extract && (o.accept?.(extract) ?? true)) found.push({ file, extract, mtimeMs: st.mtimeMs });
      };
      let e = cache.entries[file];
      if (e && (e.mtimeMs !== st.mtimeMs || e.size !== st.size)) e = undefined as never;
      const skip = (cwd?: string) => o.fits && (!cwd || !o.fits(cwd));
      if (e && (e.extract !== undefined || skip(e.cwd))) {
        stats.cached++;
        e.seen = seen;
        if (e.extract !== undefined) keep(e.extract);
        return;
      }
      try {
        if (o.peek) {
          const cwd = e?.cwd ?? o.peek(await firstLine(file));
          if (skip(cwd)) {
            stats.read++;
            cache.entries[file] = { mtimeMs: st.mtimeMs, size: st.size, ...(cwd ? { cwd } : {}), seen };
            return;
          }
        }
        const { text, truncated } = await readHead(file, cap, st.size);
        stats.read++;
        const extract = o.parse(text, truncated);
        cache.entries[file] = { mtimeMs: st.mtimeMs, size: st.size, extract, ...(extract?.cwd ? { cwd: extract.cwd } : {}), seen };
        keep(extract);
      } catch (err: any) {
        found.push({ file, extract: null, mtimeMs: st.mtimeMs, error: err?.code === "EACCES" ? "No permission to read it." : "Couldn't read it." });
      }
    };
    const here = (cwd?: string) => !!cwd && isUnder(project.root, cwd);

    // 1. In-repo plan files (the known plan folders first: they're read even when gitignored).
    const seenFiles = new Set<string>();
    const planFile = async (rel: string) => {
      const file = path.join(project.root, rel);
      if (seenFiles.has(file) || out()) return;
      seenFiles.add(file);
      stats.paths++;
      const id = exportedPlanId(rel);
      if (id && this.o.store.load(id)) return; // a Grillado export of a plan that's still here: it's in Recent already
      if (!isPlanCandidate(rel)) return;
      await take(file, this.budget.planBytes, { parse: (text) => parsePlanFile(rel, text) });
    };
    for (const dir of PLAN_FOLDERS) {
      for (const rel of await walk(project.root, dir, 6, () => out(), false)) await planFile(rel);
    }
    const listed = project.git ? await gitFiles(project.root) : null;
    for (const rel of listed ?? (await walk(project.root, "", 6, () => out(), true))) {
      if (out()) break;
      await planFile(rel);
    }

    // 2. Claude Code: ~/.claude/projects/<encoded path>*/<session>.jsonl, confirmed by the records' cwd.
    const plansDir = path.join(this.claudeDir, "plans");
    const projects = path.join(this.claudeDir, "projects");
    const encoded = project.root.replace(/[^a-zA-Z0-9]/g, "-");
    for (const d of (await readdir(projects).catch(() => [] as string[])).filter((d) => d.startsWith(encoded))) {
      if (out()) break;
      const files = (await readdir(path.join(projects, d)).catch(() => [] as string[])).filter((f) => f.endsWith(".jsonl") && !/\.(orphaned|superseded)-/.test(f));
      for (const f of files) {
        if (out()) break;
        stats.paths++;
        await take(path.join(projects, d, f), this.budget.transcriptBytes, {
          parse: (text, truncated) => {
            const x = parseClaude(text, { plansDir, truncated });
            return x.qualifies ? x : null;
          },
          accept: (x) => here(x.cwd),
        });
      }
    }

    // 3. Codex: rollouts by date, newest first, 90 days back; only the first line says which project.
    for (const file of await codexFiles(path.join(this.codexDir, "sessions"), this.now(), () => out())) {
      if (out()) break;
      stats.paths++;
      await take(file, this.budget.transcriptBytes, {
        peek: (line) => codexMeta(line)?.cwd,
        fits: here,
        parse: (text, truncated) => {
          const x = parseCodex(text, { truncated });
          return x.qualifies ? x : null;
        },
        accept: (x) => here(x.cwd),
      });
    }

    // 4. Cursor plans in the home folder count only when they name a path in this project.
    const homePlans = path.join(this.home, ".cursor", "plans");
    for (const f of (await readdir(homePlans).catch(() => [] as string[])).filter((f) => f.endsWith(".plan.md"))) {
      if (out()) break;
      stats.paths++;
      await take(path.join(homePlans, f), this.budget.planBytes, {
        parse: (text) => parsePlanFile(f, text, "cursor"),
        accept: (x) => mentionedPaths(x.plan?.markdown ?? "").some((p) => existsSync(path.join(project.root, p))),
      });
    }

    const rows = await this.toRows(project, found, plansDir);
    const scannedAt = new Date(this.now()).toISOString();

    // Prune cache entries unseen for 90 days, keep this result for the next launch, then save it.
    for (const [k, e] of Object.entries(cache.entries)) if (seen - (e.seen ?? 0) > CODEX_DAYS * 86_400_000) delete cache.entries[k];
    const fps: Record<string, string> = {};
    for (const [id, h] of this.found) fps[id] = h.fp;
    cache.results = { ...cache.results, [norm(this.o.cwd)]: { project, rows, partial, scannedAt, fps } };
    const keys = Object.keys(cache.results);
    for (const k of keys.slice(0, Math.max(0, keys.length - 50))) delete cache.results[k];
    try {
      writeAtomic(this.cacheFile, JSON.stringify(cache));
    } catch {}
    return { project, rows, partial, scannedAt, ms: this.now() - t0, stats };
  }

  /** Attach referenced Claude plan files, dedupe, and give each row its status from sources.json. */
  private async toRows(project: Project, found: { file: string; extract: Extract | null; mtimeMs: number; error?: string }[], plansDir: string): Promise<Row[]> {
    const sources = this.readSources().sources;
    const rows: Row[] = [];
    const byHash = new Map<string, Row>();
    this.found.clear();
    for (const f of found) {
      let x = f.extract;
      if (x && x.kind === "session" && !x.plan && x.planRefs.length) x = await withPlanFile(x, plansDir, this.budget.planBytes);
      if (x && !x.qualifies) continue;
      const fp = fingerprint(x?.app ?? (f.file.endsWith(".jsonl") ? (f.file.includes(`${path.sep}.codex${path.sep}`) ? "codex" : "claude") : "file"), f.file, x?.sessionId);
      const src = sources[fp];
      const planId = src && this.o.store.load(src.planId) ? src.planId : undefined;
      const inProgress = x?.kind === "session" && this.now() - f.mtimeMs < IN_PROGRESS_MS;
      const hash = x ? contentHash(x) : "";
      const status: RowStatus = !x ? "error" : inProgress ? "in_progress" : planId ? (src!.contentHash === hash ? "imported" : "changed") : "new";
      const rel = path.relative(project.root, f.file);
      const sub = x?.cwd ? path.relative(project.root, real(x.cwd)) : "";
      const row: Row = {
        id: rowId(fp),
        app: x?.app ?? "file",
        kind: x?.kind ?? "session",
        title: x ? redact(x.title, x.idea) : path.basename(f.file),
        path: f.file,
        ...(x?.kind === "plan" && !rel.startsWith("..") ? { relPath: rel.split(path.sep).join("/") } : {}),
        ...(sub && !sub.startsWith("..") ? { subfolder: sub.split(path.sep).join("/") } : {}),
        ...(x?.branch ? { branch: x.branch } : {}),
        date: x?.date && !Number.isNaN(Date.parse(x.date)) ? new Date(x.date).toISOString() : new Date(f.mtimeMs).toISOString(),
        questions: x ? x.qa.filter((q) => q.answer !== undefined).length : 0,
        decisions: x?.decisions ?? 0,
        hasPlan: !!x?.plan,
        status,
        importable: x?.qualifies === "freetext" ? "agent" : "structured",
        ...(x?.pairs?.length ? { answers: x.pairs.length } : {}),
        ...(planId ? { planId } : {}),
        ...(x?.compacted ? { compacted: true } : {}),
        ...(x && x.qa.some((q) => q.answer === undefined) ? { unanswered: x.qa.filter((q) => q.answer === undefined).length } : {}),
        ...(f.error ? { error: f.error } : {}),
      };
      // The same plan in two places (a Cursor plan saved to the workspace and its home copy) is one row.
      if (x?.kind === "plan") {
        const twin = byHash.get(hash);
        if (twin) {
          if (twin.relPath || !row.relPath) continue;
          rows.splice(rows.indexOf(twin), 1);
        }
        byHash.set(hash, row);
      }
      rows.push(row);
      this.found.set(row.id, { row, extract: x, fp });
    }
    const rank = (r: Row) => (r.status === "in_progress" ? 1 : 0);
    return rows.sort((a, b) => rank(a) - rank(b) || b.date.localeCompare(a.date));
  }

  /** Imported plans of this project whose source is gone, changed, or still the same. */
  planStates(): Record<string, "current" | "changed" | "gone"> {
    const out: Record<string, "current" | "changed" | "gone"> = {};
    if (!this.project) return out;
    for (const e of Object.values(this.readSources().sources)) {
      if (norm(e.project) !== norm(this.project.root)) continue;
      if (!existsSync(e.path)) out[e.planId] = "gone";
      else {
        const r = this.last?.rows.find((x) => x.planId === e.planId);
        out[e.planId] = r?.status === "changed" ? "changed" : "current";
      }
    }
    return out;
  }

  hidden(): boolean {
    return !!this.project && (this.o.store.readConfig().foundHidden ?? []).includes(this.project.root);
  }

  setHidden(hide: boolean) {
    if (!this.project) throw new Error("Not in a project.");
    const c = this.o.store.readConfig();
    const set = new Set(c.foundHidden ?? []);
    if (hide) set.add(this.project.root);
    else set.delete(this.project.root);
    this.o.store.writeConfig({ ...c, foundHidden: [...set] });
  }

  /** Rows from the last launch, with what was imported since then marked so (they never import twice). */
  private cachedRows(c: CachedResult): Row[] {
    const sources = this.readSources().sources;
    return c.rows.map((r) => {
      const src = sources[c.fps[r.id] ?? ""];
      return src && r.status === "new" && this.o.store.load(src.planId) ? { ...r, status: "imported" as const, planId: src.planId } : r;
    });
  }

  /** GET /api/found and list_project_sources. Cache-first: until this launch's scan is done, the last one's rows. */
  view() {
    if (this.skip) return { enabled: false as const, reason: this.skip };
    const c = !this.last ? this.cached : null;
    const failed: Record<string, string> = {};
    for (const [id, code] of this.agentFailed) failed[id] = code;
    return {
      enabled: true as const,
      state: this.state,
      /** The rows are the last launch's, shown while this launch re-checks quietly (no skeleton). */
      cached: !!c,
      project: this.project,
      hidden: this.hidden(),
      partial: this.last?.partial ?? c?.partial ?? false,
      scannedAt: this.last?.scannedAt ?? c?.scannedAt ?? null,
      rows: this.last?.rows ?? (c ? this.cachedRows(c) : []),
      plans: this.planStates(),
      /** §4: the agent import running now, the ones waiting (in order), and the last failure per row. */
      agent: { running: this.agentRunning?.id ?? null, waiting: this.agentQueue.map((q) => q.id), failed },
    };
  }

  /** §5: an imported plan's source as its meta line shows it, and the row id its Update re-imports. */
  sourceInfo(s: Session): { state: "current" | "changed" | "gone"; row: string } | null {
    if (!s.source) return null;
    const row = rowId(s.source.fingerprint);
    if (!existsSync(s.source.path)) return { state: "gone", row };
    const r = this.found.get(row)?.row;
    return { state: r?.status === "changed" ? "changed" : "current", row };
  }

  /** §4: Stop an agent import (running or waiting). The row goes back to New; nothing is saved. */
  stop(id: string): boolean {
    this.agentFailed.delete(id);
    if (this.agentRunning?.id === id) {
      this.agentRunning.controller.abort();
      return true;
    }
    const q = this.agentQueue.find((x) => x.id === id);
    if (!q) return false;
    q.controller.abort();
    this.agentQueue = this.agentQueue.filter((x) => x !== q);
    q.go();
    this.onChange?.();
    return true;
  }

  private agentFailed = new Map<string, string>();

  /** Wait for the agent slot (click order), then run `fn` in it. */
  private async inAgentSlot<T>(id: string, fn: (signal: AbortSignal) => Promise<T>): Promise<T> {
    const controller = new AbortController();
    if (this.agentRunning) {
      await new Promise<void>((go) => {
        this.agentQueue.push({ id, go, controller });
        this.onChange?.();
      });
    }
    if (controller.signal.aborted) throw new ImportError("stopped", "Stopped. Nothing was saved.");
    this.agentRunning = { id, controller };
    this.onChange?.();
    try {
      return await fn(controller.signal);
    } finally {
      this.agentRunning = null;
      const next = this.agentQueue.shift();
      if (next) next.go();
      else this.onChange?.();
    }
  }

  /**
   * Import (or Update) one row. The source is read again, not taken from the cache. A source that
   * was imported before goes into the same plan: unchanged → nothing happens, changed → update.
   */
  import(id: string, provider: ProviderId, w: Writer = storeWriter(this.o.store), agent?: AgentRun): Promise<ImportResult> {
    const busy = this.importing.get(id);
    if (busy) return busy;
    const p = this.doImport(id, provider, w, agent).finally(() => this.importing.delete(id));
    this.importing.set(id, p);
    return p;
  }

  private async doImport(id: string, provider: ProviderId, w: Writer, agent?: AgentRun): Promise<ImportResult> {
    if (!this.found.has(id)) await this.scan();
    const hit = this.found.get(id);
    if (!hit || !this.project) throw new ImportError("unknown", "That source isn't in this project's scan any more. Look again.");
    const { row } = hit;
    let st;
    let text;
    try {
      st = await stat(row.path);
      text = (await readHead(row.path, row.kind === "plan" ? this.budget.planBytes : this.budget.transcriptBytes, st.size)).text;
    } catch {
      throw new ImportError("unreadable", "Couldn't read this source.");
    }
    const plansDir = path.join(this.claudeDir, "plans");
    let x: Extract | null =
      row.app === "claude" ? parseClaude(text, { plansDir }) : row.app === "codex" ? parseCodex(text) : parsePlanFile(row.relPath ?? path.basename(row.path), text, row.app);
    if (x && x.kind === "session" && !x.plan && x.planRefs.length) x = await withPlanFile(x, plansDir, this.budget.planBytes);
    if (!x) throw new ImportError("not_qualified", "This source doesn't hold a plan any more.");
    const inProgress = x.kind === "session" && this.now() - st.mtimeMs < IN_PROGRESS_MS;
    const prev = this.readSources().sources[hit.fp];
    let existing = prev ? w.load(prev.planId) : null;
    if (existing && prev!.contentHash === contentHash(x)) return { planId: existing.id, result: "unchanged" };
    let agentDecisions: AgentDecision[] | undefined;
    if (x.qualifies === "freetext" && !inProgress) {
      if (!agent) throw new ImportError("needs_agent", "Turning this session's answers into decisions needs an agent run.");
      const fx = x;
      this.agentFailed.delete(id);
      const r = await this.inAgentSlot(id, async (signal) => {
        const out = await agent(fx, signal).catch(() => ({ ok: false as const, code: "unknown" }));
        if (signal.aborted) throw new ImportError("stopped", "Stopped. Nothing was saved.");
        return out;
      });
      if (!r.ok) {
        this.agentFailed.set(id, r.code);
        throw new ImportError("agent", "The agent couldn't turn the answers into decisions. Nothing was saved.", r.code);
      }
      agentDecisions = r.decisions;
      // The plan may have changed hands while the agent worked.
      existing = prev ? w.load(prev.planId) : null;
    }
    const inp = { extract: x, path: row.path, fingerprint: hit.fp, project: this.project.root, provider: providerFor(row.app, provider), inProgress, ...(agentDecisions ? { agentDecisions } : {}) };
    let result: ImportResult;
    if (existing) {
      const disk = this.o.store.readPlan(existing.id);
      const u = updateFromSource(existing, inp, disk, new Date(this.now()));
      w.save(existing, u.markdown, u.conflict);
      result = { planId: existing.id, result: u.conflict ? "conflict" : "updated", ...(u.conflict ? { conflictPath: path.join(this.o.store.sessionDir(existing.id), "plan.conflict.md") } : {}) };
    } else {
      const { session, markdown } = sessionFromSource(inp, new Date(this.now()));
      w.create(session, markdown);
      result = { planId: session.id, result: "created" };
    }
    this.updateSources((s) => {
      s.sources[hit.fp] = { planId: result.planId, contentHash: contentHash(x!), importedAt: new Date(this.now()).toISOString(), app: x!.app, path: row.path, ...(x!.sessionId ? { sessionId: x!.sessionId } : {}), project: this.project!.root };
    });
    Object.assign(row, { status: "imported", planId: result.planId });
    result.source = {
      app: x.app,
      kind: x.kind,
      path: row.path,
      date: row.date,
      answers: x.kind === "plan" ? row.decisions : agentDecisions ? (x.pairs?.length ?? 0) : x.qa.filter((q) => q.answer !== undefined).length,
      hasPlan: !!x.plan,
      compacted: x.compacted,
      ideaFromSummary: x.ideaFromSummary,
      viaAgent: !!agentDecisions,
      project: this.project.name,
    };
    if (!this.importedThisLaunch) {
      this.importedThisLaunch = true;
      const ms = this.now() - this.launchedAt;
      this.stat((f) => {
        f.launchesWithImport = (f.launchesWithImport ?? 0) + 1;
        f.firstPlanMs = [...(f.firstPlanMs ?? []), ms].slice(-200);
      });
    }
    this.onChange?.();
    return result;
  }

  /** Local counters for the item's target metric (no telemetry, §14.4). */
  private stat(fn: (f: { projectLaunches?: number; launchesWithImport?: number; firstPlanMs?: number[] }) => void) {
    const file = path.join(this.o.store.dir, "stats.json");
    try {
      withLock(file, () => {
        let s: any = {};
        try {
          s = JSON.parse(readFileSync(file, "utf8"));
        } catch {}
        s.found ??= {};
        fn(s.found);
        writeAtomic(file, `${JSON.stringify(s, null, 2)}\n`);
      });
    } catch {}
  }
}

/** The session's provider follows the source when Grillado has it, else the user's pick. */
const providerFor = (app: Extract["app"], fallback: ProviderId): ProviderId => (app === "claude" ? "claude" : app === "codex" ? "codex" : fallback);

/** Writes through the Store (the MCP server, and tests). The web app passes its own, to keep live copies in step. */
export function storeWriter(store: Store): Writer {
  const write = (s: Session, md: string | null, conflict: string | null) => {
    if (md !== null && s.plan) s.plan.path = store.writePlan(s.id, md);
    if (conflict !== null) store.writeConflict(s.id, conflict);
  };
  return {
    load: (id) => store.load(id),
    create: (s, md) => {
      if (md !== null && s.plan) s.plan.path = store.planPath(s.id);
      store.create(s);
      write(s, md, null);
    },
    save: (s, md, conflict) => {
      write(s, md, conflict);
      store.save(s);
    },
  };
}

// ---------------------------------------------------------------- file helpers

/** The first `cap` bytes, cut back to the last full line when the file is longer. */
async function readHead(file: string, cap: number, size: number): Promise<{ text: string; truncated: boolean }> {
  if (size <= cap) return { text: await readFile(file, "utf8"), truncated: false };
  const fh = await open(file, "r");
  try {
    const buf = Buffer.alloc(cap);
    const { bytesRead } = await fh.read(buf, 0, cap, 0);
    const text = buf.subarray(0, bytesRead).toString("utf8");
    return { text: text.slice(0, text.lastIndexOf("\n") + 1), truncated: true };
  } finally {
    await fh.close();
  }
}

/** The first line (up to 64 KB): Codex's session_meta. */
async function firstLine(file: string): Promise<string> {
  const fh = await open(file, "r");
  try {
    const buf = Buffer.alloc(64 * 1024);
    const { bytesRead } = await fh.read(buf, 0, buf.length, 0);
    const t = buf.subarray(0, bytesRead).toString("utf8");
    const nl = t.indexOf("\n");
    return nl < 0 ? t : t.slice(0, nl);
  } finally {
    await fh.close();
  }
}

/** The newest plan file a Claude session wrote or named (only under the shared plans folder). */
async function withPlanFile(x: Extract, plansDir: string, cap: number): Promise<Extract> {
  let best: { file: string; m: number } | null = null;
  for (const f of x.planRefs) {
    if (path.dirname(f) !== plansDir) continue;
    const st = await stat(f).catch(() => null);
    if (st && st.size <= cap && (!best || st.mtimeMs > best.m)) best = { file: f, m: st.mtimeMs };
  }
  if (!best) return x;
  const md = (await readFile(best.file, "utf8")).trim();
  if (!md) return x;
  const title = /^#\s+(.+?)\s*#*\s*$/m.exec(md)?.[1]?.trim();
  return { ...x, plan: { title, markdown: md }, title: title ?? x.title };
}

async function gitFiles(root: string): Promise<string[] | null> {
  const out = await run("git", ["ls-files", "-co", "--exclude-standard", "-z"], root);
  return out === null ? null : out.split("\0").filter(Boolean);
}

/** Repo-relative .md paths under `sub`; with `skip`, the usual build and dot folders are left out. */
async function walk(root: string, sub: string, depth: number, stop: () => boolean, skip: boolean): Promise<string[]> {
  const out: string[] = [];
  const go = async (rel: string, d: number) => {
    if (d > depth || stop()) return;
    const ents = await readdir(path.join(root, rel), { withFileTypes: true }).catch(() => []);
    for (const e of ents) {
      if (stop()) return;
      const r = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) {
        if (skip && (SKIP_DIRS.has(e.name) || e.name.startsWith("."))) continue;
        await go(r, d + 1);
      } else if (e.isFile()) out.push(r);
    }
  };
  await go(sub, sub ? sub.split("/").length : 0);
  return out;
}

/** `<root>/YYYY/MM/DD/rollout-*.jsonl`, newest day first, back 90 days. */
async function codexFiles(root: string, now: number, stop: () => boolean): Promise<string[]> {
  const out: string[] = [];
  const oldest = new Date(now - CODEX_DAYS * 86_400_000).toISOString().slice(0, 10);
  const desc = async (dir: string) => (await readdir(dir).catch(() => [] as string[])).filter((n) => /^\d+$/.test(n)).sort().reverse();
  for (const y of await desc(root)) {
    for (const m of await desc(path.join(root, y))) {
      for (const d of await desc(path.join(root, y, m))) {
        if (`${y}-${m}-${d}` < oldest || stop()) return out;
        const files = (await readdir(path.join(root, y, m, d)).catch(() => [] as string[])).filter((f) => /^rollout-.*\.jsonl$/.test(f)).sort().reverse();
        out.push(...files.map((f) => path.join(root, y, m, d, f)));
      }
    }
  }
  return out;
}
