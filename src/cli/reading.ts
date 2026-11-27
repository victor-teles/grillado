// Plan 003: the trail of what a reading agent opens while it works. Paths go through the run's path
// check (a path outside the project or a sensitive one never shows); searches are shown as the agent
// sent them, cut short. Updates go out at most four times a second.
import type { PathCheck } from "../core/project-read.ts";
import type { Activity } from "../core/providers/types.ts";

/** What the wait screens show: how many files were read, the last three things done, and when. */
export interface ReadingView {
  files: number;
  recent: string[];
  at: string;
}

export const TRAIL_LINES = 3;
const MAX_PATTERN = 80;
const MAX_FILES_LOGGED = 50;

export class ReadingTrail {
  private read: string[] = [];
  private recent: string[] = [];
  private at = new Date().toISOString();
  private timer: ReturnType<typeof setTimeout> | null = null;
  private last = 0;

  constructor(
    private check: PathCheck,
    private onUpdate: () => void,
    private every = 250,
  ) {}

  push(a: Activity) {
    let line: string;
    if (a.action === "read") {
      const rel = this.check(a.target);
      if (!rel) return;
      if (!this.read.includes(rel)) this.read.push(rel);
      line = rel;
    } else {
      const pattern = a.target.replace(/\s+/g, " ").trim().slice(0, MAX_PATTERN);
      if (!pattern) return;
      line = `${a.action}: ${pattern}`;
    }
    this.recent = [...this.recent, line].slice(-TRAIL_LINES);
    this.at = new Date().toISOString();
    this.schedule();
  }

  view(): ReadingView {
    return { files: this.read.length, recent: [...this.recent], at: this.at };
  }

  /** For the activity log at the end of the run: the first files, and how many in all. */
  logged(): { files: string[]; count: number } {
    return { files: this.read.slice(0, MAX_FILES_LOGGED), count: this.read.length };
  }

  stop() {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }

  private schedule() {
    if (this.timer) return;
    const wait = Math.max(0, this.last + this.every - Date.now());
    this.timer = setTimeout(() => {
      this.timer = null;
      this.last = Date.now();
      this.onUpdate();
    }, wait);
  }
}
