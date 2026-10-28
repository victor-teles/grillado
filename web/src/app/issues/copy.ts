// "Send to issues" (v1.3 item 2) copy, from HANDOFF-ENGINEER-item2.md §1–§8.
import type { Tracker } from "../types";

export const TNAME: Record<Tracker, string> = { github: "GitHub", linear: "Linear" };
export const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
/** "label v1.3" / "labels v1.3, ux". */
export const labelsLine = (names: string[]) => (names.length ? `${names.length === 1 ? "label" : "labels"} ${names.join(", ")}` : "");

export const ICOPY = {
  menuCreate: "Create issues…",
  menuUpdate: "Update issues…",
  menuDraft: "Finish the plan first",
  titleCreate: "Create issues",
  titleUpdate: "Update issues",
  intro: "A parent issue for the plan and one issue per slice of work. Nothing is created until you confirm.",
  why: {
    "no-remote": "This project has no GitHub remote, so it opens on Linear, which you used last.",
    "no-gh": "gh isn’t installed, so it opens on Linear, which you used last.",
  },
  repoHintNone: "This plan has no git remote. Pick or type a repository.",
  parentLocked: "The parent stays while any issue below is selected",
  over100: "A GitHub parent holds up to 100 sub-issues. The rest stay in the plan.",
  cut: (t: Tracker) => `Cut to fit ${TNAME[t]} · the rest stays in the plan`,
  // §4 blocked reasons, keyed on the server's error code or the sheet's own state, never on `error`.
  blocked: {
    repo: "Pick a repository to continue",
    access: "Pick a repository you can write to",
    missing: "Install gh to continue",
    auth: "Sign in to gh to continue",
    linear: "Connect Linear to continue",
    team: "Pick a team to continue",
    none: "Select at least one issue",
    split: "Waiting for the split",
  },
  howGh: (user: string) => `Runs gh as @${user} on this computer. Nothing is sent before you click.`,
  howLinear: "Sends to api.linear.app with your saved key. Nothing is sent before you click.",
  pub: "Public repo: anyone can read these issues",
  nothing: "Nothing changed since the export",
  running: "You can close this. It keeps going.",
  fix: {
    missing: ["GitHub CLI isn’t installed", "Grillado creates issues through your own gh, so it never keeps a GitHub token. Install it, then check again."],
    auth: (host: string) => [`gh isn’t signed in to ${host}`, "Sign in once in a terminal, then check again."],
    host: (host: string) => [`gh isn’t signed in to ${host}`, "This project’s remote is on GitHub Enterprise. Sign in to that host, then check again."],
    access: (repo: string, user: string) => [`You can’t create issues in ${repo}`, `gh is signed in as @${user}, who has no write access there. Pick another repository.`],
  },
  keyHint: "It stays on this computer and goes only to Linear.",
  badKey: "That key didn’t work.",
  disconnectAsk: "Disconnect Linear? You’ll paste a key again next time.",
  /** Before the first split (option B, DECISIONS #186) it isn't "again". */
  splitAsk: (agent: string, again: boolean) => (again ? "Split again? Your title edits are replaced." : `Split with ${agent}? Your title edits are replaced.`),
} as const;
