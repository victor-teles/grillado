import { constants, type Dirent } from "node:fs";
import { lstat, open, opendir, realpath } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { ProjectContext, ProjectContextSource } from "../core/project-context.ts";
import { isPlanCandidate } from "../core/found/extract.ts";
import { isUnder, resolveProject, skipReason } from "./found.ts";

const MAX_SOURCES = 8;
const MAX_CHARS_PER_SOURCE = 6_000;
const MAX_TOTAL_CHARS = 20_000;
const MAX_ENTRIES = 256;
const MAX_DEPTH = 4;
const MAX_READ_BYTES = MAX_CHARS_PER_SOURCE * 4 + 4;

const PLAN_DIRS = ["docs/plans", "plans", ".cursor/plans", ".claude/plans", "docs/prd"];
const EXCLUDED_DIRS = new Set(["node_modules", "vendor", "dist", "build", "out", "coverage", "target", ".next", ".turbo", ".git"]);

export interface ProjectContextInput {
  cwd: string;
  dataDir: string;
  home?: string;
  off?: boolean;
}

interface Candidate {
  absolute: string;
  relative: string;
  priority: number;
}

interface CollectionBudget {
  entries: number;
  truncated: boolean;
}

const byPath = (a: Candidate, b: Candidate) => a.priority - b.priority || (a.relative < b.relative ? -1 : a.relative > b.relative ? 1 : 0);

async function directoryEntries(directory: string, budget: CollectionBudget): Promise<Dirent[]> {
  const entries: Dirent[] = [];
  try {
    const dir = await opendir(directory, { bufferSize: 1 });
    try {
      while (budget.entries < MAX_ENTRIES) {
        const entry = await dir.read();
        if (!entry) break;
        budget.entries++;
        entries.push(entry);
      }
      if (budget.entries >= MAX_ENTRIES) budget.truncated = true;
    } finally {
      await dir.close();
    }
  } catch {
    return entries;
  }
  return entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
}

async function safeDirectory(root: string, relative: string): Promise<string | null> {
  let current = root;
  for (const part of relative.split("/")) {
    current = path.join(current, part);
    try {
      const info = await lstat(current);
      if (info.isSymbolicLink() || !info.isDirectory()) return null;
    } catch {
      return null;
    }
  }
  return current;
}

async function collectDirectory(root: string, relative: string, priority: number, dataDir: string, budget: CollectionBudget): Promise<Candidate[]> {
  const base = await safeDirectory(root, relative);
  if (!base || isUnder(dataDir, base)) return [];
  const candidates: Candidate[] = [];

  const visit = async (directory: string, depth: number): Promise<void> => {
    const entries = await directoryEntries(directory, budget);
    for (const entry of entries) {
      if (entry.isSymbolicLink()) continue;
      const absolute = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        if (EXCLUDED_DIRS.has(entry.name) || isUnder(dataDir, absolute)) continue;
        if (depth < MAX_DEPTH) await visit(absolute, depth + 1);
        else budget.truncated = true;
        continue;
      }
      if (!entry.isFile()) continue;
      const rel = path.relative(root, absolute).split(path.sep).join("/");
      if (isPlanCandidate(rel)) candidates.push({ absolute, relative: rel, priority });
    }
  };

  await visit(base, 0);
  return candidates;
}

async function rootCandidates(root: string, budget: CollectionBudget): Promise<Candidate[]> {
  const entries = await directoryEntries(root, budget);
  const candidates: Candidate[] = [];
  for (const entry of entries) {
    if (!entry.isFile() || entry.isSymbolicLink() || !isPlanCandidate(entry.name)) continue;
    candidates.push({ absolute: path.join(root, entry.name), relative: entry.name, priority: 0 });
  }
  return candidates;
}

async function readCandidate(root: string, dataDir: string, candidate: Candidate, remaining: number): Promise<ProjectContextSource | null> {
  try {
    const before = await lstat(candidate.absolute);
    if (!before.isFile() || before.isSymbolicLink()) return null;
    const canonical = await realpath(candidate.absolute);
    if (!isUnder(root, canonical) || isUnder(dataDir, canonical)) return null;

    const file = await open(candidate.absolute, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    try {
      const opened = await file.stat();
      if (!opened.isFile() || opened.dev !== before.dev || opened.ino !== before.ino) return null;
      const buffer = Buffer.allocUnsafe(MAX_READ_BYTES);
      const { bytesRead } = await file.read(buffer, 0, buffer.length, 0);
      const full = buffer.subarray(0, bytesRead).toString("utf8");
      if (!full.trim()) return null;
      const limit = Math.min(MAX_CHARS_PER_SOURCE, remaining);
      const text = full.slice(0, limit);
      const truncated = opened.size > bytesRead || full.length > limit;
      return { path: candidate.relative, text, truncated };
    } finally {
      await file.close();
    }
  } catch {
    return null;
  }
}

/** Capture a deterministic, bounded snapshot of project-local plan files. */
export async function captureProjectContext(input: ProjectContextInput): Promise<ProjectContext | undefined> {
  const home = input.home ?? os.homedir();
  if (skipReason(input.cwd, { home, dataDir: input.dataDir, off: input.off })) return undefined;

  let root: string;
  try {
    root = (await resolveProject(input.cwd)).root;
  } catch {
    return undefined;
  }
  if (skipReason(root, { home, dataDir: input.dataDir, off: input.off })) return undefined;

  const budget = { entries: 0, truncated: false };
  const candidates = await rootCandidates(root, budget);
  for (let i = 0; i < PLAN_DIRS.length && budget.entries < MAX_ENTRIES; i++) {
    candidates.push(...(await collectDirectory(root, PLAN_DIRS[i], i + 1, input.dataDir, budget)));
  }
  candidates.sort(byPath);

  const sources: ProjectContextSource[] = [];
  let total = 0;
  for (const candidate of candidates) {
    if (sources.length >= MAX_SOURCES || total >= MAX_TOTAL_CHARS) {
      budget.truncated = true;
      break;
    }
    const source = await readCandidate(root, input.dataDir, candidate, MAX_TOTAL_CHARS - total);
    if (!source) continue;
    sources.push(source);
    total += source.text.length;
    if (source.truncated) budget.truncated = true;
  }

  if (!sources.length) return undefined;
  return { capturedAt: new Date().toISOString(), sources, truncated: budget.truncated };
}
