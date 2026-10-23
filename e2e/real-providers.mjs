// Manual check against the real agent CLIs installed on this machine (not part of CI).
// For each provider: start grillado with --provider, start a session over the API, and report what
// came back (a round, or a classified error). Usage: node e2e/real-providers.mjs claude codex grok pi
// Optional env per provider: REAL_PATH_<ID>, REAL_HOME_<ID>.
import { spawn } from "node:child_process";
import { mkdtempSync } from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";

const BIN = path.resolve(import.meta.dirname, "../dist/cli.js");
const ids = process.argv.slice(2);

function api(port, token, method, p, body) {
  return new Promise((resolve, reject) => {
    const req = http.request(
      { host: "127.0.0.1", port, method, path: p, headers: { "x-grillado-token": token, "content-type": "application/json" } },
      (res) => {
        let d = "";
        res.on("data", (c) => (d += c));
        res.on("end", () => resolve(JSON.parse(d || "{}")));
      },
    );
    req.on("error", reject);
    req.end(body ? JSON.stringify(body) : undefined);
  });
}

for (const id of ids) {
  const key = id.toUpperCase();
  const env = {
    ...process.env,
    PATH: process.env[`REAL_PATH_${key}`] ?? process.env.PATH,
    HOME: process.env[`REAL_HOME_${key}`] ?? process.env.HOME,
    GRILLADO_HOME: mkdtempSync(path.join(os.tmpdir(), "grillado-real-")),
    GRILLADO_TIMEOUT_MS: "90000",
  };
  const child = spawn(process.execPath, [BIN, "--no-open", "--provider", id], { env, stdio: ["ignore", "pipe", "pipe"] });
  let out = "";
  child.stdout.on("data", (d) => (out += d));
  child.stderr.on("data", (d) => (out += d));
  const exit = new Promise((r) => child.on("exit", (code) => r(code)));
  const started = await Promise.race([
    new Promise((resolve) => {
      const iv = setInterval(() => {
        const m = /127\.0\.0\.1:(\d+)\/\?t=([\w-]+)/.exec(out);
        if (m) {
          clearInterval(iv);
          resolve({ port: Number(m[1]), token: m[2] });
        }
      }, 50);
    }),
    exit.then((code) => ({ exited: code })),
  ]);
  const banner = out.split("\n").slice(0, 3).join(" | ").replace(/\x1b\[[0-9;]*m/g, "");
  if ("exited" in started) {
    console.log(`${id}: grillado exited ${started.exited}: ${out.trim().split("\n").at(-1)}`);
    continue;
  }
  const t0 = Date.now();
  const s = await api(started.port, started.token, "POST", "/api/sessions", { idea: "A tiny habit tracker" });
  let v = s;
  while (v.busy && Date.now() - t0 < 100_000) {
    await new Promise((r) => setTimeout(r, 500));
    v = await api(started.port, started.token, "GET", `/api/sessions/${s.id}`);
  }
  const what = v.error ? `error ${v.error.code}: ${v.error.message.replace(/\s+/g, " ").slice(0, 160)}` : `status ${v.status}, ${v.rounds.at(-1)?.questions.length ?? 0} questions`;
  console.log(`${id}: ${banner}\n  → ${what} (${((Date.now() - t0) / 1000).toFixed(1)}s)`);
  child.kill("SIGINT");
  console.log(`  shutdown exit ${await exit}`);
}
