import { PROVIDER_IDS, type ProviderId } from "../core/providers/types.ts";

export interface CliArgs {
  port?: number;
  provider?: ProviderId;
  open: boolean;
  dataDir?: string;
  model?: string;
  help: boolean;
  version: boolean;
}

export class UsageError extends Error {}

export function parseArgs(argv: string[]): CliArgs {
  const out: CliArgs = { open: true, help: false, version: false };
  for (let i = 0; i < argv.length; i++) {
    const raw = argv[i];
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
      case "--no-open":
        out.open = false;
        break;
      case "--data-dir":
        out.dataDir = value();
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
  return out;
}

export const HELP = `Usage: grillado [options]

Turn a raw idea into a plan, one round of questions at a time, on the coding agent you already use.

Options:
  --port <n>          Port to listen on (default 4747; if busy, the next free one).
                      With --port, a busy port is an error.
  --provider <id>     claude | codex | grok | pi (skips the picker)
  --model <id>        Pass a model id through to the agent CLI
  --no-open           Don't open the browser; just print the URL
  --data-dir <path>   Where sessions and plans live (default ~/.grillado, or $GRILLADO_HOME)
  -v, --version       Print the version
  -h, --help          Show this help

Security:
  The server listens on 127.0.0.1 only, checks Host/Origin, and requires the per-run token in
  the printed URL. Grillado runs no tools or shell commands itself: it starts your agent CLI with
  a fixed argv in an empty temp folder, with tools off (Claude, Grok, pi) or a read-only sandbox
  (Codex). Your prompts go only to the provider your CLI is set up for.
`;
