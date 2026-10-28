// Curly apostrophes on screen (review-pr26 r2 n1, widened in the #26 follow-ups): find a straight ' that
// touches a letter or digit ("don't", "{name}'s", "${agent}'s", "agents'", 'quoted', '90s) in the strings a person reads. Only string literals, template text and JSX text count, never comments or code.
// - web/src: every string (the whole bundle is UI).
// - The server: only strings that reach the screen as a message: the argument of `new …Error(…)`,
//   `setError(…)`, or a `message` / `error` / `answer` / `loginHint` / `installHint` property.
//   Prompts, MCP text for agents and the terminal usage are not on screen and are left alone.
// - The src/core modules the web bundle imports for its labels (reasonText, the Activity labels, STOPPED):
//   every string, like web/src.
// CSS attribute values in selectors and class names ([tabindex='0'], [class*='size-']) are code, not text.
// `node scripts/apostrophes.mjs` lists them; `--fix` rewrites them to ’ in place.
import { readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import ts from "typescript";

const ROOT = path.resolve(import.meta.dirname, "..");
// A straight ' with a letter or digit on either side. The text of a template piece after `${…}` starts
// right after a value, so a leading ' there counts as touching it ("${agent}'s").
const TOUCHES = /[\p{L}\p{N}}]'|'[\p{L}\p{N}]/u;
const CSS_ATTR = /\[[\w-]+[~|^$*]?='[^'\]]*'\]/g;
const WEB_SHOWN = new Set(["src/core/reason.ts", "src/core/activity.ts"]);
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
  const files = [
    ...walk(path.join(ROOT, "web/src")).map((f) => [f, true]),
    ...SERVER.flatMap((d) => walk(path.join(ROOT, d)).filter((f) => !NOT_SHOWN.has(path.relative(ROOT, f))).map((f) => [f, WEB_SHOWN.has(path.relative(ROOT, f))])),
  ];
  return scan(files, { fix, rel: (f) => path.relative(ROOT, f), hits });
}

/** One string piece, as it reads on screen: a template piece after `${…}` starts right after a value. */
export function straightIn(text, afterValue = false) {
  const t = (afterValue ? "}" : "") + text.replace(CSS_ATTR, "");
  return TOUCHES.test(t);
}

/** Curly the ' in one string piece: ’ after a letter, digit or value, or before a digit ('90s); ‘ to open a quote. */
export function curly(text, afterValue = false) {
  const css = [...text.matchAll(CSS_ATTR)].map((m) => [m.index, m.index + m[0].length]);
  return text.replace(/'/g, (q, i) => {
    if (css.some(([a, b]) => i >= a && i < b)) return q;
    const prev = i ? text[i - 1] : afterValue ? "}" : "";
    const next = text[i + 1] ?? "";
    if (/[\p{L}\p{N}}]/u.test(prev) || /\p{N}/u.test(next)) return "’";
    return /\p{L}/u.test(next) ? "‘" : q;
  });
}

const isPiece = (n) => ts.isStringLiteral(n) || ts.isNoSubstitutionTemplateLiteral(n) || ts.isTemplateHead(n) || ts.isTemplateMiddle(n) || ts.isTemplateTail(n) || ts.isJsxText(n);
const afterValue = (n) => ts.isTemplateMiddle(n) || ts.isTemplateTail(n);

/** Scan [file, everyString] pairs; also used by the checker's own test on fixture files. */
export function scan(files, { fix = false, rel = (f) => f, hits = [] } = {}) {
  for (const [file, web] of files) {
    const text = readFileSync(file, "utf8");
    const src = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, file.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
    const ranges = [];
    const visit = (n) => {
      if (isPiece(n) && straightIn(n.text, afterValue(n)) && (web || shownOnServer(n))) {
        ranges.push([n, n.getStart(src), n.getEnd()]);
        hits.push(`${rel(file)}:${src.getLineAndCharacterOfPosition(n.getStart(src)).line + 1}: ${n.text.trim().replace(/\s+/g, " ").slice(0, 80)}`);
      }
      ts.forEachChild(n, visit);
    };
    visit(src);
    if (fix && ranges.length) {
      let out = text;
      for (const [n, a, b] of ranges.reverse()) {
        // Only the text between the delimiters. Work on the unescaped text, then escape any ' left in a '…' literal.
        const raw = out.slice(a, b);
        const open = ts.isJsxText(n) ? 0 : 1;
        const close = ts.isJsxText(n) ? 0 : ts.isTemplateHead(n) || ts.isTemplateMiddle(n) ? 2 : 1;
        const quote = ts.isStringLiteral(n) && raw[0] === "'";
        let body = curly(raw.slice(open, raw.length - close).replace(/\\'/g, "'"), afterValue(n));
        if (quote) body = body.replace(/'/g, "\\'");
        out = out.slice(0, a) + raw.slice(0, open) + body + raw.slice(raw.length - close) + out.slice(b);
      }
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
