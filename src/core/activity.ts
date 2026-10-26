// The agent activity log (v1.1 item 6, DECISIONS #51–66). `sessions/<id>/activity.jsonl` holds one
// JSON object per line, append-only, written by Grillado (never by the agent). This module is
// DOM-free: the server folds lines into entries; the browser formats titles, meta, durations, the
// copied log and the live-region messages from the same functions.

export type RunKind = "round" | "plan" | "reply" | "apply" | "diagrams";
export type RunStatus = "running" | "done" | "failed" | "stopped" | "interrupted";

export interface RunTarget {
  section?: string;
  comment?: string;
  round?: number;
  /** The round was asked again after an edit (item 2). */
  reask?: boolean;
}

export interface RunResult {
  questions?: number;
  decisions?: number;
  sections?: number;
  diagrams?: number;
  skipped?: number;
  suggestions?: number;
}

export interface SuggestionRef {
  id: string;
  section?: string;
  note?: string;
}

export type ActivityLine =
  | { v: 1; id: string; type: "run.started"; kind: RunKind; at: string; agent: string; target?: RunTarget; retryOf?: string | null }
  | { v: 1; run: string; type: "step"; label: string; ms: number; state?: "failed" | "stopped" }
  | {
      v: 1;
      run: string;
      type: "run.ended";
      status: Exclude<RunStatus, "running">;
      ms: number;
      at?: string;
      reason?: string | null;
      read?: string[];
      notDone?: string[];
      suggestions?: SuggestionRef[];
      asked?: string[];
      wrote?: string[];
      result?: RunResult;
      retryOf?: string | null;
    }
  | { v: 1; type: "review"; run: string | null; accepted: string[]; rejected: string[]; undone?: string[]; at: string }
  | { v: 1; type: "user"; what: "answered" | "confirmed"; round?: number; answers?: number; yourCall?: number; decisions?: number; open?: string[]; at: string }
  | { v: 1; type: "file"; what: "reloaded" | "kept-mine" | "loaded-file"; at: string };

export interface Step {
  label: string;
  ms?: number;
  state?: "running" | "failed" | "stopped";
}

/** One row in the Activity tab. Agent runs have steps and a duration; your actions and file events don't. */
export interface Entry {
  id: string;
  type: "run" | "review" | "user" | "file";
  at: string;
  kind?: RunKind;
  agent?: string;
  target?: RunTarget;
  status?: RunStatus;
  steps: Step[];
  ms?: number;
  endedAt?: string;
  reason?: string | null;
  read?: string[];
  notDone?: string[];
  suggestions?: SuggestionRef[];
  asked?: string[];
  wrote?: string[];
  result?: RunResult;
  retryOf?: string | null;
  // review
  run?: string | null;
  accepted?: string[];
  rejected?: string[];
  // user / file
  what?: string;
  round?: number;
  answers?: number;
  yourCall?: number;
  decisions?: number;
  open?: string[];
}

export function parseLines(text: string): ActivityLine[] {
  const out: ActivityLine[] = [];
  for (const l of text.split("\n")) {
    if (!l.trim()) continue;
    try {
      const x = JSON.parse(l);
      if (x && x.v === 1 && typeof x.type === "string") out.push(x);
    } catch {
      // a torn last line after a crash is skipped
    }
  }
  return out;
}

/**
 * Lines → entries, newest first. Reviews on one run's suggestions update one row while that run's
 * review is the latest entry; ⌘Z (an `undone` line) amends it. A review on an older run adds a row.
 */
export function fold(lines: ActivityLine[], live?: Map<string, string>): Entry[] {
  const list: Entry[] = [];
  const runs = new Map<string, Entry>();
  for (const l of lines) {
    if (l.type === "run.started") {
      const e: Entry = { id: l.id, type: "run", at: l.at, kind: l.kind, agent: l.agent, target: l.target, status: "running", steps: [], retryOf: l.retryOf ?? null };
      runs.set(l.id, e);
      list.push(e);
    } else if (l.type === "step") {
      runs.get(l.run)?.steps.push({ label: l.label, ms: l.ms, ...(l.state ? { state: l.state } : {}) });
    } else if (l.type === "run.ended") {
      const e = runs.get(l.run);
      if (!e) continue;
      Object.assign(e, { status: l.status, ms: l.ms, endedAt: l.at, reason: l.reason ?? null, read: l.read, notDone: l.notDone, suggestions: l.suggestions, asked: l.asked, wrote: l.wrote, result: l.result });
      if (l.retryOf) e.retryOf = l.retryOf;
    } else if (l.type === "review") {
      const last = list[list.length - 1];
      if (last?.type === "review" && last.run === l.run) {
        const acc = new Set([...(last.accepted ?? []), ...l.accepted]);
        const rej = new Set([...(last.rejected ?? []), ...l.rejected]);
        for (const id of l.undone ?? []) {
          acc.delete(id);
          rej.delete(id);
        }
        last.accepted = [...acc];
        last.rejected = [...rej];
        last.at = l.at;
        if (!acc.size && !rej.size) list.pop(); // everything undone: the row goes
      } else if (l.accepted.length || l.rejected.length) {
        list.push({ id: `rv_${list.length}`, type: "review", at: l.at, run: l.run, accepted: [...l.accepted], rejected: [...l.rejected], steps: [] });
      }
    } else if (l.type === "user") {
      list.push({ id: `u_${list.length}`, type: "user", at: l.at, what: l.what, round: l.round, answers: l.answers, yourCall: l.yourCall, decisions: l.decisions, open: l.open, steps: [] });
    } else if (l.type === "file") {
      list.push({ id: `f_${list.length}`, type: "file", at: l.at, what: l.what, steps: [] });
    }
  }
  for (const [id, label] of live ?? []) {
    const e = runs.get(id);
    if (e?.status === "running") e.steps.push({ label, state: "running" });
  }
  return list.reverse();
}

/** Runs with a `run.started` and no end: written as interrupted at the next launch (#57). */
export function interrupted(lines: ActivityLine[]): string[] {
  const open = new Set<string>();
  for (const l of lines) {
    if (l.type === "run.started") open.add(l.id);
    else if (l.type === "run.ended") open.delete(l.run);
  }
  return [...open];
}

// ---------------------------------------------------------------- durations (#53)

/** `10 ms` · `4.2 s` (one decimal under a minute) · `1 min 12 s` · `1 h 4 min`. Number, space, unit. */
export function fmt(ms: number): string {
  const n = Math.max(0, Math.round(ms));
  if (n < 1) return "<1 ms";
  if (n < 1000) return `${n} ms`;
  // Rounding never shows "60.0 s" or "60 min": 59,960 ms is "1 min 0 s" (#77).
  if (Math.round(n / 100) < 600) return `${(Math.round(n / 100) / 10).toFixed(1)} s`;
  if (n < 3_600_000) {
    const m = Math.floor(n / 60_000);
    const s = Math.round((n % 60_000) / 1000);
    if (s === 60 && m === 59) return "1 h 0 min";
    return s === 60 ? `${m + 1} min 0 s` : `${m} min ${s} s`;
  }
  const h = Math.floor(n / 3_600_000);
  const m = Math.round((n % 3_600_000) / 60_000);
  return m === 60 ? `${h + 1} h 0 min` : `${h} h ${m} min`;
}

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/** The spoken form of `fmt`, for aria-label: "4.2 seconds". */
export function say(ms: number): string {
  const t = fmt(ms);
  if (t === "<1 ms") return "less than 1 millisecond";
  const [a, b, c, d] = t.split(" ");
  const unit = (n: string, u: string) => {
    const one = n === "1" || n === "1.0";
    const w = u === "ms" ? "millisecond" : u === "s" ? "second" : u === "min" ? "minute" : "hour";
    return `${n} ${w}${one ? "" : "s"}`;
  };
  return c ? `${unit(a, b)} ${unit(c, d)}` : unit(a, b);
}

// ---------------------------------------------------------------- titles and meta (#51)

const q = (s?: string) => `“${s ?? ""}”`;
const fill = (t: string, agent: string) => t.replaceAll("{agent}", agent);

function runTitle(e: Entry): string {
  const s = e.status ?? "running";
  const sec = q(e.target?.section);
  const n = e.target?.round ?? 0;
  const qs = e.result?.questions;
  switch (e.kind) {
    case "round":
      if (s === "interrupted") return `Round ${n} didn’t finish`;
      if (s === "failed") return `Couldn’t get round ${n}`;
      if (s === "stopped") return `Stopped round ${n}`;
      if (s === "done" && qs === 0) return "Checked for more questions";
      return qs ? `Round ${n} · ${plural(qs, "question")}` : `Round ${n}`;
    case "plan":
      return { running: "Writing the plan", done: "Wrote the plan", failed: "Couldn’t write the plan", stopped: "Stopped writing the plan", interrupted: "The plan didn’t finish" }[s];
    case "reply":
      return { running: `Replying on ${sec}`, done: `Replied on ${sec}`, failed: `Couldn’t reply on ${sec}`, stopped: `Stopped replying on ${sec}`, interrupted: `Reply on ${sec} didn’t finish` }[s];
    case "apply":
      return { running: `Applying feedback on ${sec}`, done: `Applied feedback on ${sec}`, failed: `Couldn’t apply feedback on ${sec}`, stopped: `Stopped applying feedback on ${sec}`, interrupted: `Applying feedback on ${sec} didn’t finish` }[s];
    default:
      return { running: "Adding diagrams", done: "Added diagrams", failed: "Couldn’t add diagrams", stopped: "Stopped adding diagrams", interrupted: "Adding diagrams didn’t finish" }[s];
  }
}

export function title(e: Entry): string {
  if (e.type === "run") return runTitle(e);
  if (e.type === "review") {
    const a = e.accepted?.length ?? 0;
    const r = e.rejected?.length ?? 0;
    if (a && r) return `You reviewed ${plural(a + r, "suggestion")}`;
    return a ? `You accepted ${plural(a, "suggestion")}` : `You rejected ${plural(r, "suggestion")}`;
  }
  if (e.type === "user") return e.what === "confirmed" ? `You confirmed ${plural(e.decisions ?? 0, "decision")}` : `You answered round ${e.round ?? 0}`;
  return "plan.md changed on disk";
}

/** Plain words for a failure code from the agent CLI (AC17: never the raw text). */
export function reasonText(code: string | null | undefined, agent: string): string {
  switch (code) {
    case "rate":
      return `${agent} hit its usage limit`;
    case "auth":
      return `${agent} isn’t signed in`;
    case "timeout":
      return `${agent} took too long`;
    case "missing":
      return `${agent} isn’t installed`;
    case "malformed":
      return `${agent}’s reply didn’t come through`;
    default:
      return `${agent} stopped responding`;
  }
}

export function time(iso: string, seconds = false): string {
  return new Date(iso).toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit", ...(seconds ? { second: "2-digit" } : {}) });
}

/** Why the run happened and what it made, without the time: "from your comment · 1 suggestion". */
export function metaParts(e: Entry, o: { agent: string; agentId?: string; agentNameOf?: (id: string) => string; sectionOf?: (suggestion: string) => string | undefined }): string[] {
  const out: string[] = [];
  const s = e.status;
  const A = o.agent;
  const r = e.result ?? {};
  if (e.type === "run") {
    if (e.retryOf) out.push("started again after the run below");
    else if (e.kind === "round") out.push(e.target?.reask ? "asked again after your edit" : (e.target?.round ?? 1) <= 1 ? "from your idea" : `after your round ${(e.target?.round ?? 1) - 1} answers`);
    else if (e.kind === "reply" || e.kind === "apply") out.push("from your comment");
    else if (e.kind === "plan") out.push("after you confirmed");
    if (s === "done") {
      if (e.kind === "plan") out.push([r.decisions !== undefined ? plural(r.decisions, "decision") : "", r.sections !== undefined ? plural(r.sections, "section") : ""].filter(Boolean).join(" · "));
      if (e.kind === "apply") out.push(plural(r.suggestions ?? 0, "suggestion"));
      if (e.kind === "diagrams") out.push([plural(r.diagrams ?? 0, "diagram"), r.skipped ? `${plural(r.skipped, "section")} skipped` : ""].filter(Boolean).join(" · "));
      if (e.kind === "round" && r.questions === 0) out.push("nothing left to ask");
    } else if (s === "failed") out.push(`${reasonText(e.reason, A)} · nothing was changed`);
    else if (s === "stopped") out.push(e.kind === "diagrams" ? `stopped by you · ${r.diagrams ?? 0} of ${(r.diagrams ?? 0) + (e.notDone?.length ?? 0) + (r.skipped ?? 0)} diagrams kept` : "stopped by you · nothing was changed");
    else if (s === "interrupted") out.push(`Grillado was closed during the run · ${e.kind === "round" ? "your answers are safe" : "nothing was changed"}`);
    // The agent's name only when it differs from the current one (#65).
    if (e.agent && o.agentId && e.agent !== o.agentId) out.push(o.agentNameOf?.(e.agent) ?? e.agent);
  } else if (e.type === "review") {
    // The title already counts them: list the sections when it's all one way, counts only when mixed (#82).
    const a = e.accepted?.length ?? 0;
    const j = e.rejected?.length ?? 0;
    if (a && j) out.push(`${a} accepted · ${j} rejected`);
    else {
      const secs = [...new Set([...(e.accepted ?? []), ...(e.rejected ?? [])].map((id) => o.sectionOf?.(id)).filter((x): x is string => !!x))];
      if (secs.length) out.push(secs.join(" · "));
    }
  } else if (e.type === "user") {
    if (e.what === "confirmed") out.push(e.open?.length ? `${e.open.length} still open: ${e.open.join(", ")}` : "nothing open");
    else out.push([plural(e.answers ?? 0, "answer"), e.yourCall ? `${e.yourCall} your call` : ""].filter(Boolean).join(" · "));
  } else {
    out.push(e.what === "kept-mine" ? "you kept your version" : e.what === "loaded-file" ? "you loaded the file" : "reloaded, you had no unsaved edits");
  }
  return out.filter(Boolean).map((x) => fill(x, A));
}

/** The meta line: "3:16 PM · after your round 3 answers", or "Started 5:44 PM · from your comment" while running. */
export function meta(e: Entry, o: Parameters<typeof metaParts>[1]): string {
  const when = e.status === "running" ? `Started ${time(e.at)}` : time(e.endedAt ?? e.at);
  return [when, ...metaParts(e, o)].join(" · ");
}

const STATUS_WORD: Record<RunStatus, string> = { running: "running", done: "finished", failed: "failed", stopped: "stopped", interrupted: "didn’t finish" };

/** "Applied feedback on “Sync”, finished, 4.2 seconds, 5:29 PM, from your comment, 2 suggestions". */
export function accName(e: Entry, o: Parameters<typeof metaParts>[1]): string {
  const parts = [title(e)];
  if (e.type === "run") {
    parts.push(STATUS_WORD[e.status ?? "running"]);
    if (e.status === "running") parts.push(`started ${time(e.at)}`);
    else if (e.ms !== undefined) parts.push(say(e.ms));
  }
  if (e.status !== "running") parts.push(time(e.endedAt ?? e.at));
  for (const m of metaParts(e, o)) parts.push(...m.split(" · "));
  return parts.join(", ");
}

/** A step label, stored with `{agent}`, read with the current display name. */
export const stepText = (label: string, agent: string) => fill(label, agent);

// ---------------------------------------------------------------- grouping (#52)

export interface Group {
  key: string;
  entries: Entry[];
  from: string;
  to: string;
  runs: number;
  ms: number;
}

/** Work sessions: entries with no gap over 30 minutes. Input and output newest first. */
export function groups(entries: Entry[], gapMs = 30 * 60_000): Group[] {
  const out: Group[] = [];
  let cur: Group | null = null;
  let lastAt = 0;
  for (const e of entries) {
    const at = Date.parse(e.at);
    if (!cur || lastAt - at > gapMs) {
      cur = { key: e.id, entries: [], from: e.at, to: e.endedAt ?? e.at, runs: 0, ms: 0 };
      out.push(cur);
    }
    cur.entries.push(e);
    cur.from = e.at;
    if (e.type === "run") {
      cur.runs++;
      cur.ms += e.ms ?? 0;
    }
    lastAt = at;
  }
  return out;
}

const DAY = (d: Date) => `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`;

/** "Today · from 5:12 PM" or "Thu, Oct 22 · 2:40–3:31 PM". */
export function groupLabel(g: Group, now = new Date()): { label: string; today: boolean } {
  const from = new Date(g.from);
  if (DAY(from) === DAY(now)) return { label: `Today · from ${time(g.from)}`, today: true };
  const day = from.toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric" });
  const a = time(g.from);
  const b = time(g.to);
  const same = a.slice(-2) === b.slice(-2);
  return { label: `${day} · ${same ? a.slice(0, -3) : a}–${b}`, today: false };
}

export const groupMeta = (g: Group) => [g.runs ? plural(g.runs, "run") : "", g.runs ? fmt(g.ms) : ""].filter(Boolean).join(" · ");

// ---------------------------------------------------------------- copy log (#60) and live region (#61)

export function copyText(e: Entry, o: { agent: string; statusOf?: (id: string) => string }): string {
  const A = o.agent;
  const d = new Date(e.at);
  const when = `${d.toLocaleDateString("en-US", { month: "short", day: "numeric" })}, ${time(e.at)}`;
  const head = [title(e).replace(/[“”]/g, '"'), ...(e.type === "run" ? [A] : []), when, ...(e.ms !== undefined ? [fmt(e.ms)] : [])].join(" · ");
  const lines = [head, ...e.steps.filter((s) => s.state !== "running").map((s) => `- ${stepText(s.label, A).replace(/[‘’]/g, "'")}${s.ms !== undefined ? ` · ${fmt(s.ms)}` : ""}`)];
  if (e.status === "failed") lines.push(`Result: failed — ${reasonText(e.reason, A)}. Nothing was changed.`);
  else if (e.status === "stopped") lines.push("Result: stopped by you.");
  else if (e.status === "interrupted") lines.push("Result: Grillado was closed during the run.");
  else if (e.suggestions?.length) {
    const n = e.suggestions.length;
    lines.push(`Result: ${plural(n, "suggestion")} (${e.suggestions.map((x) => `${x.section ?? "Plan"}: ${o.statusOf?.(x.id) ?? "to review"}`).join(", ")})`);
  } else if (e.type === "run" && e.status === "done") lines.push(`Result: ${metaParts(e, { agent: A }).slice(1).join(" · ") || "done"}`);
  return lines.join("\n");
}

/** What the running entry is doing, for "{agent} started applying feedback on Hosting." */
function doing(e: Entry): string {
  const sec = e.target?.section ?? "";
  switch (e.kind) {
    case "round":
      return `round ${e.target?.round ?? ""}`.trim();
    case "plan":
      return "writing the plan";
    case "reply":
      return `replying on ${sec}`;
    case "apply":
      return `applying feedback on ${sec}`;
    default:
      return "adding diagrams";
  }
}

/** Run-level messages only: never per step, never assertive (#61). */
export function liveMessage(e: Entry, agent: string): string {
  const plain = (s: string) => s.replace(/[“”]/g, "");
  switch (e.status) {
    case "running":
      return `${agent} started ${doing(e)}.`;
    case "done": {
      const n = e.suggestions?.length ?? 0;
      return `${plain(title(e))} in ${say(e.ms ?? 0)}.${n ? ` ${plural(n, "suggestion")} to review.` : ""}`;
    }
    case "failed":
      return `${plain(title(e))}. ${reasonText(e.reason, agent)}.`;
    case "stopped":
      return e.kind === "diagrams" ? `${plain(title(e))}. ${e.result?.diagrams ?? 0} of ${(e.result?.diagrams ?? 0) + (e.notDone?.length ?? 0) + (e.result?.skipped ?? 0)} kept.` : `${plain(title(e))}.`;
    default:
      return `${plain(title(e))}.`;
  }
}

// ---------------------------------------------------------------- the recorder (server side)

/**
 * Times a run's steps back to back from the run start, so they add up to the run total. `step()`
 * closes the running step with its finished label and opens the next one (shown in the present).
 */
export class RunRecorder {
  readonly id: string;
  private t0 = Date.now();
  private mark = this.t0;
  current: string | null = null;
  ended = false;
  constructor(
    private write: (line: ActivityLine) => void,
    private onLive: () => void,
    start: { kind: RunKind; agent: string; target?: RunTarget; retryOf?: string | null },
  ) {
    this.id = `r_${globalThis.crypto.randomUUID().slice(0, 8)}`;
    write({ v: 1, id: this.id, type: "run.started", kind: start.kind, at: new Date(this.t0).toISOString(), agent: start.agent, ...(start.target ? { target: start.target } : {}), retryOf: start.retryOf ?? null });
  }
  /** Finish the running step (or a quick one) as `done`, then optionally start `next` (present tense). */
  step(done: string, next?: string, state?: "failed" | "stopped") {
    if (this.ended) return;
    const now = Date.now();
    this.write({ v: 1, run: this.id, type: "step", label: done, ms: now - this.mark, ...(state ? { state } : {}) });
    this.mark = now;
    this.current = next ?? null;
    this.onLive();
  }
  running(label: string) {
    this.current = label;
    this.onLive();
  }
  /** `last` names the step that failed or was stopped, in the past ("Stopped while {agent} was …"). */
  end(status: Exclude<RunStatus, "running" | "interrupted">, extra: Omit<Extract<ActivityLine, { type: "run.ended" }>, "v" | "run" | "type" | "status" | "ms" | "at"> & { last?: string } = {}) {
    if (this.ended) return;
    const { last, ...rest } = extra;
    if (this.current || (last && status !== "done")) this.step(last ?? this.current ?? "", undefined, status === "done" ? undefined : status);
    this.ended = true;
    this.current = null;
    // The total is the sum of the steps: the last step ends where the run ends.
    this.write({ v: 1, run: this.id, type: "run.ended", status, ms: this.mark - this.t0, at: new Date(this.mark).toISOString(), ...rest });
    this.onLive();
  }
}
