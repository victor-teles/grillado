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
                           [--plans-dir <path>] [--agent <id>] [--from <name>] [--no-open] [--json]
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
  `--agent <id>` picks the agent that asks and writes this plan, over the one selected in the web
  app. It must be one that can read the project (`claude`, `grok`); another is refused with the
  list of those that can.
- `wait` returns the plan once the user has finished. After `--timeout` (default 540 seconds,
  under the 10-minute limit some harnesses put on one command) it prints a waiting status and
  exits 0; run it again. With `--json`, `result` is `ready` or `waiting`.
- `get`, `list` and `comment` match the MCP tools `get_plan`, `list_plans` and `add_comment`.

The result goes to stdout; hints and errors go to stderr. Exit codes: 0 a result (waiting
included), 1 a problem at run time (an unknown plan id, a comment on a draft), 2 wrong usage.
Nothing here answers questions or confirms a plan: the user does that in the browser.

## Building from a plan

A written plan has build steps: thin end-to-end slices, each with a check that tells it is done.
The coding agent works through them and reports back, so the plan shows what was built.

```
grillado build next <plan> [--json]
grillado build start <plan> [--step <n>] [--json]
grillado build done <plan> [--step <n>] --verified <text> [--deviation <text>] [--json]
grillado build ask <plan> --key <key> --title <question> --option <id>=<label> --option <id>=<label>
                   [--body <text>] [--note <id>=<text>] [--suggest <id>] [--step <n>] [--no-open] [--json]
grillado build wait <plan> --ask <key> [--timeout <seconds>] [--json]
grillado build withdraw <plan> --ask <key> [--reason <text>] [--json]
```

- `next` gives the step to work on: one in progress, else the first not done, in the order the
  user set. `start` reports it started.
- `done` reports a step done. `--verified` is required: the checks that were run and what they
  showed. `--deviation` says where the build moved away from the plan. The step shows as done at
  once, and the user can reopen it.
- `ask` asks the user a decision the plan doesn't cover, with 2 to 6 options. It shows in the
  browser as a card above the plan, marked "Agent is waiting"; the tab's title and Recent on Home
  show it too. Only the user answers. The answer becomes a line under Implementation decisions,
  cited `[B:<key>]`, and comes back from `wait`. When the web app isn't running, `ask` starts it
  in the background like `plan start` does.
- `wait` returns the answer. After `--timeout` (default 540 seconds) it prints a waiting status
  and exits 0; run it again. `withdraw` takes an ask back; a withdrawn ask is never a decision.
- Every reply gives the plan's revision. When the plan changed since the agent last read it with
  `plan get` (a new decision, an edited section, a step edited, moved or reopened), the reply
  lists what changed.

The plan file ends with two sections Grillado writes, after a `<!-- grillado:build -->` line:
"Build steps" (`[ ]`, `[~]` started, `[x]` done, each with its done check) and "Build log" (what
each done step verified, any deviation, and how each ask ended). Edit the steps in the plan's
Build tab, not in the file: Grillado rewrites those two sections.

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

The six `build_*` tools (`build_next`, `build_start`, `build_done`, `build_ask`, `build_wait`,
`build_withdraw`) return the same results as the `grillado build` commands. Two differences:
`build_ask` doesn't start the web app (its reply says how, when it isn't running), and
`build_wait` waits 50 seconds by default, to stay under a client's tool timeout. `start_plan`
takes `agent`, like `--agent`.

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
