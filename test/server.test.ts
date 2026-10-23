import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import http from "node:http";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { createAdapters } from "../src/core/providers/adapters.ts";
import { GrilladoServer, assertLoopback } from "../src/cli/server.ts";
import { Store } from "../src/cli/store.ts";
import { fakeBinDir, fakeEnv } from "./helpers.ts";

const servers: GrilladoServer[] = [];
afterEach(async () => {
  while (servers.length) await servers.pop()!.close();
});

function webDir() {
  const dir = mkdtempSync(path.join(os.tmpdir(), "grillado-web-"));
  writeFileSync(path.join(dir, "index.html"), "<!doctype html><title>Grillado</title>");
  mkdirSync(path.join(dir, "assets"));
  writeFileSync(path.join(dir, "assets", "app.js"), "console.log(1)");
  return dir;
}

async function start(over: Partial<ConstructorParameters<typeof GrilladoServer>[0]> = {}, env = fakeEnv(fakeBinDir(["claude"]))) {
  const store = new Store(mkdtempSync(path.join(os.tmpdir(), "grillado-home-")));
  const server = new GrilladoServer({ adapters: createAdapters({ env }), store, webDir: webDir(), port: 0, strictPort: true, ...over });
  servers.push(server);
  await server.detect();
  await server.listen();
  return { server, store };
}

function request(port: number, opts: { method?: string; path?: string; headers?: Record<string, string>; body?: unknown }) {
  return new Promise<{ status: number; headers: http.IncomingHttpHeaders; body: string }>((resolve, reject) => {
    const req = http.request({ host: "127.0.0.1", port, method: opts.method ?? "GET", path: opts.path ?? "/", headers: opts.headers }, (res) => {
      let body = "";
      res.on("data", (d) => (body += d));
      res.on("end", () => resolve({ status: res.statusCode!, headers: res.headers, body }));
    });
    req.on("error", reject);
    if (opts.body !== undefined) req.end(JSON.stringify(opts.body));
    else req.end();
  });
}

describe("AC10: loopback only", () => {
  test("refuses any host other than 127.0.0.1", async () => {
    for (const host of ["0.0.0.0", "::", "localhost", "192.168.1.10", "::1"]) expect(() => assertLoopback(host)).toThrow("Refusing");
    const store = new Store(mkdtempSync(path.join(os.tmpdir(), "grillado-home-")));
    const s = new GrilladoServer({ adapters: [], store, webDir: webDir(), host: "0.0.0.0", port: 0, strictPort: true });
    expect(s.listen()).rejects.toThrow("Refusing to listen on 0.0.0.0");
  });

  test("binds 127.0.0.1", async () => {
    const { server } = await start();
    expect(server.address()).toMatchObject({ address: "127.0.0.1" });
  });

  test("rejects foreign Host and Origin (DNS rebinding / cross-site)", async () => {
    const { server } = await start();
    const h = { "x-grillado-token": server.token };
    expect((await request(server.port, { path: "/api/state", headers: { ...h, host: "evil.example" } })).status).toBe(403);
    expect((await request(server.port, { path: "/api/state", headers: { ...h, host: `127.0.0.1:${server.port}`, origin: "http://evil.example" } })).status).toBe(403);
    expect((await request(server.port, { path: "/api/state", headers: { ...h, host: `localhost:${server.port}` } })).status).toBe(200);
  });
});

describe("token", () => {
  test("API needs the token; the URL token becomes an HttpOnly cookie", async () => {
    const { server } = await start();
    expect((await request(server.port, { path: "/api/state" })).status).toBe(401);
    const wrong = await request(server.port, { path: "/?t=nope" });
    expect(wrong.headers["set-cookie"]).toBeUndefined();
    const res = await request(server.port, { path: `/?t=${server.token}` });
    expect(res.status).toBe(302);
    expect(res.headers.location).toBe("/");
    const cookie = res.headers["set-cookie"]![0];
    expect(cookie).toContain("HttpOnly");
    expect(cookie).toContain("SameSite=Strict");
    const ok = await request(server.port, { path: "/api/state", headers: { cookie: cookie.split(";")[0] } });
    expect(ok.status).toBe(200);
    expect(JSON.parse(ok.body).selected).toBe("claude");
  });

  test("POST requires JSON content type; bad JSON is a 400", async () => {
    const { server } = await start();
    const h = { "x-grillado-token": server.token };
    expect((await request(server.port, { method: "POST", path: "/api/rescan", headers: { ...h, "content-type": "text/plain" } })).status).toBe(415);
    const bad = await new Promise<number>((resolve) => {
      const req = http.request({ host: "127.0.0.1", port: server.port, method: "POST", path: "/api/sessions", headers: { ...h, "content-type": "application/json" } }, (r) => resolve(r.statusCode!));
      req.end("{nope");
    });
    expect(bad).toBe(400);
  });

  test("static files: SPA fallback, CSP, no path traversal", async () => {
    const { server } = await start();
    const index = await request(server.port, { path: "/some/route" });
    expect(index.status).toBe(200);
    expect(index.headers["content-security-policy"]).toContain("default-src 'self'");
    expect((await request(server.port, { path: "/assets/app.js" })).body).toBe("console.log(1)");
    expect((await request(server.port, { path: "/..%2f..%2fetc%2fpasswd" })).body).not.toContain("root:");
  });
});

describe("AC11: ports", () => {
  test("next free port when the default is busy; strict --port fails", async () => {
    const blocker = net.createServer();
    await new Promise<void>((r) => blocker.listen(0, "127.0.0.1", () => r()));
    const busy = (blocker.address() as net.AddressInfo).port;
    try {
      const { server } = await start({ port: busy, strictPort: false });
      expect(server.port).toBeGreaterThan(busy);
      expect(server.port).toBeLessThanOrEqual(busy + 20);
      const store = new Store(mkdtempSync(path.join(os.tmpdir(), "grillado-home-")));
      const strict = new GrilladoServer({ adapters: [], store, webDir: webDir(), port: busy, strictPort: true });
      expect(strict.listen()).rejects.toThrow(`Port ${busy} is already in use`);
    } finally {
      blocker.close();
    }
  });
});

async function waitFor<T>(fn: () => Promise<T | undefined>, ms = 8000): Promise<T> {
  const end = Date.now() + ms;
  for (;;) {
    const v = await fn();
    if (v !== undefined) return v;
    if (Date.now() > end) throw new Error("timed out");
    await new Promise((r) => setTimeout(r, 50));
  }
}

describe("session API with a fake CLI", () => {
  test("idea → rounds → confirm → plan.md on disk; restore after restart (AC14)", async () => {
    const env = fakeEnv(fakeBinDir(["claude"]));
    const { server, store } = await start({}, env);
    const h = { "x-grillado-token": server.token, "content-type": "application/json" };
    const api = async (method: string, p: string, body?: unknown) => {
      const r = await request(server.port, { method, path: p, headers: h, body });
      return { status: r.status, json: JSON.parse(r.body) };
    };
    const created = await api("POST", "/api/sessions", { idea: "A grilling recipe app" });
    expect(created.status).toBe(201);
    const id = created.json.id;
    const get = () => api("GET", `/api/sessions/${id}`).then((r) => r.json);
    const idle = (status: string) => waitFor(async () => {
      const s = await get();
      return !s.busy && s.status === status ? s : undefined;
    });

    let s = await idle("answering");
    expect(s.rounds[0].questions).toHaveLength(2);
    const accept = (sess: any) => sess.rounds.at(-1).questions.map((q: any) => ({ questionId: q.key, optionId: q.recommendedOptionId, accepted_recommendation: true }));
    await api("POST", `/api/sessions/${id}/answers`, { round: 1, answers: accept(s) });
    s = await idle("answering");
    await api("POST", `/api/sessions/${id}/answers`, { round: 2, answers: accept(s) });
    s = await idle("confirm");
    await api("POST", `/api/sessions/${id}/confirm`);
    s = await idle("plated");
    expect(s.plan.path).toBe(store.planPath(id));
    const md = await request(server.port, { path: `/api/sessions/${id}/plan.md`, headers: h });
    expect(md.headers["content-disposition"]).toContain("attachment");
    expect(md.body).toContain("[R2:storage]");

    // A new server process over the same data dir restores the session.
    const again = new GrilladoServer({ adapters: createAdapters({ env }), store, webDir: webDir(), port: 0, strictPort: true });
    servers.push(again);
    await again.listen();
    const r = await request(again.port, { path: `/api/sessions/${id}`, headers: { "x-grillado-token": again.token } });
    expect(JSON.parse(r.body).status).toBe("plated");
  });

  test("auth failure surfaces as a classified error with the login hint available", async () => {
    const env = fakeEnv(fakeBinDir(["claude"]), { FAKE_MODE: "auth" });
    const { server } = await start({}, env);
    const h = { "x-grillado-token": server.token, "content-type": "application/json" };
    const created = JSON.parse((await request(server.port, { method: "POST", path: "/api/sessions", headers: h, body: { idea: "x" } })).body);
    const s = await waitFor(async () => {
      const v = JSON.parse((await request(server.port, { path: `/api/sessions/${created.id}`, headers: h })).body);
      return v.error ? v : undefined;
    });
    expect(s.error.code).toBe("auth");
    const state = JSON.parse((await request(server.port, { path: "/api/state", headers: h })).body);
    expect(state.providers.find((p: any) => p.id === "claude").loginHint).toContain("/login");
  });

  test("stop kills a slow run", async () => {
    const env = fakeEnv(fakeBinDir(["claude"]), { FAKE_MODE: "slow" });
    const { server } = await start({}, env);
    const h = { "x-grillado-token": server.token, "content-type": "application/json" };
    const created = JSON.parse((await request(server.port, { method: "POST", path: "/api/sessions", headers: h, body: { idea: "x" } })).body);
    expect(created.busy).toBe(true);
    const stopped = JSON.parse((await request(server.port, { method: "POST", path: `/api/sessions/${created.id}/stop`, headers: h, body: {} })).body);
    expect(stopped.busy).toBe(false);
    expect(stopped.error.message).toContain("Stopped");
  });
});
