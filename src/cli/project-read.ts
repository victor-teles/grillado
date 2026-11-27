// Read access to the project (plan 002), the disk and git side: may this session's agent read its
// project, from which folder, and is a path it named a real file under that folder.
import { existsSync, realpathSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { type PathCheck, relativePath } from "../core/project-read.ts";
import { isUnder, resolveProject, skipReason } from "./found.ts";

/** Why a project can't be read: shown on Home, and used to leave the chip out. */
export type NoReadReason = "no-project" | "not-git" | "home" | "root" | "data-dir" | "off";

export type ReadPlace = { ok: true; root: string; name: string } | { ok: false; reason: NoReadReason; name?: string };

/**
 * Whether a project folder can be read at all, whoever's agent runs: inside a git repository, not
 * the home folder, a filesystem root or the data dir, and not turned off with --no-code.
 */
export async function readPlace(folder: string | undefined, o: { dataDir: string; home?: string; noCode?: boolean }): Promise<ReadPlace> {
  if (!folder) return { ok: false, reason: "no-project" };
  const home = o.home ?? os.homedir();
  const skip = skipReason(folder, { home, dataDir: o.dataDir });
  if (skip) return { ok: false, reason: skip };
  const project = await resolveProject(folder);
  if (!project.git) return { ok: false, reason: "not-git", name: project.name };
  // A repository whose top level is home (dotfiles) or holds the data dir is still too wide.
  const top = skipReason(project.root, { home, dataDir: o.dataDir });
  if (top) return { ok: false, reason: top, name: project.name };
  if (o.noCode) return { ok: false, reason: "off", name: project.name };
  return { ok: true, root: project.root, name: project.name };
}

/**
 * The check every path the agent names goes through before Grillado keeps it: relative to `root`
 * (an absolute path inside it is made relative), no `..`, not sensitive, it exists, and after
 * following symlinks it is still inside `root`.
 */
export function pathCheck(root: string): PathCheck {
  const real = realOr(root);
  const posixRoot = real.split(path.sep).join("/");
  return (raw) => {
    const rel = relativePath(raw, posixRoot) ?? relativePath(raw, root.split(path.sep).join("/"));
    if (!rel) return null;
    const abs = path.join(real, ...rel.split("/"));
    if (!existsSync(abs)) return null;
    return isUnder(real, realOr(abs)) ? rel : null;
  };
}

function realOr(p: string) {
  try {
    return realpathSync(p);
  } catch {
    return path.resolve(p);
  }
}
