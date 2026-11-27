// `grillado skills` (plan 004): instructions for coding agents that always match this version.
// The skills ship with the CLI (dist/skill-data/<name>/SKILL.md); an agent's skill stub points here.
import { existsSync, readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { UsageError } from "./args.ts";

export interface Skill {
  name: string;
  description: string;
  body: string;
}

/** dist/skill-data next to the built CLI, else the repository's skill-data (running from source). */
export function skillsDir(env: NodeJS.ProcessEnv = process.env, here = path.dirname(fileURLToPath(import.meta.url))): string {
  if (env.GRILLADO_SKILLS_DIR) return env.GRILLADO_SKILLS_DIR;
  for (const dir of [path.join(here, "skill-data"), path.resolve(here, "..", "..", "skill-data")]) if (existsSync(dir)) return dir;
  return path.join(here, "skill-data");
}

/** Front matter `name` and `description`, and the text after it. */
export function parseSkill(text: string, fallbackName: string): Skill {
  const m = /^---\n([\s\S]*?)\n---\n?([\s\S]*)$/.exec(text.replace(/\r\n/g, "\n"));
  const meta: Record<string, string> = {};
  for (const line of (m?.[1] ?? "").split("\n")) {
    const kv = /^([\w-]+):\s*(.*)$/.exec(line);
    if (kv) meta[kv[1]] = kv[2].trim().replace(/^"(.*)"$/, "$1");
  }
  return { name: meta.name || fallbackName, description: meta.description ?? "", body: (m?.[2] ?? text).trim() };
}

export function loadSkills(dir = skillsDir()): Skill[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { withFileTypes: true })
    .filter((d) => d.isDirectory() && existsSync(path.join(dir, d.name, "SKILL.md")))
    .map((d) => parseSkill(readFileSync(path.join(dir, d.name, "SKILL.md"), "utf8"), d.name))
    .sort((a, b) => a.name.localeCompare(b.name));
}

export const SKILLS_HELP = `Usage: grillado skills [list] [--json]
       grillado skills get <name> [name...] [--json]

Instructions for coding agents, matching this version of Grillado. Start with: grillado skills get plan
`;

/** Runs `grillado skills …`; returns the exit code. Output goes through `out` (stdout) only. */
export function runSkills(argv: string[], version: string, out: (s: string) => void, dir = skillsDir()): number {
  const json = argv.includes("--json");
  const args = argv.filter((a) => a !== "--json");
  if (args.includes("-h") || args.includes("--help")) {
    out(SKILLS_HELP);
    return 0;
  }
  const bad = args.find((a) => a.startsWith("-"));
  if (bad) throw new UsageError(`Unknown option "${bad}" for skills.\n\n${SKILLS_HELP}`);
  const [sub = "list", ...names] = args;
  const skills = loadSkills(dir);
  if (sub === "list") {
    if (names.length) throw new UsageError(`skills list takes no names.\n\n${SKILLS_HELP}`);
    if (json) out(`${JSON.stringify({ version, skills: skills.map(({ name, description }) => ({ name, description })) }, null, 2)}\n`);
    else {
      const w = Math.max(0, ...skills.map((s) => s.name.length));
      out(skills.map((s) => `${s.name.padEnd(w)}  ${s.description.split(/(?<=\.)\s/)[0]}`).join("\n") + "\n");
    }
    return 0;
  }
  if (sub !== "get") throw new UsageError(`Unknown skills command "${sub}".\n\n${SKILLS_HELP}`);
  if (!names.length) throw new UsageError(`Name a skill: ${skills.map((s) => s.name).join(", ")}.`);
  const picked = names.map((n) => skills.find((s) => s.name === n) ?? n);
  const missing = picked.filter((p): p is string => typeof p === "string");
  if (missing.length) throw new UsageError(`No skill named ${missing.map((m) => `"${m}"`).join(", ")}. Skills: ${skills.map((s) => s.name).join(", ")}.`);
  const found = picked as Skill[];
  if (json) out(`${JSON.stringify({ version, skills: found }, null, 2)}\n`);
  else out(`grillado ${version}\n\n${found.map((s) => s.body).join("\n\n---\n\n")}\n`);
  return 0;
}
