import { randomBytes, timingSafeEqual } from "node:crypto";
import { createReadStream, existsSync, mkdtempSync, rmSync, statSync, unwatchFile, watchFile } from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { nextRound, replyToComment, suggestDiagram, suggestEdits, synthesize } from "../core/engine.ts";
import { DIAGRAM_KINDS, type DiagramKind, addDiagramSuggestion, planSections } from "../core/diagrams.ts";
import { addComment, addMessage, addSuggestions, decisionAt, finishRun, locate, pending, pruneSuggestions, resolveThread, review, startRun, undoReview } from "../core/comments.ts";
import { redact } from "../core/filter.ts";
import { killAllChildren } from "../core/providers/process.ts";
import { type Detection, PROVIDER_IDS, type ProviderAdapter, type ProviderId } from "../core/providers/types.ts";
import {
  type Answer,
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
import { canOpenBrowser, openBrowser } from "./open.ts";
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
  private progress = new Map<string, string>();
  private clients = new Set<http.ServerResponse>();
  private agentDirs = new Map<string, string>();
  private watched = new Set<string>();
  port = 0;

  constructor(private opts: ServerOptions) {
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
      res.writeHead(302, { Location: "/" });
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
      this.opts.store.writePlan(live.id, live.plan.markdown);
      this.changed(live);
    });
  }

  private changed(s: Session) {
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
      })),
      dataDir: tildify(this.opts.store.dir),
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
      progress: this.progress.get(s.id),
      planPath: s.plan?.path,
      tree: buildTree(s),
      acceptStreak: acceptStreak(s),
      nudge: shouldNudge(s),
    };
  }

  // ---------------------------------------------------------------- sessions

  private getSession(id: string): Session {
    let s = this.sessions.get(id);
    if (!s) {
      const loaded = this.opts.store.load(id);
      if (!loaded) throw new Error("Session not found");
      s = loaded;
      // plan.md is the source of truth for the plan text: pick up edits made while we were down
      // (or by hand, in another editor).
      const md = s.plan ? this.opts.store.readPlan(id) : null;
      if (s.plan && md !== null && md !== s.plan.markdown) s.plan.markdown = md;
      // A run that was cut off by a restart can't resume on its own (AC14): offer Retry.
      if ((s.status === "asking" || s.status === "synthesizing") && !s.error) {
        setError(s, "unknown", "Interrupted. Retry to continue.");
      }
      for (const t of s.comments ?? []) if (t.run?.state === "running") finishRun(t, { ok: false, message: "Interrupted. Retry to continue." });
      this.sessions.set(id, s);
      this.watchPlan(s);
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

  private startRound(s: Session) {
    this.run(s, async (c) => {
      await nextRound(s, this.adapterFor(s), this.runOptions(s, c));
    });
  }

  private startPlan(s: Session) {
    this.run(s, async (c) => {
      const out = await synthesize(s, this.adapterFor(s), this.runOptions(s, c));
      if (!out.ok) return;
      // The new plan overwrites plan.md; keep the user's edited version next to it.
      if (s.plan?.editedAt) this.opts.store.keepEditedPlan(s.id);
      const file = this.opts.store.writePlan(s.id, out.markdown);
      s.plan = { title: out.plan.title, markdown: out.markdown, path: file, openDecisions: out.plan.openDecisions, createdAt: new Date().toISOString() };
      s.status = "plated";
      this.watchPlan(s);
    });
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
        if (busy || this.applying(s) || this.diagramRuns.has(s.id)) throw new Error("Waiting for the current run.");
        this.startComment(s, t.id, "apply");
        return;
      case "retry":
        if (live(t.id) || !t.run) return;
        if (t.run.kind === "apply" && (busy || this.applying(s))) throw new Error("Waiting for the current run.");
        this.startComment(s, t.id, t.run.kind);
        return;
      case "stop":
        this.commentRuns.get(t.id)?.abort();
        return;
      case "resolve":
        resolveThread(s, t.id, body?.resolved !== false);
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
      if (!undoReview(s)) throw new Error("Nothing to undo.");
    } else if (op === "accept" || op === "reject") {
      // "all" takes every pending suggestion (Accept all / Reject all).
      review(s, op, body?.ids === "all" ? pending(s).map((x) => x.id) : body?.ids);
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
    if (busy || this.applying(s)) throw new Error("Waiting for the current run.");
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
    this.startDiagrams(s, titles, kinds, focus);
  }

  private startDiagrams(s: Session, titles: string[], kinds: DiagramKind[], focus: string) {
    const controller = new AbortController();
    this.diagramRuns.set(s.id, controller);
    const t0 = Date.now();
    const run: NonNullable<Session["diagramRun"]> = { state: "running", startedAt: new Date().toISOString(), sections: titles, kinds, ...(focus ? { focus } : {}), done: 0, added: 0, skipped: 0 };
    s.diagramRun = run;
    this.changed(s);
    const opts = { ...this.runOptions(s, controller), onProgress: undefined };
    const work = async () => {
      // One section at a time: each suggestion lands as soon as its section is drawn (§18 I).
      for (const title of titles) {
        const md = s.plan?.markdown ?? "";
        const sec = planSections(md).find((x) => x.title === title);
        run.current = title;
        this.changed(s);
        const r = sec ? await suggestDiagram(s, md, sec, kinds, focus, this.adapterFor(s), opts) : null;
        if (controller.signal.aborted) {
          run.state = "stopped";
          break;
        }
        if (r && !r.ok && r.code !== "malformed") {
          run.state = "error";
          run.message = redact(r.message, userText(s));
          break;
        }
        // The plan stays editable while the agent draws: place it on the text as it is now.
        const now = r?.ok && !r.value.skip ? planSections(s.plan?.markdown ?? "").find((x) => x.title === title) : undefined;
        if (r?.ok && !r.value.skip && now) {
          addDiagramSuggestion(s, now, r.value.mermaid, textHash(md));
          run.added++;
        } else run.skipped++;
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
        if (this.diagramRuns.get(s.id) === controller) this.diagramRuns.delete(s.id);
        this.changed(s);
      });
  }

  private startComment(s: Session, threadId: string, kind: "reply" | "apply") {
    const t = startRun(s, threadId, kind);
    const controller = new AbortController();
    this.commentRuns.set(t.id, controller);
    this.changed(s);
    const opts = { ...this.runOptions(s, controller), onProgress: undefined };
    const work = async () => {
      if (kind === "reply") {
        const r = await replyToComment(s, t, this.adapterFor(s), opts);
        if (controller.signal.aborted) return finishRun(t, { ok: false, stopped: true, message: "Stopped." });
        if (!r.ok) return finishRun(t, { ok: false, message: redact(r.message, userText(s)) });
        addMessage(s, t.id, "agent", r.value.text);
        return finishRun(t, { ok: true });
      }
      // Suggestions are written against the plan as it is now; the plan stays editable (§4.1).
      const base = s.plan?.markdown ?? "";
      const r = await suggestEdits(s, t, this.adapterFor(s), opts, base);
      // Stop keeps nothing (§4.1).
      if (controller.signal.aborted) return finishRun(t, { ok: false, stopped: true, message: "Stopped · nothing changed" });
      if (!r.ok) return finishRun(t, { ok: false, message: redact(r.message, userText(s)) });
      const { added, dropped } = addSuggestions(s, t.id, r.value.edits, t.at, textHash(base));
      // A thread on a decision block: answers change through the decision (#22), never a suggestion.
      const at = locate(base, t.quote, t.at);
      const decision = added.length ? null : decisionAt(base, at);
      finishRun(t, { ok: true, edits: added.length, ...(dropped ? { dropped } : {}), ...(decision ? { decision } : {}) });
    };
    work()
      .catch((err) => finishRun(t, { ok: false, message: String(err?.message ?? err) }))
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
      this.startRound(s);
      return this.json(res, 201, this.view(s));
    }
    const s = this.getSession(parts[0] ?? "");
    const action = parts[1];
    if (req.method === "GET" && !action) return this.json(res, 200, this.view(s));
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
    if (action === "comments" || action === "suggestions" || action === "diagrams") {
      if (s.status !== "plated" || !s.plan) throw new Error("Comments open once the plan is written.");
      if (action === "comments") this.commentRoute(s, parts[2], parts[3], body, busy);
      else if (action === "diagrams") this.diagramRoute(s, body, busy);
      else this.reviewRoute(s, body);
      return this.json(res, 200, this.view(s));
    }
    switch (action) {
      case "answers": {
        if (busy) throw new Error("The agent is still working.");
        submitAnswers(s, Number(body?.round), (body?.answers ?? []) as Answer[]);
        this.startRound(s);
        break;
      }
      case "retry": {
        if (busy) break;
        if (s.status === "asking") this.startRound(s);
        else if (s.status === "synthesizing") this.startPlan(s);
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
