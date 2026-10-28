// Linear over its GraphQL API with the user's personal API key (v1.3 item 2). The key goes in the
// Authorization header as is (personal keys take no "Bearer" prefix) and only to api.linear.app.
import { type IssueLink, markerSearch, readMarker } from "../../core/issues.ts";
import { type IssueTracker, type NewIssue, type RemoteIssue, TrackerError, said, saidAfter } from "./tracker.ts";

export const LINEAR_URL = "https://api.linear.app/graphql";
export const LINEAR_KEYS_URL = "https://linear.app/settings/account/security";

export interface LinearOptions {
  /** Tests point it at a mock server. */
  url?: string;
  /** Back-off before the one retry after a rate limit, when Linear doesn't say (ms). */
  retryMs?: number;
  fetch?: typeof fetch;
}

const ISSUE = "id identifier number url title description";

export class Linear {
  constructor(
    private key: string,
    private o: LinearOptions = {},
  ) {}

  /** One GraphQL call. A rate limit backs off and retries once (spec edge case), then fails. */
  async gql<T = any>(query: string, variables: Record<string, unknown> = {}): Promise<T> {
    for (let attempt = 1; ; attempt++) {
      let res: Response;
      try {
        res = await (this.o.fetch ?? fetch)(this.o.url ?? LINEAR_URL, {
          method: "POST",
          headers: { "Content-Type": "application/json", Authorization: this.key },
          body: JSON.stringify({ query, variables }),
          signal: AbortSignal.timeout(30_000),
        });
      } catch (err) {
        throw new TrackerError("failed", saidAfter("Couldn’t connect", String((err as Error)?.message ?? err)));
      }
      const j: any = await res.json().catch(() => ({}));
      const errs: any[] = j?.errors ?? [];
      const code = (e: any) => String(e?.extensions?.code ?? e?.extensions?.type ?? "").toUpperCase();
      const limited = res.status === 429 || errs.some((e) => code(e) === "RATELIMITED");
      if (limited) {
        if (attempt >= 2) throw new TrackerError("rate", "Rate limited. Try again in a minute.");
        const after = Number(res.headers.get("retry-after"));
        await new Promise((r) => setTimeout(r, after > 0 ? Math.min(after, 60) * 1000 : (this.o.retryMs ?? 2000)));
        continue;
      }
      if (res.status === 401 || errs.some((e) => code(e) === "AUTHENTICATION_ERROR")) throw new TrackerError("bad_key", "That key didn’t work.");
      if (errs.length) {
        const e = errs[0];
        if (code(e) === "FORBIDDEN") throw new TrackerError("access", said(e.message ?? ""));
        const err = new TrackerError("failed", said(String(e.extensions?.userPresentableMessage ?? e.message ?? "")));
        (err as any).notFound = /not found|could not find/i.test(String(e.message ?? ""));
        throw err;
      }
      if (!res.ok) throw new TrackerError("failed", `Error ${res.status}.`);
      return j.data as T;
    }
  }

  /** Read: who the key belongs to (Connect checks the key with this). */
  async viewer(): Promise<{ id: string; name: string }> {
    return (await this.gql(`query { viewer { id name } }`)).viewer;
  }

  async teams(): Promise<{ id: string; name: string; key: string }[]> {
    return (await this.gql(`query { teams(first: 250) { nodes { id name key } } }`)).teams.nodes;
  }

  async projects(teamId: string): Promise<{ id: string; name: string }[]> {
    return (await this.gql(`query($id: String!) { team(id: $id) { projects(first: 250) { nodes { id name } } } }`, { id: teamId })).team.projects.nodes;
  }

  async labels(teamId: string): Promise<{ id: string; name: string; color: string }[]> {
    return (await this.gql(`query($id: String!) { team(id: $id) { labels(first: 250) { nodes { id name color } } } }`, { id: teamId })).team.labels.nodes;
  }
}

function toRemote(x: any): RemoteIssue {
  return { id: x.id, identifier: x.identifier, number: x.number, url: x.url, title: x.title ?? "", body: x.description ?? "" };
}

export class LinearTracker implements IssueTracker {
  readonly kind = "linear" as const;
  constructor(
    private api: Linear,
    readonly teamId: string,
    readonly teamName: string,
    private projectId?: string,
  ) {}

  get name() {
    return `Linear · ${this.teamName}`;
  }

  async findByMarker(planId: string) {
    const q = `query($m: String!, $team: ID!) { issues(first: 250, includeArchived: true, filter: { team: { id: { eq: $team } }, description: { contains: $m } }) { nodes { ${ISSUE} } } }`;
    const found = new Map<string, RemoteIssue>();
    for (const x of (await this.api.gql(q, { m: markerSearch(planId), team: this.teamId })).issues.nodes) {
      const m = readMarker(x.description ?? "");
      if (m?.plan === planId && !found.has(m.key)) found.set(m.key, toRemote(x));
    }
    return found;
  }

  async get(link: IssueLink) {
    try {
      const x = (await this.api.gql(`query($id: String!) { issue(id: $id) { ${ISSUE} archivedAt trashed } }`, { id: link.id })).issue;
      return !x || x.trashed ? null : toRemote(x);
    } catch (err) {
      if ((err as any).notFound) return null;
      throw err;
    }
  }

  async create(issue: NewIssue, parent?: IssueLink) {
    const input = {
      teamId: this.teamId,
      title: issue.title,
      description: issue.body,
      ...(this.projectId ? { projectId: this.projectId } : {}),
      ...(issue.labels.length ? { labelIds: issue.labels } : {}),
      ...(parent ? { parentId: parent.id } : {}),
    };
    const r = (await this.api.gql(`mutation($input: IssueCreateInput!) { issueCreate(input: $input) { success issue { ${ISSUE} } } }`, { input })).issueCreate;
    if (!r?.success || !r.issue) throw new TrackerError("failed", "The issue wasn’t created.");
    return { issue: toRemote(r.issue), attached: !!parent };
  }

  async update(link: IssueLink, issue: NewIssue) {
    const r = (await this.api.gql(`mutation($id: String!, $input: IssueUpdateInput!) { issueUpdate(id: $id, input: $input) { success issue { ${ISSUE} } } }`, { id: link.id, input: { title: issue.title, description: issue.body } })).issueUpdate;
    if (!r?.success || !r.issue) throw new TrackerError("failed", "The issue wasn’t updated.");
    return toRemote(r.issue);
  }

  async attach(child: IssueLink, parent: IssueLink) {
    const r = (await this.api.gql(`mutation($id: String!, $input: IssueUpdateInput!) { issueUpdate(id: $id, input: $input) { success } }`, { id: child.id, input: { parentId: parent.id } })).issueUpdate;
    if (!r?.success) throw new TrackerError("failed", "The sub-issue wasn’t linked.");
  }
}
