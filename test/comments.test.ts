// v1.1 item 3: comments on the plan, the agent's reply, and "Apply feedback" as suggestions that
// only reach plan.md once accepted (Phase 2 §3–4, DECISIONS #13–16).
import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { GrilladoServer } from "../src/cli/server.ts";
import { Store } from "../src/cli/store.ts";
import { addComment, addSuggestions, checkEdits, fenceRanges, locate, normalizeEdit, plainQuote, review, sectionAt, undoReview } from "../src/core/comments.ts";
import { buildCommentPrompt, replyToComment, suggestEdits } from "../src/core/engine.ts";
import { createAdapters } from "../src/core/providers/adapters.ts";
import type { ProviderAdapter, RunRequest } from "../src/core/providers/types.ts";
import { createSession } from "../src/core/session.ts";
import { fakeBinDir, fakeEnv } from "./helpers.ts";

const PLAN = `# Recipe app

## Problem
Families lose recipes in group chats [R1:scope].

## Implementation decisions
- Yes, one core flow [R1:scope]
- Web first [R1:platform]

\`\`\`decision
id: R1·1
key: scope
question: One core flow?
answer: Yes, one core flow
by: you
at: 2026-10-22T21:14-03:00
\`\`\`
`;

function plated() {
  const s = createSession({ idea: "Recipe app", provider: "claude" });
  s.status = "plated";
  s.plan = { title: "Recipe app", markdown: PLAN, path: "", openDecisions: [], createdAt: new Date().toISOString() };
  return s;
}

describe("anchors", () => {
  test("locate picks the occurrence nearest the hint, and skips fences when asked", () => {
    const md = "a cat\n\n```\ncat\n```\n\nb cat";
    expect(locate(md, "cat", 0)).toBe(2);
    expect(locate(md, "cat", md.length)).toBe(md.length - 3);
    expect(locate(md, "cat", 11, true)).toBe(2);
    expect(locate(md, "dog", 0)).toBe(-1);
    expect(fenceRanges(md)).toEqual([[7, 18]]);
  });

  test("a comment needs text in the plan and a body", () => {
    const s = plated();
    expect(() => addComment(s, { quote: "not there", at: 0, text: "hi" })).toThrow("isn't in the plan");
    expect(() => addComment(s, { quote: "Families", at: 0, text: "  " })).toThrow("Write a comment");
    expect(() => addComment(s, { quote: "a\n\nb", at: 0, text: "x" })).toThrow("one passage");
    const t = addComment(s, { quote: "lose recipes", at: 999, text: "Which chats?" });
    expect(t.at).toBe(PLAN.indexOf("lose recipes"));
    expect(t.messages).toMatchObject([{ by: "you", text: "Which chats?" }]);
    expect(sectionAt(PLAN, t.at)).toBe("Problem");
    expect(plainQuote("**Web** first [R1:platform]")).toBe("Web first");
  });
});

describe("suggestions", () => {
  test("edits must be exact, inline, outside fences and not overlap", () => {
    expect(checkEdits(PLAN, [{ before: "Web first", after: "Web and iOS" }])).toBeNull();
    expect(checkEdits(PLAN, [{ before: "- Web first", after: "- Web and iOS" }])).toBeNull();
    expect(normalizeEdit({ before: "- Web first", after: "- Web and iOS" })).toEqual({ before: "Web first", after: "Web and iOS" });
    expect(checkEdits(PLAN, [])).toContain("at least one");
    expect(checkEdits(PLAN, [{ before: "Nope", after: "x" }])).toContain("copied exactly");
    expect(checkEdits(PLAN, [{ before: "Web first", after: "Web first" }])).toContain("must change");
    expect(checkEdits(PLAN, [{ before: "Web first", after: "a\nb" }])).toContain("line breaks");
    expect(checkEdits(PLAN, [{ before: "question: One core flow?", after: "x" }])).toContain("outside code and decision blocks");
    expect(checkEdits(PLAN, [{ before: "lose recipes", after: "x" }, { before: "recipes in", after: "y" }])).toContain("overlap");
  });

  test("plan.md text changes only on accept; reject and undo restore the review", () => {
    const s = plated();
    const t = addComment(s, { quote: "lose recipes", at: 0, text: "Say where" });
    const [a, b] = addSuggestions(s, t.id, [{ before: "lose recipes", after: "lose recipes they cooked" }, { before: "Web first", after: "Web and iOS" }], t.at);
    expect(s.plan!.markdown).toBe(PLAN);

    expect(review(s, "accept", [a.id])).toEqual({ done: 1, stale: 0 });
    expect(s.plan!.markdown).toContain("lose recipes they cooked in group chats");
    expect(s.suggestions!.map((x) => x.id)).toEqual([b.id]);
    expect(undoReview(s)).toBe(true);
    expect(s.plan!.markdown).toBe(PLAN);
    expect(s.suggestions!.map((x) => x.id).sort()).toEqual([a.id, b.id].sort());

    review(s, "reject", [b.id]);
    expect(s.plan!.markdown).toBe(PLAN);
    undoReview(s);
    expect(s.suggestions).toHaveLength(2);

    review(s, "accept", [a.id, b.id]);
    expect(s.plan!.markdown).toContain("Web and iOS [R1:platform]");
    expect(s.plan!.markdown).toContain("they cooked");
    expect(s.suggestions).toEqual([]);
    expect(() => review(s, "accept", [a.id])).toThrow("already reviewed");
  });

  test("an edit whose text changed under it is dropped, not forced in", () => {
    const s = plated();
    const t = addComment(s, { quote: "Web first", at: 0, text: "iOS too" });
    const [x] = addSuggestions(s, t.id, [{ before: "Web first", after: "Web and iOS" }], t.at);
    s.plan!.markdown = PLAN.replace("Web first", "Web only");
    expect(review(s, "accept", [x.id])).toEqual({ done: 0, stale: 1 });
    expect(s.plan!.markdown).toBe(PLAN.replace("Web first", "Web only"));
  });
});

describe("agent calls go through the adapter", () => {
  const stub = (outputs: unknown[]): ProviderAdapter & { calls: RunRequest[] } => {
    const calls: RunRequest[] = [];
    return {
      id: "claude",
      label: "Claude",
      calls,
      detect: async () => ({ id: "claude", label: "Claude", found: true, version: "1", authed: true }) as any,
      run: async function* (req: RunRequest) {
        calls.push(req);
        yield { type: "result", raw: outputs.shift() } as any;
      },
    } as any;
  };

  test("the reply is retried once when it leaks a banned term the user didn't type", async () => {
    const s = plated();
    const t = addComment(s, { quote: "lose recipes", at: 0, text: "Which chats?" });
    const a = stub([{ type: "reply", text: "Per the grilling method." }, { type: "reply", text: "WhatsApp groups, mostly." }]);
    const r = await replyToComment(s, t, a, {} as any);
    expect(r).toMatchObject({ ok: true, value: { text: "WhatsApp groups, mostly." } });
    expect(a.calls.map((c) => c.kind)).toEqual(["comment", "comment"]);
    expect(a.calls[0].userPrompt).toContain("<state>");
    expect(buildCommentPrompt(s, t, "reply")).toContain('"section":"Problem"');
  });

  test("words the user typed in the thread are theirs", async () => {
    const s = plated();
    const t = addComment(s, { quote: "lose recipes", at: 0, text: "What about grilling recipes?" });
    const r = await replyToComment(s, t, stub([{ type: "reply", text: "Grilling recipes fit the same flow." }]), {} as any);
    expect(r.ok).toBe(true);
  });

  test("edits that don't match the plan are retried, then rejected", async () => {
    const s = plated();
    const t = addComment(s, { quote: "Web first", at: 0, text: "iOS too" });
    const bad = { type: "edits", summary: "x", edits: [{ before: "not in the plan", after: "y" }] };
    const r = await suggestEdits(s, t, stub([bad, { type: "edits", summary: "iOS", edits: [{ before: "Web first", after: "Web and iOS" }] }]), {} as any);
    expect(r).toMatchObject({ ok: true, value: { edits: [{ before: "Web first" }] } });
    const r2 = await suggestEdits(s, t, stub([bad, bad]), {} as any);
    expect(r2.ok).toBe(false);
  });
});

describe("routes", () => {
  const servers: GrilladoServer[] = [];
  afterEach(async () => {
    while (servers.length) await servers.pop()!.close();
  });

  async function serve(env = fakeEnv(fakeBinDir(["claude"]))) {
    const store = new Store(mkdtempSync(path.join(os.tmpdir(), "grillado-home-")));
    const s = plated();
    s.plan!.path = store.writePlan(s.id, PLAN);
    store.save(s);
    const web = mkdtempSync(path.join(os.tmpdir(), "grillado-web-"));
    writeFileSync(path.join(web, "index.html"), "<!doctype html>");
    mkdirSync(path.join(web, "assets"));
    const server = new GrilladoServer({ adapters: createAdapters({ env }), store, webDir: web, port: 0, strictPort: true });
    servers.push(server);
    await server.detect();
    await server.listen();
    const call = (method: string, p: string, body?: unknown) =>
      new Promise<{ status: number; json: any }>((resolve, reject) => {
        const req = http.request(
          { host: "127.0.0.1", port: server.port, method, path: `/api/sessions/${s.id}${p}`, headers: { "x-grillado-token": server.token, "content-type": "application/json" } },
          (res) => {
            let data = "";
            res.on("data", (d) => (data += d));
            res.on("end", () => resolve({ status: res.statusCode!, json: JSON.parse(data) }));
          },
        );
        req.on("error", reject);
        req.end(body === undefined ? undefined : JSON.stringify(body));
      });
    const settle = async (id: string) => {
      for (let i = 0; i < 200; i++) {
        const v = (await call("GET", "")).json;
        const t = v.comments.find((c: any) => c.id === id);
        if (t.run?.state !== "running") return v;
        await new Promise((r) => setTimeout(r, 40));
      }
      throw new Error("run never finished");
    };
    return { call, settle, file: s.plan!.path, store, id: s.id };
  }

  test("comment → automatic reply → apply → accept one, reject one, undo → plan.md", async () => {
    const { call, settle, file } = await serve();
    const c = await call("POST", "/comments", { quote: "lose recipes in group chats", at: 30, text: "Say who shares them" });
    expect(c.status).toBe(200);
    const tid = c.json.comments[0].id;
    expect(c.json.comments[0].run).toMatchObject({ kind: "reply", state: "running" });
    let v = await settle(tid);
    expect(v.comments[0].messages.map((m: any) => m.by)).toEqual(["you", "agent"]);
    expect(v.comments[0].messages[1].text).toContain("Problem");

    await call("POST", `/comments/${tid}/apply`);
    v = await settle(tid);
    expect(v.comments[0].run).toMatchObject({ kind: "apply", state: "done", edits: 2 });
    expect(v.suggestions).toHaveLength(2);
    expect(readFileSync(file, "utf8")).toBe(PLAN);
    expect(v.plan.markdown).toBe(PLAN);

    const [first, second] = v.suggestions;
    v = (await call("POST", "/suggestions", { op: "accept", ids: [first.id] })).json;
    expect(readFileSync(file, "utf8")).toContain("group chats, shared by everyone at home");
    v = (await call("POST", "/suggestions", { op: "reject", ids: [second.id] })).json;
    expect(v.suggestions).toEqual([]);
    expect(readFileSync(file, "utf8")).not.toContain("shipped first");
    v = (await call("POST", "/suggestions", { op: "undo" })).json;
    expect(v.suggestions).toHaveLength(1);
    v = (await call("POST", "/suggestions", { op: "accept", ids: [second.id] })).json;
    expect(readFileSync(file, "utf8")).toContain("Yes, one core flow, shipped first [R1:scope]");
    expect(readFileSync(file, "utf8")).toContain("answer: Yes, one core flow\n");

    v = (await call("POST", `/comments/${tid}/resolve`, { resolved: true })).json;
    expect(v.comments[0].resolved).toBe(true);
    expect((await call("POST", "/comments/nope/reply", { text: "x" })).status).toBe(400);
  });

  test("a reply that leaks is retried; the agent's words never reach the browser", async () => {
    const { call, settle } = await serve(fakeEnv(fakeBinDir(["claude"]), { FAKE_COMMENT: "leak-once" }));
    const tid = (await call("POST", "/comments", { quote: "Web first", at: 0, text: "Why web?" })).json.comments[0].id;
    const v = await settle(tid);
    expect(JSON.stringify(v).toLowerCase()).not.toContain("grilling");
    expect(v.comments[0].messages).toHaveLength(2);
  });

  test("the plan can't be saved while the agent is applying feedback", async () => {
    const { call, settle } = await serve(fakeEnv(fakeBinDir(["claude"]), { FAKE_DELAY_MS: "600" }));
    const tid = (await call("POST", "/comments", { quote: "Web first", at: 0, text: "iOS too" })).json.comments[0].id;
    await settle(tid);
    const a = await call("POST", `/comments/${tid}/apply`);
    expect(a.json.applying).toBe(true);
    expect((await call("POST", "/plan", { markdown: PLAN + "x" })).status).toBe(409);
    expect((await call("POST", `/comments/${tid}/apply`)).status).toBe(400);
    await call("POST", `/comments/${tid}/stop`);
    const v = await settle(tid);
    expect(v.comments[0].run).toMatchObject({ state: "error", message: "Stopped. Nothing changed in the plan." });
    expect(v.suggestions ?? []).toEqual([]);
  });
});
