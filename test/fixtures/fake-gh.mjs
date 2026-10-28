#!/usr/bin/env node
// A fake `gh` for "Send to issues" (v1.3 item 2). Never talks to GitHub: issues live in
// $FAKE_GH_DIR/state.json, and every call's argv goes to $FAKE_GH_DIR/argv.jsonl.
// Env: FAKE_GH_VERSION (default 2.94.0), FAKE_GH_AUTH (ok | out), FAKE_GH_PERM (WRITE | READ | …),
// FAKE_GH_VISIBILITY (PUBLIC | PRIVATE), FAKE_GH_FAIL_CREATE (comma-separated create numbers, 1-based,
// that fail once each), FAKE_GH_FAIL_ATTACH (comma-separated issue numbers whose attach fails once),
// FAKE_GH_RATE (every create fails with a rate limit).
import { appendFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

const dir = process.env.FAKE_GH_DIR;
if (!dir) {
  process.stderr.write("FAKE_GH_DIR not set\n");
  process.exit(2);
}
const args = process.argv.slice(2);
const stateFile = path.join(dir, "state.json");
const state = existsSync(stateFile) ? JSON.parse(readFileSync(stateFile, "utf8")) : { next: 1, creates: 0, issues: [], labels: [{ name: "bug", color: "d73a4a" }], failed: [] };
const save = () => writeFileSync(stateFile, JSON.stringify(state, null, 2));
const flag = (name) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
};
const flags = (name) => args.flatMap((a, i) => (a === name ? [args[i + 1]] : []));
const out = (x) => process.stdout.write(typeof x === "string" ? `${x}\n` : `${JSON.stringify(x)}\n`);
const die = (msg, code = 1) => {
  process.stderr.write(`${msg}\n`);
  process.exit(code);
};
const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => k === "GH_HOST"));
appendFileSync(path.join(dir, "argv.jsonl"), `${JSON.stringify({ args, ...(Object.keys(env).length ? { env } : {}), ...(flag("--body-file") ? { body: readFileSync(flag("--body-file"), "utf8") } : {}) })}\n`);

const host = "github.com";
const repoOf = (r) => (r ?? "victor-teles/grillado").replace(/^[^/]+\/(?=[^/]+\/[^/]+$)/, "");
const view = (x, repo) => ({ id: x.id, number: x.number, html_url: `https://${host}/${repo}/issues/${x.number}`, url: `https://${host}/${repo}/issues/${x.number}`, title: x.title, body: x.body, state: x.state, labels: x.labels.map((name) => ({ name })) });
const once = (list, n) => {
  const key = `${list}:${n}`;
  if (!(process.env[list] ?? "").split(",").includes(String(n)) || state.failed.includes(key)) return false;
  state.failed.push(key);
  save();
  return true;
};
const loggedIn = (process.env.FAKE_GH_AUTH ?? "ok") === "ok";
const [a, b] = args;

if (a === "--version") out(`gh version ${process.env.FAKE_GH_VERSION ?? "2.94.0"} (2026-01-01)\nhttps://github.com/cli/cli/releases/latest`);
else if (a === "auth" && b === "status") {
  if (!loggedIn) die(`You are not logged into any GitHub hosts. To log in, run: gh auth login`);
  out(`${flag("--hostname") ?? host}\n  ✓ Logged in to ${flag("--hostname") ?? host} account fake-user (keyring)`);
} else if (!loggedIn) die("To get started with GitHub CLI, please run:  gh auth login", 4);
else if (a === "repo" && b === "view") {
  const repo = repoOf(args[2]);
  if (repo.endsWith("/missing")) die(`GraphQL: Could not resolve to a Repository with the name '${repo}'.`);
  out({ nameWithOwner: repo, visibility: process.env.FAKE_GH_VISIBILITY ?? "PRIVATE", viewerPermission: process.env.FAKE_GH_PERM ?? "WRITE", isFork: false, parent: null });
} else if (a === "repo" && b === "list") out([{ nameWithOwner: "victor-teles/grillado" }, { nameWithOwner: "victor-teles/other" }]);
else if (a === "label" && b === "list") out(state.labels);
else if (a === "label" && b === "create") {
  if (state.labels.some((l) => l.name === args[2])) die(`label with name "${args[2]}" already exists; use \`--force\` to update its color and description`);
  state.labels.push({ name: args[2], color: "ededed" });
  save();
} else if (a === "issue" && b === "create") {
  const repo = repoOf(flag("--repo"));
  state.creates++;
  const n = state.creates;
  if (process.env.FAKE_GH_RATE) {
    save();
    die("HTTP 403: API rate limit exceeded for user ID 1.");
  }
  if (once("FAKE_GH_FAIL_CREATE", n)) {
    save();
    die("HTTP 502: Bad Gateway (https://api.github.com/graphql)");
  }
  for (const l of flags("--label")) if (!state.labels.some((x) => x.name === l)) die(`could not add label: '${l}' not found`);
  const x = { id: 9000 + state.next, number: state.next++, title: flag("--title"), body: readFileSync(flag("--body-file"), "utf8"), labels: flags("--label"), state: "open", parent: null };
  state.issues.push(x);
  const p = flag("--parent");
  if (p !== undefined) {
    if (!/^2\.(9[4-9]|\d{3})|^[3-9]\./.test(process.env.FAKE_GH_VERSION ?? "2.94.0")) {
      save();
      die("unknown flag: --parent");
    }
    if (once("FAKE_GH_FAIL_ATTACH", x.number)) {
      save();
      out(view(x, repo).html_url);
      die("failed to add sub-issue: HTTP 422");
    }
    x.parent = Number(p);
  }
  save();
  out(view(x, repo).html_url);
} else if (a === "issue" && b === "edit") {
  const x = state.issues.find((i) => i.number === Number(args[2]));
  if (!x) die(`GraphQL: Could not resolve to an issue or pull request with the number of ${args[2]}.`);
  if (flag("--title")) x.title = flag("--title");
  if (flag("--body-file")) x.body = readFileSync(flag("--body-file"), "utf8");
  if (flag("--parent")) {
    if (once("FAKE_GH_FAIL_ATTACH", x.number)) die("failed to add sub-issue: HTTP 422");
    x.parent = Number(flag("--parent"));
  }
  save();
  out(view(x, repoOf(flag("--repo"))).html_url);
} else if (a === "issue" && b === "list") {
  // --search "\"grillado:plan=<id>\" in:body": the quoted phrase, in the body.
  const phrase = /"([^"]+)"/.exec(flag("--search") ?? "")?.[1] ?? "";
  const repo = repoOf(flag("--repo"));
  out(state.issues.filter((x) => !x.deleted && x.body.includes(phrase)).map((x) => ({ number: x.number, url: view(x, repo).html_url, title: x.title, body: x.body })));
} else if (a === "api") {
  const rest = args.slice(1).filter((x, i, all) => !(x === "--hostname" || all[i - 1] === "--hostname"));
  const method = rest.includes("-X") ? rest[rest.indexOf("-X") + 1] : "GET";
  const route = rest.find((x) => x.startsWith("repos/"));
  const m = /^repos\/([^/]+\/[^/]+)\/issues\/(\d+)(\/sub_issues)?$/.exec(route ?? "");
  if (!m) die("gh: Not Found (HTTP 404)");
  const x = state.issues.find((i) => i.number === Number(m[2]));
  if (!x || x.deleted) die("gh: Not Found (HTTP 404)");
  if (m[3] && method === "POST") {
    const f = rest[rest.indexOf("-F") + 1] ?? "";
    const id = Number(/^sub_issue_id=(\d+)$/.exec(f)?.[1]);
    const child = state.issues.find((i) => i.id === id);
    if (!child) die("gh: Validation Failed (HTTP 422)");
    if (once("FAKE_GH_FAIL_ATTACH", child.number)) die("gh: Validation Failed (HTTP 422)");
    child.parent = x.number;
    save();
    out(view(x, m[1]));
  } else out(view(x, m[1]));
} else die(`fake gh: unsupported ${args.join(" ")}`, 2);
