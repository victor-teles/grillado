import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import type { ProviderId } from "../core/providers/types.ts";
import type { Session } from "../core/session.ts";

export interface Config {
  defaultProvider?: ProviderId;
}

export function defaultDataDir(env = process.env): string {
  return env.GRILLADO_HOME || path.join(os.homedir(), ".grillado");
}

/** Atomic write: a crash never leaves a half-written session file. */
function writeAtomic(file: string, data: string) {
  mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, data, { mode: 0o600 });
  renameSync(tmp, file);
}

export class Store {
  constructor(readonly dir: string) {
    mkdirSync(path.join(dir, "sessions"), { recursive: true });
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

  save(s: Session) {
    writeAtomic(path.join(this.sessionDir(s.id), "session.json"), JSON.stringify(s, null, 2));
  }

  load(id: string): Session | null {
    try {
      return JSON.parse(readFileSync(path.join(this.sessionDir(id), "session.json"), "utf8"));
    } catch {
      return null;
    }
  }

  planPath(id: string) {
    return path.join(this.sessionDir(id), "plan.md");
  }

  writePlan(id: string, markdown: string) {
    const file = this.planPath(id);
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
