#!/usr/bin/env node
// A stand-in for the claude / codex / grok / pi CLIs. It speaks each CLI's output format and plays
// a small deterministic interview, so tests and the e2e run exercise the real adapters end to end.
// Env: FAKE_MODE (ok | auth | rate | garbage | garbage-once | dependent-once | plan-early-once |
// leak-once | slow | broken-version), FAKE_STATE_DIR (counters), FAKE_LOG (jsonl of invocations).
import { appendFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

const [name, ...args] = process.argv.slice(2);
const mode = process.env.FAKE_MODE ?? "ok";
const stateDir = process.env.FAKE_STATE_DIR ?? "/tmp";

if (args[0] === "--version") {
  if (mode === "broken-version") {
    console.error("segfault-ish");
    process.exit(3);
  }
  console.log(`${name} 9.9.9-fake`);
  process.exit(0);
}
if (args[0] === "--help") {
  console.log(name === "grok" && mode !== "wrong-grok" ? "Usage: grok [OPTIONS]\n  --output-format <F>" : `Usage: ${name}`);
  process.exit(0);
}

const flag = (f) => {
  const i = args.indexOf(f);
  return i === -1 ? undefined : args[i + 1];
};
const readStdin = () => {
  try {
    return readFileSync(0, "utf8");
  } catch {
    return "";
  }
};

let system = "";
let prompt = "";
if (name === "claude") {
  system = readFileSync(flag("--system-prompt-file"), "utf8");
  prompt = readStdin();
} else if (name === "codex") {
  prompt = readStdin();
  system = prompt;
} else if (name === "grok") {
  system = flag("--system-prompt-override") ?? "";
  prompt = readFileSync(flag("--prompt-file"), "utf8");
} else if (name === "pi") {
  system = flag("--system-prompt") ?? "";
  prompt = readStdin();
}

if (process.env.FAKE_LOG) {
  appendFileSync(process.env.FAKE_LOG, `${JSON.stringify({ name, pid: process.pid, args, cwd: process.cwd(), promptBytes: prompt.length })}\n`);
}

const once = (key) => {
  const file = path.join(stateDir, `fake-once-${key}`);
  if (existsSync(file)) return false;
  writeFileSync(file, "1");
  return true;
};

function fail(kind) {
  const msg = kind === "auth" ? authMessage() : "429 Too Many Requests: rate limit reached";
  if (name === "claude") {
    console.log(JSON.stringify({ type: "result", is_error: true, result: msg, api_error_status: kind === "rate" ? 429 : null }));
    process.exit(1);
  }
  if (name === "grok") {
    console.log(JSON.stringify({ type: "error", message: msg }));
    console.error(`Error: ${msg}`);
    process.exit(1);
  }
  if (name === "pi") {
    const m = { role: "assistant", content: [], stopReason: "error", errorMessage: msg };
    console.log(JSON.stringify({ type: "message_end", message: m }));
    process.exit(0); // pi exits 0 on model errors
  }
  console.error(`ERROR: ${msg}`);
  process.exit(1);
}
function authMessage() {
  return {
    claude: "Not logged in · Please run /login",
    codex: "unexpected status 401 Unauthorized: Missing bearer or basic authentication in header",
    grok: "Not signed in. To authenticate without a browser, run:\n  grok login --device-code",
    pi: "401 invalid api key",
  }[name];
}

if (mode === "auth") fail("auth");
if (mode === "rate") fail("rate");
if (mode === "slow") await new Promise((r) => setTimeout(r, 60_000));

const state = JSON.parse(prompt.match(/<state>([\s\S]*?)<\/state>/)?.[1] ?? "{}");
const isPlan = /"type":"plan"/.test(system);

const TEMPLATES = [
  { key: "scope", title: "Ship a narrow first version?", deps: [], options: [["mvp", "Yes, one core flow"], ["full", "No, the full vision"]] },
  { key: "platform", title: "Start on the web?", deps: [], options: [["web", "Web app"], ["mobile", "Mobile app"], ["cli", "Command line"]] },
  { key: "storage", title: "Keep data local first?", deps: ["platform"], options: [["local", "Local storage"], ["cloud", "Hosted database"]] },
];

function question(t) {
  return {
    key: t.key,
    title: t.title,
    body: `Context for ${t.key}.`,
    options: t.options.map(([id, label]) => ({ id, label, description: "" })),
    recommendedOptionId: t.options[0][0],
    dependsOn: t.deps,
  };
}

function roundReply() {
  const settled = new Set((state.decisions ?? []).map((d) => d.key));
  if (mode === "garbage") return "I think you should consider many things. No JSON here.";
  if (mode === "garbage-once" && once("garbage")) return "Sure! Here's my thinking, sorry, no JSON.";
  if (mode === "truncated-once" && once("truncated")) return '{"type":"ask_round","questions":[{"key":"sc';
  if (mode === "wrong-shape-once" && once("wrong")) return { type: "ask_round", questions: "lots" };
  if (mode === "dependent-once" && once("dep")) {
    return { type: "ask_round", summary: "bad", questions: [question(TEMPLATES[1]), question(TEMPLATES[2])] };
  }
  if (mode === "plan-early-once" && once("plan")) {
    return { type: "plan", title: "Too early", markdown: "# nope", decisions: [], openDecisions: [] };
  }
  const ready = TEMPLATES.filter((t) => !settled.has(t.key) && t.deps.every((d) => settled.has(d)));
  if (ready.length) {
    const q = ready.map(question);
    if (mode === "leak-once" && once("leak")) q[0].body = "This follows the grilling method.";
    return { type: "ask_round", summary: `Round ${state.nextRound}`, questions: q };
  }
  if (state.keepGoing && !settled.has("extras")) {
    return { type: "ask_round", summary: "More", questions: [question({ key: "extras", title: "Add sharing later?", deps: ["scope"], options: [["later", "Later"], ["now", "Now"]] })] };
  }
  return { type: "frontier_empty", summary: "Everything is settled.", questions: [] };
}

function planReply() {
  const ds = state.decisions ?? [];
  return {
    type: "plan",
    title: `Plan: ${state.idea}`,
    markdown: `## Problem\n${state.idea}\n\n## Implementation decisions\n${ds.map((d) => `- ${d.answer} [R${d.round}:${d.key}]`).join("\n")}`,
    decisions: ds.map((d) => ({ round: d.round, questionId: d.key, statement: `Decided: ${d.answer}.` })),
    openDecisions: state.openDecisions ?? [],
  };
}

const reply = isPlan ? planReply() : roundReply();
const text = typeof reply === "string" ? reply : JSON.stringify(reply);

if (name === "claude") {
  const out = { type: "result", is_error: false, result: text };
  if (typeof reply !== "string") out.structured_output = reply;
  console.log(JSON.stringify(out));
} else if (name === "codex") {
  writeFileSync(flag("-o"), text);
  console.log('{"type":"thread.started"}');
} else if (name === "grok") {
  const out = { text, stopReason: "end_turn", sessionId: "s" };
  if (typeof reply !== "string") out.structured_output = reply;
  console.log(JSON.stringify(out));
} else if (name === "pi") {
  // pi has no schema flag: wrap in a fence to exercise extraction.
  const m = { role: "assistant", content: [{ type: "text", text: `Here you go:\n\`\`\`json\n${text}\n\`\`\`` }], stopReason: "stop" };
  console.log(JSON.stringify({ type: "session" }));
  console.log(JSON.stringify({ type: "message_end", message: m }));
}
