// The command an editor runs to start `grillado mcp` (v1.2 item 1, handoff §2a and DECISIONS #109).
// The web app's "Use in your editor" popover shows it verbatim: run through npx or a global install
// it is `npx -y grillado mcp`; from a local checkout or build, `/abs/path/to/node /abs/path/dist/cli.js mcp`.
// The absolute Node path keeps working when an editor launched from the macOS Dock doesn't have an
// nvm-installed `node` on its PATH.
import { realpathSync } from "node:fs";
import os from "node:os";
import path from "node:path";

export interface McpLaunch {
  command: string;
  args: string[];
  /** Only when the data dir isn't the default ~/.grillado. */
  env?: { GRILLADO_HOME: string };
  /** command and args as one shell line. */
  line: string;
}

/** POSIX shell quoting for one word, as used in `line`. */
export const shellQuote = (a: string) => (/^[\w@%+=:,./-]+$/.test(a) ? a : `'${a.replace(/'/g, `'\\''`)}'`);

/** How this build of Grillado is run: npx (cache or a global install) or node with the checkout's cli.js. */
function runner(cliFile: string, node: string): [string, string[]] {
  let file = path.resolve(cliFile);
  try {
    file = realpathSync(file);
  } catch {}
  // npx runs the package from its cache (…/_npx/<hash>/node_modules/grillado/…); a global
  // install lives in …/lib/node_modules/grillado/….
  const installed = file.split(path.sep).join("/").includes("/node_modules/grillado/");
  return installed ? ["npx", ["-y", "grillado"]] : [node, [file]];
}

const custom = (dataDir: string, home: string) => {
  const dir = path.resolve(dataDir);
  return dir === path.join(home, ".grillado") ? null : dir;
};

export function mcpLaunch(cliFile: string, dataDir: string, home = os.homedir(), node = process.execPath): McpLaunch {
  const [command, base] = runner(cliFile, node);
  const args = [...base, "mcp"];
  const dir = custom(dataDir, home);
  return { command, args, ...(dir ? { env: { GRILLADO_HOME: dir } } : {}), line: [command, ...args].map(shellQuote).join(" ") };
}

/** The shell line that starts the web app with the same build and data dir (start_plan's app-closed hint). */
export function appLine(cliFile: string, dataDir: string, home = os.homedir(), node = process.execPath): string {
  const [command, args] = runner(cliFile, node);
  const dir = custom(dataDir, home);
  return [command, ...(command === "npx" ? ["grillado"] : args), ...(dir ? ["--data-dir", dir] : [])].map(shellQuote).join(" ");
}
