---
name: mcp
description: Use Grillado through its MCP server instead of the shell commands, and set the server up in Claude Code, Codex or Cursor.
---

# Grillado over MCP

The shell commands (`npx -y grillado plan …`) need no setup. If the user prefers MCP, `npx -y grillado mcp` serves the same plans over stdio.

| Command | MCP tool |
|---|---|
| `grillado plan start "<idea>" --context "…"` | `start_plan` (`idea`, `context`, `path`, `agent`). It returns a link to open; it doesn't open the browser or start the web app. |
| `grillado plan get <id>` | `get_plan` (`plan`) |
| `grillado plan list` | `list_plans` |
| `grillado plan comment <id> --quote … --text …` | `add_comment` (`plan`, `quote`, `text`) |
| `grillado build next <id>` | `build_next` (`plan`) |
| `grillado build start <id>` | `build_start` (`plan`, `step`) |
| `grillado build done <id> --verified "…"` | `build_done` (`plan`, `step`, `verified`, `deviation`) |
| `grillado build ask <id> --key … --title "…" --option a="…" --option b="…"` | `build_ask` (`plan`, `key`, `title`, `body`, `options`, `suggest`, `step`). It doesn't start the web app. |
| `grillado build wait <id> --ask …` | `build_wait` (`plan`, `ask`, `timeout`). It waits 50 seconds by default; call it again while the result is "waiting". |
| `grillado build withdraw <id> --ask …` | `build_withdraw` (`plan`, `ask`, `reason`) |
| (no command) | `get_decisions`, `list_project_sources`, `import_source` |

There is no MCP tool to wait for a plan: after `start_plan`, ask the user to tell you when they've finished, then call `get_plan`. The `build_*` tools return the same results as the `grillado build` commands (`npx -y grillado skills get build` says how to use them). Each plan is also a resource, `grillado://plans/<id>`.

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
