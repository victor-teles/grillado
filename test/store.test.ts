import { afterEach, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { Store } from "../src/cli/store.ts";
import { createSession } from "../src/core/session.ts";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function fixture() {
  const root = mkdtempSync(path.join(os.tmpdir(), "grillado-store-"));
  roots.push(root);
  return { root, store: new Store(path.join(root, "data")), session: createSession({ idea: "A plan", provider: "claude" }) };
}

test("project Markdown survives reloads, external edits and rewrites; backups stay in session data", () => {
  const { root, store, session } = fixture();
  const project = path.join(root, "project");
  store.create(session, project);
  const file = path.join(project, "docs", "plans", `grillado-plan-${session.id}.md`);
  expect(existsSync(file)).toBe(false);
  expect(store.writePlan(session.id, "# First\n")).toBe(file);

  const reopened = new Store(store.dir);
  expect(reopened.planPath(session.id)).toBe(file);
  writeFileSync(file, "# Edited externally\n");
  expect(reopened.readPlan(session.id)).toBe("# Edited externally\n");
  const backup = reopened.keepEditedPlan(session.id)!;
  expect(path.dirname(backup)).toBe(store.sessionDir(session.id));
  expect(readFileSync(backup, "utf8")).toBe("# Edited externally\n");
  expect(reopened.writePlan(session.id, "# Rewritten\n")).toBe(file);
  expect(readFileSync(file, "utf8")).toBe("# Rewritten\n");
  expect(path.dirname(reopened.writeConflict(session.id, "# Conflict\n"))).toBe(store.sessionDir(session.id));
  expect(existsSync(path.join(store.sessionDir(session.id), "plan.md"))).toBe(false);
});

test("legacy sessions keep their data-dir Markdown even when they have an imported project", () => {
  const { root, store, session } = fixture();
  session.project = path.join(root, "imported-project");
  store.create(session);
  const file = path.join(store.sessionDir(session.id), "plan.md");
  expect(store.writePlan(session.id, "# Existing plan\n")).toBe(file);
  const reopened = new Store(store.dir);
  expect(reopened.readPlan(session.id)).toBe("# Existing plan\n");
  expect(reopened.writePlan(session.id, "# Updated\n")).toBe(file);
  expect(existsSync(session.project)).toBe(false);
});
