// The on-screen apostrophe check (scripts/apostrophes.mjs), widened in the #26 follow-ups: any straight '
// touching a letter or digit, in the strings a person reads, and never in comments, code or CSS selectors.
import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { curly, offscreenTags, scan, straightApostrophes, straightIn, webShown } from "../scripts/apostrophes.mjs";

describe("straightIn: which pieces of text are caught", () => {
  test("contractions, possessives after a value, plural possessives, quotes and '90s", () => {
    expect(straightIn("don't")).toBe(true);
    expect(straightIn("{name}'s plan")).toBe(true);
    expect(straightIn("'s split", true)).toBe(true); // the `'s` after `${agent}`
    expect(straightIn("the agents' answers")).toBe(true);
    expect(straightIn("it said 'done'")).toBe(true);
    expect(straightIn("back in '90s")).toBe(true);
  });
  test("curly text, a lone quote and CSS attribute values are fine", () => {
    expect(straightIn("don’t, {name}’s, agents’ and ‘done’")).toBe(false);
    expect(straightIn("a ' b")).toBe(false);
    expect(straightIn("button,[tabindex='0']")).toBe(false);
    expect(straightIn("[&_svg:not([class*='size-'])]:size-3")).toBe(false);
  });
});

describe("curly: what --fix writes", () => {
  test("’ for apostrophes, ‘…’ for quotes, ’ for an elided '90s", () => {
    expect(curly("don't")).toBe("don’t");
    expect(curly("{name}'s plan")).toBe("{name}’s plan");
    expect(curly("'s split", true)).toBe("’s split");
    expect(curly("the agents' answers")).toBe("the agents’ answers");
    expect(curly("it said 'done'")).toBe("it said ‘done’");
    expect(curly("back in '90s")).toBe("back in ’90s");
    expect(curly("x [tabindex='0'] don't")).toBe("x [tabindex='0'] don’t");
  });
});

describe("scan: on-screen strings only", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "apos-"));
  const write = (name: string, body: string) => {
    const f = path.join(dir, name);
    writeFileSync(f, body);
    return f;
  };
  test("web files: every string, template piece and JSX text; never comments or selectors", () => {
    const f = write("ui.tsx", [
      "// a comment: don't, agents' and 'quoted' never count",
      "const a = \"{name}'s plan\";",
      "const b = (agent: string) => `${agent}'s split`;",
      "const c = 'the agents\\' answers';",
      "const d = \"it said 'done' in the '90s\";",
      "const e = \"button,[tabindex='0']\";",
      "export const V = () => <p>We're on it</p>;",
      "/** An old stored message, only matched. @offscreen */",
      "const f = \"Stopped. Retry when you're ready.\";",
      "export { a, b, c, d, e, f };",
    ].join("\n"));
    const hits = scan([[f, true]]);
    expect(hits.map((h) => h.split(":")[1])).toEqual(["2", "3", "4", "5", "7"]);
    scan([[f, true]], { fix: true });
    const out = readFileSync(f, "utf8");
    expect(out).toContain("\"{name}’s plan\"");
    expect(out).toContain("`${agent}’s split`");
    expect(out).toContain("'the agents’ answers'");
    expect(out).toContain("\"it said ‘done’ in the ’90s\"");
    expect(out).toContain("[tabindex='0']");
    expect(out).toContain("<p>We’re on it</p>");
    expect(out).toContain("const f = \"Stopped. Retry when you're ready.\";");
    expect(out).toContain("// a comment: don't, agents' and 'quoted' never count");
    expect(scan([[f, true]])).toEqual([]);
  });
  test("server files: only messages that reach the screen, never prompts", () => {
    const f = write("srv.ts", [
      "declare function setError(s: unknown, c: string, m: string): void;",
      "const prompt = \"Answer in the user's words, 'as is'.\";",
      "setError({}, \"x\", `${\"Grok\"}'s reply didn't parse`);",
      "const r = { message: \"The agents' run stopped\" };",
      "throw new Error(\"Can't read '90s plans\");",
      "export { prompt, r };",
    ].join("\n"));
    expect(scan([[f, false]]).map((h) => h.split(":")[1])).toEqual(["3", "4", "5"]);
  });
  test("@offscreen hides a tagged const only, never a whole function or class", () => {
    const f = write("tags.tsx", [
      "/** @offscreen */",
      "export function Shown() { return <p>We're on it</p>; }",
      "/** @offscreen */",
      "export class Also { t = \"Can't\"; }",
      "/** @offscreen: kept to match old stored text. */",
      "export const OLD = \"You're stopped\";",
    ].join("\n"));
    expect(scan([[f, true]]).map((h) => h.split(":")[1])).toEqual(["2", "4"]);
  });
  // A long scan (TypeScript parses every file); 7.6 s under load once, against the 5 s default (review-pr27 nice 2).
  test("the repo itself is clean", () => {
    expect(straightApostrophes()).toEqual([]);
  }, 30_000);
  // review-pr27 nice 3: the src/core modules in the web bundle get the web rule, from web's own imports.
  // A new one fails here so someone reads it for on-screen text (and tags code-only constants @offscreen).
  test("the core modules checked with the web rule are exactly what web imports", () => {
    expect([...webShown()].sort()).toEqual([
      "src/core/activity.ts",
      "src/core/addplan.ts",
      "src/core/comments.ts",
      "src/core/decision-block.ts",
      "src/core/diagrams.ts",
      "src/core/editor.ts",
      "src/core/floor.ts",
      "src/core/reason.ts",
      "src/core/shell.ts",
      "src/core/text-hash.ts",
    ]);
  }, 30_000);
  // review-pr27 nice 4: the @offscreen allowlist, pinned. Adding a tag means adding it here, on purpose.
  test("only the old stored Stop message and shell quoting are @offscreen", () => {
    expect(offscreenTags().sort()).toEqual(["src/core/reason.ts STOPPED_BEFORE_26", "src/core/shell.ts shellQuote"]);
  }, 30_000);
});
