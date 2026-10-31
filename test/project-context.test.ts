import { afterEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { captureProjectContext } from "../src/cli/project-context.ts";
import { Store } from "../src/cli/store.ts";
import { createSession } from "../src/core/session.ts";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function fixture() {
  const root = mkdtempSync(path.join(os.tmpdir(), "grillado-context-"));
  roots.push(root);
  const project = path.join(root, "project");
  const dataDir = path.join(root, "data");
  mkdirSync(project);
  mkdirSync(dataDir);
  return { root, project, dataDir };
}

function write(root: string, relative: string, text: string) {
  const file = path.join(root, relative);
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, text);
}

test("captures sparse plans only from the root and known plan folders", async () => {
  const { root, project, dataDir } = fixture();
  write(project, "PLAN.md", "One line is still a plan.");
  write(project, "docs/plans/billing.md", "Billing notes");
  write(project, "plans/search.md", "Search notes");
  write(project, ".cursor/plans/mobile.plan.md", "Mobile notes");
  write(project, ".claude/plans/api.md", "API notes");
  write(project, "docs/prd/accounts.md", "Account notes");
  write(project, "docs/plans/grillado-plan-old.md", "Earlier Grillado export");
  write(project, "notes.md", "not a plan");
  write(project, "src/PLAN.md", "not in an allowed location");
  write(root, "home/.codex/sessions/PLAN.md", "home transcript");

  const context = await captureProjectContext({ cwd: project, dataDir, home: path.join(root, "home") });
  expect(context?.sources.map((source) => source.path)).toEqual([
    "PLAN.md",
    "docs/plans/billing.md",
    "docs/plans/grillado-plan-old.md",
    "plans/search.md",
    ".cursor/plans/mobile.plan.md",
    ".claude/plans/api.md",
    "docs/prd/accounts.md",
  ]);
  expect(context?.sources.map((source) => source.text)).not.toContain("home transcript");
  expect(context?.truncated).toBe(false);
});

test("rejects symlinked files and symlinked ancestor directories", async () => {
  const { root, project, dataDir } = fixture();
  const outside = path.join(root, "outside");
  write(outside, "secret.md", "outside secret");
  mkdirSync(path.join(project, "docs"), { recursive: true });
  symlinkSync(outside, path.join(project, "docs", "plans"));
  symlinkSync(path.join(outside, "secret.md"), path.join(project, "PLAN.md"));
  write(project, "plans/safe.md", "safe plan");

  const context = await captureProjectContext({ cwd: project, dataDir });
  expect(context?.sources).toEqual([{ path: "plans/safe.md", text: "safe plan", truncated: false }]);
  expect(JSON.stringify(context)).not.toContain("outside secret");
});

test("rechecks guarded roots after project resolution", async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "grillado-context-home-"));
  roots.push(root);
  const home = path.join(root, "home");
  const nested = path.join(home, "project");
  const dataDir = path.join(root, "data");
  mkdirSync(nested, { recursive: true });
  mkdirSync(dataDir);
  execFileSync("git", ["init", "-q", home]);
  write(home, "PLAN.md", "home-root plan");

  expect(await captureProjectContext({ cwd: nested, dataDir, home })).toBeUndefined();
});

test("does not enter dependency, build, or Grillado data directories inside plan folders", async () => {
  const { project } = fixture();
  const dataDir = path.join(project, "docs", "plans", "custom-session-data");
  write(project, "docs/plans/safe.md", "safe plan");
  write(project, "docs/plans/node_modules/pkg/PLAN.md", "dependency plan");
  write(project, "docs/plans/dist/PLAN.md", "build plan");
  write(dataDir, "sessions/PLAN.md", "session data plan");

  const context = await captureProjectContext({ cwd: project, dataDir });
  expect(context?.sources).toEqual([{ path: "docs/plans/safe.md", text: "safe plan", truncated: false }]);
  expect(JSON.stringify(context)).not.toMatch(/dependency plan|build plan|session data plan/);
});

test("enforces per-source, total-text, and source-count limits deterministically", async () => {
  const { project, dataDir } = fixture();
  write(project, "PLAN.md", "r".repeat(7_000));
  for (let i = 1; i <= 10; i++) write(project, `docs/plans/${String(i).padStart(2, "0")}.md`, String(i).repeat(4_000));

  const context = await captureProjectContext({ cwd: project, dataDir });
  expect(context?.sources.map((source) => source.path)).toEqual(["PLAN.md", "docs/plans/01.md", "docs/plans/02.md", "docs/plans/03.md", "docs/plans/04.md"]);
  expect(context?.sources[0]).toMatchObject({ truncated: true });
  expect(context?.sources[0].text).toHaveLength(6_000);
  expect(context?.sources.reduce((sum, source) => sum + source.text.length, 0)).toBe(20_000);
  expect(context?.truncated).toBe(true);

  const countFixture = fixture();
  for (let i = 1; i <= 10; i++) write(countFixture.project, `plans/${String(i).padStart(2, "0")}.md`, `plan ${i}`);
  const countContext = await captureProjectContext({ cwd: countFixture.project, dataDir: countFixture.dataDir });
  expect(countContext?.sources.map((source) => source.path)).toEqual([
    "plans/01.md",
    "plans/02.md",
    "plans/03.md",
    "plans/04.md",
    "plans/05.md",
    "plans/06.md",
    "plans/07.md",
    "plans/08.md",
  ]);
  expect(countContext?.truncated).toBe(true);
});

test("returns no snapshot when empty or disabled, and persisted snapshots do not change on reload", async () => {
  const { project, dataDir } = fixture();
  expect(await captureProjectContext({ cwd: project, dataDir })).toBeUndefined();
  write(project, "PLAN.md", "first version");
  expect(await captureProjectContext({ cwd: project, dataDir, off: true })).toBeUndefined();

  const projectContext = await captureProjectContext({ cwd: project, dataDir });
  const store = new Store(dataDir);
  const session = createSession({ idea: "x", provider: "claude", projectContext });
  store.create(session, project);
  write(project, "PLAN.md", "second version");
  expect(store.load(session.id)?.projectContext).toEqual(projectContext);
});

test("counts unrelated root entries toward the traversal limit", async () => {
  const { project, dataDir } = fixture();
  for (let i = 0; i < 256; i++) write(project, `unrelated-${i}.txt`, "irrelevant");
  write(project, "docs/plans/later.md", "Beyond the entry budget");
  expect(await captureProjectContext({ cwd: project, dataDir })).toBeUndefined();
});

test("reports truncation when the entry budget prevents scanning later plan folders", async () => {
  const { project, dataDir } = fixture();
  write(project, "PLAN.md", "Root plan");
  for (let i = 0; i < 254; i++) write(project, `docs/plans/unrelated-${i}.txt`, "irrelevant");
  write(project, "docs/plans/first.md", "First folder plan");
  write(project, "plans/later.md", "Later folder plan");
  const context = await captureProjectContext({ cwd: project, dataDir });
  expect(context?.sources[0].path).toBe("PLAN.md");
  expect(context?.sources.some((source) => source.path === "plans/later.md")).toBe(false);
  expect(context?.truncated).toBe(true);
});

