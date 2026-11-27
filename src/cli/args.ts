import { PROVIDER_IDS, type ProviderId } from "../core/providers/types.ts";
import { DEFAULT_MAX_ROUNDS } from "../core/session.ts";

export interface CliArgs {
  /** `grillado mcp`: the stdio MCP server instead of the web app. */
  command?: "mcp";
  port?: number;
  provider?: ProviderId;
  open: boolean;
  dataDir?: string;
  /** `--plans-dir` (plan 005): where this folder's plans are saved; relative to it. */
  plansDir?: string;
  model?: string;
  help: boolean;
  version: boolean;
  /** Look in the launch folder for plans and planning sessions (v1.3 item 1). --no-scan turns it off. */
  scan: boolean;
  /** Let the agent read the project for rounds and the plan (plan 002). --no-code turns it off. */
  code: boolean;
  /** Quit once nobody has used the app for a while (plan 004: started in the background by `plan start`). */
  exitWhenIdle: boolean;
  /** Rounds of questions before Confirm (#32). Every agent gets the same; absent means DEFAULT_MAX_ROUNDS. */
  maxRounds: number;
}

export class UsageError extends Error {}

export const MAX_ROUNDS_ERROR = "--max-rounds needs a whole number of 1 or more, like --max-rounds 2.";

export function parseArgs(argv: string[]): CliArgs {
  const out: CliArgs = { open: true, help: false, version: false, scan: true, code: true, exitWhenIdle: false, maxRounds: DEFAULT_MAX_ROUNDS };
  let maxRoundsSet = false;
  for (let i = 0; i < argv.length; i++) {
    const raw = argv[i];
    if (raw === "mcp" && i === 0) {
      out.command = "mcp";
      continue;
    }
    const [flag, inline] = raw.startsWith("--") && raw.includes("=") ? [raw.slice(0, raw.indexOf("=")), raw.slice(raw.indexOf("=") + 1)] : [raw, undefined];
    const value = () => {
      const v = inline ?? argv[++i];
      if (v === undefined || (inline === undefined && v.startsWith("--"))) throw new UsageError(`${flag} needs a value`);
      return v;
    };
    switch (flag) {
      case "--port": {
        const n = Number(value());
        if (!Number.isInteger(n) || n < 1 || n > 65535) throw new UsageError("--port must be a number between 1 and 65535");
        out.port = n;
        break;
      }
      case "--provider": {
        const v = value();
        if (!PROVIDER_IDS.includes(v as ProviderId)) throw new UsageError(`Unknown provider "${v}". Use one of: ${PROVIDER_IDS.join(", ")}`);
        out.provider = v as ProviderId;
        break;
      }
      case "--max-rounds": {
        // Digits only: "2.0", "1e1", " 3" and "0x2" are refused, not read as numbers.
        const v = inline ?? argv[++i];
        if (v === undefined || !/^[0-9]+$/.test(v) || !(Number(v) >= 1) || !Number.isSafeInteger(Number(v))) throw new UsageError(MAX_ROUNDS_ERROR);
        out.maxRounds = Number(v);
        maxRoundsSet = true;
        break;
      }
      case "--no-open":
        out.open = false;
        break;
      case "--no-scan":
        out.scan = false;
        break;
      case "--no-code":
        out.code = false;
        break;
      case "--exit-when-idle":
        out.exitWhenIdle = true;
        break;
      case "--data-dir":
        out.dataDir = value();
        break;
      case "--plans-dir":
        out.plansDir = value();
        break;
      case "--model":
        out.model = value();
        break;
      case "-h":
      case "--help":
        out.help = true;
        break;
      case "-v":
      case "--version":
        out.version = true;
        break;
      default:
        throw new UsageError(`Unknown option "${raw}"`);
    }
  }
  if (out.command === "mcp" && (maxRoundsSet || out.port !== undefined || out.provider || out.model || !out.open || !out.code || out.exitWhenIdle || out.plansDir !== undefined)) throw new UsageError("mcp only takes --data-dir and --no-scan");
  return out;
}

export const HELP = `Usage: grillado [options]
       grillado mcp [--data-dir <path>] [--no-scan]

Turn a raw idea into a plan, one round of questions at a time, on the coding agent you already use.

Options:
  --port <n>          Port to listen on (default 4747; if busy, the next free one).
                      With --port, a busy port is an error.
  --provider <id>     claude | codex | grok | pi (skips the picker)
  --model <id>        Pass a model id through to the agent CLI
  --max-rounds <n>    Question rounds before the plan is written (default 2)
  --no-open           Don't open the browser; just print the URL
  --no-scan           Don't look in this folder for plans and planning sessions from your
                      coding agent (also GRILLADO_NO_SCAN=1). Nothing is imported unless you click.
  --no-code           Don't let the agent read this project's files (also GRILLADO_NO_CODE=1)
  --plans-dir <path>  Where this folder's plans are saved (default docs/plans; relative paths
                      are inside the folder). Home can switch projects and change it too.
  --exit-when-idle    Quit after 30 minutes with no browser open and nothing running
  --data-dir <path>   Session data (default ~/.grillado, or $GRILLADO_HOME)
  -v, --version       Print the version
  -h, --help          Show this help

Commands:
  plan                Plan from your coding agent's shell: start, wait, get, list, comment
                      (grillado plan --help).
  build               Build a plan step by step from your coding agent's shell: next, start, done,
                      ask, wait, withdraw (grillado build --help).
  skills              Instructions for coding agents that match this version
                      (grillado skills get plan).
  mcp                 Run an MCP server over stdio for your coding agent: list and read plans
                      and their decisions, start a plan, comment on one. Same data as the web app.

For coding agents:
  Run \`grillado skills get plan\` before planning with Grillado. Install the skill once with
  \`npx skills add victor-teles/grillado\` so your agent finds Grillado on its own.

Security:
  The server listens on 127.0.0.1 only, checks Host/Origin, and requires the per-run token in
  the printed URL. Grillado runs no shell commands for your agent: it starts your agent CLI with
  a fixed argv. Inside a git repository, Claude Code and Grok may read the project while they
  ask questions and write the plan, with read-only file tools only: no edits, no shell, no web,
  no MCP tools, and environment files and keys denied. Everything else (and Codex and pi always)
  runs in an empty temp folder with tools off, or Codex's read-only sandbox. --no-code turns
  reading off. Your prompts go
  only to the provider your CLI is set up for.
  Send to issues is the only time Grillado talks to a service itself: Linear over HTTPS, or GitHub
  through your own gh. It creates or changes issues only when you click the confirm button, and
  only in the destination it names. A Linear key stays in secrets.json (0600) in the data dir.
`;
