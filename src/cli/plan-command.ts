// `grillado plan …` (plan 004): the MCP tools as shell commands, so any coding agent with a shell can
// use Grillado with no setup. The result goes to stdout (text, or JSON with --json); hints and errors go
// to stderr. Exit 0 with a result (waiting included), 1 for a problem at run time, 2 for wrong usage.
import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import { UsageError } from "./args.ts";
import { canOpenBrowser, openBrowser } from "./open.ts";
import { MAX_COMMENT, MAX_CONTEXT, MAX_IDEA, MAX_QUOTE, PLAN_ID, agentFor, commentOnPlan, getPlan, listPlans, loadPlan, sessionUrl, startPlan } from "./plans.ts";
import { Store, defaultDataDir, resolvePlansDir } from "./store.ts";

export const PLAN_HELP = `Usage: grillado plan start <idea> [--context <text>] [--context-file <path>] [--path <dir>]
                            [--plans-dir <path>] [--agent <id>] [--from <name>] [--no-open] [--json]
       grillado plan wait <id> [--timeout <seconds>] [--json]
       grillado plan get <id> [--json]
       grillado plan list [--json]
       grillado plan comment <id> --quote <text> --text <text> [--json]
All take --data-dir <path> (default ~/.grillado, or $GRILLADO_HOME).

start   Send an idea to Grillado and open its questions in the browser (starts the web app if
        it isn't running). The user answers there; nothing is answered for them. --agent picks
        the agent that asks and writes the plan (claude, grok): one that can read the project.
wait    Wait for the user to finish and print the plan. Prints a waiting status (exit 0) when
        --timeout passes first (default 540 s); run it again.
get     Print a plan's Markdown, with its build steps (a draft while its interview isn't finished).
        To build from it step by step: grillado build --help
list    List the plans, newest first.
comment Leave a comment on a passage of a written plan (quote it exactly from \`get\`).
`;

/** Under the 10-minute limit some agent harnesses put on one shell command. */
export const DEFAULT_WAIT_S = 540;
const APP_START_MS = 15_000;

type Flags = Record<string, string | true>;
const VALUE = new Set(["--context", "--context-file", "--path", "--plans-dir", "--from", "--timeout", "--quote", "--text", "--data-dir", "--agent"]);
const BOOL = new Set(["--no-open", "--json"]);

function parse(argv: string[]): { pos: string[]; flags: Flags } {
  const pos: string[] = [];
  const flags: Flags = {};
  for (let i = 0; i < argv.length; i++) {
    const raw = argv[i];
    if (raw === "--") {
      pos.push(...argv.slice(i + 1));
      break;
    }
    if (!raw.startsWith("--")) {
      pos.push(raw);
      continue;
    }
    const eq = raw.indexOf("=");
    const name = eq > 0 ? raw.slice(0, eq) : raw;
    if (BOOL.has(name)) flags[name] = true;
    else if (VALUE.has(name)) {
      const v = eq > 0 ? raw.slice(eq + 1) : argv[++i];
      if (v === undefined) throw new UsageError(`${name} needs a value.`);
      flags[name] = v;
    } else throw new UsageError(`Unknown option "${raw}" for plan.\n\n${PLAN_HELP}`);
  }
  return { pos, flags };
}

const str = (f: Flags, k: string) => (typeof f[k] === "string" ? (f[k] as string) : undefined);

/** The options each command takes, besides --json and --data-dir. */
const TAKES: Record<string, string[]> = {
  start: ["--context", "--context-file", "--path", "--plans-dir", "--from", "--no-open", "--agent"],
  wait: ["--timeout"],
  get: [],
  list: [],
  comment: ["--quote", "--text", "--from"],
};

function only(flags: Flags, cmd: string) {
  const extra = Object.keys(flags).find((k) => !TAKES[cmd].includes(k) && k !== "--json" && k !== "--data-dir");
  if (extra) throw new UsageError(`plan ${cmd} doesn't take ${extra}.\n\n${PLAN_HELP}`);
}

/** Wrong usage throws, without running anything (the skills' commands are checked with this). */
export function checkPlanArgs(argv: string[]): void {
  const [sub, ...rest] = argv;
  if (!sub || !(sub in TAKES)) throw new UsageError(`Unknown plan command "${sub ?? ""}".`);
  only(parse(rest).flags, sub);
}

function planIdArg(pos: string[], cmd: string): string {
  if (pos.length !== 1) throw new UsageError(`plan ${cmd} needs one plan id (see grillado plan list).`);
  if (!PLAN_ID.test(pos[0])) throw new UsageError(`"${pos[0]}" isn't a plan id. A plan id looks like 2026-10-26-1a2b3c4d (see grillado plan list).`);
  return pos[0];
}

export interface PlanCommandEnv {
  version: string;
  /** stdout: the result only. */
  out: (s: string) => void;
  /** stderr: hints and errors. */
  err: (s: string) => void;
  env?: NodeJS.ProcessEnv;
  cwd?: string;
  /** This CLI, to start the web app in the background (dist/cli.js). */
  cliFile: string;
  node?: string;
  /** How to start the web app, for messages. */
  appLine: (dataDir: string) => string;
  /** Tests: don't open a browser, and how often `wait` looks. */
  open?: (url: string) => void;
  pollMs?: number;
}

/** Runs `grillado plan …`; returns the exit code. Throws UsageError for wrong usage. */
export async function runPlan(argv: string[], c: PlanCommandEnv): Promise<number> {
  const env = c.env ?? process.env;
  const [sub, ...rest] = argv;
  if (!sub || sub === "-h" || sub === "--help" || rest.includes("--help") || rest.includes("-h")) {
    c.out(PLAN_HELP);
    return sub ? 0 : 2;
  }
  const { pos, flags } = parse(rest);
  const json = flags["--json"] === true;
  const store = new Store(str(flags, "--data-dir") ?? env.GRILLADO_HOME ?? defaultDataDir());
  const print = (data: unknown, text: string) => c.out(json ? `${JSON.stringify(data, null, 2)}\n` : text.endsWith("\n") ? text : `${text}\n`);
  try {
    switch (sub) {
      case "list": {
        only(flags, "list");
        if (pos.length) throw new UsageError("plan list takes no arguments.");
        const plans = listPlans(store);
        print({ plans }, plans.length ? plans.map((p) => `${p.id}  ${p.draft ? `draft (${p.status})` : "plan"}  ${p.title}`).join("\n") : "No plans yet. Start one with: grillado plan start \"<idea>\"");
        return 0;
      }
      case "get": {
        only(flags, "get");
        const p = getPlan(store, planIdArg(pos, "get"));
        print(p, p.markdown);
        return 0;
      }
      case "comment": {
        only(flags, "comment");
        const plan = planIdArg(pos, "comment");
        const quote = str(flags, "--quote");
        const text = str(flags, "--text")?.trim();
        if (!quote) throw new UsageError("plan comment needs --quote, copied exactly from the plan's Markdown.");
        if (!text) throw new UsageError("plan comment needs --text.");
        if (quote.length > MAX_QUOTE) throw new UsageError(`--quote is longer than ${MAX_QUOTE} characters.`);
        if (text.length > MAX_COMMENT) throw new UsageError(`--text is longer than ${MAX_COMMENT} characters.`);
        const r = commentOnPlan(store, { plan, quote, text, client: str(flags, "--from") });
        print(r, `Comment added to plan ${plan}. It's in Grillado's Comments rail.`);
        return 0;
      }
      case "wait": {
        only(flags, "wait");
        const id = planIdArg(pos, "wait");
        const t = str(flags, "--timeout");
        if (t !== undefined && !/^\d+$/.test(t)) throw new UsageError("--timeout takes a whole number of seconds.");
        const until = Date.now() + Number(t ?? DEFAULT_WAIT_S) * 1000;
        loadPlan(store, id);
        for (;;) {
          const s = loadPlan(store, id);
          if (s.status === "plated" && s.plan) {
            const p = getPlan(store, id);
            print({ result: "ready", ...p }, p.markdown);
            return 0;
          }
          if (Date.now() >= until) {
            const answered = s.rounds.filter((r) => r.answers).length;
            const decisions = Object.keys(s.decisions).length;
            const url = sessionUrl(store, id);
            const where = `${s.status}, ${answered} ${answered === 1 ? "round" : "rounds"} answered, ${decisions} ${decisions === 1 ? "decision" : "decisions"} so far`;
            const lines = [`Still waiting for the user to finish plan ${id} (${where}).`];
            if (s.error) lines.push(`The last agent run failed: ${s.error.message} The user can retry in the browser.`);
            lines.push(url ? `Questions: ${url}` : `Grillado's web app isn't running. Run \`${c.appLine(store.dir)}\` to answer.`);
            lines.push(`Run \`grillado plan wait ${id}\` again to keep waiting.`);
            print({ result: "waiting", id, status: s.status, roundsAnswered: answered, decisions, url, error: s.error?.message ?? null }, lines.join("\n"));
            return 0;
          }
          await new Promise((r) => setTimeout(r, c.pollMs ?? 1000));
        }
      }
      case "start": {
        only(flags, "start");
        const idea = pos.join(" ").trim();
        if (!idea) throw new UsageError('plan start needs the idea, in the user\'s words: grillado plan start "<idea>"');
        if (idea.length > MAX_IDEA) throw new UsageError(`The idea is longer than ${MAX_IDEA} characters; put the rest in --context.`);
        if (flags["--context"] !== undefined && flags["--context-file"] !== undefined) throw new UsageError("Use --context or --context-file, not both.");
        const file = str(flags, "--context-file");
        const context = file ? readFileSync(path.resolve(c.cwd ?? process.cwd(), file), "utf8") : str(flags, "--context");
        if (context && context.length > MAX_CONTEXT) throw new UsageError(`The context is longer than ${MAX_CONTEXT} characters.`);
        const cwd = path.resolve(c.cwd ?? process.cwd(), str(flags, "--path") ?? ".");
        const appLine = c.appLine(store.dir);
        const plansDir = str(flags, "--plans-dir");
        const agent = agentFor(str(flags, "--agent"));
        const r = await startPlan(store, { idea, context, cwd, agent, plansDir: plansDir ? resolvePlansDir(cwd, plansDir) : undefined, from: str(flags, "--from") ?? "", appLine, scanOff: env.GRILLADO_NO_SCAN === "1" });
        let app: "running" | "started" | "unavailable" = r.url ? "running" : "unavailable";
        let url = r.url;
        if (!url) {
          url = await startApp(c, store, cwd);
          if (url) app = "started";
        }
        const sessionLink = url ? sessionUrl(store, r.id) : null;
        const wantOpen = flags["--no-open"] !== true && !!sessionLink && (c.open ? true : canOpenBrowser());
        if (wantOpen && sessionLink) (c.open ?? openBrowser)(sessionLink);
        const next = sessionLink
          ? `The questions are open in the browser${wantOpen ? "" : ` at ${sessionLink}`}. When the user finishes, run: grillado plan wait ${r.id}`
          : `Grillado's web app couldn't be started. Run \`${appLine}\` and open this idea from Recent.`;
        print({ id: r.id, url: sessionLink, opened: wantOpen, app, next, ...(r.projectContext ? { projectContext: r.projectContext } : {}) }, `Started plan ${r.id}.\n${sessionLink ?? ""}${sessionLink ? "\n" : ""}${next}`);
        return sessionLink ? 0 : 1;
      }
      default:
        throw new UsageError(`Unknown plan command "${sub}".\n\n${PLAN_HELP}`);
    }
  } catch (err) {
    if (err instanceof UsageError) throw err;
    c.err(`grillado: ${err instanceof Error ? err.message.replace("Call list_plans", "Run grillado plan list") : String(err)}\n`);
    return 1;
  }
}

/**
 * Start the web app in the background for this data dir, in the project folder, so the user can
 * answer. It quits on its own once nobody has used it for a while (--exit-when-idle).
 */
export async function startApp(c: PlanCommandEnv, store: Store, cwd: string): Promise<string | null> {
  const args = [c.cliFile, "--no-open", "--exit-when-idle", "--data-dir", store.dir];
  try {
    const child = spawn(c.node ?? process.execPath, args, { cwd, env: c.env ?? process.env, detached: true, stdio: "ignore" });
    child.unref();
  } catch {
    return null;
  }
  const end = Date.now() + APP_START_MS;
  while (Date.now() < end) {
    const info = store.readServerInfo();
    if (info) return `http://127.0.0.1:${info.port}/?t=${info.token}`;
    await new Promise((r) => setTimeout(r, 100));
  }
  return null;
}
