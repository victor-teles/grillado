import { appendFileSync, closeSync, copyFileSync, existsSync, mkdirSync, openSync, readFileSync, readdirSync, renameSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import type { ProviderId } from "../core/providers/types.ts";
import { adoptThreads } from "../core/comments.ts";
import type { Session } from "../core/session.ts";

export interface Config {
  defaultProvider?: ProviderId;
  /** Project roots where the user hid "Found in this project" (v1.3 item 1, #141). */
  foundHidden?: string[];
  /** "Send to issues" (v1.3 item 2): the last destination, per project too (#179), and the labels last used per target (#177). */
  issues?: {
    last?: "github" | "linear";
    byProject?: Record<string, "github" | "linear">;
    labels?: Record<string, string[]>;
  };
}

export function defaultDataDir(env = process.env): string {
  return env.GRILLADO_HOME || path.join(os.homedir(), ".grillado");
}

/** Atomic write: a crash never leaves a half-written session file. */
export function writeAtomic(file: string, data: string) {
  mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, data, { mode: 0o600 });
  renameSync(tmp, file);
}

/** Where a running web app can be reached, for `grillado mcp` (start_plan's URL). */
export interface ServerInfo {
  pid: number;
  port: number;
  token: string;
}

const pause = (ms: number) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

/**
 * Hold `<file>.lock` while `fn` runs, so the web app and `grillado mcp` never interleave a
 * read-modify-write on one session. A lock older than 10 s was left by a crash and is taken over.
 */
export function withLock<T>(file: string, fn: () => T): T {
  const lock = `${file}.lock`;
  mkdirSync(path.dirname(lock), { recursive: true });
  for (let i = 0; ; i++) {
    try {
      closeSync(openSync(lock, "wx"));
      break;
    } catch (err: any) {
      if (err?.code !== "EEXIST") throw err;
      try {
        if (Date.now() - statSync(lock).mtimeMs > 10_000) unlinkSync(lock);
      } catch {}
      if (i > 250) throw new Error("Another Grillado process is holding this session; try again.");
      pause(20);
    }
  }
  try {
    return fn();
  } finally {
    try {
      unlinkSync(lock);
    } catch {}
  }
}

export class Store {
  constructor(readonly dir: string) {
    mkdirSync(path.join(dir, "sessions"), { recursive: true });
  }

  /** A running web app writes this (0600) so `grillado mcp` can link straight to a session. */
  writeServerInfo(info: ServerInfo) {
    writeAtomic(path.join(this.dir, "server.json"), `${JSON.stringify(info)}\n`);
  }

  /** The running web app, or null when none is (its pid is gone). */
  readServerInfo(): ServerInfo | null {
    try {
      const info = JSON.parse(readFileSync(path.join(this.dir, "server.json"), "utf8")) as ServerInfo;
      process.kill(info.pid, 0);
      return info;
    } catch {
      return null;
    }
  }

  clearServerInfo(pid: number) {
    const file = path.join(this.dir, "server.json");
    try {
      if (JSON.parse(readFileSync(file, "utf8")).pid === pid) unlinkSync(file);
    } catch {}
  }

  readConfig(): Config {
    try {
      return JSON.parse(readFileSync(path.join(this.dir, "config.json"), "utf8"));
    } catch {
      return {};
    }
  }

  writeConfig(config: Config) {
    writeAtomic(path.join(this.dir, "config.json"), `${JSON.stringify(config, null, 2)}\n`);
  }

  sessionDir(id: string) {
    if (!/^[\w-]+$/.test(id)) throw new Error("Bad session id");
    return path.join(this.dir, "sessions", id);
  }

  private sessionFile(id: string) {
    return path.join(this.sessionDir(id), "session.json");
  }

  /**
   * Save, keeping comment threads another process (`grillado mcp`) added since `s` was loaded:
   * they are adopted into `s` too, so the caller's copy shows them.
   */
  save(s: Session) {
    const file = this.sessionFile(s.id);
    withLock(file, () => {
      const disk = this.load(s.id);
      if (disk) adoptThreads(s, disk);
      writeAtomic(file, JSON.stringify(s, null, 2));
    });
  }

  /** Create a session, optionally binding its Markdown output to the launch project. */
  create(s: Session, project?: string) {
    const file = this.sessionFile(s.id);
    withLock(file, () => {
      if (existsSync(file)) throw new Error("Session already exists");
      if (project) {
        s.project = path.resolve(project);
        s.planFile = path.join(s.project, "docs", "plans", `grillado-plan-${s.id}.md`);
      }
      writeAtomic(file, JSON.stringify(s, null, 2));
    });
  }

  /** Load, change and save one session under its lock (for `grillado mcp`). */
  update<T>(id: string, fn: (s: Session) => T): T | null {
    const file = this.sessionFile(id);
    return withLock(file, () => {
      const s = this.load(id);
      if (!s) return null;
      const out = fn(s);
      writeAtomic(file, JSON.stringify(s, null, 2));
      return out;
    });
  }

  load(id: string): Session | null {
    try {
      return JSON.parse(readFileSync(this.sessionFile(id), "utf8"));
    } catch {
      return null;
    }
  }

  /** The activity log (item 6): append-only, one JSON object per line. */
  activityPath(id: string) {
    return path.join(this.sessionDir(id), "activity.jsonl");
  }

  appendActivity(id: string, lines: unknown[]) {
    mkdirSync(this.sessionDir(id), { recursive: true });
    appendFileSync(this.activityPath(id), lines.map((l) => `${JSON.stringify(l)}\n`).join(""));
  }

  readActivity(id: string): string {
    try {
      return readFileSync(this.activityPath(id), "utf8");
    } catch {
      return "";
    }
  }

  planPath(id: string) {
    const legacy = path.join(this.sessionDir(id), "plan.md");
    return this.load(id)?.planFile ?? legacy;
  }

  writePlan(id: string, markdown: string) {
    const file = this.planPath(id);
    writeAtomic(file, markdown);
    return file;
  }

  /** Copy an edited plan.md aside before a new plan replaces it. Returns the copy's path. */
  keepEditedPlan(id: string): string | null {
    const file = this.planPath(id);
    if (!existsSync(file)) return null;
    const copy = path.join(this.sessionDir(id), `plan.edited-${new Date().toISOString().replace(/[:.]/g, "-")}.md`);
    copyFileSync(file, copy);
    return copy;
  }

  /** The losing side of a "plan.md changed outside Grillado" conflict. */
  writeConflict(id: string, markdown: string) {
    const file = path.join(this.sessionDir(id), "plan.conflict.md");
    writeAtomic(file, markdown);
    return file;
  }

  readPlan(id: string): string | null {
    const file = this.planPath(id);
    return existsSync(file) ? readFileSync(file, "utf8") : null;
  }

  list(): Session[] {
    const root = path.join(this.dir, "sessions");
    const out: Session[] = [];
    for (const id of readdirSync(root)) {
      const s = this.load(id);
      if (s) out.push(s);
    }
    return out.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  }
}
