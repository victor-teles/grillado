# Grillado for coding agents

Coding agents use Grillado in one of three ways. All of them share the same plans as the web app
(`~/.grillado`, `$GRILLADO_HOME` or `--data-dir`).

## The skill

`npx skills add victor-teles/grillado` installs a small skill (`skills/grillado/SKILL.md` in this
repository) into your agents' skill folders. Its description tells the agent when to reach for
Grillado; its body tells it to load the real instructions from the CLI, which always match the
installed version:

```sh
grillado skills list            # plan, build, mcp
grillado skills get plan        # plan something with the user
grillado skills get build       # build from a finished plan
grillado skills get mcp         # the MCP tools and how to set them up
```

`--json` gives the same as JSON. `GRILLADO_SKILLS_DIR` points the command at another folder of
`<name>/SKILL.md` files.

## Shell commands

No setup: any agent with a shell can run them with `npx -y grillado`.

```
grillado plan start <idea> [--context <text>] [--context-file <path>] [--path <dir>]
                           [--plans-dir <path>] [--from <name>] [--no-open] [--json]
grillado plan wait <id> [--timeout <seconds>] [--json]
grillado plan get <id> [--json]
grillado plan list [--json]
grillado plan comment <id> --quote <text> --text <text> [--json]
```

- `start` creates the plan (in `--path`, or the current folder; its Markdown goes to
  `docs/plans/` there, or to `--plans-dir`, or to the plans folder the user set for the project
  in the web app) and opens its questions in the browser. When the web app isn't running it
  starts one in the background with `--exit-when-idle`, so it quits after 30 minutes with no
  browser open and nothing running. `--from` names the agent in Recent ("From Claude Code").
- `wait` returns the plan once the user has finished. After `--timeout` (default 540 seconds,
  under the 10-minute limit some harnesses put on one command) it prints a waiting status and
  exits 0; run it again. With `--json`, `result` is `ready` or `waiting`.
- `get`, `list` and `comment` match the MCP tools `get_plan`, `list_plans` and `add_comment`.

The result goes to stdout; hints and errors go to stderr. Exit codes: 0 a result (waiting
included), 1 a problem at run time (an unknown plan id, a comment on a draft), 2 wrong usage.
Nothing here answers questions or confirms a plan: the user does that in the browser.

## MCP

`npx grillado mcp` is an MCP server over stdio on the same data as the web app (`~/.grillado`,
`$GRILLADO_HOME` or `--data-dir`). It works whether or not the web app is running and needs no
network. Tools: `list_plans`, `get_plan` (Markdown plus the decisions and their answers; a plan
that isn't finished comes back marked as a draft), `get_decisions`, `start_plan` (sends an idea to
Grillado and returns the link to answer its questions in the browser) and `add_comment` (shows in
the plan's Comments rail as from the coding agent), plus `list_project_sources` and
`import_source` (the planning sessions and plan files found in a project, and importing one as a
plan). Once a plan has been sent to GitHub or Linear, `get_plan` includes its `issues` links. There
is no tool to create issues: that only happens in the browser, after its preview and confirm. Each plan is also a resource,
`grillado://plans/<id>`.

`start_plan` saves its Markdown in the MCP server's working folder under `docs/plans/`.
Pass `path` to start it in a different project. Opening its link in a web app launched elsewhere
keeps that destination.

Set it up once, for every project (`npx -y` skips npx's install prompt). If you use a custom
data dir, pass it as `GRILLADO_HOME` (the web app's "Use in your editor" shows these with the
right command and env filled in).

Claude Code:

```sh
claude mcp add --scope user grillado -- npx -y grillado mcp
```

Cursor, in `~/.cursor/mcp.json`:

```json
{
  "mcpServers": {
    "grillado": {
      "type": "stdio",
      "command": "npx",
      "args": ["-y", "grillado", "mcp"]
    }
  }
}
```

Codex, in `~/.codex/config.toml` (or `codex mcp add grillado -- npx -y grillado mcp`):

```toml
[mcp_servers.grillado]
command = "npx"
args = ["-y", "grillado", "mcp"]
```

Then ask your agent to "build the Grillado plan for …".
