// GitHub through the user's own `gh` (v1.3 item 2). Grillado keeps no GitHub token: every call is
// `gh` with a fixed argv (no shell), and issue bodies go through a temp file, never the argv.
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { type IssueLink, contentHash, readMarker, markerSearch } from "../../core/issues.ts";
import { runProcess } from "../../core/providers/process.ts";
import { type IssueTracker, type NewIssue, type RemoteIssue, TrackerError, said } from "./tracker.ts";

/** `gh issue create --parent` landed in 2.94; older versions attach through the sub-issues API. */
export const PARENT_FLAG_VERSION = [2, 94, 0] as const;

export interface GhOptions {
  bin?: string;
  env?: NodeJS.ProcessEnv;
  timeoutMs?: number;
}

export type GhStatus =
  | { state: "missing" }
  | { state: "auth"; version: string; host: string; command: string }
  | { state: "ready"; version: string; host: string; user: string | null; subIssues: "flag" | "api" };

export interface GhRepo {
  repo: string;
  visibility: "public" | "private" | "internal";
  /** Can create issues, labels and sub-issues (triage or more). */
  access: boolean;
  /** The fork's parent, offered as "upstream". */
  upstream?: string;
}

export function parseVersion(out: string): number[] | null {
  const m = /gh version (\d+)\.(\d+)\.(\d+)/.exec(out);
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null;
}

export function atLeast(v: number[], min: readonly number[]): boolean {
  for (let i = 0; i < min.length; i++) if ((v[i] ?? 0) !== min[i]) return (v[i] ?? 0) > min[i];
  return true;
}

const isDefaultHost = (host: string) => !host || host === "github.com";

export class Gh {
  constructor(readonly o: GhOptions = {}) {}

  /** One `gh` call. A gh that isn't on PATH is TrackerError("missing"). */
  async run(args: string[], extra: Record<string, string> = {}): Promise<{ code: number | null; out: string; err: string }> {
    const cwd = mkdtempSync(path.join(os.tmpdir(), "grillado-gh-"));
    try {
      const env = { ...(this.o.env ?? process.env), GH_PROMPT_DISABLED: "1", GH_NO_UPDATE_NOTIFIER: "1", NO_COLOR: "1", GH_PAGER: "", PAGER: "cat", ...extra };
      const r = await runProcess(this.o.bin ?? "gh", args, { cwd, env, timeoutMs: this.o.timeoutMs ?? 60_000 });
      if (r.spawnError) throw new TrackerError("missing", "gh isn't installed");
      if (r.timedOut) throw new TrackerError("failed", "gh took too long");
      return { code: r.exitCode, out: r.stdout, err: r.stderr };
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  }

  /** Read: version, then whether gh is signed in to `host`. */
  async status(host = "github.com"): Promise<GhStatus> {
    let v: Awaited<ReturnType<Gh["run"]>>;
    try {
      v = await this.run(["--version"]);
    } catch (err) {
      if (err instanceof TrackerError && err.code === "missing") return { state: "missing" };
      throw err;
    }
    const version = parseVersion(v.out);
    if (v.code !== 0 || !version) return { state: "missing" };
    const ver = version.join(".");
    const a = await this.run(["auth", "status", "--hostname", host]);
    if (a.code !== 0) return { state: "auth", version: ver, host, command: isDefaultHost(host) ? "gh auth login" : `gh auth login --hostname ${host}` };
    const user = /account (\S+)/.exec(`${a.out}\n${a.err}`)?.[1] ?? /as (\S+)/.exec(`${a.out}\n${a.err}`)?.[1] ?? null;
    return { state: "ready", version: ver, host, user, subIssues: atLeast(version, PARENT_FLAG_VERSION) ? "flag" : "api" };
  }

  /** Read: visibility, access and fork parent. A repo gh can't see is `access: false`. */
  async repo(repo: string, host = "github.com"): Promise<GhRepo> {
    const r = await this.run(["repo", "view", repoArg(repo, host), "--json", "nameWithOwner,visibility,viewerPermission,isFork,parent"]);
    if (r.code !== 0) return { repo, visibility: "private", access: false };
    const j = JSON.parse(r.out);
    const perm = String(j.viewerPermission ?? "").toUpperCase();
    const parent = j.parent?.owner?.login && j.parent?.name ? `${j.parent.owner.login}/${j.parent.name}` : undefined;
    return {
      repo: j.nameWithOwner ?? repo,
      visibility: String(j.visibility ?? "private").toLowerCase() as GhRepo["visibility"],
      access: ["ADMIN", "MAINTAIN", "WRITE", "TRIAGE"].includes(perm),
      ...(j.isFork && parent ? { upstream: parent } : {}),
    };
  }

  /** Read: the user's repositories, for the picker. */
  async repos(host = "github.com"): Promise<string[]> {
    // `gh repo list` has no --hostname; GH_HOST picks the Enterprise host.
    const r = await this.run(["repo", "list", "--limit", "100", "--json", "nameWithOwner"], isDefaultHost(host) ? {} : { GH_HOST: host });
    if (r.code !== 0) throw this.fail(r.err);
    return (JSON.parse(r.out) as { nameWithOwner: string }[]).map((x) => x.nameWithOwner);
  }

  /** Read: the repo's labels. */
  async labels(repo: string, host = "github.com"): Promise<{ name: string; color: string }[]> {
    const r = await this.run(["label", "list", "--repo", repoArg(repo, host), "--limit", "200", "--json", "name,color"]);
    if (r.code !== 0) throw this.fail(r.err);
    return JSON.parse(r.out);
  }

  fail(err: string): TrackerError {
    if (/gh auth login|not logged|authentication|HTTP 401/i.test(err)) return new TrackerError("auth", said(err));
    if (/HTTP 403|HTTP 404|Could not resolve to a Repository|not have permission|must have (?:push|triage|write)/i.test(err)) return new TrackerError("access", said(err));
    if (/rate limit/i.test(err)) return new TrackerError("rate", said(err));
    return new TrackerError("failed", said(err));
  }
}

/** `--repo` takes HOST/OWNER/REPO for GitHub Enterprise. */
export const repoArg = (repo: string, host: string) => (isDefaultHost(host) ? repo : `${host}/${repo}`);

export class GitHubTracker implements IssueTracker {
  readonly kind = "github" as const;
  constructor(
    private gh: Gh,
    readonly repo: string,
    readonly host: string,
    /** "flag": `gh issue create --parent`; "api": create, then POST …/sub_issues. */
    private subIssues: "flag" | "api",
  ) {}

  get name() {
    return this.repo;
  }

  private api(...args: string[]) {
    return this.gh.run(["api", ...(isDefaultHost(this.host) ? [] : ["--hostname", this.host]), ...args]);
  }

  private async issue(n: number): Promise<RemoteIssue | null> {
    const r = await this.api(`repos/${this.repo}/issues/${n}`);
    if (r.code !== 0) {
      if (/HTTP 404|HTTP 410|Not Found/i.test(r.err)) return null;
      throw this.gh.fail(r.err);
    }
    return toRemote(JSON.parse(r.out));
  }

  async findByMarker(planId: string) {
    const r = await this.gh.run(["issue", "list", "--repo", repoArg(this.repo, this.host), "--search", `"${markerSearch(planId)}" in:body`, "--state", "all", "--limit", "200", "--json", "number,url,title,body"]);
    if (r.code !== 0) throw this.gh.fail(r.err);
    const found = new Map<string, RemoteIssue>();
    for (const x of JSON.parse(r.out) as { number: number; url: string; title: string; body: string }[]) {
      const m = readMarker(x.body);
      if (m?.plan !== planId || found.has(m.key)) continue;
      // The sub-issues API takes the database id, which `issue list` doesn't give.
      const full = await this.issue(x.number);
      if (full) found.set(m.key, full);
    }
    return found;
  }

  get(link: IssueLink) {
    return this.issue(link.number!);
  }

  async create(issue: NewIssue, parent?: IssueLink) {
    const dir = mkdtempSync(path.join(os.tmpdir(), "grillado-issue-"));
    try {
      const file = path.join(dir, "body.md");
      writeFileSync(file, issue.body, { mode: 0o600 });
      const args = ["issue", "create", "--repo", repoArg(this.repo, this.host), "--title", issue.title, "--body-file", file];
      for (const l of issue.labels) args.push("--label", l);
      if (parent && this.subIssues === "flag") args.push("--parent", String(parent.number));
      const r = await this.gh.run(args);
      const url = r.out.match(/https?:\/\/\S+\/issues\/(\d+)/);
      if (r.code !== 0 && !url) throw this.gh.fail(r.err);
      if (!url) throw new TrackerError("failed", "gh didn't print the new issue's link");
      const made = (await this.issue(Number(url[1]))) ?? { id: "", number: Number(url[1]), url: url[0], title: issue.title, body: issue.body };
      // With --parent, a create that worked but couldn't attach prints the link and fails.
      if (parent && this.subIssues === "flag") return r.code === 0 ? { issue: made, attached: true } : { issue: made, attached: false, attachError: said(r.err) };
      if (!parent) return { issue: made, attached: false };
      try {
        await this.attachIds(made.id, parent);
        return { issue: made, attached: true };
      } catch (err) {
        return { issue: made, attached: false, attachError: (err as Error).message };
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }

  async update(link: IssueLink, issue: NewIssue) {
    const dir = mkdtempSync(path.join(os.tmpdir(), "grillado-issue-"));
    try {
      const file = path.join(dir, "body.md");
      writeFileSync(file, issue.body, { mode: 0o600 });
      const r = await this.gh.run(["issue", "edit", String(link.number), "--repo", repoArg(this.repo, this.host), "--title", issue.title, "--body-file", file]);
      if (r.code !== 0) throw this.gh.fail(r.err);
      return (await this.issue(link.number!)) ?? { id: link.id, number: link.number, url: link.url, title: issue.title, body: issue.body };
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }

  /** An existing issue made a sub-issue: `gh issue edit --parent` on 2.94+, else the API. */
  async attach(child: IssueLink, parent: IssueLink) {
    if (this.subIssues === "api") return this.attachIds(child.id, parent);
    const r = await this.gh.run(["issue", "edit", String(child.number), "--repo", repoArg(this.repo, this.host), "--parent", String(parent.number)]);
    if (r.code !== 0) throw this.gh.fail(r.err);
  }

  /** The sub-issues REST API: POST …/issues/{parent number}/sub_issues with the child's database id (an integer, so -F). */
  private async attachIds(childId: string, parent: IssueLink) {
    const r = await this.api("-X", "POST", `repos/${this.repo}/issues/${parent.number}/sub_issues`, "-F", `sub_issue_id=${childId}`);
    if (r.code !== 0) throw this.gh.fail(r.err);
  }

  async createLabels(names: string[]) {
    for (const name of names) {
      const r = await this.gh.run(["label", "create", name, "--repo", repoArg(this.repo, this.host)]);
      if (r.code !== 0 && !/already exists/i.test(r.err)) throw this.gh.fail(r.err);
    }
  }
}

function toRemote(j: any): RemoteIssue {
  return { id: String(j.id), number: j.number, url: j.html_url ?? j.url, title: j.title ?? "", body: j.body ?? "" };
}

export const remoteHash = (x: RemoteIssue) => contentHash(x.title, x.body);

/** "git@github.com:o/r.git", "https://ghe.acme.com/o/r", "ssh://git@host/o/r.git" → host and owner/repo. */
export function parseRemote(url: string): { host: string; repo: string } | null {
  const t = url.trim();
  const m = /^(?:[\w.-]+@)?([\w.-]+):(?!\/\/)([\w.-]+\/[\w.-]+?)(?:\.git)?\/?$/.exec(t) ?? /^(?:https?|ssh|git):\/\/(?:[^@/]+@)?([\w.-]+)(?::\d+)?\/([\w.-]+\/[\w.-]+?)(?:\.git)?\/?$/.exec(t);
  return m ? { host: m[1].toLowerCase(), repo: m[2] } : null;
}

/** Read, local: the project's origin and upstream remotes (no network). */
export async function projectRemotes(dir: string): Promise<{ origin?: { host: string; repo: string }; upstream?: { host: string; repo: string } }> {
  const get = (name: string) =>
    new Promise<string | null>((resolve) => execFile("git", ["-C", dir, "remote", "get-url", name], { timeout: 5000 }, (err, out) => resolve(err ? null : String(out))));
  const [o, u] = await Promise.all([get("origin"), get("upstream")]);
  const origin = o ? parseRemote(o) : null;
  const upstream = u ? parseRemote(u) : null;
  return { ...(origin ? { origin } : {}), ...(upstream ? { upstream } : {}) };
}
