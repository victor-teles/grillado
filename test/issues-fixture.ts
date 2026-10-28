// "Send to issues" (v1.3 item 2) test helpers: a plated plan with stories, a fake `gh` and a mock Linear.
import { chmodSync, existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import type { Store } from "../src/cli/store.ts";
import { type Session, createSession } from "../src/core/session.ts";
import { NODE } from "./helpers.ts";

export const FAKE_GH = path.join(import.meta.dir, "fixtures", "fake-gh.mjs");

export const STORY_MD = [
  "# Recipe box",
  "",
  "## Problem",
  "",
  "Recipes are scattered across notes and screenshots [R1:storage].",
  "",
  "## Solution",
  "",
  "One app that keeps them on the device.",
  "",
  "```decision",
  "storage: SQLite",
  "```",
  "",
  "## User stories",
  "",
  "- As a cook, I add a recipe from a photo [R1:storage].",
  "- As a cook, I find a recipe by ingredient.",
  "- As a cook, I see my recipes on a second phone [R2:sync].",
  "",
  "## Out of scope",
  "",
  "- Meal plans.",
  "",
].join("\n");

/** A real ```decision block (the fixture's own `storage: SQLite` block doesn't parse, so the session stands in). */
export const block = (id: string, key: string, question: string, answer: string, note?: string) =>
  ["```decision", `id: ${id}`, `key: ${key}`, `question: ${question}`, `answer: ${answer}`, ...(note ? [`note: ${note}`] : []), "by: you", "kept_suggestion: false", "```"].join("\n");

/** STORY_MD with decision blocks at the end of its Solution, as a written plan has them. */
export const withBlocks = (md: string, ...blocks: string[]) => md.replace("\n## User stories", `\n${blocks.join("\n\n")}\n\n## User stories`);

export function storySession(store: Store, md = STORY_MD): Session {
  const s = createSession({ idea: "A recipe box app", provider: "claude" });
  s.status = "plated";
  s.decisions = {
    storage: { key: "storage", round: 1, title: "Where do recipes live?", answer: "SQLite on the device", kind: "option", accepted_recommendation: true, dependsOn: [] },
    sync: { key: "sync", round: 2, title: "Sync between devices?", answer: "Not in v1", kind: "other", accepted_recommendation: false, dependsOn: ["storage"] },
  };
  const file = store.writePlan(s.id, md);
  s.plan = { title: "Recipe box", markdown: md, path: file, openDecisions: [], createdAt: s.createdAt };
  store.create(s);
  return s;
}

/** A fake `gh` on its own: { bin, dir, env, calls(), state() }. Nothing on PATH, nothing real. */
export function fakeGh(env: Record<string, string> = {}) {
  const dir = mkdtempSync(path.join(os.tmpdir(), "grillado-fakegh-"));
  const bin = path.join(dir, "gh");
  writeFileSync(bin, `#!/bin/sh\nexec "${NODE}" "${FAKE_GH}" "$@"\n`);
  chmodSync(bin, 0o755);
  const fullEnv = { PATH: "/usr/bin:/bin", HOME: dir, FAKE_GH_DIR: dir, ...env };
  return {
    bin,
    dir,
    env: fullEnv,
    set(extra: Record<string, string | undefined>) {
      for (const [k, v] of Object.entries(extra)) {
        if (v === undefined) delete (fullEnv as any)[k];
        else (fullEnv as any)[k] = v;
      }
    },
    calls(): { args: string[]; body?: string; env?: Record<string, string> }[] {
      const f = path.join(dir, "argv.jsonl");
      return existsSync(f) ? readFileSync(f, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l)) : [];
    },
    state(): { issues: { id: number; number: number; title: string; body: string; labels: string[]; parent: number | null; deleted?: boolean }[]; labels: { name: string }[] } {
      const f = path.join(dir, "state.json");
      return existsSync(f) ? JSON.parse(readFileSync(f, "utf8")) : { issues: [], labels: [] };
    },
    edit(fn: (st: any) => void) {
      const f = path.join(dir, "state.json");
      const st = JSON.parse(readFileSync(f, "utf8"));
      fn(st);
      writeFileSync(f, JSON.stringify(st));
    },
  };
}

/** Is this argv a write (anything that changes GitHub)? */
export const isWrite = (args: string[]) =>
  (args[0] === "issue" && ["create", "edit", "close", "delete"].includes(args[1])) || (args[0] === "label" && args[1] === "create") || (args[0] === "api" && args.includes("-X") && args[args.indexOf("-X") + 1] !== "GET");

export interface LinearMock {
  url: string;
  requests: { auth: string | undefined; query: string; variables: any }[];
  issues: any[];
  /** Answer the next n requests with a rate limit. */
  rateLimit(n: number): void;
  close(): Promise<void>;
}

/** A mock Linear GraphQL API on 127.0.0.1, accepting the key "lin_api_good". */
export async function linearMock(): Promise<LinearMock> {
  const requests: LinearMock["requests"] = [];
  const issues: any[] = [];
  let limited = 0;
  let n = 0;
  const view = (x: any) => ({ id: x.id, identifier: x.identifier, number: x.number, url: x.url, title: x.title, description: x.description, archivedAt: null, trashed: x.trashed ?? false });
  const server = http.createServer((req, res) => {
    let raw = "";
    req.on("data", (d) => (raw += d));
    req.on("end", () => {
      const { query, variables } = JSON.parse(raw || "{}");
      requests.push({ auth: req.headers.authorization, query, variables });
      const send = (status: number, body: unknown, headers: Record<string, string> = {}) => {
        res.writeHead(status, { "content-type": "application/json", ...headers });
        res.end(JSON.stringify(body));
      };
      if (limited > 0) {
        limited--;
        return send(400, { errors: [{ message: "Rate limit exceeded", extensions: { code: "RATELIMITED" } }] }, { "retry-after": "0" });
      }
      if (req.headers.authorization !== "lin_api_good") return send(400, { errors: [{ message: "Authentication required, not authenticated", extensions: { code: "AUTHENTICATION_ERROR" } }] });
      if (/viewer/.test(query)) return send(200, { data: { viewer: { id: "u1", name: "Victor" } } });
      if (/teams\(/.test(query)) return send(200, { data: { teams: { nodes: [{ id: "team-1", name: "Core", key: "COR" }] } } });
      if (/projects\(/.test(query)) return send(200, { data: { team: { projects: { nodes: [{ id: "proj-1", name: "Grillado" }] } } } });
      if (/labels\(/.test(query)) return send(200, { data: { team: { labels: { nodes: [{ id: "label-1", name: "feature", color: "#fff" }] } } } });
      if (/issueCreate/.test(query)) {
        const i = variables.input;
        n++;
        const x = { id: `iss-${n}`, identifier: `COR-${n}`, number: n, url: `https://linear.app/acme/issue/COR-${n}`, title: i.title, description: i.description, parentId: i.parentId ?? null, labelIds: i.labelIds ?? [], projectId: i.projectId ?? null, teamId: i.teamId };
        issues.push(x);
        return send(200, { data: { issueCreate: { success: true, issue: view(x) } } });
      }
      if (/issueUpdate/.test(query)) {
        const x = issues.find((i) => i.id === variables.id);
        if (!x) return send(200, { errors: [{ message: "Entity not found: Issue" }] });
        if (variables.input.title !== undefined) x.title = variables.input.title;
        if (variables.input.description !== undefined) x.description = variables.input.description;
        if (variables.input.parentId !== undefined) x.parentId = variables.input.parentId;
        return send(200, { data: { issueUpdate: { success: true, issue: view(x) } } });
      }
      if (/issues\(/.test(query)) return send(200, { data: { issues: { nodes: issues.filter((x) => x.teamId === variables.team && String(x.description).includes(variables.m)).map(view) } } });
      if (/issue\(id/.test(query)) {
        const x = issues.find((i) => i.id === variables.id);
        return x ? send(200, { data: { issue: view(x) } }) : send(200, { errors: [{ message: "Entity not found: Issue" }], data: null });
      }
      send(400, { errors: [{ message: `mock: unsupported ${query}` }] });
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  const port = (server.address() as any).port;
  return {
    url: `http://127.0.0.1:${port}/graphql`,
    requests,
    issues,
    rateLimit: (k) => (limited = k),
    close: () => new Promise((r) => server.close(() => r())),
  };
}
