// The plan-to-build loop: build steps on a plated plan, the coding agent's progress and asks, the
// plan file's build sections, what changed since the agent last read, the shell commands and their
// MCP tools (same results), the agent choice on `plan start`, and the server end to end.
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { UsageError } from "../src/cli/args.ts";
import { runBuild } from "../src/cli/build-command.ts";
import { createMcpServer } from "../src/cli/mcp.ts";
import { runPlan } from "../src/cli/plan-command.ts";
import { agentFor, getPlan } from "../src/cli/plans.ts";
import { GrilladoServer } from "../src/cli/server.ts";
import { Store } from "../src/cli/store.ts";
import {
  BUILD_MARKER,
  type BuildState,
  BuildError,
  addAsk,
  addDecisionLine,
  addStep,
  answerAsk,
  buildAppendix,
  changesSince,
  decisionBullet,
  editStep,
  emptyBuild,
  finishStep,
  moveStep,
  nextStep,
  removeStep,
  reopenStep,
  setSteps,
  snapshot,
  startStep,
  stripBuildAppendix,
  withBuildAppendix,
  withdrawAsk,
} from "../src/core/build.ts";
import { parseDecisionBody } from "../src/core/decision-block.ts";
import { stepsProblem } from "../src/core/engine.ts";
import { cleanText, fallbackSlices } from "../src/core/issues.ts";
import { synthesisSystemPrompt } from "../src/core/prompts.ts";
import { createAdapters } from "../src/core/providers/adapters.ts";
import { PlanReplySchema, planJsonSchema } from "../src/core/schema.ts";
import { PLAN_MD, draftSession, platedSession, tempStore } from "./mcp-fixture.ts";
import { fakeBinDir, fakeEnv } from "./helpers.ts";

const STEPS = [
  { title: "Store recipes", done: "A saved recipe is there after a restart" },
  { title: "Search recipes", done: "Typing a word lists the recipes that have it" },
  { title: "Share a recipe", done: "A second device opens the link" },
];
const build = (): BuildState => {
  const b = emptyBuild();
  setSteps(b, STEPS);
  return b;
};
const OPTIONS = [{ id: "file", label: "A file on disk" }, { id: "db", label: "A small database", description: "Easier to query" }];
const facts = (markdown = PLAN_MD) => ({ markdown, decisions: [{ key: "storage", round: 1, answer: "SQLite on the device" }] });

// ---------------------------------------------------------------- core rules

describe("build steps", () => {
  test("a plan's steps get stable keys; a plan written again keeps progress by title", () => {
    const b = build();
    expect(b.steps.map((s) => [s.key, s.status])).toEqual([["step-1", "todo"], ["step-2", "todo"], ["step-3", "todo"]]);
    finishStep(b, 1, { verified: "restart test passes" });
    setSteps(b, [{ title: "Import recipes", done: "A file imports" }, { title: "store recipes", done: "Still there after a restart" }]);
    expect(b.steps.map((s) => [s.key, s.title, s.status, s.verified])).toEqual([
      ["step-4", "Import recipes", "todo", undefined],
      ["step-1", "store recipes", "done", "restart test passes"],
    ]);
  });

  test("next is the step in progress, else the first not done, in the user's order", () => {
    const b = build();
    expect(nextStep(b)?.key).toBe("step-1");
    startStep(b, 2);
    expect(nextStep(b)?.key).toBe("step-2");
    finishStep(b, "step-2", { verified: "search test passes" });
    finishStep(b, 1, { verified: "ok" });
    moveStep(b, 3, -1);
    expect(b.steps.map((s) => s.key)).toEqual(["step-1", "step-3", "step-2"]);
    expect(nextStep(b)?.key).toBe("step-3");
    finishStep(b, "step-3", { verified: "ok" });
    expect(nextStep(b)).toBeNull();
  });

  test("done needs what was verified; a deviation is recorded; the agent's reports don't move the revision", () => {
    const b = build();
    expect(() => finishStep(b, 1, { verified: "  " })).toThrow("Say what you verified");
    expect(() => finishStep(b, 9, { verified: "x" })).toThrow('There is no step "9". The plan has steps 1 to 3.');
    startStep(b, 1);
    const s = finishStep(b, 1, { verified: "bun test: 9 pass", deviation: "One file, not two" });
    expect(s).toMatchObject({ status: "done", verified: "bun test: 9 pass", deviation: "One file, not two" });
    expect(b.rev).toBe(1);
    expect(() => startStep(b, 1)).toThrow("already done");
    expect(b.log.map((e) => e.kind)).toEqual(["started", "done"]);
  });

  test("the user's edits move the revision: reopen, edit, move, add, remove", () => {
    const b = build();
    finishStep(b, 1, { verified: "ok" });
    reopenStep(b, 1);
    expect(b.steps[0]).toMatchObject({ status: "todo", verified: undefined });
    // The earlier report stays in the log as history.
    expect(b.log.map((e) => e.kind)).toEqual(["done", "reopened"]);
    expect(b.rev).toBe(2);
    editStep(b, 1, { title: "Store recipes locally" });
    editStep(b, 1, { title: "Store recipes locally" }); // no change, no new revision
    expect(b.rev).toBe(3);
    expect(() => editStep(b, 1, { title: " " })).toThrow("needs a title");
    moveStep(b, 1, -1); // already first
    expect(b.rev).toBe(3);
    moveStep(b, 1, 1);
    const added = addStep(b, { title: "Print a recipe", done: "The print view has no buttons" }, "step-1");
    expect(b.steps.map((s) => s.key)).toEqual(["step-2", "step-1", added.key, "step-3"]);
    removeStep(b, "step-3");
    expect(b.steps).toHaveLength(3);
    expect(b.rev).toBe(6);
  });
});

describe("asks", () => {
  test("an ask needs a key, a question and 2 to 6 options; it is raised at the step in progress", () => {
    const b = build();
    startStep(b, 2);
    expect(() => addAsk(b, { key: "Ask Storage", title: "Where?", options: OPTIONS })).toThrow("lowercase-kebab-case");
    expect(() => addAsk(b, { key: "ask-storage", title: " ", options: OPTIONS })).toThrow("needs the question");
    expect(() => addAsk(b, { key: "ask-storage", title: "Where?", options: OPTIONS.slice(0, 1) })).toThrow("2 to 6 options");
    expect(() => addAsk(b, { key: "ask-storage", title: "Where?", options: OPTIONS, recommended: "cloud" })).toThrow("not one of the options");
    const ask = addAsk(b, { key: "ask-storage", title: "Where should recipes be stored?", options: OPTIONS, recommended: "file" });
    expect(ask).toMatchObject({ state: "open", step: "step-2", recommended: "file" });
    expect(() => addAsk(b, { key: "ask-storage", title: "Again?", options: OPTIONS })).toThrow("already asked");
    expect(b.rev).toBe(1);
  });

  test("only an answer makes a decision: an option or the user's own words; it moves the revision", () => {
    const b = build();
    startStep(b, 1);
    addAsk(b, { key: "ask-storage", title: "Where should recipes be stored?", options: OPTIONS });
    expect(() => answerAsk(b, "ask-storage", {})).toThrow("Pick one of the options");
    const a = answerAsk(b, "ask-storage", { optionId: "db" });
    expect(a).toMatchObject({ state: "answered", answer: "A small database", answerId: "db" });
    expect(b.rev).toBe(2);
    expect(() => answerAsk(b, "ask-storage", { optionId: "file" })).toThrow("already answered");
    expect(decisionBullet(b, a)).toBe("- Where should recipes be stored? A small database. Decided during the build, at step 1. [B:ask-storage]");
    addAsk(b, { key: "ask-name", title: "What is it called", options: OPTIONS });
    const own = answerAsk(b, "ask-name", { text: "  Recipe box.  " });
    expect(own.answer).toBe("Recipe box.");
    expect(own.answerId).toBeUndefined();
    expect(decisionBullet(b, own)).toBe("- What is it called: Recipe box. Decided during the build, at step 1. [B:ask-name]");
  });

  test("a withdrawn ask is not a decision and can't be answered afterwards", () => {
    const b = build();
    addAsk(b, { key: "ask-sync", title: "Sync?", options: OPTIONS });
    const w = withdrawAsk(b, "ask-sync", "Found it in the plan");
    expect(w).toMatchObject({ state: "withdrawn", reason: "Found it in the plan" });
    expect(w.answer).toBeUndefined();
    expect(b.rev).toBe(1);
    expect(() => answerAsk(b, "ask-sync", { optionId: "db" })).toThrow("withdrew");
    expect(() => withdrawAsk(b, "nope")).toThrow('There is no ask "nope"');
  });

  test("the decision line goes at the end of the Implementation decisions bullets, before its decision blocks", () => {
    const md = "# P\n\n## Implementation decisions\n- One [R1:a]\n- Two [R1:b]\n\n```decision\nid: R1·1\nkey: a\nquestion: Q?\nanswer: One\n```\n\n## Testing decisions\n- T\n";
    expect(addDecisionLine(md, "- New [B:x]")).toBe("# P\n\n## Implementation decisions\n- One [R1:a]\n- Two [R1:b]\n- New [B:x]\n\n```decision\nid: R1·1\nkey: a\nquestion: Q?\nanswer: One\n```\n\n## Testing decisions\n- T\n");
    expect(addDecisionLine("# P\n\n## Problem\nx\n\n## Out of scope\n- y\n", "- New [B:x]")).toBe("# P\n\n## Problem\nx\n\n## Implementation decisions\n\n- New [B:x]\n\n## Out of scope\n- y\n");
    expect(addDecisionLine("# P\n\n## Problem\nx\n", "- New [B:x]")).toBe("# P\n\n## Problem\nx\n\n## Implementation decisions\n\n- New [B:x]\n");
  });

  test("a build citation is read where a round's is", () => {
    expect(cleanText("- Where? A file. [B:ask-storage] and [R1:storage, B:ask-x]")).toBe("- Where? A file. and");
    expect(parseDecisionBody("id: B·1\nkey: ask-storage\nquestion: Where?\nanswer: A file").ok).toBe(true);
  });
});

describe("the plan file's build sections", () => {
  test("every status and every way an ask ends is written", () => {
    const b = build();
    startStep(b, 1);
    addAsk(b, { key: "ask-storage", title: "Where?", options: OPTIONS });
    answerAsk(b, "ask-storage", { optionId: "file" });
    addAsk(b, { key: "ask-sync", title: "Sync on every change?", options: OPTIONS });
    withdrawAsk(b, "ask-sync");
    addAsk(b, { key: "ask-open", title: "Still open?", options: OPTIONS });
    finishStep(b, 1, { verified: "restart test passes", deviation: "One file, not two" });
    finishStep(b, 3, { verified: "opened on a phone" });
    reopenStep(b, 3);
    startStep(b, 2);
    expect(buildAppendix(b).join("\n")).toBe(
      [
        "## Build steps",
        "",
        "- [x] 1. Store recipes",
        "  Done when: A saved recipe is there after a restart",
        "- [~] 2. Search recipes (started)",
        "  Done when: Typing a word lists the recipes that have it",
        "- [ ] 3. Share a recipe",
        "  Done when: A second device opens the link",
        "",
        "## Build log",
        "",
        "- Ask `ask-storage` answered: “A file on disk” [B:ask-storage]",
        "- Ask `ask-sync` withdrawn by the agent: “Sync on every change?”",
        "- Step 1 done. Verified: restart test passes",
        "  Deviation: One file, not two",
        "- Step 3 done. Verified: opened on a phone",
        "- Step 3 reopened by you.",
      ].join("\n"),
    );
    expect(buildAppendix(emptyBuild())).toEqual([]);
    expect(buildAppendix(undefined)).toEqual([]);
  });

  test("the text before the build sections comes back byte for byte", () => {
    const b = build();
    for (const body of ["# P\n\n## Problem\nx\n", "# P\n\n## Problem\nx", "# P\n\n## Problem\nx\n\n\n"]) {
      const file = withBuildAppendix(body, b);
      expect(file.startsWith(`${body}\n${BUILD_MARKER}\n\n## Build steps\n`)).toBe(true);
      expect(stripBuildAppendix(file)).toBe(body);
      // Writing it again with new state replaces the sections, never stacks them.
      finishStep(b, 1, { verified: "ok" });
      expect(withBuildAppendix(file, b).match(/## Build steps/g)).toHaveLength(1);
      reopenStep(b, 1);
    }
    // A plan with no build state is written exactly as it was.
    expect(withBuildAppendix("# P\n", undefined)).toBe("# P\n");
    expect(stripBuildAppendix("# P\n\n## Problem\nx")).toBe("# P\n\n## Problem\nx");
  });

  test("what a person wrote after the sections is kept; a removed marker still loses the two sections", () => {
    const file = `${withBuildAppendix("# P\n\n## Problem\nx\n", build())}\n## Notes\nMine.\n`;
    expect(stripBuildAppendix(file)).toBe("# P\n\n## Problem\nx\n\n## Notes\nMine.\n");
    expect(stripBuildAppendix(file.replace(`${BUILD_MARKER}\n`, ""))).toBe("# P\n\n## Problem\nx\n\n\n## Notes\nMine.\n");
    // A heading inside a code fence is not a section.
    expect(stripBuildAppendix("# P\n\n```md\n## Build steps\n```\n")).toBe("# P\n\n```md\n## Build steps\n```\n");
  });
});

describe("what changed since the agent last read", () => {
  test("nothing until the revision moves; then decisions, sections and steps, one line each", () => {
    const b = build();
    b.seen = snapshot(b, facts());
    startStep(b, 1);
    finishStep(b, 1, { verified: "ok" });
    expect(changesSince(b.seen, b, facts())).toEqual([]);
    expect(changesSince(undefined, b, facts())).toEqual([]);

    addAsk(b, { key: "ask-export", title: "Export as?", options: OPTIONS });
    answerAsk(b, "ask-export", { optionId: "file" });
    editStep(b, 2, { done: "Search finds a word in the title or the steps" });
    moveStep(b, 3, -1);
    addStep(b, { title: "Print a recipe" });
    reopenStep(b, 1);
    const md = PLAN_MD.replace("No sync in v1.", "Sync through iCloud.") + "\n## Printing\n\nA print view.\n";
    const now = { markdown: md, decisions: [{ key: "storage", round: 1, answer: "Postgres" }, { key: "sync", round: 3, answer: "iCloud" }] };
    expect(changesSince(b.seen, b, now)).toEqual([
      "~ decision [R1:storage] changed: SQLite on the device -> Postgres",
      "+ decision [R3:sync] iCloud",
      "+ decision [B:ask-export] A file on disk",
      '~ section "Sync" edited',
      '+ section "Printing"',
      '~ step 3 edited: "Search recipes"',
      '+ step 4 "Print a recipe"',
      "~ steps reordered",
      "~ step 1 reopened by the user",
    ]);
    removeStep(b, 4);
    expect(changesSince(b.seen, b, { markdown: PLAN_MD.replace("## Sync\n\nNo sync in v1.\n\n", ""), decisions: [] })).toContain('- section "Sync" removed');
    expect(changesSince(b.seen, b, { markdown: PLAN_MD, decisions: [] })).toContain("- decision [R1:storage] reopened or removed");
  });
});

describe("the plan run writes the steps", () => {
  test("the reply shape, the prompt and the repair check", () => {
    expect((planJsonSchema() as any).required).toContain("steps");
    expect((planJsonSchema() as any).properties.steps.items.required).toEqual(["title", "done"]);
    const reply = { type: "plan", title: "t", markdown: "m", decisions: [], openDecisions: [] };
    // Missing or malformed steps never fail the plan: they are dropped, and asked for once.
    expect(PlanReplySchema.parse(reply).steps).toEqual([]);
    expect(PlanReplySchema.parse({ ...reply, steps: [{ title: "Ok", done: "It runs" }, { title: "" }, "nope"] }).steps).toEqual([{ title: "Ok", done: "It runs" }]);
    expect(stepsProblem([])).toContain('Add "steps"');
    expect(stepsProblem([{ title: "Store recipes", done: "" }])).toBe('Step "Store recipes" needs "done": one sentence that says how to tell it is done.');
    expect(stepsProblem(STEPS)).toBeNull();
    for (const read of [false, true]) {
      const p = synthesisSystemPrompt({ read });
      expect(p).toContain("Each step is a thin end-to-end slice");
      expect(p).toContain('"steps":[{"title":"...","done":"..."}]');
    }
  });

  test("Send to issues uses the plan's steps, ahead of its user stories", () => {
    const store = tempStore();
    const s = platedSession(store);
    const md = `${PLAN_MD}\n## User stories\n\n1. As a cook, I want search.\n`;
    expect(fallbackSlices(s, md).source).toBe("stories");
    s.build = build();
    const out = fallbackSlices(s, md);
    expect(out.source).toBe("steps");
    expect(out.slices.map((x) => [x.key, x.title, x.sections])).toEqual(STEPS.map((x, i) => [`step-${i + 1}`, x.title, ["Build steps"]]));
    expect(out.slices[0].body).toBe("Store recipes\n\nDone when: A saved recipe is there after a restart");
  });
});

// ---------------------------------------------------------------- the store

function withSteps(store: Store) {
  const s = platedSession(store);
  store.update(s.id, (x) => {
    x.build = build();
  });
  store.refreshPlan(s.id);
  return s.id;
}

describe("the store keeps the file and the state together", () => {
  test("the file has the build sections; readers of the plan text don't; a save never drops build state", () => {
    const store = tempStore();
    const id = withSteps(store);
    expect(store.readPlan(id)).toBe(PLAN_MD);
    expect(store.readPlanFile(id)).toBe(`${PLAN_MD}\n${BUILD_MARKER}\n\n${buildAppendix(build()).join("\n")}\n`);
    // Another process (the web app) holding an older copy saves it: the build state on disk stays.
    const stale = store.load(id)!;
    store.update(id, (x) => void finishStep(x.build!, 1, { verified: "ok" }));
    stale.build = emptyBuild();
    store.save(stale);
    expect(store.load(id)!.build!.steps[0].status).toBe("done");
    expect(stale.build!.steps[0].status).toBe("done");
    // A plan with no build state is written as before.
    const plain = platedSession(store, "Another");
    expect(store.readPlanFile(plain.id)).toBe(PLAN_MD);
  });
});

// ---------------------------------------------------------------- the shell commands

function io() {
  const o = { out: "", err: "" };
  return { o, out: (s: string) => void (o.out += s), err: (s: string) => void (o.err += s) };
}
function shell(store: Store) {
  const run = async (...argv: string[]) => {
    const c = io();
    const code = await runBuild(argv, { version: "9.9.9", out: c.out, err: c.err, env: { GRILLADO_HOME: store.dir }, cliFile: "/nope", appLine: () => "npx grillado", pollMs: 10 });
    return { code, out: c.o.out, err: c.o.err };
  };
  const json = async (...argv: string[]) => JSON.parse((await run(...argv, "--json")).out);
  const plan = async (...argv: string[]) => {
    const c = io();
    await runPlan(argv, { version: "9.9.9", out: c.out, err: c.err, env: { GRILLADO_HOME: store.dir }, cliFile: "/nope", appLine: () => "npx grillado", pollMs: 10 });
    return c.o.out;
  };
  return { run, json, plan };
}
/** The app is "running": an ask doesn't try to start one. */
const running = (store: Store) => store.writeServerInfo({ pid: process.pid, port: 4999, token: "tok" });

describe("grillado build", () => {
  test("next, start and done walk the steps in order, with the revision and progress on every reply", async () => {
    const store = tempStore();
    const id = withSteps(store);
    const { run, json } = shell(store);
    let r = await run("next", id);
    expect(r.code).toBe(0);
    expect(r.out).toBe(
      `Step 1: Store recipes\nDone when: A saved recipe is there after a restart\n\nRun \`grillado build start ${id} --step 1\`, build it, then report it done with what you verified.\nPlan revision 1 · 0 of 3 steps done.\n`,
    );
    expect(await json("start", id)).toMatchObject({ plan: id, rev: 1, progress: { done: 0, of: 3 }, step: { n: 1, key: "step-1", status: "started" } });
    expect((await run("next", id)).out).toContain("Step 1: Store recipes (in progress)");
    // done: wrong usage without what was verified; with it, the step in progress is finished.
    await expect(run("done", id)).rejects.toThrow(UsageError);
    r = await run("done", id, "--verified", "restart test passes", "--deviation", "One file, not two");
    expect(r.out).toBe(`Step 1 done.\nStep 1 is done. Next: grillado build next ${id}\nPlan revision 1 · 1 of 3 steps done.\n`);
    expect(store.readPlanFile(id)).toContain("- [x] 1. Store recipes");
    expect(store.readPlanFile(id)).toContain("- Step 1 done. Verified: restart test passes\n  Deviation: One file, not two");
    // A step by number, out of order; next then gives the first that isn't done.
    expect((await json("done", id, "--step", "3", "--verified", "ok")).progress).toEqual({ done: 2, of: 3 });
    expect((await json("next", id)).step).toMatchObject({ n: 2, title: "Search recipes" });
    await run("done", id, "--step", "2", "--verified", "ok");
    const end = await json("next", id);
    expect(end.step).toBeNull();
    expect(end.next).toContain("Every build step is done");
  });

  test("errors an agent can act on: no such plan or step, a draft, a plan with no steps, wrong usage", async () => {
    const store = tempStore();
    const { run } = shell(store);
    const plain = platedSession(store);
    const draft = draftSession(store);
    expect(await run("next", "2026-01-01-aaaaaaaa")).toMatchObject({ code: 1, out: "" });
    expect((await run("next", draft.id)).err).toContain("still a draft");
    const none = await run("next", plain.id);
    expect(none.code).toBe(0);
    expect(none.out).toContain("This plan has no build steps");
    expect((await run("start", plain.id)).err).toContain("no build steps");
    const id = withSteps(store);
    expect((await run("done", id, "--step", "9", "--verified", "x")).err).toContain('There is no step "9"');
    expect((await run("done", id, "--verified", "x")).err).toContain("No step is in progress");
    for (const argv of [["next"], ["next", "not a plan id"], ["next", id, "--step", "1"], ["bogus", id], ["wait", id], ["withdraw", id], ["ask", id, "--key", "k", "--title", "T", "--option", "a=A"], ["ask", id, "--key", "k", "--title", "T", "--option", "a", "--option", "b=B"]])
      await expect(run(...argv)).rejects.toThrow(UsageError);
    expect((await run()).code).toBe(2);
    expect((await run("--help")).out).toContain("grillado build ask <plan>");
  });

  test("ask, wait and withdraw: the answer comes back, a timeout is a normal result, a withdrawn ask is no decision", async () => {
    const store = tempStore();
    const id = withSteps(store);
    running(store);
    const { run, json } = shell(store);
    await run("start", id);
    const asked = await json("ask", id, "--key", "ask-storage", "--title", "Where should recipes be stored?", "--body", "The plan doesn't say.", "--option", "file=A file on disk", "--option", "db=A small database", "--note", "db=Easier to query", "--suggest", "file");
    expect(asked).toMatchObject({ ask: { key: "ask-storage", state: "open", step: 1 }, url: `http://127.0.0.1:4999/s/${id}?t=tok`, opened: false, waitingOnUser: ["ask-storage"] });
    expect(asked.next).toContain(`grillado build wait ${id} --ask ask-storage`);
    expect(store.load(id)!.build!.asks[0]).toMatchObject({ body: "The plan doesn't say.", recommended: "file", options: [{ id: "file", label: "A file on disk" }, { id: "db", label: "A small database", description: "Easier to query" }] });

    const waiting = await run("wait", id, "--ask", "ask-storage", "--timeout", "0");
    expect(waiting.code).toBe(0);
    expect(waiting.out).toContain('Still waiting for the user to answer "Where should recipes be stored?".');
    expect(waiting.out).toContain("Run the same command again to keep waiting.");

    // The user answers while the agent waits.
    const pending = json("wait", id, "--ask", "ask-storage", "--timeout", "5");
    setTimeout(() => store.update(id, (x) => void answerAsk(x.build!, "ask-storage", { optionId: "db" })), 60);
    expect(await pending).toMatchObject({ result: "answered", answer: "A small database", ask: { answerId: "db" } });

    await run("ask", id, "--key", "ask-sync", "--title", "Sync?", "--option", "y=Yes", "--option", "n=No");
    const gone = await run("withdraw", id, "--ask", "ask-sync", "--reason", "It is in the plan");
    expect(gone.out).toContain('"ask-sync" is withdrawn. It is not a decision');
    expect((await json("wait", id, "--ask", "ask-sync")).result).toBe("withdrawn");
    expect((await run("withdraw", id, "--ask", "ask-storage")).err).toContain("already answered: A small database");
    expect((await run("wait", id, "--ask", "nope")).err).toContain('There is no ask "nope"');
    expect(store.readPlanFile(id)).toContain("- Ask `ask-sync` withdrawn by the agent: “Sync?”");
    store.clearServerInfo(process.pid);
  });

  test("every reply says what changed since the agent last read the plan, until it reads it again", async () => {
    const store = tempStore();
    const id = withSteps(store);
    const { run, json, plan } = shell(store);
    const first = await plan("get", id);
    expect(first).toContain("## Build steps\n\n- [ ] 1. Store recipes");
    expect(getPlan(store, id).build).toMatchObject({ rev: 1, steps: [{ n: 1, key: "step-1", status: "todo" }, { n: 2 }, { n: 3 }] });
    expect((await json("next", id)).changed).toBeUndefined();
    // The user edits a step, reopens nothing, and adds a line to the plan text.
    store.update(id, (x) => {
      editStep(x.build!, 2, { title: "Search by ingredient" });
      x.build!.rev++;
    });
    store.writePlan(id, PLAN_MD.replace("No sync in v1.", "Sync through iCloud."));
    const r = await json("next", id);
    expect(r.changed).toMatchObject({ from: 1, to: 3, what: ['~ section "Sync" edited', '~ step 2 edited: "Search by ingredient"'] });
    const text = (await run("start", id)).out;
    expect(text).toContain(`The plan changed since you last read it (rev 1 -> 3):\n  ~ section "Sync" edited\n  ~ step 2 edited: "Search by ingredient"\nRun \`grillado plan get ${id}\` before the next step.\n`);
    await plan("get", id);
    expect((await json("next", id)).changed).toBeUndefined();
  });
});

// ---------------------------------------------------------------- MCP: the same results

async function connect(store: Store) {
  const [a, b] = InMemoryTransport.createLinkedPair();
  await createMcpServer(store, "0.0.0-dev").connect(a);
  const client = new Client({ name: "test-coder", version: "1.0.0" });
  await client.connect(b);
  return (name: string, args: Record<string, unknown> = {}) => client.callTool({ name, arguments: args }) as Promise<any>;
}

/** Times and ids differ between two runs; everything else must not. */
const same = (v: unknown, id: string) => JSON.parse(JSON.stringify(v).replaceAll(id, "PLAN").replace(/"(askedAt|endedAt|at)":"[^"]+"/g, '"$1":"T"'));

describe("the build_* tools match the shell commands", () => {
  test("the same steps give the same results over MCP and from a shell", async () => {
    const a = tempStore();
    const b = tempStore();
    const ida = withSteps(a);
    const idb = withSteps(b);
    running(a);
    running(b);
    const { json } = shell(a);
    const call = await connect(b);
    const both = async (cmd: string[], tool: string, args: Record<string, unknown>) => {
      const s = await json(...cmd.map((x) => (x === "ID" ? ida : x)));
      const m = await call(tool, { plan: idb, ...args });
      expect(m.isError).toBeFalsy();
      // The shell adds whether it opened a browser; over MCP nothing is opened.
      const { opened: _o, ...shellResult } = s;
      expect(same(m.structuredContent, idb), tool).toEqual(same(shellResult, ida));
      return m.structuredContent;
    };
    await both(["next", "ID"], "build_next", {});
    await both(["start", "ID", "--step", "2"], "build_start", { step: 2 });
    await both(["ask", "ID", "--key", "ask-storage", "--title", "Where?", "--body", "Not in the plan.", "--option", "file=A file", "--option", "db=A database", "--note", "db=Easier to query", "--suggest", "file"], "build_ask", {
      key: "ask-storage",
      title: "Where?",
      body: "Not in the plan.",
      options: [{ id: "file", label: "A file" }, { id: "db", label: "A database", description: "Easier to query" }],
      suggest: "file",
    });
    await both(["wait", "ID", "--ask", "ask-storage", "--timeout", "0"], "build_wait", { ask: "ask-storage", timeout: 0 });
    for (const [store, id] of [[a, ida], [b, idb]] as const) store.update(id, (x) => void answerAsk(x.build!, "ask-storage", { optionId: "db" }));
    const answered = await both(["wait", "ID", "--ask", "ask-storage", "--timeout", "1"], "build_wait", { ask: "ask-storage", timeout: 1 });
    expect(answered).toMatchObject({ result: "answered", answer: "A database" });
    await both(["done", "ID", "--verified", "search test passes", "--deviation", "No index yet"], "build_done", { verified: "search test passes", deviation: "No index yet" });
    await both(["ask", "ID", "--key", "ask-sync", "--title", "Sync?", "--option", "y=Yes", "--option", "n=No"], "build_ask", { key: "ask-sync", title: "Sync?", options: [{ id: "y", label: "Yes" }, { id: "n", label: "No" }] });
    await both(["withdraw", "ID", "--ask", "ask-sync", "--reason", "In the plan"], "build_withdraw", { ask: "ask-sync", reason: "In the plan" });
    await both(["next", "ID"], "build_next", {});
    expect(a.readPlanFile(ida)!.replace(/\n/g, "|")).toBe(b.readPlanFile(idb)!.replace(/\n/g, "|"));
    a.clearServerInfo(process.pid);
    b.clearServerInfo(process.pid);
  });

  test("tool errors are results the agent can read; with no app running an ask says how to start it", async () => {
    const store = tempStore();
    const id = withSteps(store);
    const call = await connect(store);
    const bad = await call("build_done", { plan: id, step: 9, verified: "x" });
    expect(bad.isError).toBe(true);
    expect(bad.content[0].text).toContain('There is no step "9"');
    expect((await call("build_next", { plan: draftSession(store).id })).content[0].text).toContain("still a draft");
    const asked = await call("build_ask", { plan: id, key: "ask-x", title: "X?", options: [{ id: "a", label: "A" }, { id: "b", label: "B" }] });
    expect(asked.structuredContent.url).toBeNull();
    expect(asked.content[0].text).toContain("web app isn't running");
    expect(asked.content[0].text).toContain("npx grillado");
  });
});

// ---------------------------------------------------------------- choosing the agent

describe("plan start --agent", () => {
  test("an agent that can read the project is used and kept; one that can't is refused with the ones that can", async () => {
    expect(agentFor(undefined)).toBeUndefined();
    expect(agentFor("claude")).toBe("claude");
    expect(() => agentFor("codex")).toThrow("Codex can’t read the project yet, so its questions and plan wouldn’t know the code. Agents that can: claude (Claude Code), grok (Grok).");
    expect(() => agentFor("gpt")).toThrow('Unknown agent "gpt". Agents that can read the project: claude (Claude Code), grok (Grok).');

    const store = tempStore();
    store.writeConfig({ defaultProvider: "codex" });
    running(store);
    const project = mkdtempSync(path.join(os.tmpdir(), "grillado-proj-"));
    const start = async (...extra: string[]) => {
      const c = io();
      const code = await runPlan(["start", "Save carts", "--json", ...extra], { version: "9", out: c.out, err: c.err, env: { GRILLADO_HOME: store.dir }, cwd: project, cliFile: "/nope", appLine: () => "npx grillado", open: () => {} });
      return { code, out: c.o.out, err: c.o.err };
    };
    const chosen = store.load(JSON.parse((await start("--agent", "grok")).out).id)!;
    expect(chosen).toMatchObject({ provider: "grok", agentPinned: true });
    const byDefault = store.load(JSON.parse((await start()).out).id)!;
    expect(byDefault.provider).toBe("codex");
    expect(byDefault.agentPinned).toBeUndefined();
    const refused = await start("--agent", "codex");
    expect(refused.code).toBe(1);
    expect(refused.err).toContain("Agents that can: claude (Claude Code), grok (Grok).");
    expect(refused.out).toBe("");
    store.clearServerInfo(process.pid);
  });
});

// ---------------------------------------------------------------- the server, end to end

const servers: GrilladoServer[] = [];
afterEach(async () => {
  while (servers.length) await servers.pop()!.close();
});

function request(port: number, token: string, method: string, p: string, body?: unknown) {
  return new Promise<any>((resolve, reject) => {
    const req = http.request({ host: "127.0.0.1", port, method, path: p, headers: { "x-grillado-token": token, "content-type": "application/json" } }, (res) => {
      let d = "";
      res.on("data", (c) => (d += c));
      res.on("end", () => resolve({ status: res.statusCode, json: d ? JSON.parse(d) : {} }));
    });
    req.on("error", reject);
    req.end(body === undefined ? undefined : JSON.stringify(body));
  });
}

async function waitFor<T>(fn: () => Promise<T | undefined>, ms = 10_000): Promise<T> {
  const end = Date.now() + ms;
  for (;;) {
    const v = await fn();
    if (v !== undefined) return v;
    if (Date.now() > end) throw new Error("timed out");
    await new Promise((r) => setTimeout(r, 40));
  }
}

/** A plan plated through the server with the fake agent: two rounds answered as suggested. */
async function plate(extra: Record<string, string> = {}) {
  const dir = mkdtempSync(path.join(os.tmpdir(), "grillado-buildsrv-"));
  const log = path.join(dir, "calls.jsonl");
  const web = mkdtempSync(path.join(os.tmpdir(), "grillado-web-"));
  writeFileSync(path.join(web, "index.html"), "<!doctype html><title>Grillado</title>");
  const env = fakeEnv(fakeBinDir(["claude"]), { FAKE_LOG: log, ...extra });
  const store = new Store(mkdtempSync(path.join(os.tmpdir(), "grillado-home-")));
  const project = mkdtempSync(path.join(os.tmpdir(), "grillado-proj-"));
  const server = new GrilladoServer({ adapters: createAdapters({ env }), store, webDir: web, port: 0, strictPort: true, launchDir: project });
  servers.push(server);
  await server.detect();
  await server.listen();
  const api = (method: string, p: string, body?: unknown) => request(server.port, server.token, method, p, body);
  const id = (await api("POST", "/api/sessions", { idea: "A shopping list" })).json.id as string;
  const get = async () => (await api("GET", `/api/sessions/${id}`)).json;
  const idle = (status: string) => waitFor(async () => { const s = await get(); return !s.busy && s.status === status ? s : undefined; });
  for (const round of [1, 2]) {
    const s = await idle("answering");
    await api("POST", `/api/sessions/${id}/answers`, { round, answers: s.rounds.at(-1).questions.map((q: any) => ({ questionId: q.key, optionId: q.recommendedOptionId, accepted_recommendation: true })) });
  }
  await idle("confirm");
  await api("POST", `/api/sessions/${id}/confirm`);
  await idle("plated");
  const calls = () => readFileSync(log, "utf8").trim().split("\n").map((l) => JSON.parse(l)).filter((c) => c.args[0] !== "--version");
  const act = (body: unknown) => api("POST", `/api/sessions/${id}/build`, body);
  return { api, act, get, id, store, calls, shell: shell(store) };
}

describe("server: the plan-to-build loop", () => {
  test("a plated plan has the agent's steps, in the session, the file and the view", async () => {
    const { get, id, store, calls } = await plate();
    const s = await get();
    expect(s.build.steps.map((x: any) => [x.key, x.title, x.status])).toEqual([
      ["step-1", "Build scope: Yes, one core flow", "todo"],
      ["step-2", "Build platform: Web app", "todo"],
      ["step-3", "Build storage: Local storage", "todo"],
    ]);
    expect(s.build.seen).toBeUndefined();
    expect(s.plan.markdown).not.toContain("Build steps");
    expect(store.readPlanFile(id)).toContain(`${BUILD_MARKER}\n\n## Build steps\n\n- [ ] 1. Build scope: Yes, one core flow\n`);
    // Rounds 1 and 2, then the plan: no repair pass was needed.
    expect(calls()).toHaveLength(3);
  });

  test("a plan with no steps gets the one repair pass; steps without a done check too", async () => {
    const a = await plate({ FAKE_STEPS: "none-once" });
    expect((await a.get()).build.steps).toHaveLength(3);
    expect(a.calls()).toHaveLength(4);
    const b = await plate({ FAKE_STEPS: "bare-once" });
    expect((await b.get()).build.steps.every((x: any) => x.done)).toBe(true);
    expect(b.calls()).toHaveLength(4);
    // Still none after the repair pass: the plan is kept, without steps.
    const c = await plate({ FAKE_STEPS: "none" });
    const s = await c.get();
    expect(s.status).toBe("plated");
    expect(s.build?.steps ?? []).toEqual([]);
    expect(c.store.readPlanFile(c.id)).not.toContain("Build steps");
  });

  test("the agent's reports reach the open plan; the user answers its ask and the answer is a cited decision", async () => {
    const { act, get, id, store, shell: sh } = await plate();
    await sh.run("start", id);
    const seen = await waitFor(async () => { const s = await get(); return s.build.steps[0].status === "started" ? s : undefined; });
    expect(seen.build.rev).toBe(1);
    running(store);
    await sh.run("ask", id, "--key", "ask-storage", "--title", "Where should the list be stored?", "--option", "file=A file on disk", "--option", "db=A small database");
    await waitFor(async () => ((await get()).build.asks.length ? true : undefined));
    const waiting = sh.json("wait", id, "--ask", "ask-storage", "--timeout", "5");
    expect((await act({ op: "answer", key: "ask-storage" })).json.error).toBe("Pick one of the options, or type your own answer.");
    const r = await act({ op: "answer", key: "ask-storage", optionId: "db" });
    expect(r.status).toBe(200);
    expect(r.json.build.asks[0]).toMatchObject({ state: "answered", answer: "A small database" });
    expect(r.json.build.rev).toBe(2);
    const line = "- Where should the list be stored? A small database. Decided during the build, at step 1. [B:ask-storage]";
    expect(r.json.plan.markdown).toContain(`- Local storage [R2:storage]\n${line}\n`);
    expect(store.readPlanFile(id)).toContain(line);
    expect(store.readPlanFile(id)).toContain("- Ask `ask-storage` answered: “A small database” [B:ask-storage]");
    // The waiting agent gets the answer, and is told the plan changed.
    const got = await waiting;
    expect(got).toMatchObject({ result: "answered", answer: "A small database", rev: 2 });
    // Answering twice, or an ask that isn't there, is refused.
    expect((await act({ op: "answer", key: "ask-storage", optionId: "file" })).json.error).toBe("That was already answered.");
    expect((await act({ op: "answer", key: "nope", optionId: "file" })).status).toBe(400);
    store.clearServerInfo(process.pid);
  });

  test("the user edits, moves, adds, removes and reopens steps; each moves the revision and the file", async () => {
    const { act, get, id, store, shell: sh } = await plate();
    await sh.run("done", id, "--step", "1", "--verified", "list test passes");
    await waitFor(async () => ((await get()).build.steps[0].status === "done" ? true : undefined));
    let s = (await act({ op: "reopen", step: "step-1" })).json;
    expect(s.build.steps[0].status).toBe("todo");
    expect(s.build.rev).toBe(2);
    s = (await act({ op: "edit", step: "step-2", title: "Build the web shell", done: "The shell loads in a browser" })).json;
    expect(s.build.steps[1]).toMatchObject({ title: "Build the web shell", done: "The shell loads in a browser" });
    s = (await act({ op: "move", step: "step-3", by: -1 })).json;
    expect(s.build.steps.map((x: any) => x.key)).toEqual(["step-1", "step-3", "step-2"]);
    s = (await act({ op: "add", title: "Share by link", done: "A second browser sees the list" })).json;
    expect(s.build.steps.at(-1)).toMatchObject({ key: "step-4", title: "Share by link", status: "todo" });
    s = (await act({ op: "remove", step: "step-2" })).json;
    expect(s.build.steps.map((x: any) => x.key)).toEqual(["step-1", "step-3", "step-4"]);
    expect(s.build.rev).toBe(6);
    expect((await act({ op: "edit", step: "step-1", title: " " })).json.error).toBe("A step needs a title.");
    expect((await act({ op: "bogus" })).status).toBe(400);
    expect(store.readPlanFile(id)).toContain("- [ ] 1. Build scope: Yes, one core flow\n  Done when: The scope choice works end to end and its test passes.\n- [ ] 2. Build storage: Local storage\n");
    expect(store.readPlanFile(id)).toContain("- Step 1 reopened by you.");
    // An edit to the plan text is a new revision too.
    const edited = (await get()).plan.markdown.replace("A shopping list", "A shared shopping list");
    const before = (await get()).build.rev;
    expect((await (await plateEdit({ get, id, act }, edited))).build.rev).toBe(before + 1);
  });
});

/** Save an edited plan text through the API (the editor's autosave). */
async function plateEdit(p: { get: () => Promise<any>; id: string; act: (b: unknown) => Promise<any> }, markdown: string) {
  const s = servers.at(-1)!;
  await request(s.port, s.token, "POST", `/api/sessions/${p.id}/plan`, { markdown });
  return p.get();
}

describe("server: the revision after a restart", () => {
  test("the first edit after the app starts again is a new revision too", async () => {
    const first = await plate();
    const { id, store } = first;
    const rev = (await first.get()).build.rev;
    await servers.pop()!.close();
    const web = mkdtempSync(path.join(os.tmpdir(), "grillado-web-"));
    writeFileSync(path.join(web, "index.html"), "<!doctype html><title>Grillado</title>");
    const server = new GrilladoServer({ adapters: createAdapters({ env: fakeEnv(fakeBinDir(["claude"])) }), store, webDir: web, port: 0, strictPort: true });
    servers.push(server);
    await server.detect();
    await server.listen();
    const api = (method: string, p: string, body?: unknown) => request(server.port, server.token, method, p, body);
    const s = (await api("GET", `/api/sessions/${id}`)).json;
    expect(s.build.rev).toBe(rev);
    await api("POST", `/api/sessions/${id}/plan`, { markdown: s.plan.markdown.replace("A shopping list", "A shared shopping list") });
    expect((await api("GET", `/api/sessions/${id}`)).json.build.rev).toBe(rev + 1);
  });
});
