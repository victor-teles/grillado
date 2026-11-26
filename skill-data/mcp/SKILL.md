---
name: mcp
description: Use Grillado through its MCP server instead of the shell commands, and set the server up in Claude Code, Codex or Cursor.
---

# Grillado over MCP

The shell commands (`npx -y grillado plan …`) need no setup. If the user prefers MCP, `npx -y grillado mcp` serves the same plans over stdio.

| Command | MCP tool |
|---|---|
| `grillado plan start "<idea>" --context "…"` | `start_plan` (`idea`, `context`, `path`). It returns a link to open; it doesn't open the browser or start the web app. |
| `grillado plan get <id>` | `get_plan` (`plan`) |
| `grillado plan list` | `list_plans` |
| `grillado plan comment <id> --quote … --text …` | `add_comment` (`plan`, `quote`, `text`) |
| (no command) | `get_decisions`, `list_project_sources`, `import_source` |

There is no MCP tool to wait: after `start_plan`, ask the user to tell you when they've finished, then call `get_plan`. Each plan is also a resource, `grillado://plans/<id>`.

## Set it up once

Claude Code:

```sh
claude mcp add --scope user grillado -- npx -y grillado mcp
```

Codex:

```sh
codex mcp add grillado -- npx -y grillado mcp
```

Cursor, in `~/.cursor/mcp.json`:

```json
{ "mcpServers": { "grillado": { "type": "stdio", "command": "npx", "args": ["-y", "grillado", "mcp"] } } }
```

The web app's "Use in your editor" shows these with the right command for the user's install.
