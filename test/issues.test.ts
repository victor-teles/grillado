// "Send to issues" (v1.3 item 2), below the HTTP layer: items, the gh adapter against a fake gh, the
// Linear client against a mock server, the export run (dedupe, retry, re-export, lock, cut) and counters.
import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { Gh, GitHubTracker, atLeast, parseRemote, parseVersion } from "../src/cli/issues/gh.ts";
import { Linear, LinearTracker } from "../src/cli/issues/linear.ts";
import { linearView, readSecrets, writeSecrets } from "../src/cli/issues/secrets.ts";
import { said, saidAfter } from "../src/cli/issues/tracker.ts";
import { type ExportRun, countExport, runExport, takeExportLock } from "../src/cli/issues/service.ts";
import { Store } from "../src/cli/store.ts";
import { BODY_LIMIT, MAX_CHILDREN, PARENT_KEY, type IssueItem, type PlanIssues, buildItems, contentHash, fallbackSlices, fitBody, groupedSlices, groupsTodos, marker, parentItem, planChanges, readMarker } from "../src/core/issues.ts";
import { buildGroupPrompt, buildSplitPrompt } from "../src/core/engine.ts";
import { groupSystemPrompt } from "../src/core/prompts.ts";
import type { Session } from "../src/core/session.ts";
import { type LinearMock, STORY_MD, block, fakeGh, isWrite, linearMock, storySession, withBlocks } from "./issues-fixture.ts";

const tempStore = () => new Store(mkdtempSync(path.join(os.tmpdir(), "grillado-issues-")));

/** One export, saving links to the session like the server does. */
async function exportAll(s: Session, tracker: any, dest: PlanIssues["tracker"], target: string, extra: { overwrite?: string[]; newLabels?: string[]; labels?: string[]; keys?: string[] } = {}) {
  const md = s.plan!.markdown;
  const { items } = buildItems(s, md, dest, fallbackSlices(s, md).slices);
  const chosen = extra.keys ? items.filter((it) => extra.keys!.includes(it.key)) : items;
  const runs: ExportRun[] = [];
  const run = await runExport(
    s,
    { tracker, dest: { tracker: dest, target, labels: extra.labels ?? [] }, items: chosen, overwrite: extra.overwrite ?? [], newLabels: extra.newLabels ?? [] },
    { save: (i) => (s.issues = structuredClone(i)), progress: (r) => runs.push(structuredClone(r)) },
  );
  return { run, items, runs };
}

const status = (run: ExportRun) => Object.fromEntries(run.rows.map((r) => [r.key, r.status]));

describe("items", () => {
  test("the parent has Problem, Solution, Out of scope and the decisions; citations and decision fences are gone", () => {
    const s = storySession(tempStore());
    const p = parentItem(s, STORY_MD, "github");
    expect(p.key).toBe(PARENT_KEY);
    expect(p.title).toBe("Recipe box");
    expect(p.body).toContain("## Problem\nRecipes are scattered across notes and screenshots.");
    // BIG-1 option A: Problem, Solution, the decisions, Out of scope, in that order.
    expect(p.body.indexOf("## Solution")).toBeLessThan(p.body.indexOf("## Decisions"));
    expect(p.body.indexOf("## Decisions")).toBeLessThan(p.body.indexOf("## Out of scope"));
    expect(p.body).toContain("- **Where do recipes live?** SQLite on the device");
    expect(p.body).not.toContain("[R1");
    expect(p.body).not.toContain("```decision");
    expect(p.body).not.toContain("User stories");
    expect(readMarker(p.body)).toEqual({ plan: s.id, key: PARENT_KEY });
    expect(p.body).toContain(`\n\nFrom Grillado plan ‘Recipe box’\n<!-- grillado:plan=${s.id} item=plan -->\n`);
    expect(p.covers).toEqual(["storage", "sync"]);
  });

  test("with no agent split, each user story is a child, covering the decisions its line cites", () => {
    const s = storySession(tempStore());
    const { source, slices } = fallbackSlices(s, STORY_MD);
    expect(source).toBe("stories");
    expect(slices.map((x) => x.title)).toEqual(["As a cook, I add a recipe from a photo", "As a cook, I find a recipe by ingredient", "As a cook, I see my recipes on a second phone"]);
    expect(slices.map((x) => x.covers)).toEqual([["storage"], [], ["sync"]]);
    expect(new Set(slices.map((x) => x.key)).size).toBe(3);
    s.rounds = [{ n: 1, questions: [{ key: "storage" }] } as any, { n: 2, questions: [{ key: "other" }, { key: "sync" }] } as any];
    const { items } = buildItems(s, STORY_MD, "github", slices);
    expect(items[1].body).toStartWith("As a cook, I add a recipe from a photo");
    expect(items[1].body).toContain("\n\n**Covers:** Where do recipes live? SQLite on the device\n\nFrom Grillado plan");
    expect(items[3].body).toContain("**Covers:** Sync between devices? Not in v1");
    expect(readMarker(items[1].body)).toEqual({ plan: s.id, key: slices[0].key });
  });

  test("an imported plan's to-dos map 1:1", () => {
    const s = storySession(tempStore(), "# Tasks plan\n\n## Tasks\n\n- [ ] Add the schema\n- [x] Write the importer\n");
    s.source = { kind: "cursor-plan" } as any;
    const { source, slices } = fallbackSlices(s, s.plan!.markdown);
    expect(source).toBe("todos");
    expect(slices.map((x) => x.title)).toEqual(["Add the schema", "Write the importer"]);
  });

  describe("review r5: a plan with to-dos and no decisions groups its to-dos", () => {
    const todoPlan = () => {
      const s = storySession(tempStore(), "# Budget\n\n## Tasks\n\n- [ ] Import bank CSVs\n- [ ] Tag each expense\n- [ ] Show the totals\n");
      s.source = { kind: "cursor-plan" } as any;
      s.decisions = {};
      return { s, todos: fallbackSlices(s, s.plan!.markdown).slices };
    };
    const g = (key: string, todos: string[]) => ({ key, title: `Slice ${key}`, body: "Done when it works.", todos });

    test("only when there are to-dos and no decisions (plans with decisions keep the split)", () => {
      const { s } = todoPlan();
      expect(groupsTodos(s, fallbackSlices(s, s.plan!.markdown))).toBe(true);
      const withDecisions = storySession(tempStore(), s.plan!.markdown);
      withDecisions.source = { kind: "cursor-plan" } as any;
      expect(groupsTodos(withDecisions, fallbackSlices(withDecisions, s.plan!.markdown))).toBe(false);
      const stories = storySession(tempStore());
      stories.decisions = {};
      expect(groupsTodos(stories, fallbackSlices(stories, STORY_MD))).toBe(false);
    });

    test("the prompt: its own method, the to-dos by id, each in exactly one slice", () => {
      const { s, todos } = todoPlan();
      const p = buildGroupPrompt(s.plan!.markdown, todos);
      expect(p).toContain('<todos>[{"id":"t1","text":"Import bank CSVs"},{"id":"t2","text":"Tag each expense"},{"id":"t3","text":"Show the totals"}]</todos>');
      expect(p).not.toContain("<state>");
      expect(groupSystemPrompt()).toContain("Every to-do goes into exactly one slice");
      expect(groupSystemPrompt()).toContain('"type":"groups"');
    });

    test("the split prompt: plans with decisions are unchanged", () => {
      const withDecisions = storySession(tempStore());
      const p = buildSplitPrompt(withDecisions, STORY_MD, []);
      expect(p.endsWith("Split the plan into thin end-to-end slices.")).toBe(true);
      expect(p).not.toContain("no decisions");
    });

    test("review r6: no decisions, a story plan: the split asks to group its user stories", () => {
      const s = storySession(tempStore());
      s.decisions = {};
      expect(buildSplitPrompt(s, STORY_MD, [])).toEndWith(
        "\nThis plan has no decisions. Group its user stories into a few thin end-to-end slices, each one something a person can ship on its own, and leave covers empty. If they’re already that small, reply with no slices.",
      );
    });

    test("review r6: no decisions, a parent-only plan: the split asks to split it", () => {
      const md = "# Chore wheel\n\nWho does the dishes is a weekly argument.\n";
      const s = storySession(tempStore(), md);
      s.decisions = {};
      expect(buildSplitPrompt(s, md, [])).toEndWith(
        "\nThis plan has no decisions. Split it into a few thin end-to-end slices, each one something a person can ship on its own, and leave covers empty.",
      );
      expect(buildSplitPrompt(s, md, [])).not.toContain("to-dos");
    });

    test("valid: every to-do in exactly one slice; the slice lists its to-dos", () => {
      const { todos } = todoPlan();
      const r = groupedSlices(todos, [g("a", ["t1", "t2"]), g("b", ["t3"])]);
      expect(r.ok).toBe(true);
      if (!r.ok) return;
      expect(r.slices.map((x) => x.title)).toEqual(["Slice a", "Slice b"]);
      expect(r.slices[0].body).toBe("Done when it works.\n- [ ] Import bank CSVs\n- [ ] Tag each expense");
      expect(r.slices[1].sections).toEqual(["Tasks"]);
    });

    test("missing, duplicate or invented to-dos are rejected", () => {
      const { todos } = todoPlan();
      expect(groupedSlices(todos, [g("a", ["t1", "t2"])])).toEqual({ ok: false, reason: expect.stringContaining("To-dos in no slice: t3") });
      expect(groupedSlices(todos, [g("a", ["t1", "t2"]), g("b", ["t2", "t3"])])).toEqual({ ok: false, reason: expect.stringContaining("more than one slice: t2") });
      expect(groupedSlices(todos, [g("a", ["t1", "t2"]), g("b", ["t3", "t9"])])).toEqual({ ok: false, reason: expect.stringContaining("Unknown to-do ids: t9") });
      expect(groupedSlices(todos, [g("a", ["t1", "t2", "t3"]), g("b", [])]).ok).toBe(false);
    });

    test("empty: no slices is valid, and leaves the to-dos as they are", () => {
      const { todos } = todoPlan();
      expect(groupedSlices(todos, [])).toEqual({ ok: true, slices: [] });
    });
  });

  test("a plan with no stories is the parent alone", () => {
    const s = storySession(tempStore(), "# Small\n\n## Solution\n\nJust do it.\n");
    expect(fallbackSlices(s, s.plan!.markdown)).toEqual({ source: "none", slices: [] });
  });

  test("past GitHub's 100 sub-issues the rest are dropped and counted; Linear takes 250", () => {
    const s = storySession(tempStore());
    const many = Array.from({ length: 120 }, (_, i) => ({ key: `k${i}`, title: `Slice ${i}`, body: "x", covers: [], sections: [] }));
    expect(buildItems(s, STORY_MD, "github", many)).toMatchObject({ dropped: 20 });
    expect(buildItems(s, STORY_MD, "github", many).items.length).toBe(MAX_CHILDREN.github + 1);
    expect(buildItems(s, STORY_MD, "linear", many).dropped).toBe(0);
  });

  test("the 65,536-character cut: at a line, with a pointer back, the marker kept", () => {
    const end = `\n\n${marker("p1", "k")}\n`;
    const text = Array.from({ length: 5000 }, (_, i) => `Line ${i} of a very long plan section.`).join("\n");
    const { body, cut } = fitBody(text, end, BODY_LIMIT.github, "the parent issue “Recipe box”", "GitHub");
    expect(cut).toBe(true);
    expect(body.length).toBeLessThanOrEqual(65_536);
    expect(body).toContain("_Cut to fit GitHub. The rest is in the parent issue “Recipe box”._");
    expect(body.endsWith(end)).toBe(true);
    expect(body.split("\n…")[0].trimEnd()).toMatch(/plan section\.$/);
    // A cut never splits an emoji.
    const emoji = fitBody("😀".repeat(40_000), end, BODY_LIMIT.github, "x", "GitHub").body;
    expect(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/.test(emoji)).toBe(false);
  });

  test("planChanges: new, unchanged, update, edited, missing, removed", () => {
    const s = storySession(tempStore());
    const { items } = buildItems(s, STORY_MD, "github", fallbackSlices(s, STORY_MD).slices);
    const [p, a, b, c] = items;
    const link = (it: typeof p, hash = contentHash(it.title, it.body)) => ({ id: "1", number: 1, url: "u", contentHash: hash });
    const issues: PlanIssues = { tracker: "github", target: "o/r", labels: [], parent: link(p), items: { [a.key]: link(a, "old"), [b.key]: link(b, "old"), [c.key]: link(c), gone: link(c) }, exportedAt: "" };
    const plan = planChanges(items, issues, { [a.key]: "old", [b.key]: "someone-else", [c.key]: null });
    const by = Object.fromEntries(plan.map((x: any) => [x.key, x.change]));
    expect(by).toEqual({ [p.key]: "unchanged", [a.key]: "update", [b.key]: "edited", [c.key]: "missing", gone: "removed" });
  });

  // review-pr28 must 3: issues sent before #28 had "**Covers:** R1·1 question answer". Losing the codes alone isn't a change.
  test("planChanges: an issue sent with the old R·n Covers line is unchanged, until something real changes", () => {
    const s = storySession(tempStore());
    s.rounds = [{ n: 1, questions: [{ key: "storage" }] } as any, { n: 2, questions: [{ key: "other" }, { key: "sync" }] } as any];
    const { items } = buildItems(s, STORY_MD, "github", fallbackSlices(s, STORY_MD).slices);
    const [p, a, b, c] = items;
    // The bodies exactly as 2b745d9 (main before #28) sent them.
    const oldA = a.body.replace("**Covers:** Where do recipes live?", "**Covers:** R1·1 Where do recipes live?");
    const oldC = c.body.replace("**Covers:** Sync between devices?", "**Covers:** R2·2 Sync between devices?");
    expect(oldA).not.toBe(a.body);
    expect(oldC).not.toBe(c.body);
    expect(b.legacyBody).toBeUndefined(); // covers nothing: one format only
    const link = (hash: string) => ({ id: "1", number: 1, url: "u", contentHash: hash });
    const issues: PlanIssues = { tracker: "github", target: "o/r", labels: [], parent: link(contentHash(p.title, p.body)), items: { [a.key]: link(contentHash(a.title, oldA)), [b.key]: link(contentHash(b.title, b.body)), [c.key]: link(contentHash(c.title, oldC)) }, exportedAt: "" };
    const by = (xs: ReturnType<typeof planChanges>) => Object.fromEntries(xs.map((x) => [x.key, x.change]));
    expect(by(planChanges(items, issues, { [a.key]: contentHash(a.title, oldA), [c.key]: contentHash(c.title, oldC) }))).toEqual({ [p.key]: "unchanged", [a.key]: "unchanged", [b.key]: "unchanged", [c.key]: "unchanged" });
    // A real change still reads as one: the answer moved on since that export.
    s.decisions.storage = { ...s.decisions.storage, answer: "Postgres on a server" };
    const moved = buildItems(s, STORY_MD, "github", fallbackSlices(s, STORY_MD).slices).items;
    expect(by(planChanges(moved, issues))[a.key]).toBe("update");
  });

  describe("dogfood friction 18: the plan's decision blocks are the source, not the session's answers", () => {
    const STORAGE = block("R1·1", "storage", "Where do recipes live?", "SQLite, with a weekly export");
    const CAP = block("R1·2", "cap", "Round cap?", "3 rounds", "Overridden by the PO: default 2 rounds");
    const OVR = "Overridden by the PO: SQLite, with a weekly export to a file";
    const STORAGE_OVR = block("R1·1", "storage", "Where do recipes live?", "SQLite on the device", OVR);
    const withCap = (s: Session) => (s.decisions.cap = { key: "cap", round: 1, title: "Round cap?", answer: "3 rounds", kind: "option", accepted_recommendation: true, dependsOn: [] });
    const by = (xs: ReturnType<typeof planChanges>) => Object.fromEntries(xs.map((x) => [x.key, x.change]));
    const link = (hash: string) => ({ id: "1", number: 1, url: "u", contentHash: hash });

    test("a block's answer wins in the parent, the children's Covers and the split prompt; with no block, the session's", () => {
      const md = withBlocks(STORY_MD, STORAGE);
      const s = storySession(tempStore(), md);
      const [p, a] = buildItems(s, md, "github", fallbackSlices(s, md).slices).items;
      expect(p.body).toContain("- **Where do recipes live?** SQLite, with a weekly export\n");
      expect(p.body).toContain("- **Sync between devices?** Not in v1\n"); // no block: the session's answer
      expect(p.body).not.toContain("SQLite on the device");
      expect(a.body).toContain("**Covers:** Where do recipes live? SQLite, with a weekly export");
      const prompt = buildSplitPrompt(s, md, []);
      expect(prompt).toContain(`{"key":"storage","question":"Where do recipes live?","answer":"SQLite, with a weekly export"}`);
      expect(prompt).not.toContain("SQLite on the device");
    });

    test("an override is the decision: its note is the answer in the parent, the Covers line and the split prompt; other notes follow their answer (review-pr29 must 1)", () => {
      const md = withBlocks(STORY_MD, CAP, STORAGE_OVR, block("R2·1", "sync", "Sync between devices?", "Not in v1", "Decided: Not in v1."));
      const s = storySession(tempStore(), md);
      withCap(s);
      const [p, a] = buildItems(s, md, "github", fallbackSlices(s, md).slices).items;
      expect(p.body).toContain("- **Round cap?** Overridden by the PO: default 2 rounds\n");
      expect(p.body).toContain(`- **Where do recipes live?** ${OVR}\n`);
      expect(p.body).not.toContain("3 rounds");
      expect(p.body).not.toContain("SQLite on the device");
      // A note that only says the answer again isn't repeated (the plan page's rule, noteAdds); an override has no note line.
      expect(p.body).toContain("- **Sync between devices?** Not in v1\n");
      expect(p.body).not.toContain("_Note:_");
      expect(a.body).toContain(`**Covers:** Where do recipes live? ${OVR}`);
      const prompt = buildSplitPrompt(s, md, []);
      expect(prompt).toContain(`{"key":"cap","question":"Round cap?","answer":"Overridden by the PO: default 2 rounds"}`);
      expect(prompt.slice(prompt.indexOf("<state>"))).not.toContain("3 rounds"); // the plan itself is in the prompt, for the record
    });

    test("a note that says more, and isn't an override, follows its answer on its own line", () => {
      const md = withBlocks(STORY_MD, block("R1·1", "storage", "Where do recipes live?", "SQLite on the device", "A weekly export to a file covers backups."));
      const s = storySession(tempStore(), md);
      const p = parentItem(s, md, "github");
      expect(p.body).toContain("- **Where do recipes live?** SQLite on the device\n  _Note:_ A weekly export to a file covers backups.\n");
    });

    test("hash stability: blocks that say what the session says, with no notes, export byte for byte what the session alone did", () => {
      const s = storySession(tempStore());
      const before = buildItems(s, STORY_MD, "github", fallbackSlices(s, STORY_MD).slices).items;
      const md = withBlocks(STORY_MD, block("R1·1", "storage", "Where do recipes live?", "SQLite on the device"), block("R2·1", "sync", "Sync between devices?", "Not in v1", "Decided: Not in v1."));
      const after = buildItems(s, md, "github", fallbackSlices(s, md).slices).items;
      expect(after.map((it) => contentHash(it.title, it.body))).toEqual(before.map((it) => contentHash(it.title, it.body)));
      expect(after.map((it) => it.body)).toEqual(before.map((it) => it.body));
      expect(after[0].legacyBody).toBeUndefined();
      // Sent from the session alone, read against the plan: all unchanged.
      const issues: PlanIssues = { tracker: "github", target: "o/r", labels: [], parent: link(contentHash(before[0].title, before[0].body)), items: Object.fromEntries(before.slice(1).map((it) => [it.key, link(contentHash(it.title, it.body))])), exportedAt: "" };
      expect(Object.values(by(planChanges(after, issues)))).toEqual(["unchanged", "unchanged", "unchanged", "unchanged"]);
    });

    test("issues sent before #29 that cover an override read update, the rest unchanged (#28's R·n Covers too); a plain note edit after a #29 export reads update", () => {
      const s = storySession(tempStore());
      withCap(s);
      s.rounds = [{ n: 1, questions: [{ key: "storage" }, { key: "cap" }] } as any, { n: 2, questions: [{ key: "other" }, { key: "sync" }] } as any];
      // What main sent: the session's answers, whatever the plan's blocks said.
      const sentByMain = buildItems(s, STORY_MD, "github", fallbackSlices(s, STORY_MD).slices).items;
      const hashes = (pick: (it: IssueItem) => string) => {
        const [p, ...cs] = sentByMain;
        return { tracker: "github", target: "o/r", labels: [], parent: link(contentHash(p.title, pick(p))), items: Object.fromEntries(cs.map((it) => [it.key, link(contentHash(it.title, pick(it)))])), exportedAt: "" } as PlanIssues;
      };
      const main = hashes((it) => it.body);
      const pr28 = hashes((it) => it.legacyBody ?? it.body); // #28's old "R1·1 title answer" Covers
      expect(Object.values(pr28.items).map((l) => l.contentHash)).not.toEqual(Object.values(main.items).map((l) => l.contentHash));

      const md = withBlocks(STORY_MD, CAP, STORAGE_OVR);
      s.plan!.markdown = md;
      const items = buildItems(s, md, "github", fallbackSlices(s, md).slices).items;
      const [p, a, b, c] = items;
      expect(a.covers).toContain("storage");
      expect([b, c].some((it) => it.covers.includes("storage"))).toBe(false);
      for (const sent of [main, pr28]) expect(by(planChanges(items, sent))).toEqual({ [p.key]: "update", [a.key]: "update", [b.key]: "unchanged", [c.key]: "unchanged" });

      // No override in the plan: what main sent reads unchanged, and a parent renamed in the sheet still matches.
      const plain = withBlocks(STORY_MD, block("R1·1", "storage", "Where do recipes live?", "SQLite on the device", "A weekly export to a file covers backups."));
      const kept = buildItems(s, plain, "github", fallbackSlices(s, plain).slices).items;
      expect(kept[0].legacyBody).toBe(sentByMain[0].body);
      expect(Object.values(by(planChanges(kept, main)))).toEqual(["unchanged", "unchanged", "unchanged", "unchanged"]);
      expect(by(planChanges([{ ...kept[0], title: "Renamed" }], { ...main, parent: link(contentHash("Renamed", sentByMain[0].body)) }))[kept[0].key]).toBe("unchanged");

      // Sent with #29, then the plain note or an override is edited: update.
      const sent29: PlanIssues = { ...main, parent: link(contentHash(kept[0].title, kept[0].body)) };
      const md2 = plain.replace("covers backups", "covers backups and moving phones");
      expect(by(planChanges(buildItems(s, md2, "github", fallbackSlices(s, md2).slices).items, sent29))[kept[0].key]).toBe("update");
      const sentO: PlanIssues = { ...main, parent: link(contentHash(p.title, p.body)), items: { ...main.items, [a.key]: link(contentHash(a.title, a.body)) } };
      const md3 = md.replace("default 2 rounds", "default 2 rounds, 1 more on request");
      expect(by(planChanges(buildItems(s, md3, "github", fallbackSlices(s, md3).slices).items, sentO))[p.key]).toBe("update");
      expect(by(planChanges(items, sentO))).toEqual({ [p.key]: "unchanged", [a.key]: "unchanged", [b.key]: "unchanged", [c.key]: "unchanged" });
    });
  });

  test("gh versions and remotes", () => {
    expect(parseVersion("gh version 2.94.0 (2026-01-01)")).toEqual([2, 94, 0]);
    expect(atLeast([2, 94, 0], [2, 94, 0])).toBe(true);
    expect(atLeast([2, 93, 9], [2, 94, 0])).toBe(false);
    expect(atLeast([3, 0, 0], [2, 94, 0])).toBe(true);
    expect(parseRemote("git@github.com:victor-teles/grillado.git")).toEqual({ host: "github.com", repo: "victor-teles/grillado" });
    expect(parseRemote("https://ghe.acme.com/team/app")).toEqual({ host: "ghe.acme.com", repo: "team/app" });
    expect(parseRemote("ssh://git@github.com/o/r.git")).toEqual({ host: "github.com", repo: "o/r" });
    expect(parseRemote("not a remote")).toBeNull();
  });
});

describe("gh adapter (fake gh)", () => {
  const tracker = (gh: ReturnType<typeof fakeGh>, mode: "flag" | "api") => new GitHubTracker(new Gh({ bin: gh.bin, env: gh.env }), "victor-teles/grillado", "github.com", mode);

  test("status: missing, logged out (with the exact command), old version falls back to the API", async () => {
    expect(await new Gh({ bin: "/nonexistent/gh" }).status()).toEqual({ state: "missing" });
    const gh = fakeGh({ FAKE_GH_AUTH: "out" });
    expect(await new Gh({ bin: gh.bin, env: gh.env }).status()).toMatchObject({ state: "auth", command: "gh auth login" });
    expect(await new Gh({ bin: gh.bin, env: gh.env }).status("ghe.acme.com")).toMatchObject({ state: "auth", command: "gh auth login --hostname ghe.acme.com" });
    gh.set({ FAKE_GH_AUTH: undefined, FAKE_GH_VERSION: "2.80.0" });
    expect(await new Gh({ bin: gh.bin, env: gh.env }).status()).toMatchObject({ state: "ready", subIssues: "api", user: "fake-user" });
    gh.set({ FAKE_GH_VERSION: "2.94.0" });
    expect(await new Gh({ bin: gh.bin, env: gh.env }).status()).toMatchObject({ state: "ready", subIssues: "flag" });
    expect(gh.calls().every((c) => !isWrite(c.args))).toBe(true);
  });

  test("repo access, visibility and lists are reads", async () => {
    const gh = fakeGh({ FAKE_GH_PERM: "READ", FAKE_GH_VISIBILITY: "PUBLIC" });
    const g = new Gh({ bin: gh.bin, env: gh.env });
    expect(await g.repo("victor-teles/grillado")).toMatchObject({ visibility: "public", access: false });
    expect(await g.repo("victor-teles/missing")).toMatchObject({ access: false });
    expect(await g.repos("ghe.acme.com")).toContain("victor-teles/grillado");
    expect(gh.calls().find((c) => c.args[1] === "list")?.env).toEqual({ GH_HOST: "ghe.acme.com" });
    expect((await g.labels("victor-teles/grillado")).map((l) => l.name)).toEqual(["bug"]);
    expect(gh.calls().every((c) => !isWrite(c.args))).toBe(true);
  });

  test("gh >= 2.94: children are created with --parent; bodies go through a file, not the argv", async () => {
    const gh = fakeGh();
    const s = storySession(tempStore());
    const { run } = await exportAll(s, tracker(gh, "flag"), "github", "victor-teles/grillado");
    expect(run.rows.map((r) => r.status)).toEqual(["created", "created", "created", "created"]);
    const creates = gh.calls().filter((c) => c.args[0] === "issue" && c.args[1] === "create");
    expect(creates.length).toBe(4);
    expect(creates[0].args).not.toContain("--parent");
    for (const c of creates.slice(1)) expect(c.args[c.args.indexOf("--parent") + 1]).toBe("1");
    for (const c of creates) expect(c.args.join(" ")).not.toContain("grillado:plan=");
    expect(gh.calls().some((c) => c.args.some((a) => a.includes("sub_issues")))).toBe(false);
    expect(gh.state().issues.map((x) => x.parent)).toEqual([null, 1, 1, 1]);
    expect(s.issues).toMatchObject({ tracker: "github", target: "victor-teles/grillado", parent: { number: 1, url: "https://github.com/victor-teles/grillado/issues/1" } });
    expect(Object.keys(s.issues!.items).length).toBe(3);
  });

  test("gh < 2.94: create, then POST …/sub_issues with the integer id", async () => {
    const gh = fakeGh({ FAKE_GH_VERSION: "2.80.0" });
    const s = storySession(tempStore());
    const { run } = await exportAll(s, tracker(gh, "api"), "github", "victor-teles/grillado");
    expect(run.rows.every((r) => r.status === "created")).toBe(true);
    const creates = gh.calls().filter((c) => c.args[0] === "issue" && c.args[1] === "create");
    for (const c of creates) expect(c.args).not.toContain("--parent");
    const attaches = gh.calls().filter((c) => c.args.some((a) => a.includes("sub_issues")));
    expect(attaches.map((c) => c.args.slice(1))).toEqual([2, 3, 4].map((n) => ["-X", "POST", "repos/victor-teles/grillado/issues/1/sub_issues", "-F", `sub_issue_id=${9000 + n}`]));
    expect(gh.state().issues.map((x) => x.parent)).toEqual([null, 1, 1, 1]);
  });

  test("partial failure, then Retry failed: only the failed one is created, no duplicates", async () => {
    const gh = fakeGh({ FAKE_GH_FAIL_CREATE: "3" });
    const s = storySession(tempStore());
    const first = await exportAll(s, tracker(gh, "flag"), "github", "victor-teles/grillado");
    const keys = first.items.map((it) => it.key);
    expect(first.run.rows.map((r) => r.status)).toEqual(["created", "created", "failed", "created"]);
    expect(first.run.rows[2].message).toContain("HTTP 502");
    expect(Object.keys(s.issues!.failed!)).toEqual([keys[2]]);
    const retry = await exportAll(s, tracker(gh, "flag"), "github", "victor-teles/grillado", { keys: [PARENT_KEY, keys[2]] });
    expect(status(retry.run)).toEqual({ [PARENT_KEY]: "unchanged", [keys[2]]: "created" });
    expect(s.issues!.failed).toEqual({});
    expect(gh.state().issues.length).toBe(4);
    expect(new Set(gh.state().issues.map((x) => readMarker(x.body)!.key)).size).toBe(4);
  });

  test("an export over issues sent with the old R·n Covers line leaves them as sent (review-pr28 must 3)", async () => {
    const gh = fakeGh({});
    const s = storySession(tempStore());
    s.rounds = [{ n: 1, questions: [{ key: "storage" }] } as any, { n: 2, questions: [{ key: "other" }, { key: "sync" }] } as any];
    const first = await exportAll(s, tracker(gh, "flag"), "github", "victor-teles/grillado");
    const a = first.items[1];
    // As if a build before #28 had sent it: the link holds the hash of the body with the code.
    s.issues!.items[a.key].contentHash = contentHash(a.title, a.body.replace("**Covers:** Where do recipes live?", "**Covers:** R1·1 Where do recipes live?"));
    const before = gh.calls().length;
    const again = await exportAll(s, tracker(gh, "flag"), "github", "victor-teles/grillado");
    expect(Object.values(status(again.run))).toEqual(["unchanged", "unchanged", "unchanged", "unchanged"]);
    expect(gh.calls().slice(before).every((c) => !isWrite(c.args))).toBe(true);
  });

  test("the parent failing skips every child", async () => {
    const gh = fakeGh({ FAKE_GH_FAIL_CREATE: "1" });
    const s = storySession(tempStore());
    const { run } = await exportAll(s, tracker(gh, "flag"), "github", "victor-teles/grillado");
    expect(run.rows.map((r) => r.status)).toEqual(["failed", "skipped", "skipped", "skipped"]);
    expect(gh.state().issues.length).toBe(0);
  });

  test("a create whose attach fails stays linked and is attached on retry, not created again", async () => {
    const gh = fakeGh({ FAKE_GH_VERSION: "2.80.0", FAKE_GH_FAIL_ATTACH: "2" });
    const s = storySession(tempStore());
    const first = await exportAll(s, tracker(gh, "api"), "github", "victor-teles/grillado");
    const k = first.items[1].key;
    expect(first.run.rows[1]).toMatchObject({ status: "failed" });
    expect(first.run.rows[1].message).toContain("Created, but couldn’t make it a sub-issue: ");
    expect(s.issues!.items[k]).toMatchObject({ number: 2, unattached: true });
    const retry = await exportAll(s, tracker(gh, "api"), "github", "victor-teles/grillado", { keys: [PARENT_KEY, k] });
    expect(status(retry.run)[k]).toBe("unchanged");
    expect(s.issues!.items[k].unattached).toBeUndefined();
    expect(gh.state().issues.length).toBe(4);
    expect(gh.state().issues[1].parent).toBe(1);
  });

  test("re-export: unchanged items are skipped, a changed plan updates in place, nothing is duplicated", async () => {
    const gh = fakeGh();
    const store = tempStore();
    const s = storySession(store);
    await exportAll(s, tracker(gh, "flag"), "github", "victor-teles/grillado");
    const again = await exportAll(s, tracker(gh, "flag"), "github", "victor-teles/grillado");
    expect(again.run.rows.every((r) => r.status === "unchanged")).toBe(true);
    s.plan!.markdown = STORY_MD.replace("One app that keeps them on the device.", "One app that keeps them on the device, offline.");
    const changed = await exportAll(s, tracker(gh, "flag"), "github", "victor-teles/grillado");
    expect(changed.run.rows.map((r) => r.status)).toEqual(["updated", "unchanged", "unchanged", "unchanged"]);
    expect(gh.state().issues.length).toBe(4);
    expect(gh.state().issues[0].body).toContain("offline");
    expect(gh.calls().filter((c) => c.args[1] === "edit").length).toBe(1);
  });

  test("lost local links: the hidden marker finds the issues, so nothing is created twice", async () => {
    const gh = fakeGh();
    const s = storySession(tempStore());
    await exportAll(s, tracker(gh, "flag"), "github", "victor-teles/grillado");
    s.issues = undefined;
    const again = await exportAll(s, tracker(gh, "flag"), "github", "victor-teles/grillado");
    expect(again.run.rows.every((r) => r.status === "unchanged")).toBe(true);
    expect(gh.state().issues.length).toBe(4);
    expect(s.issues!.parent!.number).toBe(1);
    const search = gh.calls().find((c) => c.args[1] === "list")!.args;
    expect(search[search.indexOf("--search") + 1]).toBe(`"grillado:plan=${s.id}" in:body`);
    expect(search).toContain("all");
  });

  test("edited in the tracker: skipped unless overwrite is chosen (#182)", async () => {
    const gh = fakeGh();
    const s = storySession(tempStore());
    const first = await exportAll(s, tracker(gh, "flag"), "github", "victor-teles/grillado");
    const k = first.items[1].key;
    gh.edit((st) => (st.issues[1].body = `${st.issues[1].body}\n\nA note from the team.`));
    s.plan!.markdown = STORY_MD.replace("I add a recipe from a photo", "I add a recipe from a photo or a link");
    const skip = await exportAll(s, tracker(gh, "flag"), "github", "victor-teles/grillado");
    // The story's key is stable (its first words), so the plan change meets the team's edit: left as is.
    expect(status(skip.run)[k]).toBe("edited");
    expect(skip.run.rows.find((r) => r.key === k)!.message).toBe("Changed in GitHub after the export, so it’s left as is.");
    expect(gh.state().issues[1].body).not.toContain("or a link");
    gh.edit((st) => (st.issues[0].title = "Recipe box (team edit)"));
    s.plan!.markdown = STORY_MD.replace("One app", "One small app");
    const edited = await exportAll(s, tracker(gh, "flag"), "github", "victor-teles/grillado");
    expect(status(edited.run)[PARENT_KEY]).toBe("edited");
    expect(gh.state().issues[0].title).toBe("Recipe box (team edit)");
    const over = await exportAll(s, tracker(gh, "flag"), "github", "victor-teles/grillado", { overwrite: [PARENT_KEY] });
    expect(status(over.run)[PARENT_KEY]).toBe("updated");
    expect(gh.state().issues[0].title).toBe("Recipe box");
    expect(gh.state().issues[1].body).toContain("A note from the team.");
  });

  test("a deleted parent is recreated; the children that exist are re-attached, not made again (#176)", async () => {
    const gh = fakeGh();
    const s = storySession(tempStore());
    await exportAll(s, tracker(gh, "flag"), "github", "victor-teles/grillado");
    gh.edit((st) => (st.issues[0].deleted = true));
    const { run } = await exportAll(s, tracker(gh, "flag"), "github", "victor-teles/grillado");
    expect(run.rows.map((r) => r.status)).toEqual(["created", "unchanged", "unchanged", "unchanged"]);
    const st = gh.state();
    expect(st.issues.length).toBe(5);
    expect(s.issues!.parent!.number).toBe(5);
    expect(st.issues.slice(1, 4).map((x) => x.parent)).toEqual([5, 5, 5]);
  });

  test("new labels are created once, before the issues", async () => {
    const gh = fakeGh();
    const s = storySession(tempStore());
    await exportAll(s, tracker(gh, "flag"), "github", "victor-teles/grillado", { labels: ["grillado", "bug"], newLabels: ["grillado"] });
    const order = gh.calls().map((c) => `${c.args[0]} ${c.args[1]}`);
    expect(order.indexOf("label create")).toBeLessThan(order.indexOf("issue create"));
    expect(gh.state().issues.every((x) => x.labels.join() === "grillado,bug")).toBe(true);
  });

  test("a rate limit fails the rows with GitHub's reason", async () => {
    const gh = fakeGh({ FAKE_GH_RATE: "1" });
    const s = storySession(tempStore());
    const { run } = await exportAll(s, tracker(gh, "flag"), "github", "victor-teles/grillado");
    expect(run.rows[0]).toMatchObject({ status: "failed" });
    expect(run.rows[0].message).toContain("rate limit");
  });

  test("switching destination starts fresh links", async () => {
    const gh = fakeGh();
    const s = storySession(tempStore());
    await exportAll(s, tracker(gh, "flag"), "github", "victor-teles/grillado");
    const other = new GitHubTracker(new Gh({ bin: gh.bin, env: gh.env }), "victor-teles/other", "github.com", "flag");
    await exportAll(s, other, "github", "victor-teles/other");
    expect(s.issues!.target).toBe("victor-teles/other");
  });
});

describe("the tracker's words (review r2)", () => {
  test("its first line, without the gh/error prefix; nothing said reads as no reason, never an empty colon", () => {
    expect(said("gh: Not Found (HTTP 404)\nmore")).toBe("Not Found (HTTP 404)");
    expect(said("  \n ")).toBe("No reason given.");
    expect(saidAfter("Couldn’t connect", "fetch failed")).toBe("Couldn’t connect: fetch failed");
    expect(saidAfter("Couldn’t connect", "")).toBe("Couldn’t connect.");
    expect(saidAfter("Created, but couldn’t make it a sub-issue", undefined)).toBe("Created, but couldn’t make it a sub-issue.");
  });
});

describe("the lock", () => {
  test("one export per plan; a dead process's lock is taken over", () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "grillado-lock-"));
    const release = takeExportLock(dir);
    expect(() => takeExportLock(dir)).toThrow("already being created");
    release();
    expect(existsSync(path.join(dir, "issues.lock"))).toBe(false);
    writeFileSync(path.join(dir, "issues.lock"), "999999");
    const again = takeExportLock(dir);
    expect(readFileSync(path.join(dir, "issues.lock"), "utf8")).toBe(String(process.pid));
    again();
  });
});

describe("Linear (mock server)", () => {
  let mock: LinearMock;
  afterEach(async () => mock && (await mock.close()));
  const api = (key = "lin_api_good") => new Linear(key, { url: mock.url, retryMs: 5 });

  test("the key is sent as is, with no Bearer prefix", async () => {
    mock = await linearMock();
    expect(await api().viewer()).toEqual({ id: "u1", name: "Victor" });
    expect(mock.requests[0].auth).toBe("lin_api_good");
  });

  test("a bad key is bad_key", async () => {
    mock = await linearMock();
    expect(api("lin_api_nope").viewer()).rejects.toMatchObject({ code: "bad_key", message: "That key didn’t work." });
  });

  test("a rate limit backs off and retries once, then fails", async () => {
    mock = await linearMock();
    mock.rateLimit(1);
    expect((await api().teams())[0].name).toBe("Core");
    mock.rateLimit(2);
    expect(api().teams()).rejects.toMatchObject({ code: "rate" });
  });

  test("create with parentId, project and labels; re-export updates; the marker dedupes", async () => {
    mock = await linearMock();
    const s = storySession(tempStore());
    const t = new LinearTracker(api(), "team-1", "Core", "proj-1");
    s.issues = undefined;
    const first = await exportAll(s, t, "linear", "team-1", { labels: ["label-1"] });
    expect(first.run.rows.every((r) => r.status === "created")).toBe(true);
    expect(mock.issues.map((x) => x.parentId)).toEqual([null, "iss-1", "iss-1", "iss-1"]);
    expect(mock.issues.every((x) => x.projectId === "proj-1" && x.labelIds.join() === "label-1")).toBe(true);
    expect(s.issues!.parent).toMatchObject({ identifier: "COR-1", url: "https://linear.app/acme/issue/COR-1" });
    s.plan!.markdown = STORY_MD.replace("One app", "One small app");
    const second = await exportAll(s, t, "linear", "team-1");
    expect(status(second.run)[PARENT_KEY]).toBe("updated");
    mock.issues[0].title = "Recipe box (team edit)";
    s.plan!.markdown = STORY_MD.replace("One app", "One tiny app");
    const edited = await exportAll(s, t, "linear", "team-1");
    expect(edited.run.rows[0]).toMatchObject({ status: "edited", message: "Changed in Linear after the export, so it’s left as is." });
    mock.issues[0].title = "Recipe box";
    s.plan!.markdown = STORY_MD.replace("One app", "One small app");
    s.issues = undefined;
    const third = await exportAll(s, t, "linear", "team-1");
    expect(third.run.rows.every((r) => r.status === "unchanged")).toBe(true);
    expect(mock.issues.length).toBe(4);
    expect(mock.requests.every((r) => r.auth === "lin_api_good")).toBe(true);
  });
});

describe("secrets", () => {
  test("the Linear key lives in secrets.json at 0600 and is never shown whole", () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "grillado-secrets-"));
    expect(linearView(dir)).toEqual({ connected: false });
    writeSecrets(dir, { linear: { key: "lin_api_abcdef1234", name: "Victor", connectedAt: "now" } });
    const file = path.join(dir, "secrets.json");
    expect(statSync(file).mode & 0o777).toBe(0o600);
    expect(readSecrets(dir).linear!.key).toBe("lin_api_abcdef1234");
    const view = linearView(dir);
    expect(view).toEqual({ connected: true, name: "Victor", last4: "1234" });
    expect(JSON.stringify(view)).not.toContain("abcdef");
    writeSecrets(dir, {});
    expect(existsSync(file)).toBe(false);
  });
});

describe("counters", () => {
  test("runs, clean runs, created and failed, per tracker, and the plans exported", () => {
    const store = tempStore();
    const run = (statuses: string[]): ExportRun => ({ state: "done", tracker: "github", target: "o/r", name: "o/r", startedAt: "", rows: statuses.map((st, i) => ({ key: `k${i}`, status: st as any })) });
    countExport(store, "p1", run(["created", "created", "failed"]));
    countExport(store, "p1", run(["unchanged", "created"]));
    const stats = JSON.parse(readFileSync(path.join(store.dir, "stats.json"), "utf8")).issues;
    expect(stats).toEqual({ runs: 2, cleanRuns: 1, created: 3, updated: 0, failed: 1, github: 2, plans: ["p1"] });
  });
});
