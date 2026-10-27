// A reader for JSON that is still arriving (#97). Claude Code streams a structured reply as
// `input_json_delta` chunks of one object; this pulls one top-level string field out of the text so
// far, decoded, so the reply can be shown while it grows. It never guesses: an escape or a key that
// hasn't fully arrived is left out until the next chunk completes it.

const WS = /\s/;

/**
 * The value of the top-level string field `field` in `json`, as far as it has arrived, or
 * undefined when the field hasn't started (or isn't a string).
 */
export function partialStringField(json: string, field: string): string | undefined {
  let i = 0;
  const n = json.length;
  const ws = () => {
    while (i < n && WS.test(json[i])) i++;
  };
  ws();
  if (json[i] !== "{") return undefined;
  i++;
  for (;;) {
    ws();
    if (i >= n || json[i] === "}") return undefined;
    if (json[i] === ",") {
      i++;
      continue;
    }
    if (json[i] !== '"') return undefined;
    const key = readString();
    if (!key || !key.done) return undefined;
    ws();
    if (json[i] !== ":") return undefined;
    i++;
    ws();
    if (i >= n) return undefined;
    if (key.value === field) {
      if (json[i] !== '"') return undefined;
      return readString()?.value;
    }
    if (!skipValue()) return undefined;
  }

  /** Reads a string starting at the opening quote. `done` is false when it hasn't closed yet. */
  function readString(): { value: string; done: boolean } | undefined {
    i++; // opening quote
    let out = "";
    while (i < n) {
      const c = json[i];
      if (c === '"') {
        i++;
        return { value: out, done: true };
      }
      if (c !== "\\") {
        out += c;
        i++;
        continue;
      }
      if (i + 1 >= n) return { value: out, done: false };
      const e = json[i + 1];
      if (e === "u") {
        const hex = json.slice(i + 2, i + 6);
        if (hex.length < 4) return { value: out, done: false };
        if (!/^[0-9a-fA-F]{4}$/.test(hex)) return undefined;
        const code = Number.parseInt(hex, 16);
        // A high surrogate waits for its pair, so half an emoji never shows.
        if (code >= 0xd800 && code <= 0xdbff) {
          const lo = json.slice(i + 6, i + 12);
          if (lo.length < 6) return { value: out, done: false };
          if (!/^\\u[dD][c-fC-F][0-9a-fA-F]{2}$/.test(lo)) return undefined;
          out += String.fromCharCode(code, Number.parseInt(lo.slice(2), 16));
          i += 12;
          continue;
        }
        out += String.fromCharCode(code);
        i += 6;
        continue;
      }
      const simple: Record<string, string> = { '"': '"', "\\": "\\", "/": "/", b: "\b", f: "\f", n: "\n", r: "\r", t: "\t" };
      if (!(e in simple)) return undefined;
      out += simple[e];
      i += 2;
    }
    return { value: out, done: false };
  }

  /** Skips a complete value of any type; false when it hasn't fully arrived. */
  function skipValue(): boolean {
    const c = json[i];
    if (c === '"') return readString()?.done === true;
    if (c === "{" || c === "[") {
      let depth = 0;
      while (i < n) {
        const d = json[i];
        if (d === '"') {
          if (readString()?.done !== true) return false;
          continue;
        }
        if (d === "{" || d === "[") depth++;
        else if (d === "}" || d === "]") {
          depth--;
          if (depth === 0) {
            i++;
            return true;
          }
        }
        i++;
      }
      return false;
    }
    // number, true, false, null: done once a delimiter follows.
    while (i < n && !/[,}\]\s]/.test(json[i])) i++;
    return i < n;
  }
}
