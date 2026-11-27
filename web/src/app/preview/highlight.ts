// A small tokenizer for code sketches in option previews: comments, strings, numbers and common
// keywords, enough to read a short sketch of the calling side in any mainstream language. It only
// splits text into spans; nothing here is parsed as HTML.

export type TokenKind = "c" | "s" | "n" | "k" | "";
export interface Token {
  kind: TokenKind;
  text: string;
}

const KEYWORDS = new Set(
  "abstract as async await break case catch class const continue def default defer del do elif else enum export extends false final finally fn for from func function if impl implements import in interface is let match mut new nil none not null of or package private protected pub public raise return self static struct super switch this throw true try type typeof undefined use var void while with yield and None True False".split(
    " ",
  ),
);
const HASH_COMMENTS = new Set(["py", "python", "rb", "ruby", "sh", "bash", "zsh", "yaml", "yml", "toml", "r", "pl", "perl", "ex", "elixir"]);

const DASH_COMMENTS = new Set(["sql", "lua", "hs", "haskell", "elm"]);

/** Split `source` into tokens whose text, joined, is `source` again. */
export function tokenize(source: string, lang = ""): Token[] {
  const hash = HASH_COMMENTS.has(lang.toLowerCase());
  const dash = DASH_COMMENTS.has(lang.toLowerCase());
  const re = new RegExp(
    [
      "(\\/\\*[\\s\\S]*?\\*\\/|\\/\\/[^\\n]*" + (hash ? "|#[^\\n]*" : "") + (dash ? "|--[^\\n]*" : "") + "|<!--[\\s\\S]*?-->)",
      "(\"(?:\\\\.|[^\"\\\\\\n])*\"|'(?:\\\\.|[^'\\\\\\n])*'|`(?:\\\\.|[^`\\\\])*`)",
      "(\\b\\d[\\d_]*(?:\\.\\d+)?\\b)",
      "([A-Za-z_$][\\w$]*)",
    ].join("|"),
    "g",
  );
  const out: Token[] = [];
  let at = 0;
  const push = (kind: TokenKind, text: string) => {
    if (!text) return;
    const last = out.at(-1);
    if (last && last.kind === kind) last.text += text;
    else out.push({ kind, text });
  };
  for (const m of source.matchAll(re)) {
    push("", source.slice(at, m.index));
    const [text, comment, string, number, word] = m;
    push(comment ? "c" : string ? "s" : number ? "n" : word && KEYWORDS.has(word) ? "k" : "", text);
    at = m.index + text.length;
  }
  push("", source.slice(at));
  return out;
}
