// Grok's per-run timeout (real CLI 1.0.70 rounds took 115–220 s, past the old 180 s default) and
// the copy for long runs: the waiting note and the "running slow" timeout card.
import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { GrilladoServer } from "../src/cli/server.ts";
import { Store } from "../src/cli/store.ts";
import { SPECS, createAdapters } from "../src/core/providers/adapters.ts";
import { DEFAULT_TIMEOUT_MS } from "../src/core/providers/base.ts";
import type { ProviderAdapter, ProviderId } from "../src/core/providers/types.ts";
import { COPY, fmt } from "../web/src/app/copy.ts";
import { fakeBinDir, fakeEnv } from "./helpers.ts";

const servers: GrilladoServer[] = [];
afterEach(async () => {
  while (servers.length) await servers.pop()!.close();
});

function webDir() {
  const dir = mkdtempSync(path.join(os.tmpdir(), "grillado-web-"));
  writeFileSync(path.join(dir, "index.html"), "<!doctype html><title>Grillado</title>");
  mkdirSync(path.join(dir, "assets"));
  return dir;
}

/** The real adapters, with every run's timeout recorded. */
function spied(adapters: ProviderAdapter[], seen: [string, number][]): ProviderAdapter[] {
  return adapters.map((a) => ({ ...a, run: (req, signal) => (seen.push([a.id, req.timeoutMs]), a.run(req, signal)) }));
}

async function serve(id: ProviderId, env: NodeJS.ProcessEnv, timeoutMs?: number) {
  const seen: [string, number][] = [];
  const store = new Store(mkdtempSync(path.join(os.tmpdir(), "grillado-home-")));
  const server = new GrilladoServer({ adapters: spied(createAdapters({ env }), seen), store, webDir: webDir(), port: 0, strictPort: true, ...(timeoutMs ? { timeoutMs } : {}) });
  servers.push(server);
  await server.detect();
  await server.listen();
  const h = { "x-grillado-token": server.token, "content-type": "application/json" };
  const call = (method: string, p: string, body?: unknown) =>
    new Promise<any>((resolve, reject) => {
      const req = http.request({ host: "127.0.0.1", port: server.port, method, path: p, headers: h }, (res) => {
        let b = "";
        res.on("data", (d) => (b += d));
        res.on("end", () => resolve(JSON.parse(b)));
      });
      req.on("error", reject);
      req.end(body === undefined ? undefined : JSON.stringify(body));
    });
  const created = await call("POST", "/api/sessions", { idea: "A shared pantry list" });
  expect(created.provider).toBe(id);
  const until = async (ok: (s: any) => boolean, ms = 10_000) => {
    const end = Date.now() + ms;
    for (;;) {
      const s = await call("GET", `/api/sessions/${created.id}`);
      if (ok(s)) return s;
      if (Date.now() > end) throw new Error("timed out");
      await new Promise((r) => setTimeout(r, 50));
    }
  };
  const retry = () => call("POST", `/api/sessions/${created.id}/retry`, {});
  return { seen, until, retry };
}

describe("per-provider default timeout", () => {
  test("Grok waits 600 s per run; Claude Code, Codex and pi keep 180 s", () => {
    expect(DEFAULT_TIMEOUT_MS).toBe(180_000);
    const byId = Object.fromEntries(createAdapters({ env: fakeEnv(fakeBinDir()) }).map((a) => [a.id, a.defaultTimeoutMs]));
    expect(byId).toEqual({ claude: 180_000, codex: 180_000, grok: 600_000, pi: 180_000 });
    expect(SPECS.grok.defaultTimeoutMs).toBe(600_000);
    for (const id of ["claude", "codex", "pi"] as const) expect(SPECS[id].defaultTimeoutMs).toBeUndefined();
  });

  test("a Grok round runs with 600 s, a Claude Code round with 180 s", async () => {
    const g = await serve("grok", fakeEnv(fakeBinDir(["grok"])));
    await g.until((s) => !s.busy && s.status === "answering");
    expect(g.seen).toEqual([["grok", 600_000]]);
    const c = await serve("claude", fakeEnv(fakeBinDir(["claude"])));
    await c.until((s) => !s.busy && s.status === "answering");
    expect(c.seen).toEqual([["claude", 180_000]]);
  });

  test("GRILLADO_TIMEOUT_MS (the server's timeoutMs) still overrides Grok's default", async () => {
    const g = await serve("grok", fakeEnv(fakeBinDir(["grok"])), 45_000);
    await g.until((s) => !s.busy && s.status === "answering");
    expect(g.seen).toEqual([["grok", 45_000]]);
  });
});

describe("a run past the timeout reads as slow, not failed", () => {
  test("a fake Grok that sleeps past a short override ends in a timeout, and Retry gets a round", async () => {
    const ctl = path.join(mkdtempSync(path.join(os.tmpdir(), "grillado-ctl-")), "ctl.json");
    writeFileSync(ctl, JSON.stringify({ FAKE_DELAY_MS: "3000" }));
    const g = await serve("grok", fakeEnv(fakeBinDir(["grok"]), { FAKE_CTL: ctl }), 400);
    const s = await g.until((v) => !v.busy && !!v.error);
    expect(s.error.code).toBe("timeout");
    expect(s.error.message).toContain("Grok took longer than");
    expect(s.rounds).toHaveLength(0);
    writeFileSync(ctl, "{}");
    await g.retry();
    const after = await g.until((v) => !v.busy && v.status === "answering");
    expect(after.error).toBeFalsy();
    expect(after.rounds).toHaveLength(1);
  });

  test("the timeout card and the waiting note", () => {
    expect(fmt(COPY.timeoutTitle, { agent: "Grok" })).toBe("Grok is running slow");
    expect(COPY.timeoutBody).toBe("It hasn't answered yet, so Grillado stopped waiting. Your answers are saved.");
    expect(`${COPY.timeoutTitle} ${COPY.timeoutBody}`).not.toMatch(/didn.t come through|fail|error/i);
    expect(COPY.roundWaitNote).toBe("Rounds can take a few minutes.");
  });
});
