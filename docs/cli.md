# Running Grillado

```sh
npx grillado
```

A browser tab opens. Describe the idea, answer rounds of questions (number keys pick, Enter
sends, the recommendation is preselected), confirm the decisions, and get a `plan.md` that cites
the answer behind every decision.

## Where plans are saved

Run Grillado from your project folder. New plans are saved as
`docs/plans/grillado-plan-<session-id>.md` in that folder, so you can commit them with your code.

To plan for another project without restarting, click the project name in the composer and pick a
project you planned in before, or type its folder under **Other folder**. The same menu has
**Save plans in**: a folder inside the project (like `notes/plans`) or a full path elsewhere (like
`~/vault/plans`). Grillado remembers it per project. `--plans-dir <path>` sets it for one run.
Session history, settings and credentials stay in `~/.grillado`. Each session remembers its
project when you reopen it. Existing plans and imported copies keep their original storage location.

When a new session is created, Grillado takes one bounded snapshot of existing plan files in the
project (`PLAN.md`, known plan folders, and earlier Grillado exports). It uses those references as
possibly stale background for consistent follow-up questions and never refreshes them during the
session. Explicit context and current answers take precedence. Use `--no-scan` or
`GRILLADO_NO_SCAN=1` to disable both this snapshot and project-source discovery.

## Options

```
--port <n>          Port (default 4747, or the next free one). With --port, a busy port is an error.
--provider <id>     claude | codex | grok | pi
--model <id>        Passed through to the agent CLI
--max-rounds <n>    Question rounds before the plan is written (default 2)
--no-open           Don't open a browser; just print the URL
--no-scan           Don't read existing plans for context or import (also GRILLADO_NO_SCAN=1)
--no-code           Don't let the agent read this project's files (also GRILLADO_NO_CODE=1)
--plans-dir <path>  Where this folder's plans are saved (default docs/plans; relative paths
                    are inside the folder). Home can switch projects and change it too.
--exit-when-idle    Quit after 30 minutes with no browser open and nothing running
--data-dir <path>   Session data (default ~/.grillado, or $GRILLADO_HOME)
```

Requires Node.js 22 or newer.

Agent-facing commands (`grillado plan`, `grillado skills`, `grillado mcp`) are described in
[agents.md](agents.md).
