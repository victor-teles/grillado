// `grillado build next | start | done | ask | wait | withdraw <plan>`: the plan-to-build loop from a
// coding agent's shell. It reports and asks; it never builds, runs a command for the agent, or
// answers for the user. The result goes to stdout (Markdown-ish text, or --json); hints and errors
// to stderr. Exit codes: 0 done (a `wait` that timed out is a normal result), 1 the command
// couldn't do it, 2 wrong usage.
import { UsageError } from "./args.ts";
import { BuildError, askResult, buildAsk, buildDone, buildNext, buildStart, buildWait, buildWithdraw } from "./build.ts";
import { canOpenBrowser, openBrowser } from "./open.ts";
import { DEFAULT_WAIT_S, type PlanCommandEnv, startApp } from "./plan-command.ts";
import { PLAN_ID, sessionUrl } from "./plans.ts";
import { Store, defaultDataDir } from "./store.ts";

export const BUILD_HELP = `Usage: grillado build next <plan> [--json]
       grillado build start <plan> [--step <n>] [--json]
       grillado build done <plan> [--step <n>] --verified <text> [--deviation <text>] [--json]
       grillado build ask <plan> --key <key> --title <question> --option <id>=<label> --option <id>=<label>
                          [--body <text>] [--note <id>=<text>] [--suggest <id>] [--step <n>] [--no-open] [--json]
       grillado build wait <plan> --ask <key> [--timeout <seconds>] [--json]
       grillado build withdraw <plan> --ask <key> [--reason <text>] [--json]
All take --data-dir <path> (default ~/.grillado, or $GRILLADO_HOME).

next      The build step to work on: one in progress, else the first not done, in the user's order.
start     Report that you started a step (the one \`next\` gave, or --step).
done      Report a step done. --verified is required: the checks you ran and what they showed.
          --deviation says where you moved away from the plan, if you did.
ask       Ask the user a decision the plan doesn't cover, with 2 to 6 options of yours. It shows in
          Grillado as a card; only the user answers it. --suggest marks the one you would pick.
wait      Wait for the user's answer. Prints a waiting status (exit 0) when --timeout passes first
          (default 540 s); run it again.
withdraw  Take back an ask you no longer need. A withdrawn ask is never a decision.

Every reply gives the plan's revision. When the plan changed since you last read it (a new
decision, an edited section, a step edited or reopened), the reply says what changed: run
\`grillado plan get <plan>\` again before the next step.
`;

type Flags = Record<string, string | boolean | string[]>;
const VALUE = new Set(["--step", "--verified", "--deviation", "--key", "--title", "--body", "--suggest", "--ask", "--timeout", "--reason", "--data-dir"]);
const MANY = new Set(["--option", "--note"]);
const BOOL = new Set(["--json", "--no-open"]);

function parse(argv: string[]): { pos: string[]; flags: Flags } {
  const pos: string[] = [];
  const flags: Flags = {};
  for (let i = 0; i < argv.length; i++) {
    const raw = argv[i];
    if (!raw.startsWith("--")) {
      pos.push(raw);
      continue;
    }
    const eq = raw.indexOf("=");
    const name = eq > 0 ? raw.slice(0, eq) : raw;
    if (BOOL.has(name)) flags[name] = true;
    else if (VALUE.has(name) || MANY.has(name)) {
      const v = eq > 0 ? raw.slice(eq + 1) : argv[++i];
      if (v === undefined) throw new UsageError(`${name} needs a value.`);
      if (MANY.has(name)) flags[name] = [...((flags[name] as string[] | undefined) ?? []), v];
      else flags[name] = v;
    } else throw new UsageError(`Unknown option "${raw}" for build.\n\n${BUILD_HELP}`);
  }
  return { pos, flags };
}

const str = (f: Flags, k: string) => (typeof f[k] === "string" ? (f[k] as string) : undefined);
const many = (f: Flags, k: string) => (Array.isArray(f[k]) ? (f[k] as string[]) : []);

/** The options each command takes, besides --json and --data-dir. */
const TAKES: Record<string, string[]> = {
  next: [],
  start: ["--step"],
  done: ["--step", "--verified", "--deviation"],
  ask: ["--key", "--title", "--body", "--option", "--note", "--suggest", "--step", "--no-open"],
  wait: ["--ask", "--timeout"],
  withdraw: ["--ask", "--reason"],
};

function only(flags: Flags, cmd: string) {
  const extra = Object.keys(flags).find((k) => !TAKES[cmd].includes(k) && k !== "--json" && k !== "--data-dir");
  if (extra) throw new UsageError(`build ${cmd} doesn't take ${extra}.\n\n${BUILD_HELP}`);
}

/** Wrong usage throws, without running anything (the skills' commands are checked with this). */
export function checkBuildArgs(argv: string[]): void {
  const [sub, ...rest] = argv;
  if (!sub || !(sub in TAKES)) throw new UsageError(`Unknown build command "${sub ?? ""}".`);
  only(parse(rest).flags, sub);
}

function planArg(pos: string[], cmd: string): string {
  if (pos.length !== 1) throw new UsageError(`build ${cmd} needs one plan id (see grillado plan list).`);
  if (!PLAN_ID.test(pos[0])) throw new UsageError(`"${pos[0]}" isn't a plan id. A plan id looks like 2026-10-26-1a2b3c4d (see grillado plan list).`);
  return pos[0];
}

/** `a=Label` → { id: "a", text: "Label" }. */
function pair(raw: string, flag: string): { id: string; text: string } {
  const eq = raw.indexOf("=");
  if (eq < 1 || !raw.slice(eq + 1).trim()) throw new UsageError(`${flag} takes <id>=<text>, like ${flag} a="Keep waiting".`);
  return { id: raw.slice(0, eq).trim(), text: raw.slice(eq + 1).trim() };
}

interface Head {
  rev: number;
  progress: { done: number; of: number };
  changed?: { from: number; to: number; what: string[]; next: string };
}

/** The lines every text reply ends with: where the build stands, and what changed in the plan. */
function tail(r: Head): string[] {
  const lines = [`Plan revision ${r.rev} · ${r.progress.done} of ${r.progress.of} steps done.`];
  if (r.changed) lines.push("", `The plan changed since you last read it (rev ${r.changed.from} -> ${r.changed.to}):`, ...r.changed.what.map((w) => `  ${w}`), r.changed.next.replace(/^The plan changed since you last read it\. /, ""));
  return lines;
}

/** Runs `grillado build …`; returns the exit code. Throws UsageError for wrong usage. */
export async function runBuild(argv: string[], c: PlanCommandEnv): Promise<number> {
  const env = c.env ?? process.env;
  const [sub, ...rest] = argv;
  if (!sub || sub === "-h" || sub === "--help" || rest.includes("--help") || rest.includes("-h")) {
    c.out(BUILD_HELP);
    return sub ? 0 : 2;
  }
  if (!(sub in TAKES)) throw new UsageError(`Unknown build command "${sub}".\n\n${BUILD_HELP}`);
  const { pos, flags } = parse(rest);
  only(flags, sub);
  const json = flags["--json"] === true;
  const store = new Store(str(flags, "--data-dir") ?? env.GRILLADO_HOME ?? defaultDataDir());
  const print = (data: unknown, text: string[]) => c.out(json ? `${JSON.stringify(data, null, 2)}\n` : `${text.join("\n")}\n`);
  const id = planArg(pos, sub);
  try {
    switch (sub) {
      case "next": {
        const r = buildNext(store, id);
        print(r, r.step ? [`Step ${r.step.n}: ${r.step.title}${r.step.status === "started" ? " (in progress)" : ""}`, ...(r.step.done ? [`Done when: ${r.step.done}`] : []), "", r.next, ...tail(r)] : [r.next, ...tail(r)]);
        return 0;
      }
      case "start": {
        const r = buildStart(store, id, str(flags, "--step"));
        print(r, [`Step ${r.step.n} started: ${r.step.title}`, ...(r.step.done ? [`Done when: ${r.step.done}`] : []), "", ...tail(r)]);
        return 0;
      }
      case "done": {
        if (!str(flags, "--verified")?.trim()) throw new UsageError('build done needs --verified: the checks you ran and what they showed, like --verified "bun test test/plans.test.ts: 12 pass".');
        const r = buildDone(store, id, str(flags, "--step"), { verified: str(flags, "--verified"), deviation: str(flags, "--deviation") });
        print(r, [`Step ${r.step.n} done.`, r.next, ...tail(r)]);
        return 0;
      }
      case "ask": {
        const notes = new Map(many(flags, "--note").map((n) => [pair(n, "--note").id, pair(n, "--note").text]));
        const options = many(flags, "--option").map((o) => {
          const p = pair(o, "--option");
          return { id: p.id, label: p.text, description: notes.get(p.id) };
        });
        if (!str(flags, "--key") || !str(flags, "--title") || options.length < 2)
          throw new UsageError('build ask needs --key, --title and at least two --option, like: grillado build ask <plan> --key ask-storage --title "Where should step status live?" --option a="In the session file" --option b="In a file next to it"');
        const r = buildAsk(store, id, { key: str(flags, "--key"), title: str(flags, "--title"), body: str(flags, "--body"), options, recommended: str(flags, "--suggest"), step: str(flags, "--step") });
        // The user answers in the browser: make sure there is an app to answer in.
        let url = r.url;
        let opened = false;
        if (!url && (await startApp(c, store, c.cwd ?? process.cwd()))) {
          url = sessionUrl(store, id);
          if (url && flags["--no-open"] !== true && (c.open ? true : canOpenBrowser())) {
            (c.open ?? openBrowser)(url);
            opened = true;
          }
        }
        const next = url
          ? `The question is waiting for the user in Grillado${opened ? " (opened in the browser)" : ` (${url})`}. Wait for the answer: grillado build wait ${id} --ask ${r.ask.key}. Don't answer it yourself and don't guess meanwhile.`
          : r.next;
        print({ ...r, url, opened, next }, [`Asked: ${r.ask.title}`, next, ...tail(r)]);
        return url ? 0 : 1;
      }
      case "wait": {
        const t = str(flags, "--timeout");
        if (t !== undefined && !/^\d+$/.test(t)) throw new UsageError("--timeout takes a whole number of seconds.");
        if (!str(flags, "--ask")) throw new UsageError("build wait needs --ask <key>: the key you gave build ask.");
        askResult(store, id, str(flags, "--ask"));
        const r = await buildWait(store, id, str(flags, "--ask"), Number(t ?? DEFAULT_WAIT_S), { pollMs: c.pollMs });
        const lines = r.result === "waiting" ? [`Still waiting for the user to answer "${r.ask.title}".`, ...(r.url ? [`It is open at ${r.url}`] : [`Grillado's web app isn't running. Run \`${c.appLine(store.dir)}\` so the user can answer.`]), r.next] : r.result === "answered" ? [`Answered: ${r.answer}`, r.next] : [r.next];
        print(r, [...lines, ...tail(r)]);
        return 0;
      }
      default: {
        if (!str(flags, "--ask")) throw new UsageError("build withdraw needs --ask <key>.");
        const r = buildWithdraw(store, id, str(flags, "--ask"), str(flags, "--reason"));
        print(r, [r.next, ...tail(r)]);
        return 0;
      }
    }
  } catch (err) {
    if (err instanceof UsageError) throw err;
    c.err(`grillado: ${err instanceof Error ? err.message.replace("Call list_plans", "Run grillado plan list") : String(err)}\n`);
    return 1;
  }
}
