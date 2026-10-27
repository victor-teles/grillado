import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import http from "node:http";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { createAdapters } from "../src/core/providers/adapters.ts";
import { GrilladoServer, assertLoopback } from "../src/cli/server.ts";
import { Store } from "../src/cli/store.ts";
import { addCoderComment } from "../src/core/comments.ts";
import { createSession } from "../src/core/session.ts";
import { fakeBinDir, fakeEnv } from "./helpers.ts";
import { platedSession } from "./mcp-fixture.ts";

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

describe("grillado mcp, web app side (v1.2 item 1)", () => {
  test("server.json points `grillado mcp` at the running app, and goes away on close", async () => {
    const { server, store } = await start();
    expect(store.readServerInfo()).toEqual({ pid: process.pid, port: server.port, token: server.token });
    const state = JSON.parse((await request(server.port, { path: "/api/state", headers: { "x-grillado-token": server.token } })).body);
    // Always present (review N4): main.ts passes it; without one, the cli.js next to the web dir.
    expect(state.mcp.command).toBe(process.execPath);
    expect(state.mcp.args[1]).toBe("mcp");
    expect(state.mcp.line).toContain("cli.js mcp");
    await servers.pop()!.close();
    expect(store.readServerInfo()).toBeNull();
  });

  test("a session link with the token keeps its path", async () => {
    const { server } = await start();
    const res = await request(server.port, { path: `/s/2026-10-26-abcd1234?t=${server.token}` });
    expect(res.status).toBe(302);
    expect(res.headers.location).toBe("/s/2026-10-26-abcd1234");
    expect(res.headers["set-cookie"]![0]).toContain(server.token);
    expect((await request(server.port, { path: `/x/../../etc?t=${server.token}` })).headers.location).toBe("/");
  });

  test("a session queued over MCP starts its first round when opened, on the picked agent", async () => {
    const { server, store } = await start();
    const s = createSession({ idea: "From the coding agent", provider: "codex" });
    s.queued = true;
    store.create(s);
    const h = { "x-grillado-token": server.token };
    const state = JSON.parse((await request(server.port, { path: "/api/state", headers: h })).body);
    expect(state.sessions.map((x: any) => x.id)).toContain(s.id);
    const v = await waitFor(async () => {
      const r = JSON.parse((await request(server.port, { path: `/api/sessions/${s.id}`, headers: h })).body);
      return !r.busy && r.status === "answering" ? r : undefined;
    });
    expect(v.error).toBeUndefined();
    expect(v.provider).toBe("claude");
    expect(store.load(s.id)!.queued).toBeUndefined();
  });

  test("a comment written over MCP shows up live and survives the app's next save", async () => {
    const { server, store } = await start();
    const s = platedSession(store);
    const h = { "x-grillado-token": server.token, "content-type": "application/json" };
    const get = async () => JSON.parse((await request(server.port, { path: `/api/sessions/${s.id}`, headers: h })).body);
    expect((await get()).comments).toBeUndefined();
    // Live: the open page's event stream gets the session with the new thread, no request needed.
    let events = "";
    const sse = http.get({ host: "127.0.0.1", port: server.port, path: "/api/events", headers: h }, (res) => res.on("data", (d) => (events += d)));
    await waitFor(async () => (events.includes("connected") ? true : undefined));
    store.update(s.id, (x) => void addCoderComment(x, { quote: "No sync in v1.", text: "Sync is cheap with iCloud.", client: "claude-code" }));
    await waitFor(async () => (events.includes("Sync is cheap with iCloud.") ? true : undefined), 10_000);
    sse.destroy();
    const v = await get();
    expect(v.comments[0].messages[0]).toMatchObject({ by: "coder", client: "claude-code" });
    // The app saves its copy (resolve) and the MCP thread is still there on disk.
    await request(server.port, { method: "POST", path: `/api/sessions/${s.id}/comments/${v.comments[0].id}/resolve`, headers: h, body: { resolved: true } });
    expect(store.load(s.id)!.comments![0]).toMatchObject({ resolved: true, quote: "No sync in v1." });
  }, 15_000);
});
