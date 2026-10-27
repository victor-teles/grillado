// v1.2 item 1, "Use in your editor": what each editor needs to start `grillado mcp` (handoff §2,
// ED in the mock). The command comes from the server (§2a) and is used as it is; only the editor's
// own wrapping (claude mcp add …, mcp.json, config.toml) is added around it.
import { shellQuote } from "../../../../src/core/shell.ts";
import type { McpLaunch, ProviderId } from "../types.ts";

export type EditorKey = "claude" | "cursor" | "codex";
export const EDITOR_KEYS: EditorKey[] = ["claude", "cursor", "codex"];
export const EDITOR_NAME: Record<EditorKey, string> = { claude: "Claude Code", cursor: "Cursor", codex: "Codex" };
export const LAST_EDITOR = "grillado.editor";

export interface Setup {
  key: EditorKey;
  name: string;
  /** "Run this in a terminal" / "Add this to ~/.cursor/mcp.json": the path is shown as code. */
  where: { lead: string; path?: string };
  code: string;
  /** Codex only: the one-line `codex mcp add` alternative. */
  alt?: string;
  what: "command" | "config";
}

/** JSON strings, and TOML basic strings: JSON.stringify escapes quotes and backslashes for both. */
const str = (s: string) => JSON.stringify(s);
const list = (a: string[]) => `[${a.map(str).join(", ")}]`;

export function setups(l: McpLaunch): Record<EditorKey, Setup> {
  const home = l.env?.GRILLADO_HOME;
  const envFlag = home ? ` --env ${shellQuote(`GRILLADO_HOME=${home}`)}` : "";
  const json = [
    "{",
    '  "mcpServers": {',
    '    "grillado": {',
    '      "type": "stdio",',
    `      "command": ${str(l.command)},`,
    `      "args": ${list(l.args)}${home ? "," : ""}`,
    ...(home ? [`      "env": { "GRILLADO_HOME": ${str(home)} }`] : []),
    "    }",
    "  }",
    "}",
  ].join("\n");
  const toml = [
    "[mcp_servers.grillado]",
    `command = ${str(l.command)}`,
    `args = ${list(l.args)}`,
    ...(home ? ["", "[mcp_servers.grillado.env]", `GRILLADO_HOME = ${str(home)}`] : []),
  ].join("\n");
  return {
    claude: { key: "claude", name: EDITOR_NAME.claude, where: { lead: "Run this in a terminal" }, code: `claude mcp add --scope user${envFlag} grillado -- ${l.line}`, what: "command" },
    cursor: { key: "cursor", name: EDITOR_NAME.cursor, where: { lead: "Add this to", path: "~/.cursor/mcp.json" }, code: json, what: "config" },
    codex: {
      key: "codex",
      name: EDITOR_NAME.codex,
      where: { lead: "Add this to", path: "~/.codex/config.toml" },
      code: toml,
      alt: `codex mcp add${envFlag} grillado -- ${l.line}`,
      what: "config",
    },
  };
}

/** §7: the agent in use, else the last tab picked, else Claude Code. */
export function defaultEditor(agent: ProviderId | null | undefined, stored: string | null): EditorKey {
  if (agent === "claude" || agent === "codex") return agent;
  return EDITOR_KEYS.includes(stored as EditorKey) ? (stored as EditorKey) : "claude";
}

/** Keys (TOML/JSON) in muted-fg, values in fg (§4.5). */
export function highlight(code: string): { text: string; key: boolean }[] {
  const out: { text: string; key: boolean }[] = [];
  for (const [i, line] of code.split("\n").entries()) {
    if (i) out.push({ text: "\n", key: false });
    const m = /^(\[.*\])$/.exec(line) ?? null;
    if (m) {
      out.push({ text: line, key: true });
      continue;
    }
    const j = /^(\s*)("\w+")(:.*)$/.exec(line) ?? /^()(\w+)( =.*)$/.exec(line);
    if (j) out.push({ text: j[1], key: false }, { text: j[2], key: true }, { text: j[3], key: false });
    else out.push({ text: line, key: false });
  }
  return out;
}
