// The two trackers behind one small interface, so the export run (service.ts) is tracker-agnostic.
import type { IssueLink, Tracker } from "../../core/issues.ts";

/** An issue as the tracker has it now. */
export interface RemoteIssue {
  id: string;
  number?: number;
  identifier?: string;
  url: string;
  title: string;
  body: string;
}

export type TrackerErrorCode =
  /** gh isn't on PATH. */
  | "missing"
  /** gh isn't signed in (to this host). */
  | "auth"
  /** No access to the repository or team. */
  | "access"
  /** Linear rejected the key. */
  | "bad_key"
  /** Still rate limited after one back-off. */
  | "rate"
  /** Anything else the tracker said. */
  | "failed";

export class TrackerError extends Error {
  constructor(
    readonly code: TrackerErrorCode,
    message: string,
  ) {
    super(message);
  }
}

export interface NewIssue {
  title: string;
  body: string;
  labels: string[];
}

export interface IssueTracker {
  readonly kind: Tracker;
  /** "victor-teles/grillado", or "Linear · Team Core", for messages. */
  readonly name: string;
  /** Read: issues carrying this plan's hidden marker, by item key (dedupe when a link is lost). */
  findByMarker(planId: string): Promise<Map<string, RemoteIssue>>;
  /** Read: the linked issue now, or null when the tracker says it's gone. */
  get(link: IssueLink): Promise<RemoteIssue | null>;
  /** Write. With a parent, the new issue is its sub-issue. */
  create(issue: NewIssue, parent?: IssueLink): Promise<{ issue: RemoteIssue; attached: boolean; attachError?: string }>;
  /** Write: new title and body. */
  update(link: IssueLink, issue: NewIssue): Promise<RemoteIssue>;
  /** Write: make `child` a sub-issue of `parent` (re-attach after a Recreate, or retry a failed attach). */
  attach(child: IssueLink, parent: IssueLink): Promise<void>;
  /** Write: create labels the user typed and confirmed (GitHub only). */
  createLabels?(names: string[]): Promise<void>;
}

/** The tracker's own words, short and on one line, for "GitHub said: …". */
export function said(text: string): string {
  const line =
    text
      .split("\n")
      .map((l) => l.trim())
      .find((l) => l && !/^\s*$/.test(l)) ?? "";
  const t = line.replace(/^(error|gh|graphql):\s*/i, "");
  return t.length > 200 ? `${t.slice(0, 197)}…` : t || NO_REASON;
}

const NO_REASON = "No reason given.";

/** "Couldn’t connect: fetch failed" with the tracker's words, or just "Couldn’t connect." when it gave none. */
export function saidAfter(lead: string, text: string | undefined): string {
  const t = text === undefined ? "" : said(text);
  return t && t !== NO_REASON ? `${lead}: ${t}` : `${lead}.`;
}
