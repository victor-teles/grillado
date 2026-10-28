// Curly apostrophes on screen (review-pr26 r2 n1, widened in the #26 follow-ups): find a straight ' that
// touches a letter or digit ("don't", "{name}'s", "${agent}'s", "agents'", 'quoted', '90s) in the strings a person reads. Only string literals, template text and JSX text count, never comments or code.
// - web/src: every string (the whole bundle is UI).
// - The server: only strings that reach the screen as a message: the argument of `new …Error(…)`,
//   `setError(…)`, or a `message` / `error` / `answer` / `loginHint` / `installHint` property.
//   Prompts, MCP text for agents and the terminal usage are not on screen and are left alone.
// - The src/core modules the web bundle imports (directly or through another core module; `import type`
//   brings no strings): every string, like web/src. The list is derived from the imports, never kept by hand.
// CSS attribute values in selectors and class names ([tabindex='0'], [class*='size-']) are code, not text.
// A variable statement (`const X = …`) whose comment says `@offscreen` is never shown (e.g. an old stored
// message kept only to match it, or a shell quoting constant). Only variable statements: a tag on a function
// or a class would hide every string in it, so it does nothing there.
// `node scripts/apostrophes.mjs` lists them; `--fix` rewrites them to ’ in place.
import { existsSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import ts from "typescript";

const ROOT = path.resolve(import.meta.dirname, "..");
// A straight ' with a letter or digit on either side. The text of a template piece after `${…}` starts
// right after a value, so a leading ' there counts as touching it ("${agent}'s").
const TOUCHES = /[\p{L}\p{N}}]'|'[\p{L}\p{N}]/u;
const CSS_ATTR = /\[[\w-]+[~|^$*]?='[^'\]]*'\]/g;
const SERVER = ["src/cli", "src/core"];
// What `grillado mcp` returns is read by a coding agent, not shown on screen.
const NOT_SHOWN = new Set(["src/cli/mcp.ts"]);
const SHOWN_PROPS = new Set(["message", "error", "answer", "loginHint", "installHint"]);

const walk = (d) => readdirSync(d).flatMap((f) => {
  const p = path.join(d, f);
  return statSync(p).isDirectory() ? walk(p) : /\.tsx?$/.test(p) && !p.endsWith(".d.ts") ? [p] : [];
});

/** A relative import from `from`, resolved to its .ts/.tsx file (null for packages). */
function resolveImport(from, spec) {
  if (!spec.startsWith(".")) return null;
  const base = path.resolve(path.dirname(from), spec.replace(/\.js$/, ""));
  for (const c of [base + ".ts", base + ".tsx", path.join(base, "index.ts"), base]) if (existsSync(c) && statSync(c).isFile()) return c;
  return null;
}

/** The value imports and re-exports of one file (`import type` / `export type` bring no strings). */
function valueImports(file) {
  const src = ts.createSourceFile(file, readFileSync(file, "utf8"), ts.ScriptTarget.Latest, true);
  const out = [];
  for (const st of src.statements) {
    const spec = ts.isImportDeclaration(st) && !st.importClause?.isTypeOnly ? st.moduleSpecifier
      : ts.isExportDeclaration(st) && !st.isTypeOnly ? st.moduleSpecifier : undefined;
    const r = spec && ts.isStringLiteral(spec) ? resolveImport(file, spec.text) : null;
    if (r) out.push(r);
  }
  return out;
}

/** The src/core modules in the web bundle: what web/src imports from src/core, and what those import in turn. */
export function webShown() {
  const core = path.join(ROOT, "src/core") + path.sep;
  const seen = new Set();
  const todo = walk(path.join(ROOT, "web/src")).flatMap(valueImports).filter((f) => f.startsWith(core));
  while (todo.length) {
    const f = todo.pop();
    if (seen.has(f)) continue;
    seen.add(f);
    todo.push(...valueImports(f).filter((d) => d.startsWith(core)));
  }
  return new Set([...seen].map((f) => path.relative(ROOT, f)));
}

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
  const WEB_SHOWN = webShown();
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

/** A `const`/`let` statement tagged `@offscreen` in its leading comment. */
const offscreen = (text, n) => ts.isVariableStatement(n) && (ts.getLeadingCommentRanges(text, n.getFullStart()) ?? []).some((c) => text.slice(c.pos, c.end).includes("@offscreen"));

/** Every `@offscreen` tag in the scanned files, as `file:line name`, so a test can pin the allowlist. */
export function offscreenTags() {
  const tags = [];
  for (const f of [...walk(path.join(ROOT, "web/src")), ...SERVER.flatMap((d) => walk(path.join(ROOT, d)))]) {
    const text = readFileSync(f, "utf8");
    if (!text.includes("@offscreen")) continue;
    const src = ts.createSourceFile(f, text, ts.ScriptTarget.Latest, true, f.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
    const visit = (n) => {
      if (ts.isStatement(n) && (ts.getLeadingCommentRanges(text, n.getFullStart()) ?? []).some((c) => text.slice(c.pos, c.end).includes("@offscreen"))) {
        const name = ts.isVariableStatement(n) ? n.declarationList.declarations.map((d) => d.name.getText()).join(",") : `(${ts.SyntaxKind[n.kind]}, ignored)`;
        tags.push(`${path.relative(ROOT, f)} ${name}`);
      }
      ts.forEachChild(n, visit);
    };
    visit(src);
  }
  return tags;
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
      if (offscreen(text, n)) return;
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
