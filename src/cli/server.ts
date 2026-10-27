import { randomBytes, timingSafeEqual } from "node:crypto";
import { type FSWatcher, createReadStream, existsSync, mkdtempSync, rmSync, statSync, unwatchFile, watch, watchFile } from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { decisionsFromAnswers, nextRound, replyToComment, suggestAddPlan, suggestDiagram, suggestEdits, synthesize } from "../core/engine.ts";
import { addPlanSuggestion, inPlan } from "../core/addplan.ts";
import { DIAGRAM_KINDS, type DiagramKind, addDiagramSuggestion, withCode, planSections } from "../core/diagrams.ts";
import { type ActivityLine, RunRecorder, type RunKind, type RunTarget, fold, interrupted, parseLines, reasonText } from "../core/activity.ts";
import { addComment, addMessage, adoptThreads, addSuggestions, decisionAt, deleteThread, finishRun, pending, pruneSuggestions, refind, resolveThread, restoreThread, review, sectionAt, settleThreads, startRun, threadSection, undoReview } from "../core/comments.ts";
import { redact } from "../core/filter.ts";
import { killAllChildren } from "../core/providers/process.ts";
import { type Detection, PROVIDER_IDS, type ProviderAdapter, type ProviderId } from "../core/providers/types.ts";
import {
  type Answer,
  UNKNOWN_OPTION,
  type Session,
  acceptStreak,
  answerOpenDecision,
  changeDecision,
  createSession,
  dismissNudge,
  editPlan,
  adoptExternalPlan,
  confirmExternal,
  dismissExternal,
  planAnswerEdits,
  reaskStale,
  saveAnswerEdits,
  keepGoing,
  reopen,
  setError,
  shouldNudge,
  startSynthesis,
  submitAnswers,
  userText,
  wrapUp,
} from "../core/session.ts";
import { textHash } from "../core/text-hash.ts";
import { buildTree } from "../core/tree.ts";
import { type McpLaunch, mcpLaunch } from "./launch.ts";
import { canOpenBrowser, openBrowser } from "./open.ts";
import { type AgentRun, type FoundService, type ImportResult, type Writer, storeWriter } from "./found.ts";
import { stripInvocation } from "../core/found/extract.ts";
import { ImportError } from "../core/found/import.ts";
import type { Store } from "./store.ts";

export const LOOPBACK = "127.0.0.1";

export interface ServerOptions {
  adapters: ProviderAdapter[];
  store: Store;
  webDir: string;
  host?: string;
  port: number;
  strictPort: boolean;
  provider?: ProviderId;
  model?: string;
  timeoutMs?: number;
  onQuit?: () => void;
  /** How an editor starts `grillado mcp`, for "Use in your editor" (v1.2 item 1). */
  mcpLaunch?: McpLaunch;
  /** "Found in this project" (v1.3 item 1): the launch folder's scan. None: the feature is off. */
  found?: FoundService;
}

export interface ProviderInfo {
  id: ProviderId;
  displayName: string;
  installHint: string;
  loginHint: string;
  detection: Detection;
}

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
  ".json": "application/json; charset=utf-8",
  ".woff2": "font/woff2",
};

/** Grillado listens on 127.0.0.1 only (AC10). Anything else is refused before we touch the network. */
export function assertLoopback(host: string) {
  if (host !== LOOPBACK) throw new Error(`Refusing to listen on ${host}: Grillado only listens on ${LOOPBACK}.`);
}

export class GrilladoServer {
  readonly token = randomBytes(24).toString("base64url");
  private server: http.Server;
  private providers: ProviderInfo[] = [];
  private selected: ProviderId | null = null;
  private sessions = new Map<string, Session>();
  private inflight = new Map<string, AbortController>();
  /** Agent runs on comment threads, by thread id. They don't lock the plan, except "Apply feedback". */
  private commentRuns = new Map<string, AbortController>();
  private diagramRuns = new Map<string, AbortController>();
  /** "Add to plan" (#104), by session: one decision at a time. */
  private addPlanRuns = new Map<string, AbortController>();
  private progress = new Map<string, string>();
  private clients = new Set<http.ServerResponse>();
  private agentDirs = new Map<string, string>();
  private watched = new Set<string>();
  private dirWatch?: FSWatcher;
  /** The activity log (item 6): lines read once per session, then appended in memory and on disk. */
  private logs = new Map<string, ActivityLine[]>();
  /** Runs in progress, by session, for the running step shown in the Activity tab. */
  private recorders = new Map<string, Set<RunRecorder>>();
  /** The last run per thread, per "Add diagrams" and per interview, so Try again can say what it retries. */
  private lastRun = new Map<string, string>();
  port = 0;

  constructor(private opts: ServerOptions) {
    if (opts.found) opts.found.onChange = () => this.broadcast({ type: "found" });
    this.server = http.createServer((req, res) => {
      this.handle(req, res).catch((err) => {
        if (!res.headersSent) this.json(res, 500, { error: "Internal error" });
        console.error(err);
      });
    });
  }

  get url() {
    return `http://${LOOPBACK}:${this.port}/?t=${this.token}`;
  }

  get providerList() {
    return this.providers;
  }

  async detect() {
    this.providers = await Promise.all(
      this.opts.adapters.map(async (a) => ({
        id: a.id,
        displayName: a.displayName,
        installHint: a.installHint,
        loginHint: a.loginHint,
        detection: await a.detect(),
      })),
    );
    const ready = this.providers.filter((p) => p.detection.status === "ready").map((p) => p.id);
    const remembered = this.opts.store.readConfig().defaultProvider;
    if (this.opts.provider) this.selected = ready.includes(this.opts.provider) ? this.opts.provider : null;
    else if (this.selected && ready.includes(this.selected)) {
      // keep
    } else if (remembered && ready.includes(remembered)) this.selected = remembered;
    else if (ready.length === 1) this.selected = ready[0];
    else this.selected = null;
    return this.providers;
  }

  async listen(): Promise<number> {
    const host = this.opts.host ?? LOOPBACK;
    assertLoopback(host);
    let port = this.opts.port;
    const last = this.opts.strictPort ? port : port + 20;
    for (;;) {
      try {
        await new Promise<void>((resolve, reject) => {
          const onError = (err: Error) => {
            this.server.off("listening", onListening);
            reject(err);
          };
          const onListening = () => {
            this.server.off("error", onError);
            resolve();
          };
          this.server.once("error", onError);
          this.server.once("listening", onListening);
          this.server.listen({ host, port, exclusive: true });
        });
        const addr = this.server.address();
        if (!addr || typeof addr === "string" || addr.address !== LOOPBACK) throw new Error("Bound to an unexpected address");
        this.port = addr.port;
        // For `grillado mcp`: start_plan links straight to the new session (v1.2 item 1).
        this.opts.store.writeServerInfo({ pid: process.pid, port: this.port, token: this.token });
        this.watchSessions();
        return this.port;
      } catch (err: any) {
        if (err?.code === "EADDRINUSE" && port < last) {
          port++;
          continue;
        }
        if (err?.code === "EADDRINUSE") throw new Error(`Port ${port} is already in use.`);
        throw err;
      }
    }
  }

  address() {
    return this.server.address();
  }

  /** Graceful stop (AC13): kill agent runs, flush sessions, close sockets. */
  async close() {
    for (const c of this.inflight.values()) c.abort();
    for (const c of this.commentRuns.values()) c.abort();
    killAllChildren();
    for (const s of this.sessions.values()) this.opts.store.save(s);
    for (const res of this.clients) res.end();
    for (const dir of this.agentDirs.values()) rmSync(dir, { recursive: true, force: true });
    for (const file of this.watched) unwatchFile(file);
    this.watched.clear();
    this.dirWatch?.close();
    if (this.port) this.opts.store.clearServerInfo(process.pid);
    this.server.closeAllConnections();
    await new Promise<void>((resolve) => this.server.close(() => resolve()));
  }

  // ---------------------------------------------------------------- security

  private hostAllowed(req: http.IncomingMessage) {
    const host = req.headers.host ?? "";
    return host === `${LOOPBACK}:${this.port}` || host === `localhost:${this.port}`;
  }

  private originAllowed(req: http.IncomingMessage) {
    const origin = req.headers.origin;
    if (!origin) return true;
    return origin === `http://${LOOPBACK}:${this.port}` || origin === `http://localhost:${this.port}`;
  }

  private get cookieName() {
    return `grillado_${this.port}`;
  }

  private tokenOk(req: http.IncomingMessage) {
    const header = req.headers["x-grillado-token"];
    const cookie = (req.headers.cookie ?? "")
      .split(";")
      .map((c) => c.trim().split("="))
      .find(([k]) => k === this.cookieName)?.[1];
    const given = typeof header === "string" ? header : cookie;
    if (!given) return false;
    const a = Buffer.from(given);
    const b = Buffer.from(this.token);
    return a.length === b.length && timingSafeEqual(a, b);
  }

  // ---------------------------------------------------------------- http

  private async handle(req: http.IncomingMessage, res: http.ServerResponse) {
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("Referrer-Policy", "no-referrer");
    if (!this.hostAllowed(req)) return this.json(res, 403, { error: "Host not allowed" });
    if (!this.originAllowed(req)) return this.json(res, 403, { error: "Origin not allowed" });
    const url = new URL(req.url ?? "/", `http://${LOOPBACK}:${this.port}`);

    if (!url.pathname.startsWith("/api/")) return this.serveStatic(req, res, url);

    if (!this.tokenOk(req)) return this.json(res, 401, { error: "Open the link printed in your terminal." });
    if (req.method === "POST" && !(req.headers["content-type"] ?? "").startsWith("application/json"))
      return this.json(res, 415, { error: "Expected JSON" });

    const parts = url.pathname.split("/").filter(Boolean).slice(1); // drop "api"
    try {
      const body = req.method === "POST" ? await readJson(req) : {};
      if (req.method === "GET" && parts[0] === "state") return this.json(res, 200, this.appState());
      if (req.method === "GET" && parts[0] === "events") return this.events(req, res);
      if (req.method === "POST" && parts[0] === "rescan") {
        await this.detect();
        this.broadcast({ type: "app" });
        return this.json(res, 200, this.appState());
      }
      if (req.method === "POST" && parts[0] === "provider") return this.selectProvider(res, body);
      if (req.method === "POST" && parts[0] === "quit") {
        this.json(res, 200, { ok: true });
        setTimeout(() => this.opts.onQuit?.(), 50);
        return;
      }
      if (parts[0] === "sessions") return await this.sessionRoutes(req, res, parts.slice(1), body);
      if (parts[0] === "found") return await this.foundRoutes(req, res, parts.slice(1), body);
      return this.json(res, 404, { error: "Not found" });
    } catch (err: any) {
      return this.json(res, 400, { error: err?.message ?? "Bad request" });
    }
  }

  private serveStatic(req: http.IncomingMessage, res: http.ServerResponse, url: URL) {
    if (req.method !== "GET" && req.method !== "HEAD") return this.json(res, 405, { error: "Method not allowed" });
    // The opened URL carries the per-run token once; trade it for a cookie and drop it from the address bar.
    const t = url.searchParams.get("t");
    if (t !== null) {
      if (t === this.token) {
        res.setHeader("Set-Cookie", `${this.cookieName}=${this.token}; Path=/; HttpOnly; SameSite=Strict`);
      }
      // A session link (from `grillado mcp`'s start_plan) keeps its path.
      res.writeHead(302, { Location: /^\/s\/[\w-]+$/.test(url.pathname) ? url.pathname : "/" });
      return res.end();
    }
    const root = path.resolve(this.opts.webDir);
    let file = path.resolve(root, `.${decodeURIComponent(url.pathname)}`);
    if (!file.startsWith(root + path.sep) && file !== root) return this.json(res, 404, { error: "Not found" });
    if (!existsSync(file) || statSync(file).isDirectory()) file = path.join(root, "index.html");
    if (!existsSync(file)) return this.json(res, 500, { error: "Web UI not built" });
    const ext = path.extname(file);
    res.writeHead(200, {
      "Content-Type": MIME[ext] ?? "application/octet-stream",
      "Cache-Control": ext === ".html" ? "no-store" : "public, max-age=31536000, immutable",
      ...(ext === ".html"
        ? {
            "Content-Security-Policy":
              "default-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'",
          }
        : {}),
    });
    if (req.method === "HEAD") return res.end();
    createReadStream(file).pipe(res);
  }

  private json(res: http.ServerResponse, status: number, data: unknown) {
    const body = JSON.stringify(data);
    res.writeHead(status, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
    res.end(body);
  }

  private events(req: http.IncomingMessage, res: http.ServerResponse) {
    res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-store", Connection: "keep-alive" });
    res.write(": connected\n\n");
    this.clients.add(res);
    const ping = setInterval(() => res.write(": ping\n\n"), 15_000);
    req.on("close", () => {
      clearInterval(ping);
      this.clients.delete(res);
    });
  }

  private broadcast(event: unknown) {
    const line = `data: ${JSON.stringify(event)}\n\n`;
    for (const c of this.clients) c.write(line);
  }

  /**
   * plan.md edited outside Grillado (Q5): adopt the file's text and tell the browser, which
   * reloads it on its own when it has no unsaved edits and asks otherwise. Polling (stat every
   * 500 ms) survives editors that save by renaming a new file over the old one.
   */
  private watchPlan(s: Session) {
    if (!s.plan) return;
    const file = this.opts.store.planPath(s.id);
    if (this.watched.has(file)) return;
    this.watched.add(file);
    watchFile(file, { interval: 500 }, (cur, prev) => {
      if (cur.mtimeMs === prev.mtimeMs && cur.size === prev.size) return;
      const live = this.sessions.get(s.id);
      if (!live?.plan) return;
      const md = this.opts.store.readPlan(s.id);
      if (md === null || md === live.plan.markdown) return; // our own write, or nothing new
      // A changed `answer:` with dependents waits for the user (DECISIONS #26); nothing reruns here.
      adoptExternalPlan(live, md);
      // A hand edit in an editor is still a hand edit (§4.7): what no longer fits is counted, not left unplaced.
      pruneSuggestions(live);
      this.opts.store.writePlan(live.id, live.plan.markdown);
      this.log(live, { v: 1, type: "file", what: "reloaded", at: new Date().toISOString() });
      this.changed(live);
    });
  }

  /**
   * `grillado mcp` writes to the same data dir (v1.2 item 1): a new session refreshes Home, and a
   * comment on an open session lands in its rail live. Our own saves adopt those threads too
   * (Store.save), so nothing it wrote is overwritten.
   */
  private watchSessions() {
    if (this.dirWatch) return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      this.dirWatch = watch(path.join(this.opts.store.dir, "sessions"), () => {
        clearTimeout(timer);
        timer = setTimeout(() => this.broadcast({ type: "app" }), 200);
      });
      this.dirWatch.on("error", () => {});
    } catch {}
  }

  private watchSession(s: Session) {
    const file = path.join(this.opts.store.sessionDir(s.id), "session.json");
    if (this.watched.has(file)) return;
    this.watched.add(file);
    watchFile(file, { interval: 500 }, (cur, prev) => {
      if (cur.mtimeMs !== prev.mtimeMs) this.adoptExternal(s.id, true);
    });
  }

  /** Threads another process wrote to session.json since we loaded it. Our own writes add none. */
  private adoptExternal(id: string, push: boolean) {
    const live = this.sessions.get(id);
    const disk = live && this.opts.store.load(id);
    if (!live || !disk || !adoptThreads(live, disk)) return;
    if (push) this.broadcast({ type: "session", session: this.view(live) });
  }

  // ---------------------------------------------------------------- activity log (item 6)

  private lines(s: Session): ActivityLine[] {
    let l = this.logs.get(s.id);
    if (!l) {
      l = parseLines(this.opts.store.readActivity(s.id));
      this.logs.set(s.id, l);
    }
    return l;
  }

  private log(s: Session, ...lines: ActivityLine[]) {
    this.lines(s).push(...lines);
    this.opts.store.appendActivity(s.id, lines);
  }

  /** Start a run's log entry. Its steps are timed back to back; the live one shows in the tab. */
  private record(s: Session, kind: RunKind, target?: RunTarget, retryKey?: string): RunRecorder {
    const retryOf = retryKey ? (this.lastRun.get(retryKey) ?? null) : null;
    const rec = new RunRecorder(
      (line) => this.log(s, line),
      () => this.broadcast({ type: "session", session: this.view(s) }),
      { kind, agent: s.provider, ...(target ? { target } : {}), retryOf },
    );
    const set = this.recorders.get(s.id) ?? new Set();
    set.add(rec);
    this.recorders.set(s.id, set);
    const end = rec.end.bind(rec);
    rec.end = (...a) => {
      end(...a);
      set.delete(rec);
    };
    return rec;
  }

  /** The latest `limit` entries, newest first, with the running steps of live runs. */
  activityView(s: Session, limit = 50) {
    const lines = this.lines(s);
    const live = new Map<string, string>();
    for (const r of this.recorders.get(s.id) ?? []) if (r.current) live.set(r.id, r.current);
    const entries = fold(lines, live).map((e) => (e.type === "import" && e.source ? { ...e, source: { ...e.source, path: tildify(e.source.path), gone: !existsSync(e.source.path) } } : e));
    const first = lines.find((l) => l.type === "run.started");
    // Sessions from before 1.1 had work that wasn't logged (#58).
    // Imported plans (v1.3 item 1) have no runs: their work happened in the source.
    const legacy = !s.source && s.rounds.length > 0 && (!first || Date.parse((first as { at: string }).at) > Date.parse(s.rounds[0].askedAt) + 1000);
    return { entries: entries.slice(0, Math.max(1, Math.min(limit, 5000))), total: entries.length, legacy };
  }

  /** Review lines, one per run whose suggestions were reviewed. */
  private logReview(s: Session, ids: string[], field: "accepted" | "rejected" | "undone") {
    const byRun = new Map<string | null, string[]>();
    for (const id of ids) {
      const run = (s.suggestions ?? []).find((x) => x.id === id)?.run ?? null;
      byRun.set(run, [...(byRun.get(run) ?? []), id]);
    }
    const at = new Date().toISOString();
    for (const [run, list] of byRun)
      this.log(s, { v: 1, type: "review", run, accepted: field === "accepted" ? list : [], rejected: field === "rejected" ? list : [], ...(field === "undone" ? { undone: list } : {}), at });
  }

  private changed(s: Session) {
    // Whatever changed the plan, each comment's position follows its quote inside its section (#114).
    settleThreads(s);
    this.opts.store.save(s);
    this.broadcast({ type: "session", session: this.view(s) });
  }

  // ---------------------------------------------------------------- views

  private appState() {
    const ready = this.providers.filter((p) => p.detection.status === "ready");
    return {
      providers: this.providers.map((p) => ({
        id: p.id,
        // The agent's own name when its binary reports one (v1.1 §5b), else the adapter's.
        displayName: ("name" in p.detection && p.detection.name) || p.displayName,
        installHint: p.installHint,
        loginHint: p.loginHint,
        status: p.detection.status,
        version: "version" in p.detection ? p.detection.version : undefined,
        reason: "reason" in p.detection ? p.detection.reason : undefined,
      })),
      selected: this.selected,
      needsPicker: !this.selected && ready.length > 1,
      remembered: this.opts.store.readConfig().defaultProvider ?? null,
      sessions: this.opts.store.list().slice(0, 20).map((s) => ({
        id: s.id,
        idea: s.idea.slice(0, 140),
        status: s.status,
        rounds: s.rounds.length,
        decisions: Object.keys(s.decisions).length,
        open: s.plan?.openDecisions.length ?? 0,
        updatedAt: s.updatedAt,
        // Imported (v1.3 item 1): where it came from, for Recent's "From Claude Code session" line.
        ...(s.source ? { source: { app: s.source.app, kind: s.source.kind }, ...(s.source.title ? { title: s.source.title } : {}) } : {}),
        from: s.from,
        queued: !!s.queued,
      })),
      dataDir: tildify(this.opts.store.dir),
      // Always present (review N4): without one passed in, the build next to the web dir.
      mcp: this.opts.mcpLaunch ?? mcpLaunch(path.resolve(this.opts.webDir, "..", "cli.js"), this.opts.store.dir),
      // v1.3 item 1 (review-pr21 #1): the Found view comes with the first state, so Home knows the
      // group's space from its first paint and Recent never jumps when /api/found answers later.
      found: this.foundView(),
    };
  }

  /** What the browser sees of a session. Error text from CLIs is scrubbed (AC17). */
  private view(s: Session) {
    return {
      ...s,
      error: s.error ? { ...s.error, message: redact(s.error.message, userText(s)) } : undefined,
      busy: this.inflight.has(s.id),
      applying: this.applying(s),
      drawing: this.diagramRuns.has(s.id),
      // A run cut short by a restart reads as stopped.
      diagramRun: s.diagramRun?.state === "running" && !this.diagramRuns.has(s.id) ? { ...s.diagramRun, state: "stopped", current: undefined } : s.diagramRun,
      adding: this.addPlanRuns.has(s.id),
      addPlanRun: s.addPlanRun?.state === "running" && !this.addPlanRuns.has(s.id) ? { ...s.addPlanRun, state: "stopped" } : s.addPlanRun,
      progress: this.progress.get(s.id),
      planPath: s.plan?.path,
      tree: buildTree(s),
      activity: this.activityView(s),
      // v1.3 item 1 §6: where an imported plan came from, and whether that source changed or is gone.
      ...(s.source ? { sourceInfo: this.sourceInfo(s) } : {}),
      acceptStreak: acceptStreak(s),
      nudge: shouldNudge(s),
    };
  }

  // ---------------------------------------------------------------- found in this project (v1.3 item 1)

  /** §5: the source's state for the plan's meta line, dated like its Activity entry (the source's date). */
  private sourceInfo(s: Session) {
    const at = (this.lines(s).find((l) => l.type === "import") as { at: string } | undefined)?.at ?? s.source!.importedAt;
    const i = this.opts.found && !this.opts.found.skip ? this.opts.found.sourceInfo(s) : null;
    return { ...(i ?? { state: existsSync(s.source!.path) ? ("current" as const) : ("gone" as const), row: "" }), date: at };
  }

  /** The launch scan. Errors stay local: a scan that fails shows nothing, it never stops the app. */
  async scanProject() {
    if (!this.opts.found || this.opts.found.skip) return;
    try {
      await this.opts.found.scan();
    } catch (err) {
      console.error(`grillado: project scan failed: ${(err as Error)?.message ?? err}`);
    }
  }

  private foundView() {
    const f = this.opts.found;
    return f ? f.view() : { enabled: false as const, reason: "off" as const };
  }

  private static FOUND_STATUS: Record<ImportError["code"], number> = { unknown: 404, in_progress: 409, needs_agent: 409, busy: 409, not_qualified: 422, unreadable: 422, filtered: 422, stopped: 409, agent: 502 };

  private async foundRoutes(req: http.IncomingMessage, res: http.ServerResponse, parts: string[], body: any) {
    const f = this.opts.found;
    const view = () => this.foundView();
    if (req.method === "GET" && parts.length === 0) return this.json(res, 200, view());
    if (req.method !== "POST" || parts.length !== 1) return this.json(res, 404, { error: "Not found" });
    if (!f || f.skip) return this.json(res, 409, { error: "The project scan is off.", code: "off" });
    if (parts[0] === "rescan") {
      await f.scan();
      return this.json(res, 200, view());
    }
    if (parts[0] === "dismiss") {
      f.setHidden(body?.hidden !== false);
      this.broadcast({ type: "found" });
      return this.json(res, 200, view());
    }
    if (parts[0] === "stop") {
      if (typeof body?.id !== "string") return this.json(res, 400, { error: "Expected { id }" });
      f.stop(body.id);
      return this.json(res, 200, view());
    }
    if (parts[0] === "import") {
      if (typeof body?.id !== "string") return this.json(res, 400, { error: "Expected { id }" });
      try {
        const r = await f.import(body.id, this.selected ?? this.opts.store.readConfig().defaultProvider ?? PROVIDER_IDS[0], this.foundWriter(), this.foundAgent());
        if ((r.result === "created" || r.result === "updated") && r.source) this.logImport(r.planId, r.result, r.source);
        this.broadcast({ type: "app" });
        return this.json(res, 200, { ...r, url: `/s/${r.planId}`, row: f.last?.rows.find((x) => x.id === body.id) ?? null });
      } catch (err) {
        if (err instanceof ImportError) return this.json(res, GrilladoServer.FOUND_STATUS[err.code], { error: err.message, code: err.code, ...(err.reason ? { reason: err.reason } : {}) });
        throw err;
      }
    }
    return this.json(res, 404, { error: "Not found" });
  }

  /** §4: the selected agent turns a free-text session's answers into decisions, in an empty folder. */
  private foundAgent(): AgentRun {
    return async (x, signal) => {
      const id = this.selected ?? this.opts.store.readConfig().defaultProvider;
      const adapter = this.providers.some((p) => p.id === id && p.detection.status === "ready") ? this.opts.adapters.find((p) => p.id === id) : undefined;
      if (!adapter) return { ok: false, code: "not_found" };
      const cwd = mkdtempSync(path.join(os.tmpdir(), "grillado-import-"));
      try {
        const r = await decisionsFromAnswers(stripInvocation(x.idea), x.pairs ?? [], adapter, { cwd, timeoutMs: this.opts.timeoutMs ?? 180_000, signal });
        return r.ok ? { ok: true, decisions: r.value.decisions } : { ok: false, code: r.code };
      } finally {
        rmSync(cwd, { recursive: true, force: true });
      }
    };
  }

  /** §5 (#154): "Imported from a Claude Code session" in the plan's Activity, dated at the source. */
  private logImport(planId: string, what: "created" | "updated", src: NonNullable<ImportResult["source"]>) {
    const s = this.sessions.get(planId) ?? this.opts.store.load(planId);
    if (!s) return;
    const now = new Date().toISOString();
    this.log(s, {
      v: 1,
      type: "import",
      what: what === "created" ? "imported" : "updated",
      at: what === "created" && src.date ? src.date : now,
      importedAt: now,
      app: src.app,
      kind: src.kind,
      path: src.path,
      answers: src.answers,
      hasPlan: src.hasPlan,
      project: src.project,
      ...(src.compacted ? { compacted: true } : {}),
      ...(src.ideaFromSummary ? { ideaFromSummary: true } : {}),
      ...(src.viaAgent ? { viaAgent: true } : {}),
    });
    if (this.sessions.get(planId) === s) this.broadcast({ type: "session", session: this.view(s) });
  }

  /** Imports go through the live copy when the plan is open, so the browser sees them at once. */
  private foundWriter(): Writer {
    const base = storeWriter(this.opts.store);
    return {
      load: (id) => {
        if (this.inflight.has(id) || this.addPlanRuns.has(id)) throw new ImportError("busy", "The agent is working on this plan. Update it when it's done.");
        return this.sessions.get(id) ?? this.opts.store.load(id);
      },
      create: (s, md) => base.create(s, md),
      save: (s, md, conflict) => {
        base.save(s, md, conflict);
        if (this.sessions.get(s.id) === s) this.broadcast({ type: "session", session: this.view(s) });
      },
    };
  }

  // ---------------------------------------------------------------- sessions

  private getSession(id: string): Session {
    let s = this.sessions.get(id);
    // The watcher polls; a request reads the file too, so it never misses a comment sent over MCP.
    if (s) this.adoptExternal(id, true);
    if (!s) {
      const loaded = this.opts.store.load(id);
      if (!loaded) throw new Error("Session not found");
      s = loaded;
      // plan.md is the source of truth for the plan text: pick up edits made while we were down
      // (or by hand, in another editor).
      const md = s.plan ? this.opts.store.readPlan(id) : null;
      if (s.plan && md !== null && md !== s.plan.markdown) s.plan.markdown = md;
      const queued = s.queued;
      // A run that was cut off by a restart can't resume on its own (AC14): offer Retry.
      if (queued) delete s.queued;
      else if ((s.status === "asking" || s.status === "synthesizing") && !s.error) {
        setError(s, "unknown", "Interrupted. Retry to continue.");
      }
      for (const t of s.comments ?? []) if (t.run?.state === "running") finishRun(t, { ok: false, message: "Interrupted. Retry to continue." });
      this.sessions.set(id, s);
      // Runs with no end were cut off when Grillado closed: written as interrupted now (#57).
      const lines = this.lines(s);
      const ended = interrupted(lines).map((run): ActivityLine => {
        const start = lines.find((l) => l.type === "run.started" && l.id === run) as Extract<ActivityLine, { type: "run.started" }>;
        const ms = lines.reduce((n, l) => n + (l.type === "step" && l.run === run ? l.ms : 0), 0);
        return { v: 1, run, type: "run.ended", status: "interrupted", ms, at: new Date(Date.parse(start.at) + ms).toISOString() };
      });
      if (ended.length) this.log(s, ...ended);
      this.watchPlan(s);
      this.watchSession(s);
      if (queued) {
        // Started from a coding agent (`grillado mcp` start_plan): the first round runs when it's
        // opened here, on the agent picked here.
        if (this.selected) s.provider = this.selected;
        this.startRound(s);
      }
    }
    return s;
  }

  private adapterFor(s: Session) {
    const a = this.opts.adapters.find((x) => x.id === s.provider);
    if (!a) throw new Error("Unknown provider");
    return a;
  }

  private agentCwd(s: Session) {
    let dir = this.agentDirs.get(s.id);
    if (!dir || !existsSync(dir)) {
      dir = mkdtempSync(path.join(os.tmpdir(), "grillado-agent-"));
      this.agentDirs.set(s.id, dir);
    }
    return dir;
  }

  private runOptions(s: Session, controller: AbortController) {
    return {
      cwd: this.agentCwd(s),
      timeoutMs: this.opts.timeoutMs ?? 180_000,
      model: this.opts.model,
      signal: controller.signal,
      onProgress: (label: string) => {
        this.progress.set(s.id, label);
        this.broadcast({ type: "progress", sessionId: s.id, label });
      },
    };
  }

  private run(s: Session, work: (controller: AbortController) => Promise<void>) {
    if (this.inflight.has(s.id)) return;
    const controller = new AbortController();
    this.inflight.set(s.id, controller);
    s.error = undefined;
    this.changed(s);
    work(controller)
      .catch((err) => setError(s, "unknown", String(err?.message ?? err)))
      .finally(() => {
        if (this.inflight.get(s.id) === controller) this.inflight.delete(s.id);
        this.progress.delete(s.id);
        this.changed(s);
      });
  }

  private startRound(s: Session, retry = false) {
    if (this.inflight.has(s.id)) return;
    const n = s.rounds.length + 1;
    const rec = this.record(s, "round", { round: n, ...(s.reopened.length && s.rounds.length ? { reask: true } : {}) }, retry ? `session:${s.id}` : undefined);
    this.lastRun.set(`session:${s.id}`, rec.id);
    this.run(s, async (c) => {
      rec.step("Read the session", "{agent} is picking questions");
      const opts = { ...this.runOptions(s, c), onRepair: () => rec.step("{agent}’s answer didn’t fit the format; asked again", "{agent} is picking questions") };
      try {
        const ok = await nextRound(s, this.adapterFor(s), opts);
        if (c.signal.aborted) return rec.end("stopped", { last: "Stopped while {agent} was picking questions" });
        if (!ok) return rec.end("failed", { reason: s.error?.code ?? null, last: reasonText(s.error?.code, "{agent}") });
        const r = s.rounds.length === n ? s.rounds[n - 1] : null;
        if (!r) {
          rec.step("{agent} found nothing left to ask");
          return rec.end("done", { result: { questions: 0 } });
        }
        rec.step(`{agent} picked ${r.questions.length} ${r.questions.length === 1 ? "question" : "questions"}`);
        rec.step(`Round ${n} ready`);
        rec.end("done", { result: { questions: r.questions.length }, asked: r.questions.map((q) => q.key) });
      } finally {
        rec.end("failed", { reason: "unknown", last: reasonText("unknown", "{agent}") });
      }
    });
  }

  private startPlan(s: Session, retry = false) {
    if (this.inflight.has(s.id)) return;
    const rec = this.record(s, "plan", undefined, retry ? `session:${s.id}` : undefined);
    this.lastRun.set(`session:${s.id}`, rec.id);
    this.run(s, async (c) => {
      try {
        await this.writePlan(s, c, rec);
      } finally {
        rec.end("failed", { reason: "unknown", last: reasonText("unknown", "{agent}") });
      }
    });
  }

  private async writePlan(s: Session, c: AbortController, rec: RunRecorder) {
    {
      const n = Object.keys(s.decisions).length;
      rec.step(`Read ${n} ${n === 1 ? "decision" : "decisions"}`, "{agent} is writing the plan");
      const opts = { ...this.runOptions(s, c), onRepair: () => rec.step("{agent}’s plan didn’t fit the format; asked again", "{agent} is writing the plan") };
      const out = await synthesize(s, this.adapterFor(s), opts);
      if (c.signal.aborted) return rec.end("stopped", { last: "Stopped while {agent} was writing the plan" });
      if (!out.ok) return rec.end("failed", { reason: s.error?.code ?? null, last: reasonText(s.error?.code, "{agent}") });
      rec.step("{agent} wrote the plan", "Saving plan.md");
      // The new plan overwrites plan.md; keep the user's edited version next to it.
      if (s.plan?.editedAt) this.opts.store.keepEditedPlan(s.id);
      const file = this.opts.store.writePlan(s.id, out.markdown);
      s.plan = { title: out.plan.title, markdown: out.markdown, path: file, openDecisions: out.plan.openDecisions, createdAt: new Date().toISOString() };
      s.status = "plated";
      this.watchPlan(s);
      const sections = planSections(out.markdown).map((x) => x.title);
      rec.step("Saved plan.md");
      rec.end("done", { result: { decisions: n, sections: sections.length }, wrote: sections });
    }
  }

  /** "Apply feedback" is running on one of this session's threads (one at a time; the plan stays editable). */
  private applying(s: Session) {
    return (s.comments ?? []).some((t) => t.run?.kind === "apply" && t.run.state === "running" && this.commentRuns.has(t.id));
  }

  private commentRoute(s: Session, threadId: string | undefined, op: string | undefined, body: any, busy: boolean) {
    const live = (id: string) => this.commentRuns.has(id);
    if (!threadId) {
      const t = addComment(s, { quote: body?.quote, at: body?.at, text: body?.text });
      this.startComment(s, t.id, "reply"); // the agent replies to every comment (N2)
      return;
    }
    if (op === "restore") {
      restoreThread(s, threadId);
      this.changed(s);
      return;
    }
    const t = (s.comments ?? []).find((c) => c.id === threadId);
    if (!t) throw new Error("That comment is gone.");
    switch (op) {
      case "reply":
        if (live(t.id)) throw new Error("The agent is still on this thread.");
        addMessage(s, t.id, "you", String(body?.text ?? ""));
        this.startComment(s, t.id, "reply");
        return;
      case "apply":
        if (live(t.id)) throw new Error("The agent is still on this thread.");
        if (busy || this.applying(s) || this.diagramRuns.has(s.id) || this.addPlanRuns.has(s.id)) throw new Error("Waiting for the current run.");
        this.startComment(s, t.id, "apply");
        return;
      case "retry":
        if (live(t.id) || !t.run) return;
        if (t.run.kind === "apply" && (busy || this.applying(s))) throw new Error("Waiting for the current run.");
        this.startComment(s, t.id, t.run.kind, true);
        return;
      case "stop":
        this.commentRuns.get(t.id)?.abort();
        return;
      case "resolve":
        resolveThread(s, t.id, body?.resolved !== false);
        this.changed(s);
        return;
      case "delete":
        // A running reply or apply stops first (#99); it ends as "stopped" on the deleted thread.
        this.commentRuns.get(t.id)?.abort();
        deleteThread(s, t.id);
        this.changed(s);
        return;
      default:
        throw new Error("Not found");
    }
  }

  private reviewRoute(s: Session, body: any) {
    const op = String(body?.op ?? "");
    if (op === "drop") {
      // The browser couldn't draw a suggested diagram with Mermaid: it never shows, and counts as skipped (#43).
      const x = (s.suggestions ?? []).find((y) => y.id === String(body?.id) && y.kind === "diagram" && y.status === "pending");
      if (!x) return;
      s.suggestions = (s.suggestions ?? []).filter((y) => y !== x);
      if (s.diagramRun) {
        s.diagramRun.added = Math.max(0, s.diagramRun.added - 1);
        s.diagramRun.skipped++;
      }
      this.changed(s);
      return;
    }
    if (op === "undo") {
      const ids = (s.reviewUndo?.items ?? []).map((x) => x.id);
      if (!undoReview(s)) throw new Error("Nothing to undo.");
      this.logReview(s, ids, "undone");
    } else if (op === "accept" || op === "reject") {
      // Edit on a diagram suggestion accepts it with your changes, as one step (#42).
      const code = typeof body?.code === "string" ? body.code : null;
      if (op === "accept" && code !== null && Array.isArray(body?.ids) && body.ids.length === 1) {
        const x = (s.suggestions ?? []).find((y) => y.id === String(body.ids[0]) && y.kind === "diagram" && y.status === "pending");
        if (!x) throw new Error("Those suggestions were already reviewed.");
        if (!code.trim() || code.length > 8000) throw new Error("The diagram is empty.");
        withCode(x, code);
      }
      // "all" takes every pending suggestion (Accept all / Reject all).
      const before = new Set(pending(s).map((x) => x.id));
      review(s, op, body?.ids === "all" ? pending(s).map((x) => x.id) : body?.ids);
      const done = (s.suggestions ?? []).filter((x) => before.has(x.id) && x.status !== "pending").map((x) => x.id);
      this.logReview(s, done, op === "accept" ? "accepted" : "rejected");
    } else throw new Error("Not found");
    if (op !== "reject") {
      // plan.md only ever holds accepted text (N3).
      s.plan!.editedAt = new Date().toISOString();
      this.opts.store.writePlan(s.id, s.plan!.markdown);
    }
    this.changed(s);
  }

  /** "Add diagrams" (item 5): start (chosen sections, or the one at `at` from the slash menu), stop, retry. */
  private diagramRoute(s: Session, body: any, busy: boolean) {
    const op = String(body?.op ?? "start");
    if (op === "stop") return this.diagramRuns.get(s.id)?.abort();
    if (this.diagramRuns.has(s.id)) throw new Error("The agent is already adding diagrams.");
    if (busy || this.applying(s) || this.addPlanRuns.has(s.id)) throw new Error("Waiting for the current run.");
    const md = s.plan?.markdown ?? "";
    const all = planSections(md);
    let titles: string[];
    let kinds: DiagramKind[];
    let focus = "";
    if (op === "retry") {
      const r = s.diagramRun;
      if (!r) throw new Error("Nothing to try again.");
      titles = r.sections.slice(r.done);
      kinds = r.kinds;
      focus = r.focus ?? "";
    } else {
      kinds = (Array.isArray(body?.kinds) ? body.kinds : DIAGRAM_KINDS).filter((k: string) => (DIAGRAM_KINDS as string[]).includes(k));
      if (!kinds.length) throw new Error("Pick at least one kind.");
      focus = String(body?.focus ?? "").trim().slice(0, 300);
      if (op === "one") {
        // The slash menu's "Diagram by {agent}": the section the caret is in.
        const at = Number(body?.at) || 0;
        const sec = [...all].reverse().find((x) => x.start <= at);
        titles = sec ? [sec.title] : [];
      } else {
        const want = new Set(Array.isArray(body?.sections) ? body.sections.map(String) : []);
        titles = all.filter((x) => want.has(x.title)).map((x) => x.title);
      }
    }
    if (!titles.length) throw new Error("Pick at least one section.");
    this.startDiagrams(s, titles, kinds, focus, op === "retry");
  }

  private startDiagrams(s: Session, titles: string[], kinds: DiagramKind[], focus: string, retry = false) {
    const rec = this.record(s, "diagrams", undefined, retry ? `diagrams:${s.id}` : undefined);
    this.lastRun.set(`diagrams:${s.id}`, rec.id);
    const made: { id: string; section: string; note: string }[] = [];
    let repaired = false;
    const controller = new AbortController();
    this.diagramRuns.set(s.id, controller);
    const t0 = Date.now();
    const run: NonNullable<Session["diagramRun"]> = { state: "running", startedAt: new Date().toISOString(), sections: titles, kinds, ...(focus ? { focus } : {}), done: 0, added: 0, skipped: 0 };
    s.diagramRun = run;
    this.changed(s);
    const opts = { ...this.runOptions(s, controller), onProgress: undefined, onRepair: () => (repaired = true) };
    const work = async () => {
      // One section at a time: each suggestion lands as soon as its section is drawn (§18 I).
      for (const title of titles) {
        const md = s.plan?.markdown ?? "";
        const sec = planSections(md).find((x) => x.title === title);
        run.current = title;
        repaired = false;
        rec.running(`${title}: drawing a diagram`);
        this.changed(s);
        const r = sec ? await suggestDiagram(s, md, sec, kinds, focus, this.adapterFor(s), opts) : null;
        if (controller.signal.aborted) {
          run.state = "stopped";
          rec.step(`${title}: stopped`, undefined, "stopped");
          break;
        }
        if (r && !r.ok && r.code !== "malformed") {
          run.state = "error";
          run.message = redact(r.message, userText(s));
          rec.step(`${title}: ${reasonText(r.code, "{agent}")}`, undefined, "failed");
          run.code = r.code;
          break;
        }
        // The plan stays editable while the agent draws: place it on the text as it is now.
        const now = r?.ok && !r.value.skip ? planSections(s.plan?.markdown ?? "").find((x) => x.title === title) : undefined;
        const again = repaired ? "first try didn’t draw, asked again; " : "";
        if (r?.ok && !r.value.skip && now) {
          const x = addDiagramSuggestion(s, now, r.value.mermaid, textHash(md));
          if (x) {
            x.run = rec.id;
            made.push({ id: x.id, section: title, note: x.replace ? "diagram replaced" : "diagram added" });
          }
          run.added++;
          rec.step(`${title}: ${again}drew a diagram`);
        } else {
          run.skipped++;
          rec.step(`${title}: ${!sec || !r ? "no longer in the plan, skipped" : r.ok ? `${again}nothing to draw, skipped` : "the diagram didn’t come through, skipped"}`);
        }
        run.done++;
        run.current = undefined;
        this.changed(s);
      }
      if (run.state === "running") run.state = "done";
    };
    work()
      .catch((err) => {
        run.state = "error";
        run.message = redact(String(err?.message ?? err), userText(s));
      })
      .finally(() => {
        run.current = undefined;
        run.ms = Date.now() - t0;
        const status = run.state === "done" ? "done" : run.state === "stopped" ? "stopped" : "failed";
        rec.end(status, {
          ...(status === "failed" ? { reason: run.code ?? "unknown" } : {}),
          read: titles.slice(0, run.done),
          ...(run.done < titles.length ? { notDone: titles.slice(run.done + (status === "done" ? 0 : 1)) } : {}),
          suggestions: made,
          result: { diagrams: run.added, skipped: run.skipped },
        });
        if (this.diagramRuns.get(s.id) === controller) this.diagramRuns.delete(s.id);
        this.changed(s);
      });
  }

  /** "Add to plan" (#104): start on one decision no passage cites, stop, or retry the last one. */
  private addPlanRoute(s: Session, body: any, busy: boolean) {
    const op = String(body?.op ?? "start");
    if (op === "stop") {
      // Stopped at once, in this reply too: the run's own ending lands after it and changes nothing.
      const c = this.addPlanRuns.get(s.id);
      if (!c) return;
      c.abort();
      this.addPlanRuns.delete(s.id);
      if (s.addPlanRun?.state === "running") s.addPlanRun.state = "stopped";
      return this.changed(s);
    }
    if (this.addPlanRuns.has(s.id)) throw new Error("The agent is already adding a decision.");
    if (busy || this.applying(s) || this.diagramRuns.has(s.id)) throw new Error("Waiting for the current run.");
    const key = op === "retry" ? s.addPlanRun?.decision : String(body?.key ?? "");
    const d = key ? s.decisions[key] : undefined;
    if (!d) throw new Error("That decision is gone.");
    if (inPlan(s.plan?.markdown ?? "", d.key)) throw new Error("That decision is already in the plan.");
    if ((s.suggestions ?? []).some((x) => x.status === "pending" && x.source?.id === d.key)) throw new Error("Review the suggestion for it first.");
    this.startAddPlan(s, d.key, op === "retry");
  }

  private startAddPlan(s: Session, key: string, retry = false) {
    const d = s.decisions[key];
    const rec = this.record(s, "addplan", { decision: d.title }, retry ? `addplan:${s.id}` : undefined);
    this.lastRun.set(`addplan:${s.id}`, rec.id);
    const controller = new AbortController();
    this.addPlanRuns.set(s.id, controller);
    const t0 = Date.now();
    const run: NonNullable<Session["addPlanRun"]> = { decision: key, state: "running", startedAt: new Date().toISOString() };
    s.addPlanRun = run;
    this.changed(s);
    const opts = { ...this.runOptions(s, controller), onProgress: undefined };
    let made: { id: string; section: string } | null = null;
    const work = async () => {
      // Written against the plan as it is now; the plan stays editable meanwhile (§4.1).
      const base = s.plan?.markdown ?? "";
      rec.step("Read plan.md");
      rec.step("Read the decision", "{agent} is writing it into the plan");
      const r = await suggestAddPlan(s, base, d, this.adapterFor(s), { ...opts, onRepair: () => rec.step("{agent}’s answer didn’t fit the format; asked again", "{agent} is writing it into the plan") });
      if (controller.signal.aborted) {
        run.state = "stopped";
        return;
      }
      if (!r.ok) {
        run.state = "error";
        run.code = r.code;
        run.message = redact(r.message, userText(s));
        return;
      }
      if (!r.value.place) {
        rec.step("{agent} found no place for it");
        run.state = "done";
        return;
      }
      const x = addPlanSuggestion(s, key, { before: r.value.before, after: r.value.after }, textHash(base));
      if (x) {
        x.run = rec.id;
        run.suggestion = x.id;
        made = { id: x.id, section: sectionAt(s.plan?.markdown ?? "", x.at) || "the plan" };
        rec.step("Made 1 suggestion");
      } else rec.step("Checked against plan.md: the suggestion no longer fit");
      run.state = "done";
    };
    work()
      .catch((err) => {
        if (controller.signal.aborted) return;
        run.state = "error";
        run.message = redact(String(err?.message ?? err), userText(s));
      })
      .finally(() => {
        run.ms = Date.now() - t0;
        if (controller.signal.aborted) run.state = "stopped";
        if (run.state === "stopped") rec.end("stopped", { last: "Stopped while {agent} was writing it into the plan" });
        else if (run.state === "error") rec.end("failed", { reason: run.code ?? "unknown", last: reasonText(run.code ?? "unknown", "{agent}") });
        else rec.end("done", { read: [d.title], suggestions: made ? [made] : [], result: { suggestions: made ? 1 : 0 } });
        if (this.addPlanRuns.get(s.id) === controller) this.addPlanRuns.delete(s.id);
        this.changed(s);
      });
  }

  private startComment(s: Session, threadId: string, kind: "reply" | "apply", retry = false) {
    const t = startRun(s, threadId, kind);
    const section = threadSection(s.plan?.markdown ?? "", t) || "the plan";
    const rec = this.record(s, kind, { section, comment: t.id }, retry ? `thread:${t.id}` : undefined);
    this.lastRun.set(`thread:${t.id}`, rec.id);
    const controller = new AbortController();
    this.commentRuns.set(t.id, controller);
    this.changed(s);
    const opts = { ...this.runOptions(s, controller), onProgress: undefined };
    const stopped = (doing: string) => rec.end("stopped", { last: `Stopped while {agent} was ${doing}` });
    const failed = (code: string) => rec.end("failed", { reason: code, last: reasonText(code, "{agent}") });
    const plural = (n: number, w: string) => `${n} ${w}${n === 1 ? "" : "s"}`;
    const work = async () => {
      if (kind === "reply") {
        rec.step("Read your comment", "{agent} is writing a reply");
        const run = t.run!;
        const r = await replyToComment(s, t, this.adapterFor(s), {
          ...opts,
          onRepair: () => rec.step("{agent}’s reply didn’t fit the format; asked again", "{agent} is writing a reply"),
          // Streamed text (#97, Claude Code): kept on the run so a reload shows it, pushed as it grows.
          onText: (text) => {
            if (t.run !== run || run.state !== "running") return;
            if (text) run.partial = text;
            else delete run.partial;
            this.broadcast({ type: "reply-text", sessionId: s.id, threadId: t.id, text });
          },
        });
        if (controller.signal.aborted) {
          stopped("writing a reply");
          // Stop keeps what was written: it's real text, so Apply feedback is offered on it.
          const partial = run.partial;
          delete run.partial;
          if (partial && s.comments?.includes(t)) addMessage(s, t.id, "agent", partial, { stopped: true });
          return finishRun(t, { ok: false, stopped: true, message: "Stopped." });
        }
        // An error keeps the partial text on the run; Try again starts a new run, which replaces it.
        if (!r.ok) return (failed(r.code), finishRun(t, { ok: false, message: redact(r.message, userText(s)) }));
        delete run.partial;
        addMessage(s, t.id, "agent", r.value.text);
        rec.step("{agent} replied");
        rec.end("done", { read: [section] });
        return finishRun(t, { ok: true });
      }
      // Suggestions are written against the plan as it is now; the plan stays editable (§4.1).
      const base = s.plan?.markdown ?? "";
      rec.step("Read plan.md");
      rec.step(t.messages.some((m) => m.by === "agent") ? "Read your comment and {agent}’s reply" : "Read your comment", "{agent} is writing suggestions");
      const r = await suggestEdits(s, t, this.adapterFor(s), { ...opts, onRepair: () => rec.step("{agent}’s answer didn’t fit the format; asked again", "{agent} is writing suggestions") }, base);
      // Stop keeps nothing (§4.1).
      if (controller.signal.aborted) return (stopped("writing suggestions"), finishRun(t, { ok: false, stopped: true, message: "Stopped · nothing changed" }));
      if (!r.ok) return (failed(r.code), finishRun(t, { ok: false, message: redact(r.message, userText(s)) }));
      rec.step(`{agent} wrote ${plural(r.value.edits.length, "suggestion")}`, "Checking against plan.md");
      const { added, dropped } = addSuggestions(s, t.id, r.value.edits, t.at, textHash(base));
      for (const x of added) x.run = rec.id;
      // A thread on a decision block: answers change through the decision (#22), never a suggestion.
      const at = refind(base, t);
      const decision = added.length ? null : decisionAt(base, at);
      rec.step(dropped ? `Checked against plan.md: ${plural(dropped, "suggestion")} no longer fit` : "Checked against plan.md");
      rec.step(decision ? "Made no suggestion: this is a decision, change it there" : `Made ${plural(added.length, "suggestion")}`);
      rec.end("done", {
        read: [section],
        suggestions: added.map((x) => ({ id: x.id, section: sectionAt(s.plan?.markdown ?? "", x.at) || section })),
        result: { suggestions: added.length },
      });
      finishRun(t, { ok: true, edits: added.length, ...(dropped ? { dropped } : {}), ...(decision ? { decision } : {}) });
    };
    work()
      .catch((err) => (failed("unknown"), finishRun(t, { ok: false, message: String(err?.message ?? err) })))
      .finally(() => {
        if (this.commentRuns.get(t.id) === controller) this.commentRuns.delete(t.id);
        this.changed(s);
      });
  }

  private abort(s: Session) {
    this.inflight.get(s.id)?.abort();
    this.inflight.delete(s.id);
  }

  private selectProvider(res: http.ServerResponse, body: any) {
    const id = body?.id as ProviderId;
    const p = this.providers.find((x) => x.id === id);
    if (!p || p.detection.status !== "ready") return this.json(res, 400, { error: "That agent isn't available." });
    this.selected = id;
    if (body?.remember) this.opts.store.writeConfig({ ...this.opts.store.readConfig(), defaultProvider: id });
    this.broadcast({ type: "app" });
    return this.json(res, 200, this.appState());
  }

  private async sessionRoutes(req: http.IncomingMessage, res: http.ServerResponse, parts: string[], body: any) {
    if (req.method === "POST" && parts.length === 0) {
      const idea = String(body?.idea ?? "").trim();
      if (!idea) throw new Error("Tell me the idea first.");
      if (!this.selected) throw new Error("Pick an agent first.");
      const s = createSession({ idea: idea.slice(0, 8000), context: String(body?.context ?? "").slice(0, 20_000), provider: this.selected });
      this.sessions.set(s.id, s);
      this.opts.store.save(s);
      this.watchSession(s);
      this.startRound(s);
      return this.json(res, 201, this.view(s));
    }
    const s = this.getSession(parts[0] ?? "");
    const action = parts[1];
    if (req.method === "GET" && !action) return this.json(res, 200, this.view(s));
    if (req.method === "GET" && action === "activity") return this.json(res, 200, this.activityView(s, Number(new URL(req.url ?? "/", "http://x").searchParams.get("limit")) || 50));
    if (req.method === "GET" && action === "plan.md") {
      const md = this.opts.store.readPlan(s.id);
      if (!md) return this.json(res, 404, { error: "No plan yet" });
      res.writeHead(200, {
        "Content-Type": "text/markdown; charset=utf-8",
        "Content-Disposition": `attachment; filename="grillado-plan-${s.id}.md"`,
      });
      return res.end(md);
    }
    if (req.method !== "POST") return this.json(res, 404, { error: "Not found" });
    const busy = this.inflight.has(s.id);
    if (action === "comments" || action === "suggestions" || action === "diagrams" || action === "addplan") {
      if (s.status !== "plated" || !s.plan) throw new Error("Comments open once the plan is written.");
      if (action === "comments") this.commentRoute(s, parts[2], parts[3], body, busy);
      else if (action === "diagrams") this.diagramRoute(s, body, busy);
      else if (action === "addplan") this.addPlanRoute(s, body, busy);
      else this.reviewRoute(s, body);
      return this.json(res, 200, this.view(s));
    }
    switch (action) {
      case "answers": {
        if (busy) throw new Error("The agent is still working.");
        const answers = (body?.answers ?? []) as Answer[];
        submitAnswers(s, Number(body?.round), answers);
        this.log(s, { v: 1, type: "user", what: "answered", round: Number(body?.round), answers: answers.length, yourCall: answers.filter((a) => a.optionId === UNKNOWN_OPTION).length, at: new Date().toISOString() });
        this.startRound(s);
        break;
      }
      case "retry": {
        if (busy) break;
        if (s.status === "asking") this.startRound(s, true);
        else if (s.status === "synthesizing") this.startPlan(s, true);
        break;
      }
      case "provider": {
        const id = body?.id as ProviderId;
        if (!PROVIDER_IDS.includes(id) || this.providers.find((p) => p.id === id)?.detection.status !== "ready")
          throw new Error("That agent isn't available.");
        this.abort(s);
        s.provider = id;
        this.selected = id;
        s.error = undefined;
        this.changed(s);
        break;
      }
      case "stop": {
        this.abort(s);
        setError(s, "unknown", "Stopped. Retry when you're ready.");
        this.changed(s);
        break;
      }
      case "wrap": {
        this.abort(s);
        wrapUp(s);
        this.changed(s);
        break;
      }
      case "nudge": {
        dismissNudge(s);
        this.changed(s);
        break;
      }
      case "keep-going": {
        keepGoing(s);
        this.startRound(s);
        break;
      }
      case "confirm": {
        startSynthesis(s);
        this.log(s, { v: 1, type: "user", what: "confirmed", decisions: Object.keys(s.decisions).length, at: new Date().toISOString() });
        this.startPlan(s);
        break;
      }
      case "plan": {
        if (busy) throw new Error("The agent is still working.");
        // Saves name the version they were edited from. If plan.md moved on meanwhile (edited in
        // another editor), refuse so the browser can ask which version to keep (Q5).
        if (typeof body?.base === "string" && s.plan && textHash(s.plan.markdown) !== body.base && body.markdown !== s.plan.markdown)
          return this.json(res, 409, { error: "plan.md changed outside Grillado", conflict: true, markdown: s.plan.markdown });
        // A hand edit of a settled `answer:` is a Change (DECISIONS #22): it's saved only through
        // "Save and re-ask" (`reask: true`), never by the autosave.
        const edits = typeof body?.markdown === "string" && s.plan ? planAnswerEdits(s, body.markdown) : [];
        if (edits.length && body?.reask !== true)
          return this.json(res, 409, { error: "That changes a settled answer. Save it with Save and re-ask, or cancel.", answerEdits: edits });
        if (edits.length) {
          const deps = saveAnswerEdits(s, body.markdown);
          this.opts.store.writePlan(s.id, s.plan!.markdown);
          if (deps.length) this.startRound(s);
          else this.changed(s);
          return this.json(res, 200, { ok: true, savedAt: s.plan!.editedAt, reasked: deps, markdown: s.plan!.markdown });
        }
        editPlan(s, body?.markdown);
        pruneSuggestions(s);
        this.opts.store.writePlan(s.id, s.plan!.markdown);
        this.changed(s);
        return this.json(res, 200, { ok: true, savedAt: s.plan!.editedAt });
      }
      case "external-confirm":
      case "external-dismiss": {
        if (busy) throw new Error("The agent is still working.");
        if (!s.plan?.external?.length) throw new Error("Nothing changed outside Grillado.");
        const deps = action === "external-confirm" ? confirmExternal(s) : (dismissExternal(s), []);
        this.opts.store.writePlan(s.id, s.plan!.markdown);
        if (deps.length) this.startRound(s);
        else this.changed(s);
        break;
      }
      case "reask": {
        if (busy) throw new Error("The agent is still working.");
        reaskStale(s, Array.isArray(body?.keys) ? body.keys.map(String) : [String(body?.key ?? "")]);
        this.startRound(s);
        break;
      }
      case "change": {
        if (busy) throw new Error("The agent is still working.");
        const deps = changeDecision(s, String(body?.key ?? ""), { optionId: String(body?.optionId ?? ""), text: body?.text });
        this.opts.store.writePlan(s.id, s.plan!.markdown);
        if (deps.length) this.startRound(s);
        else this.changed(s);
        break;
      }
      case "answer-open": {
        if (busy) throw new Error("The agent is still working.");
        answerOpenDecision(s, String(body?.key ?? ""), { optionId: String(body?.optionId ?? ""), text: body?.text });
        this.opts.store.writePlan(s.id, s.plan!.markdown);
        this.changed(s);
        break;
      }
      case "plan-conflict": {
        // The copy that lost a "changed on disk" conflict is kept next to plan.md.
        if (!s.plan) throw new Error("There's no plan yet.");
        if (typeof body?.markdown !== "string" || body.markdown.length > 500_000) throw new Error("Expected the plan as Markdown text.");
        const file = this.opts.store.writeConflict(s.id, body.markdown);
        // Which version won is the file event you audit later ("did I overwrite it?", #84 MF4).
        if (body?.keep === "mine" || body?.keep === "file") {
          this.log(s, { v: 1, type: "file", what: body.keep === "mine" ? "kept-mine" : "loaded-file", at: new Date().toISOString() });
          this.changed(s);
        }
        return this.json(res, 200, { ok: true, path: file });
      }
      case "reveal": {
        // "Show file location": open the session folder in the OS file manager, when there is one.
        if (!s.plan) throw new Error("There's no plan yet.");
        const dir = path.dirname(this.opts.store.planPath(s.id));
        const opened = canOpenBrowser();
        if (opened) openBrowser(dir);
        return this.json(res, 200, { ok: true, opened, path: this.opts.store.planPath(s.id) });
      }
      case "reopen": {
        if (busy) throw new Error("The agent is still working.");
        // A new plan will overwrite plan.md; keep the user's edited version next to it.
        if (s.plan?.editedAt) this.opts.store.keepEditedPlan(s.id);
        reopen(s, String(body?.key ?? ""));
        this.startRound(s);
        break;
      }
      default:
        return this.json(res, 404, { error: "Not found" });
    }
    return this.json(res, 200, this.view(s));
  }
}

function readJson(req: http.IncomingMessage): Promise<any> {
  return new Promise((resolve, reject) => {
    let data = "";
    req.setEncoding("utf8");
    req.on("data", (d) => {
      data += d;
      if (data.length > 1_000_000) {
        reject(new Error("Body too large"));
        req.destroy();
      }
    });
    req.on("end", () => {
      try {
        resolve(data ? JSON.parse(data) : {});
      } catch {
        reject(new Error("Invalid JSON"));
      }
    });
    req.on("error", reject);
  });
}

/** Show the data dir relative to the user's home ("~/.grillado"), never as an absolute path (v1.2 review). */
function tildify(dir: string): string {
  const home = os.homedir();
  if (home && (dir === home || dir.startsWith(home + path.sep))) return "~" + dir.slice(home.length);
  return dir;
}
