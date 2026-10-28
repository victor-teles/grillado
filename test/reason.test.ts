// The usage-limit wording fix: one mapping from a failure code to the words people see, used by every
// feature that shows why the agent failed. Each feature runs against the fake CLI, once hitting its
// usage limit (429) and once with the CLI gone (not_found), and the test reads back what it shows.
import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { GrilladoServer } from "../src/cli/server.ts";
import { Store } from "../src/cli/store.ts";
import { copyText, type Entry, liveMessage, meta } from "../src/core/activity.ts";
import { createSession } from "../src/core/session.ts";
import { createAdapters } from "../src/core/providers/adapters.ts";
import { failureCode, reasonText } from "../src/core/reason.ts";
import { fakeBinDir, fakeEnv } from "./helpers.ts";

const A = "Claude Code";
const WORDS = { rate_limit: `${A} hit its usage limit`, not_found: `${A} isn’t installed` } as const;
type Code = keyof typeof WORDS;
const fill = (t: string) => t.replaceAll("{agent}", A);

describe("the one mapping (core/reason.ts)", () => {
  test("every classify.ts code has its own words; nothing says “couldn’t finish this” but unknown", () => {
    expect(reasonText("rate_limit", A)).toBe(WORDS.rate_limit);
    expect(reasonText("not_found", A)).toBe(WORDS.not_found);
    expect(reasonText("auth", A)).toBe(`${A} isn’t signed in`);
    expect(reasonText("timeout", A)).toBe(`${A} is running slow`);
    expect(reasonText("malformed", A)).toBe(`${A}’s reply didn’t come through`);
    expect(reasonText("unknown", A)).toBe(`${A} couldn’t finish this`);
    expect(reasonText(undefined, A)).toBe(`${A} couldn’t finish this`);
    expect(reasonText("something new", A)).toBe(`${A} couldn’t finish this`);
  });
  test("entries logged with the older short words read the same", () => {
    expect([failureCode("rate"), failureCode("missing"), failureCode(null)]).toEqual(["rate_limit", "not_found", "unknown"]);
    expect(reasonText("rate", A)).toBe(WORDS.rate_limit);
    expect(reasonText("missing", A)).toBe(WORDS.not_found);
  });
});

const PLAN = `# Recipe app

## Problem
Families lose recipes in group chats.

## Platform
- Web first
- Phones later
`;

describe("each feature shows the words for usage-limit and not-found failures", () => {
  const servers: GrilladoServer[] = [];
  afterEach(async () => {
    while (servers.length) await servers.pop()!.close();
  });

  /** A plated plan on a fake Claude Code; `fail(code)` makes its next runs fail that way. */
  async function serve() {
    const store = new Store(mkdtempSync(path.join(os.tmpdir(), "grillado-home-")));
    const s = createSession({ idea: "Recipe app", provider: "claude" });
    s.status = "plated";
    s.plan = { title: "Recipe app", markdown: PLAN, path: "", openDecisions: [], createdAt: new Date().toISOString() };
    s.plan.path = store.writePlan(s.id, PLAN);
    s.decisions.share = { key: "share", round: 1, title: "Share with family?", answer: "Yes, one shared list", kind: "option", accepted_recommendation: true, dependsOn: [] } as (typeof s.decisions)[string];
    store.save(s);
    const web = mkdtempSync(path.join(os.tmpdir(), "grillado-web-"));
    writeFileSync(path.join(web, "index.html"), "<!doctype html>");
    mkdirSync(path.join(web, "assets"));
    const bin = fakeBinDir(["claude"]);
    const ctl = path.join(mkdtempSync(path.join(os.tmpdir(), "grillado-ctl-")), "ctl.json");
    writeFileSync(ctl, "{}");
    const server = new GrilladoServer({ adapters: createAdapters({ env: fakeEnv(bin, { FAKE_CTL: ctl }) }), store, webDir: web, port: 0, strictPort: true });
    servers.push(server);
    await server.detect();
    await server.listen();
    const call = (method: string, p: string, body?: unknown) =>
      new Promise<{ status: number; json: any }>((resolve, reject) => {
        const req = http.request(
          { host: "127.0.0.1", port: server.port, method, path: p.startsWith("/api") ? p : `/api/sessions/${s.id}${p}`, headers: { "x-grillado-token": server.token, "content-type": "application/json" } },
          (res) => {
            let data = "";
            res.on("data", (d) => (data += d));
            res.on("end", () => resolve({ status: res.statusCode!, json: JSON.parse(data) }));
          },
        );
        req.on("error", reject);
        req.end(body === undefined ? undefined : JSON.stringify(body));
      });
    const until = async <T>(p: string, ok: (v: any) => T | undefined): Promise<T> => {
      for (let i = 0; i < 400; i++) {
        const got = ok((await call("GET", p)).json);
        if (got !== undefined && got !== false) return got;
        await new Promise((r) => setTimeout(r, 30));
      }
      throw new Error(`never settled: ${p}`);
    };
    // 429 from the CLI → rate_limit; the CLI deleted after detection → not_found.
    const fail = (code: Code) => (code === "rate_limit" ? writeFileSync(ctl, JSON.stringify({ FAKE_MODE: "rate" })) : rmSync(path.join(bin, "claude")));
    return { call, until, fail, ctl, id: s.id };
  }

  /** What Activity shows for the failed run: its meta line, its failed step, the copied log and the live message. */
  function expectActivity(entries: Entry[], kind: string, words: string) {
    const e = entries.find((x) => x.type === "run" && x.kind === kind && x.status === "failed");
    expect(e).toBeTruthy();
    expect(meta(e!, { agent: A })).toContain(`${words} · nothing was changed`);
    expect(e!.steps.filter((x) => x.state === "failed").map((x) => fill(x.label)).join("\n")).toContain(words);
    expect(copyText(e!, { agent: A })).toContain(`Result: failed — ${words}. Nothing was changed.`);
    expect(liveMessage(e!, A)).toContain(`${words}.`);
    expect(JSON.stringify(e).replaceAll("{agent}", A)).not.toContain("couldn’t finish this");
  }

  test("a Retry after a failure starts its own turn: the waiting timer counts from the Retry (review-pr22 r3 #2)", async () => {
    const { call, until, fail, ctl } = await serve();
    fail("rate_limit");
    const id = (await call("POST", "/api/sessions", { idea: "A tiny app" })).json.id;
    const failed = await until(`/api/sessions/${id}`, (x) => !x.busy && x.error && x);
    expect(failed.runAt).toBeUndefined(); // only while a turn runs
    await new Promise((r) => setTimeout(r, 60));
    writeFileSync(ctl, JSON.stringify({ FAKE_DELAY_MS: "400" }));
    const before = Date.now();
    const r = (await call("POST", `/api/sessions/${id}/retry`)).json;
    expect(r.busy).toBe(true);
    expect(Date.parse(r.runAt)).toBeGreaterThanOrEqual(before - 5);
    expect(Date.parse(r.runAt)).toBeGreaterThan(Date.parse(failed.createdAt) + 50);
    const done = await until(`/api/sessions/${id}`, (x) => !x.busy && x);
    expect(done.runAt).toBeUndefined();
  });

  for (const code of ["rate_limit", "not_found"] as const) {
    const words = WORDS[code];

    test(`${code}: a question round (the banner card and Activity)`, async () => {
      const { call, until, fail } = await serve();
      fail(code);
      const id = (await call("POST", "/api/sessions", { idea: "A tiny app" })).json.id;
      const v = await until(`/api/sessions/${id}`, (x) => !x.busy && x.error && x.activity?.entries?.some((e: Entry) => e.status === "failed") && x);
      expect(failureCode(v.error.code)).toBe(code); // the card ProblemBanner picks
      expectActivity(v.activity.entries, "round", words);
    });

    test(`${code}: a comment reply and Apply (Activity)`, async () => {
      const { call, until, fail } = await serve();
      const t1 = (await call("POST", "/comments", { quote: "Web first", at: 0, text: "Why web?" })).json.comments[0].id;
      await until("", (x) => x.comments.find((t: any) => t.id === t1)?.run?.state === "done");
      fail(code);
      await call("POST", `/comments/${t1}/apply`);
      let v = await until("", (x) => x.comments.find((t: any) => t.id === t1)?.run?.state === "error" && x);
      expectActivity(v.activity.entries, "apply", words);
      await call("POST", "/comments", { quote: "Phones later", at: 0, text: "Which phones?" });
      v = await until("", (x) => x.comments.find((t: any) => t.id !== t1)?.run?.state === "error" && x);
      expectActivity(v.activity.entries, "reply", words);
    });

    test(`${code}: Add diagrams (the failure bar and Activity)`, async () => {
      const { call, until, fail } = await serve();
      fail(code);
      await call("POST", "/diagrams", { sections: ["Platform"], kinds: ["flowchart"] });
      const v = await until("", (x) => x.diagramRun?.state === "error" && !x.drawing && x);
      expect(v.diagramRun.code).toBe(code);
      // AddDiagrams' bar and its live region say reasonText(run.code).
      expect(reasonText(v.diagramRun.code, A)).toBe(words);
      expectActivity(v.activity.entries, "diagrams", words);
    });

    test(`${code}: Add to plan (Activity)`, async () => {
      const { call, until, fail } = await serve();
      fail(code);
      const r = await call("POST", "/addplan", { key: "share" });
      expect(r.status).toBe(200);
      const v = await until("", (x) => x.addPlanRun && x.addPlanRun.state !== "running" && x.activity?.entries?.some((e: Entry) => e.kind === "addplan" && e.status === "failed") && x);
      expectActivity(v.activity.entries, "addplan", words);
    });
  }
});
