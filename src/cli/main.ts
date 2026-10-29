import path from "node:path";
import { fileURLToPath } from "node:url";
import { createAdapters } from "../core/providers/adapters.ts";
import { HELP, UsageError, parseArgs } from "./args.ts";
import { appLine, mcpLaunch } from "./launch.ts";
import { runMcp } from "./mcp.ts";
import { canOpenBrowser, openBrowser } from "./open.ts";
import { FoundService } from "./found.ts";
import { GrilladoServer } from "./server.ts";
import { Store, defaultDataDir } from "./store.ts";

declare const __GRILLADO_VERSION__: string;
const VERSION = typeof __GRILLADO_VERSION__ === "string" ? __GRILLADO_VERSION__ : "0.0.0-dev";

const tty = process.stdout.isTTY && !process.env.NO_COLOR;
const c = (code: number, s: string) => (tty ? `\x1b[${code}m${s}\x1b[0m` : s);
const bold = (s: string) => c(1, s);
const dim = (s: string) => c(2, s);
const green = (s: string) => c(32, s);
const orange = (s: string) => c(33, s);

export async function main(argv = process.argv.slice(2)): Promise<void> {
  const major = Number(process.versions.node.split(".")[0]);
  if (major < 22) {
    console.error(`grillado: needs Node.js 22 or newer (you have ${process.versions.node}).`);
    process.exit(1);
  }
  let args: ReturnType<typeof parseArgs>;
  try {
    args = parseArgs(argv);
  } catch (err) {
    if (err instanceof UsageError) {
      console.error(`grillado: ${err.message}\n\n${HELP}`);
      process.exit(2);
    }
    throw err;
  }
  if (args.help) return void process.stdout.write(HELP);
  if (args.version) return void console.log(VERSION);
  // stdout is the MCP protocol from here on: nothing else may write to it.
  if (args.command === "mcp") {
    const store = new Store(args.dataDir ?? defaultDataDir());
    return runMcp(store, VERSION, appLine(fileURLToPath(import.meta.url), store.dir));
  }

  const here = path.dirname(fileURLToPath(import.meta.url));
  const webDir = process.env.GRILLADO_WEB_DIR || path.join(here, "web");
  const store = new Store(args.dataDir ?? defaultDataDir());
  const server = new GrilladoServer({
    adapters: createAdapters(),
    store,
    webDir,
    port: args.port ?? 4747,
    strictPort: args.port !== undefined,
    provider: args.provider,
    model: args.model,
    maxRounds: args.maxRounds,
    log: (line) => process.stdout.write(`  ${line}\n`),
    timeoutMs: process.env.GRILLADO_TIMEOUT_MS ? Number(process.env.GRILLADO_TIMEOUT_MS) : undefined,
    onQuit: () => void shutdown("quit"),
    mcpLaunch: mcpLaunch(fileURLToPath(import.meta.url), store.dir),
    launchDir: process.cwd(),
    // Tests point Linear at a local fake; only a loopback URL is taken, so the key can't be sent anywhere else.
    issues: /^http:\/\/127\.0\.0\.1:\d+\/[\w/-]*$/.test(process.env.GRILLADO_LINEAR_URL ?? "") ? { linear: { url: process.env.GRILLADO_LINEAR_URL } } : undefined,
    found: new FoundService({ store, cwd: process.cwd(), off: !args.scan || process.env.GRILLADO_NO_SCAN === "1" }),
  });

  process.stdout.write(`${orange("●")} ${bold("Grillado")} ${dim(VERSION)}  ${dim("warming up…")}\n`);
  const providers = await server.detect();
  const line = providers
    .map((p) => {
      const d = p.detection;
      if (d.status === "ready") return green(`✓ ${p.displayName} ${d.version}`);
      if (d.status === "missing") return dim(`– ${p.displayName} not found`);
      return orange(`! ${p.displayName} not working`);
    })
    .join("  ");
  process.stdout.write(`  ${line}\n`);
  for (const p of providers) {
    if (p.detection.status === "broken" || p.detection.status === "outdated") process.stdout.write(dim(`    ${p.displayName}: ${p.detection.reason}\n`));
  }

  if (args.provider) {
    const p = providers.find((x) => x.id === args.provider);
    if (!p || p.detection.status !== "ready") {
      const why = !p || p.detection.status === "missing" ? "is not installed or not on PATH" : `is not working (${"reason" in p.detection ? p.detection.reason : ""})`;
      console.error(`grillado: --provider ${args.provider}: ${p?.displayName ?? args.provider} ${why}.`);
      process.exit(2);
    }
  }

  try {
    await server.listen();
  } catch (err: any) {
    console.error(`grillado: ${err?.message ?? err}`);
    process.exit(1);
  }
  process.stdout.write(`  ${bold(server.url)}\n`);
  process.stdout.write(dim(`  Server listening on 127.0.0.1:${server.port}. Press Ctrl+C to stop.\n`));
  if (args.open && canOpenBrowser()) openBrowser(server.url);
  // After the URL is out: the scan never delays the first paint (budget 1.5 s, results over SSE).
  setImmediate(() => void server.scanProject());

  let stopping = false;
  async function shutdown(reason: string) {
    if (stopping) return;
    stopping = true;
    const force = setTimeout(() => process.exit(0), 2500);
    force.unref();
    try {
      await server.close();
    } finally {
      process.stdout.write(dim(`\n  Grillado stopped (${reason}). Your sessions are saved in ${store.dir}\n`));
      process.exit(0);
    }
  }
  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
