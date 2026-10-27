// The editor a `grillado mcp` client is, from its MCP clientInfo.name (v1.2 item 1, DECISIONS #107).
// Shared by the Comments rail and Recent. The raw name is never shown: anything we don't know,
// including Claude Desktop's "claude-ai", reads "Your editor".
export const YOUR_EDITOR = "Your editor";

export function editorName(client?: string | null): string {
  const c = (client ?? "").trim();
  if (c === "claude-code") return "Claude Code";
  if (c === "cursor-vscode" || /^cursor/i.test(c)) return "Cursor";
  if (c === "codex-mcp-client" || /^codex/i.test(c)) return "Codex";
  return YOUR_EDITOR;
}

/** Recent's "From …" for an editor-started session: "From Cursor", or "From your editor" (#108). */
export function fromEditor(client?: string | null): string {
  const name = editorName(client);
  return `From ${name === YOUR_EDITOR ? "your editor" : name}`;
}
