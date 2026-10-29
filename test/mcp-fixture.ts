// A plated session and a draft one, written straight to a temp data dir (no agent runs).
import { mkdtempSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { Store } from "../src/cli/store.ts";
import { type Session, createSession } from "../src/core/session.ts";

export const PLAN_MD = "# Recipe box\n\n## Storage\n\nRecipes live in SQLite on the device.\n\n## Sync\n\nNo sync in v1.\n\n## Open decisions\n\n- export\n";

export function tempStore() {
  return new Store(mkdtempSync(path.join(os.tmpdir(), "grillado-mcp-")));
}

export function platedSession(store: Store, idea = "A recipe box app"): Session {
  const s = createSession({ idea, provider: "claude" });
  s.status = "plated";
  s.decisions = {
    storage: { key: "storage", round: 1, title: "Where do recipes live?", answer: "SQLite on the device", kind: "option", accepted_recommendation: true, dependsOn: [] },
    sync: { key: "sync", round: 2, title: "Sync between devices?", answer: "Not in v1", kind: "other", accepted_recommendation: false, dependsOn: ["storage"] },
  };
  const file = store.writePlan(s.id, PLAN_MD);
  s.plan = { title: "Recipe box", markdown: PLAN_MD, path: file, openDecisions: ["export"], createdAt: s.createdAt };
  store.create(s);
  return s;
}

export function draftSession(store: Store, idea = "A habit tracker"): Session {
  const s = createSession({ idea, provider: "claude" });
  s.status = "answering";
  s.decisions = { platform: { key: "platform", round: 1, title: "Which platform?", answer: "iOS first", kind: "option", accepted_recommendation: true, dependsOn: [] } };
  s.updatedAt = new Date(Date.now() + 1000).toISOString();
  store.create(s);
  return s;
}
