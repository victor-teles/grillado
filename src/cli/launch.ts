// The command an editor runs to start `grillado mcp` (v1.2 item 1, handoff §2a). The web app's
// "Use in your editor" popover shows it verbatim: run through npx or a global install it is
// `npx -y grillado mcp`; from a local checkout or build, `node /abs/path/dist/cli.js mcp`.
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

const quote = (a: string) => (/^[\w@%+=:,./-]+$/.test(a) ? a : `'${a.replace(/'/g, `'\\''`)}'`);

export function mcpLaunch(cliFile: string, dataDir: string, home = os.homedir()): McpLaunch {
  let file = path.resolve(cliFile);
  try {
    file = realpathSync(file);
  } catch {}
  // npx runs the package from its cache (…/_npx/<hash>/node_modules/grillado/…); a global
  // install lives in …/lib/node_modules/grillado/….
  const installed = file.split(path.sep).join("/").includes("/node_modules/grillado/");
  const [command, args] = installed ? ["npx", ["-y", "grillado", "mcp"]] : ["node", [file, "mcp"]];
  const dir = path.resolve(dataDir);
  return {
    command,
    args,
    ...(dir === path.join(home, ".grillado") ? {} : { env: { GRILLADO_HOME: dir } }),
    line: [command, ...args].map(quote).join(" "),
  };
}
