import { describe, expect, test } from "bun:test";
import { YOUR_EDITOR, editorName, fromEditor } from "../src/core/editor.ts";

describe("editorName: which editor an MCP client is (DECISIONS #107)", () => {
  test("the three editors by their clientInfo names", () => {
    expect(editorName("claude-code")).toBe("Claude Code");
    expect(editorName("cursor-vscode")).toBe("Cursor");
    expect(editorName("Cursor")).toBe("Cursor");
    expect(editorName("cursor-cli")).toBe("Cursor");
    expect(editorName("codex-mcp-client")).toBe("Codex");
    expect(editorName("Codex")).toBe("Codex");
    expect(editorName("codex_tui")).toBe("Codex");
  });
  test("anything else is “Your editor”, never the raw name", () => {
    for (const c of ["claude-ai", "Visual Studio Code", "Zed", "opencode", "mcp", "mcp-client", "", "  ", undefined, null]) expect(editorName(c)).toBe(YOUR_EDITOR);
  });
  test("Recent's From line", () => {
    expect(fromEditor("cursor-vscode")).toBe("From Cursor");
    expect(fromEditor("")).toBe("From your editor");
    expect(fromEditor("claude-ai")).toBe("From your editor");
  });
});
