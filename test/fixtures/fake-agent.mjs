#!/usr/bin/env node
// A stand-in for the claude / codex / grok / pi CLIs. It speaks each CLI's output format and plays
// a small deterministic interview, so tests and the e2e run exercise the real adapters end to end.
// Env: FAKE_MODE (ok | auth | rate | garbage | garbage-once | dependent-once | plan-early-once |
// leak-once | slow | broken-version | long), FAKE_COMMENT (leak-once | bad-edit-once), FAKE_COMMENT_DELAY_MS, FAKE_DELAY_MS, FAKE_STATE_DIR (counters), FAKE_LOG (jsonl of invocations).
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
// FAKE_DELAY_MS: answer every turn after a pause (screenshots of the waiting states).
if (process.env.FAKE_DELAY_MS) await new Promise((r) => setTimeout(r, Number(process.env.FAKE_DELAY_MS)));

const state = JSON.parse(prompt.match(/<state>([\s\S]*?)<\/state>/)?.[1] ?? "{}");
const isPlan = /"type":"plan"/.test(system);
const isComment = /"type":"reply"/.test(system);
const isEdit = /"type":"edits"/.test(system);

const BASE = [
  { key: "scope", label: "Scope", title: "Ship a narrow first version?", deps: [], options: [["mvp", "Yes, one core flow"], ["full", "No, the full vision"]] },
  { key: "platform", label: "Platform", title: "Start on the web?", deps: [], options: [["web", "Web app"], ["mobile", "Mobile app"], ["cli", "Command line"]] },
  { key: "storage", label: "Storage", title: "Keep data local first?", deps: ["platform"], options: [["local", "Local storage"], ["cloud", "Hosted database"]] },
];
// FAKE_MODE=long: six rounds. Round 3 opens six questions at once, so the heat drops; rounds 1–4
// accepted as suggested trigger the passivity nudge on round 5.
const yn = [["yes", "Yes"], ["no", "No"]];
const LONG = [
  { key: "audience", label: "Audience", title: "Build it for yourself first?", deps: [], options: yn },
  { key: "budget", label: "Budget", title: "Keep it free to run?", deps: [], options: yn },
  { key: "core", label: "Core flow", title: "Start with the capture flow?", deps: ["audience"], options: yn },
  ...["Search", "Tags", "Export", "Sharing", "Reminders", "Themes"].map((label) => ({
    key: label.toLowerCase(), label, title: `Include ${label.toLowerCase()} in v1?`, deps: ["core"], options: yn, hint: false,
  })),
  { key: "sync", label: "Sync", title: "Sync across devices?", deps: ["search"], options: yn },
  { key: "backup", label: "Backups", title: "Back up nightly?", deps: ["sync"], options: yn },
  { key: "launch", label: "Launch", title: "Launch to friends first?", deps: ["backup"], options: yn },
];
const TEMPLATES = mode === "long" ? LONG : BASE;

function question(t) {
  return {
    key: t.key,
    label: t.label,
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
    const asked = new Set(ready.map((t) => t.key));
    const upcoming = TEMPLATES.filter((t) => !settled.has(t.key) && !asked.has(t.key) && t.hint !== false && t.deps.some((d) => asked.has(d))).map((t) => ({
      key: t.key,
      label: t.label,
      dependsOn: t.deps,
    }));
    return { type: "ask_round", summary: `Round ${state.nextRound}`, questions: q, upcoming };
  }
  if (state.keepGoing && !settled.has("extras")) {
    return { type: "ask_round", summary: "More", questions: [question({ key: "extras", title: "Add sharing later?", deps: ["scope"], options: [["later", "Later"], ["now", "Now"]] })] };
  }
  return { type: "frontier_empty", summary: "Everything is settled.", questions: [] };
}

// FAKE_MODE=long writes plan prose a reader would recognize (item 2 handoff nice-to-have): each
// decision lands in a section as a sentence, so passages and cites look real.
const PROSE = {
  audience: ["Who it's for", { Yes: "it's built for the person writing it first, so every rough edge gets felt the same day", No: "it's built for a small group from day one, so onboarding has to work on the first try" }],
  budget: ["Who it's for", { Yes: "it stays free to run: no servers to pay for, and everything works on a laptop", No: "a small monthly bill is fine if it buys hosted search and backups" }],
  core: ["Scope", { Yes: "the capture flow comes first. Opening the app and saving a thought takes under two seconds", No: "the review flow comes first, and capture borrows the system share sheet" }],
  sync: ["Data", { Yes: "notes sync across devices through a single folder the user already backs up", No: "notes stay on one device until there is a reason to sync" }],
  backup: ["Data", { Yes: "a nightly copy goes to a dated folder, and the last seven are kept", No: "backups are left to the user's own tools" }],
  launch: ["Launch", { Yes: "it goes to five friends first, with a short note asking what they gave up on", No: "it launches publicly with a short changelog" }],
};
const FEATURE = { Yes: "is in v1", No: "waits until after v1" };
function prose(d) {
  const p = PROSE[d.key];
  const cap = (t) => t[0].toUpperCase() + t.slice(1);
  if (p) return [p[0], `${cap(p[1][d.answer] ?? `${d.key}: ${d.answer}`)} [R${d.round}:${d.key}].`];
  return ["Scope", `${cap(d.key)} ${FEATURE[d.answer] ?? `: ${d.answer}`} [R${d.round}:${d.key}].`];
}
function longMarkdown(ds) {
  const sections = new Map();
  for (const d of ds) {
    const [h, line] = prose(d);
    sections.set(h, [...(sections.get(h) ?? []), line]);
  }
  const body = [...sections].map(([h, lines]) => `## ${h}\n${lines.join(" ")}`).join("\n\n");
  return `## Problem\n${state.idea}. Ideas show up while walking or in the middle of something else, and most of them are gone by the time a laptop is open.\n\n${body}`;
}

function planReply() {
  const ds = state.decisions ?? [];
  return {
    type: "plan",
    title: `Plan: ${state.idea}`,
    markdown: mode === "long" ? longMarkdown(ds) : `## Problem\n${state.idea}\n\n## Implementation decisions\n${ds.map((d) => `- ${d.answer} [R${d.round}:${d.key}]`).join("\n")}`,
    decisions: ds.map((d) => ({ round: d.round, questionId: d.key, statement: `Decided: ${d.answer}.` })),
    openDecisions: state.openDecisions ?? [],
  };
}

// Comment threads: a reply that names the passage, and "Apply feedback" as two edits (the quoted
// passage, and the first decision in the list). FAKE_COMMENT=leak-once | bad-edit-once exercise the
// banned filter and the edit check (one retry each).
function commentReply() {
  const plan = prompt.match(/<plan>([\s\S]*?)<\/plan>/)?.[1] ?? "";
  const quote = String(state.quote ?? "");
  const words = quote.replace(/\[R\d+:[^\]]*\]/g, "").trim();
  if (isComment) {
    if (process.env.FAKE_COMMENT === "leak-once" && once("comment-leak")) return { type: "reply", text: "Per the grilling method, yes." };
    const n = (state.messages ?? []).filter((m) => m.by === "user").length;
    const lead = n > 1 ? "Sure, that works too." : "Good catch.";
    return { type: "reply", text: `${lead} I can say that under ${state.section ?? "this section"} and spell out "${words.slice(0, 40)}".` };
  }
  if (process.env.FAKE_COMMENT === "bad-edit-once" && once("bad-edit")) return { type: "edits", summary: "x", edits: [{ before: "text that is not in the plan", after: "y" }] };
  // A comment on a decision block: answers change through the decision itself, so no edits.
  const inFence = [...plan.matchAll(/^```[\s\S]*?^```/gm)].some((m) => m[0].includes(quote));
  if (inFence || !plan.includes(quote)) return { type: "edits", summary: "Nothing to change in the text", edits: [] };
  const edits = [{ before: quote, after: `${quote}, shared by everyone at home` }];
  const item = /^- (Yes, one core flow)/m.exec(plan);
  if (item && !quote.includes(item[1])) edits.push({ before: item[1], after: "Yes, one core flow, shipped first" });
  return { type: "edits", summary: "Spelled it out", edits };
}

// FAKE_COMMENT_DELAY_MS: comment replies and Apply runs take this long (the e2e sees "Writing suggestions").
if ((isComment || isEdit) && process.env.FAKE_COMMENT_DELAY_MS) await new Promise((r) => setTimeout(r, Number(process.env.FAKE_COMMENT_DELAY_MS)));
const reply = isComment || isEdit ? commentReply() : isPlan ? planReply() : roundReply();
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
