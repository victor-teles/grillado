/**
 * Pull a JSON candidate out of whatever the CLI returned: an object, a JSON string,
 * a fenced ```json block, or the first balanced {...} inside prose.
 */
export function extractCandidate(raw: unknown): unknown {
  if (raw && typeof raw === "object") return raw;
  if (typeof raw !== "string") return undefined;
  const text = raw.trim();
  if (!text) return undefined;
  const direct = tryParse(text);
  if (direct !== undefined && typeof direct === "object" && direct !== null) return direct;
  const fence = text.match(/```(?:json)?\s*\n([\s\S]*?)```/i);
  if (fence) {
    const parsed = tryParse(fence[1].trim());
    if (parsed && typeof parsed === "object") return parsed;
  }
  const balanced = firstBalancedObject(text);
  if (balanced) {
    const parsed = tryParse(balanced);
    if (parsed && typeof parsed === "object") return parsed;
  }
  return undefined;
}

function tryParse(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

/** Scan for the first `{` and return the substring up to its matching `}`, honoring strings. */
export function firstBalancedObject(text: string): string | undefined {
  let start = text.indexOf("{");
  while (start !== -1) {
    let depth = 0;
    let inString = false;
    let escaped = false;
    for (let i = start; i < text.length; i++) {
      const ch = text[i];
      if (inString) {
        if (escaped) escaped = false;
        else if (ch === "\\") escaped = true;
        else if (ch === '"') inString = false;
        continue;
      }
      if (ch === '"') inString = true;
      else if (ch === "{") depth++;
      else if (ch === "}") {
        depth--;
        if (depth === 0) {
          const candidate = text.slice(start, i + 1);
          if (tryParse(candidate) !== undefined) return candidate;
          break;
        }
      }
    }
    start = text.indexOf("{", start + 1);
  }
  return undefined;
}
