// v1.2 item 1, "Use in your editor": the snippets are ED from the Designer's mock, word for word,
// around the command the server provides (handoff §2, §2a), and the default tab follows §7.
import { describe, expect, test } from "bun:test";
import { defaultEditor, highlight, setups } from "../web/src/app/mcp/setup.ts";
import { mcpLaunch } from "../src/cli/launch.ts";

const HOME_DIR = "/Users/victor/grillado-data";
const NPX = { command: "npx", args: ["-y", "grillado", "mcp"], line: "npx -y grillado mcp" };
const npxEnv = { ...NPX, env: { GRILLADO_HOME: HOME_DIR } };
const NODE = "/Users/v/.nvm/versions/node/v22.11.0/bin/node";

describe("snippets (ED in the mock)", () => {
  test("npx, default data dir", () => {
    const s = setups(NPX);
    expect(s.claude.code).toBe("claude mcp add --scope user grillado -- npx -y grillado mcp");
    expect(s.cursor.code).toBe('{\n  "mcpServers": {\n    "grillado": {\n      "type": "stdio",\n      "command": "npx",\n      "args": ["-y", "grillado", "mcp"]\n    }\n  }\n}');
    expect(s.codex.code).toBe('[mcp_servers.grillado]\ncommand = "npx"\nargs = ["-y", "grillado", "mcp"]');
    expect(s.codex.alt).toBe("codex mcp add grillado -- npx -y grillado mcp");
    expect(JSON.parse(s.cursor.code).mcpServers.grillado).toEqual({ type: "stdio", command: "npx", args: ["-y", "grillado", "mcp"] });
  });

  test("a custom data dir adds GRILLADO_HOME, and only then (Q7)", () => {
    const s = setups(npxEnv);
    expect(s.claude.code).toBe(`claude mcp add --scope user --env GRILLADO_HOME=${HOME_DIR} grillado -- npx -y grillado mcp`);
    expect(s.cursor.code).toBe(`{\n  "mcpServers": {\n    "grillado": {\n      "type": "stdio",\n      "command": "npx",\n      "args": ["-y", "grillado", "mcp"],\n      "env": { "GRILLADO_HOME": "${HOME_DIR}" }\n    }\n  }\n}`);
    expect(s.codex.code).toBe(`[mcp_servers.grillado]\ncommand = "npx"\nargs = ["-y", "grillado", "mcp"]\n\n[mcp_servers.grillado.env]\nGRILLADO_HOME = "${HOME_DIR}"`);
    expect(s.codex.alt).toBe(`codex mcp add --env GRILLADO_HOME=${HOME_DIR} grillado -- npx -y grillado mcp`);
  });

  test("from a local build: the server's command with the absolute node, as it is (§2a, #109)", () => {
    const l = mcpLaunch("/abs/path/dist/cli.js", "/home/v/.grillado", "/home/v", NODE);
    const s = setups(l);
    expect(s.claude.code).toBe(`claude mcp add --scope user grillado -- ${NODE} /abs/path/dist/cli.js mcp`);
    expect(JSON.parse(s.cursor.code).mcpServers.grillado).toEqual({ type: "stdio", command: NODE, args: ["/abs/path/dist/cli.js", "mcp"] });
    expect(s.codex.code).toBe(`[mcp_servers.grillado]\ncommand = "${NODE}"\nargs = ["/abs/path/dist/cli.js", "mcp"]`);
    expect(s.codex.alt).toBe(`codex mcp add grillado -- ${NODE} /abs/path/dist/cli.js mcp`);
  });

  test("paths with spaces stay valid in every snippet", () => {
    const l = mcpLaunch("/My Code/grillado/dist/cli.js", "/tmp/d 2", "/home/v", "/opt/my node/bin/node");
    const s = setups(l);
    // The --env value is quoted with the server's own shellQuote (review N3).
    expect(s.claude.code).toBe("claude mcp add --scope user --env 'GRILLADO_HOME=/tmp/d 2' grillado -- '/opt/my node/bin/node' '/My Code/grillado/dist/cli.js' mcp");
    expect(s.codex.alt).toBe("codex mcp add --env 'GRILLADO_HOME=/tmp/d 2' grillado -- '/opt/my node/bin/node' '/My Code/grillado/dist/cli.js' mcp");
    expect(JSON.parse(s.cursor.code).mcpServers.grillado).toEqual({ type: "stdio", command: "/opt/my node/bin/node", args: ["/My Code/grillado/dist/cli.js", "mcp"], env: { GRILLADO_HOME: "/tmp/d 2" } });
  });

  test("quotes and backslashes stay valid JSON and TOML (review N5)", () => {
    const l = { command: 'C:\\Node "22"\\node.exe', args: ['C:\\g\\dist\\cli.js', "mcp"], env: { GRILLADO_HOME: 'C:\\d "x"' }, line: "x" };
    const s = setups(l);
    expect(JSON.parse(s.cursor.code).mcpServers.grillado).toEqual({ type: "stdio", command: l.command, args: l.args, env: l.env });
    expect(s.codex.code).toContain('command = "C:\\\\Node \\"22\\"\\\\node.exe"');
    expect(s.codex.code).toContain('GRILLADO_HOME = "C:\\\\d \\"x\\""');
  });

  test("keys are marked for the muted colour, values aren't", () => {
    const keys = highlight(setups(NPX).codex.code).filter((x) => x.key).map((x) => x.text);
    expect(keys).toEqual(["[mcp_servers.grillado]", "command", "args"]);
    expect(highlight(setups(NPX).cursor.code).filter((x) => x.key).map((x) => x.text)).toEqual(['"mcpServers"', '"grillado"', '"type"', '"command"', '"args"']);
    expect(highlight(setups(NPX).cursor.code).map((x) => x.text).join("")).toBe(setups(NPX).cursor.code);
  });
});

describe("default tab (§7)", () => {
  test("the agent in use, then the last tab picked, then Claude Code", () => {
    expect(defaultEditor("codex", "cursor")).toBe("codex");
    expect(defaultEditor("claude", "cursor")).toBe("claude");
    expect(defaultEditor("grok", "cursor")).toBe("cursor");
    expect(defaultEditor("pi", null)).toBe("claude");
    expect(defaultEditor(null, "codex")).toBe("codex");
    expect(defaultEditor(null, "nonsense")).toBe("claude");
  });
});

