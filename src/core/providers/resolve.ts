import { readFileSync, statSync } from "node:fs";
import path from "node:path";

export interface ResolveEnv {
  PATH?: string;
  PATHEXT?: string;
  platform?: NodeJS.Platform;
}

/** `which`-style lookup. Honors PATHEXT on Windows. Returns the absolute path or null. */
export function which(bin: string, env: ResolveEnv = {}): string | null {
  const platform = env.platform ?? process.platform;
  const pathVar = env.PATH ?? process.env.PATH ?? process.env.Path ?? "";
  const sep = platform === "win32" ? ";" : ":";
  const exts =
    platform === "win32"
      ? (env.PATHEXT ?? process.env.PATHEXT ?? ".COM;.EXE;.BAT;.CMD").split(";").filter(Boolean)
      : [""];
  for (const dir of pathVar.split(sep)) {
    if (!dir) continue;
    for (const ext of exts) {
      for (const candidate of new Set([path.join(dir, bin + ext), path.join(dir, bin + ext.toLowerCase())])) {
        try {
          const st = statSync(candidate);
          if (!st.isFile()) continue;
          if (platform !== "win32" && (st.mode & 0o111) === 0) continue;
          return candidate;
        } catch {
          // not here
        }
      }
    }
  }
  return null;
}

export interface SpawnTarget {
  command: string;
  prefixArgs: string[];
}

/**
 * Node refuses to spawn .cmd/.bat files without a shell, and a shell would reintroduce quoting
 * problems for JSON arguments. npm's Windows shims are tiny wrappers around `node <script>.js`,
 * so we read the shim and run the script with our own Node instead (shell: false, argv intact).
 */
export function spawnTarget(resolved: string, platform: NodeJS.Platform = process.platform): SpawnTarget {
  if (platform !== "win32" || !/\.(cmd|bat)$/i.test(resolved)) return { command: resolved, prefixArgs: [] };
  const script = scriptFromCmdShim(resolved);
  if (script) return { command: process.execPath, prefixArgs: [script] };
  return { command: resolved, prefixArgs: [] };
}

export function scriptFromCmdShim(shimPath: string): string | null {
  let text: string;
  try {
    text = readFileSync(shimPath, "utf8");
  } catch {
    return null;
  }
  const m = text.match(/"%(?:~)?dp0%\\?([^"]+?\.(?:c|m)?js)"/i);
  if (!m) return null;
  return path.win32.join(path.win32.dirname(shimPath), m[1].replace(/\//g, "\\"));
}
