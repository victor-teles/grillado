// Curly apostrophes on screen (review-pr26 r2 n1): find a straight ' between letters ("don't") in the
// strings a person reads. Only string literals, template text and JSX text count, never comments or code.
// - web/src: every string (the whole bundle is UI).
// - The server: only strings that reach the screen as a message: the argument of `new …Error(…)`,
//   `setError(…)`, or a `message` / `error` / `answer` / `loginHint` / `installHint` property.
//   Prompts, MCP text for agents and the terminal usage are not on screen and are left alone.
// `node scripts/apostrophes.mjs` lists them; `--fix` rewrites them to ’ in place.
import { readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import ts from "typescript";

const ROOT = path.resolve(import.meta.dirname, "..");
const STRAIGHT = /([A-Za-z])'([A-Za-z])/g;
const SERVER = ["src/cli", "src/core"];
// What `grillado mcp` returns is read by a coding agent, not shown on screen.
const NOT_SHOWN = new Set(["src/cli/mcp.ts"]);
const SHOWN_PROPS = new Set(["message", "error", "answer", "loginHint", "installHint"]);

const walk = (d) => readdirSync(d).flatMap((f) => {
  const p = path.join(d, f);
  return statSync(p).isDirectory() ? walk(p) : /\.tsx?$/.test(p) && !p.endsWith(".d.ts") ? [p] : [];
});

/** The server string is shown when its closest message-carrying parent says so. */
function shownOnServer(node) {
  for (let n = node.parent; n && !ts.isSourceFile(n); n = n.parent) {
    if (ts.isNewExpression(n)) return /Error$/.test(n.expression.getText());
    if (ts.isCallExpression(n)) {
      if (n.expression.getText() === "setError") return true;
      if (!ts.isTemplateSpan(node.parent) && n !== node.parent) return false;
    }
    if (ts.isPropertyAssignment(n)) return SHOWN_PROPS.has(n.name.getText());
    if (ts.isBlock(n) || ts.isVariableDeclaration(n)) return false;
  }
  return false;
}

export function straightApostrophes({ fix = false } = {}) {
  const hits = [];
  const files = [...walk(path.join(ROOT, "web/src")).map((f) => [f, true]), ...SERVER.flatMap((d) => walk(path.join(ROOT, d)).filter((f) => !NOT_SHOWN.has(path.relative(ROOT, f))).map((f) => [f, false]))];
  for (const [file, web] of files) {
    const text = readFileSync(file, "utf8");
    const src = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, file.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
    const ranges = [];
    const visit = (n) => {
      const str = ts.isStringLiteral(n) || ts.isNoSubstitutionTemplateLiteral(n) || ts.isTemplateHead(n) || ts.isTemplateMiddle(n) || ts.isTemplateTail(n) || ts.isJsxText(n);
      if (str && /[A-Za-z]'[A-Za-z]/.test(n.text) && (web || shownOnServer(n))) {
        ranges.push([n.getStart(src), n.getEnd()]);
        hits.push(`${path.relative(ROOT, file)}:${src.getLineAndCharacterOfPosition(n.getStart(src)).line + 1}: ${n.text.trim().replace(/\s+/g, " ").slice(0, 80)}`);
      }
      ts.forEachChild(n, visit);
    };
    visit(src);
    if (fix && ranges.length) {
      let out = text;
      for (const [a, b] of ranges.reverse()) out = out.slice(0, a) + out.slice(a, b).replace(STRAIGHT, "$1’$2") + out.slice(b);
      writeFileSync(file, out);
    }
  }
  return hits;
}

if (import.meta.main ?? process.argv[1] === import.meta.filename) {
  const hits = straightApostrophes({ fix: process.argv.includes("--fix") });
  for (const h of hits) console.log(h);
  console.log(`${hits.length} on-screen string(s) with a straight apostrophe${process.argv.includes("--fix") ? ", fixed" : ""}`);
}
