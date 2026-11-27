# Plan 004: Coding agents find Grillado and use it with no setup, and the README says how

> **Executor instructions**: Deliver the stated outcome within scope. Adapt routine
> implementation details to current code, preserve the listed contracts, and run
> the relevant acceptance checks. Fix task-caused failures and recheck affected
> behavior. Escalate only the material conditions below. Update the plan's status
> in `.factory/plans/README.md` unless the coordinator owns that index.
>
> **Drift check**: Compare `git diff --stat 3dcd618 -- src test e2e scripts README.md package.json`
> and `git status --short` with the recorded current state. Reconcile routine drift;
> pause dependent work if drift invalidates scope, a protected contract, or an
> unresolved product or permission decision. If plan 002 has landed, the Security text
> already describes read-only access: move that text as it is.

## Status

- **Priority**: P1
- **Effort**: M
- **Risk**: LOW
- **Depends on**: none (independent of 002 and 003; see "Maintenance notes" for the README overlap)
- **Category**: dx
- **Planned at**: commit `3dcd618`, 2026-11-24 (clean tree)

## Why this matters

A coding agent can use Grillado today only if its user first adds the MCP server to that
editor, and nothing tells the agent Grillado exists. So when a user says "let's plan this
feature", the agent plans in chat and Grillado is never opened. After this plan, an agent that
has the Grillado skill recognises a planning request, asks the installed CLI for current
instructions (`grillado skills get plan`), starts a plan with one shell command, waits while
the user answers in the browser, and builds from the result. No MCP setup is needed. The README
shrinks to what a new user needs: how to install it and how to connect it to their agent.

The owner decided on 2026-11-24 that agents drive Grillado through CLI commands, with MCP kept
as an option for people who added it.

## Current state

- `src/cli/main.ts`: entry. Parses args, then either runs `runMcp` (stdout is the MCP protocol)
  or starts the web app. The web folder is found with
  `process.env.GRILLADO_WEB_DIR || path.join(here, "web")` (line 47).
- `src/cli/args.ts`: `parseArgs` takes flags and one positional command, `mcp`, only as the
  first argument (line 29); anything else is `Unknown option`. `HELP` is the `--help` text.
- `src/cli/mcp.ts`: seven tools registered on one `McpServer`: `list_plans`, `get_plan`,
  `get_decisions`, `start_plan`, `add_comment`, `list_project_sources`, `import_source`.
  Each handler holds its own logic inline. Exported helpers: `summary`, `decisionsOf`,
  `markdownOf`, `UnknownPlan`.
- `src/cli/store.ts`: `readServerInfo()` returns `{ pid, port, token }` of a running web app,
  or null when its pid is gone (line 81). The web app writes it on listen
  (`src/cli/server.ts:239`) and clears it on exit.
- `src/cli/server.ts`: `clients` is the set of open browser event streams (line 130);
  `inflight` holds running agent calls; `close()` shuts down cleanly (line 258);
  `onQuit` is how the app asks `main.ts` to stop.
- `src/cli/launch.ts`: `appLine` and `mcpLaunch` build the command that starts this build
  (npx or a local checkout). `src/cli/open.ts`: `canOpenBrowser`, `openBrowser`.
- `scripts/build-cli.mjs`: bundles `src/cli/main.ts` into the single file `dist/cli.js`.
  `package.json` publishes only `dist`, `THIRD_PARTY_NOTICES.md` and `LICENSE`.
- `scripts/check-banned.mjs`: fails the build when `dist/web` or the MCP surface contains a
  term from `BANNED` or a hidden prompt fragment.
- `README.md` (160 lines): intro, Options, MCP setup and tool list, Security, Development,
  Publishing to npm.
- `test/mcp.test.ts` with `test/mcp-fixture.ts` (`tempStore`, `platedSession`,
  `draftSession`): the pattern for testing plan operations without an agent.

How `start_plan` works today, which the new `plan start` must match:

```ts
// src/cli/mcp.ts:182
const cwd = path ?? process.cwd();
const projectContext = await captureProjectContext({ cwd, dataDir: store.dir, home: options.home,
  off: options.scan === false || env.GRILLADO_NO_SCAN === "1" });
const s = createSession({ idea, context, projectContext,
  provider: store.readConfig().defaultProvider ?? PROVIDER_IDS[0] });
s.queued = true;                       // the first round starts when the web app opens it
s.from = (clientName() ?? "").slice(0, 80);
store.create(s, cwd);                  // binds plan.md to <cwd>/docs/plans/
const info = store.readServerInfo();
const url = info ? `http://127.0.0.1:${info.port}/s/${s.id}?t=${info.token}` : null;
```

How other tools do this, verified on this machine with `agent-browser skills --help`:

- A **discovery stub** lives in the tool's repository at `skills/<name>/SKILL.md`. The open
  skills installer (`npx skills add <owner>/<repo>`) copies it into `~/.agents/skills/` and
  links it into each agent's skill folder (seen here: `~/.claude/skills/agent-browser` is a
  link to `~/.agents/skills/agent-browser`, source path `skills/agent-browser/SKILL.md`).
- The stub's front matter `description` is what the agent matches a request against. Its body
  is short and says: run `<tool> skills get <name>` for the real instructions.
- The real instructions ship inside the CLI package, so they always match the installed
  version.

Conventions that apply:

- **stdout is the result.** In `mcp` mode nothing but the protocol may write to stdout
  (`src/cli/main.ts:40`). The new commands follow the same discipline: the result on stdout,
  hints and errors on stderr.
- **Never surface the banned terms** (`src/core/filter.ts:4`) in anything an agent or user
  reads. The new skill text is such a surface.
- **Asset folders are found next to the built file, with an env override**, as the web folder
  is.
- **Errors an agent can read**: MCP tools return plain sentences that say what to do next
  (`UnknownPlan`: "No plan with id … Call list_plans to see the ids."). Keep that voice.

## Commands you will need

| Purpose | Command | Expected on success |
|---|---|---|
| Install | `bun install` | exit 0 |
| Typecheck | `npm run typecheck` | exit 0 |
| Tests | `bun test test/` | all pass |
| Build (web, CLI, banned check) | `npm run build` | exit 0 |
| Run the built CLI | `node dist/cli.js skills list` | the skills table |
| Browser tests | `CHROME_PATH=<chrome> npm run e2e` | exit 0 |

Not run during planning (read-only; this worktree has no `node_modules`).

## Implementation rules relevant to this plan

- **One owner per operation.** Listing, reading, starting and commenting each live in one
  function that both the MCP tool and the CLI command call. Do not copy handler bodies.
- **MCP stays byte-for-byte the same.** Tool names, descriptions, input schemas, result text
  and `structuredContent` do not change. `test/mcp.test.ts` passes without edits.
- **Existing invocations keep working**: `grillado`, `grillado [options]`, `grillado mcp …`,
  and the rule that `mcp` only takes `--data-dir` and `--no-scan` (`src/cli/args.ts:86`).
- **Agent-friendly output.** Every new command takes `--json`. Without it, output is plain
  text an agent can also read. A command that is waiting on the user exits 0 with a status,
  not a failure: many harnesses show a non-zero exit as an error.
- **Exit codes**: 0 result; 1 a problem at run time (unknown plan id, no agent installed, the
  app could not start); 2 wrong usage.
- **Nothing is answered for the user.** No command answers questions, confirms decisions or
  writes a plan. The skill text says so too.
- **Parse input at the boundary.** Reuse the limits MCP already enforces (idea 8,000
  characters, context 20,000, the plan id pattern, `MAX_QUOTE`, `MAX_COMMENT`).
- **Skill text is product copy.** Plain words, short sentences, commands in code blocks, no
  term from the banned list, and no promise the CLI does not keep.
- Keep `args.ts` readable: if subcommand parsing makes `parseArgs` hard to follow, give the
  new commands their own parser module and leave the existing function for the web app and
  `mcp`.

## Design

### 1. `grillado skills`: instructions that match the installed version

```
grillado skills                 list the skills (same as: skills list)
grillado skills list [--json]
grillado skills get <name> [name...] [--json]
```

- Skill files live in the repository under `skill-data/<name>/SKILL.md`, each with front
  matter `name` and `description`. The build copies the folder to `dist/skill-data/`.
- The CLI finds them with `process.env.GRILLADO_SKILLS_DIR || <folder of cli.js>/skill-data`,
  and falls back to the repository's `skill-data/` when run from source.
- `list` prints name and the first line of the description. `get` prints the file body
  preceded by one line: `grillado <version>`. An unknown name exits 2 and lists the names.
- No `--full`, `--ref` or `path` until a skill needs them.

Three skills to write:

| Name | Use | Must cover |
|---|---|---|
| `plan` | The user wants to plan something | When to use it and when not to (a one-line fix does not need a plan). Say in one sentence that a browser tab will open. `plan start` with the idea in the user's own words and what the agent knows about the codebase as context. `plan wait`, and calling it again while the status is `waiting`. What to do when no agent CLI is installed or the app cannot start. Never answer the questions for the user. |
| `build` | A plan exists and the user wants it built | `plan list` and `plan get`. Decisions are settled: follow them and do not reopen them in chat. `[R1:key]` marks cite the decision behind a line. Open decisions go back to the user, not to a guess. `plan comment` to leave a note on a passage. Plans are also files at `docs/plans/grillado-plan-<id>.md`. |
| `mcp` | The harness has the Grillado MCP server | The tool that matches each command, and the one-line setup per editor (the lines now in `README.md:62-88`). |

### 2. The discovery stub

`skills/grillado/SKILL.md` in the repository, installed by `npx skills add victor-teles/grillado`.

- `name: grillado`.
- `description`: written to be matched. It must say what Grillado is in one clause, then the
  requests that should trigger it: planning, scoping, specifying or thinking through a
  feature, app, refactor or migration before building it; phrases such as "help me plan",
  "let's plan", "write a spec", "what should we build", "think this through with me"; work
  that is about to start with product or architecture decisions still open; and reading or
  building from an existing plan at `docs/plans/grillado-plan-*.md`. It ends by saying to
  prefer Grillado over planning in chat when the user wants a plan they can keep.
- `allowed-tools: Bash(grillado:*), Bash(npx grillado:*), Bash(npx -y grillado:*)`.
- Body, under 30 lines: this is a stub; run `npx -y grillado skills get plan` before doing
  anything; `skills get build` when a plan exists; `skills list` for the rest. One line on
  what the user will see (a browser tab with questions). Install line: `npx grillado`.

Also make Grillado findable without the stub:

- `grillado --help` gains a "For coding agents" paragraph: run `grillado skills get plan`.
- `package.json` `description` and `keywords` name planning, spec, coding agents, and the
  supported agent CLIs.
- The README gives a three-line snippet users can paste into `AGENTS.md` or `CLAUDE.md` for
  harnesses without skill support.

### 3. `grillado plan`: the MCP tools as commands

```
grillado plan start <idea> [--context <text>] [--context-file <path>] [--path <dir>]
                           [--from <name>] [--no-open] [--json]
grillado plan wait <id> [--timeout <seconds>] [--json]
grillado plan get <id> [--json]
grillado plan list [--json]
grillado plan comment <id> --quote <text> --text <text> [--json]
```

All take `--data-dir` (and honor `GRILLADO_HOME`) like `mcp` does.

**`plan start`** does what `start_plan` does, then makes sure the user can answer:

1. Create the queued session bound to `--path` or the current folder. `--from` sets
   `Session.from` (the name Recent shows after "From"); without it the row reads
   "From your editor", as an unnamed MCP client does today.
2. If no web app is running (`readServerInfo()` is null), start one in the background for
   this build and data dir, in the project folder, with `--no-open` and the new
   `--exit-when-idle` flag. Wait up to 15 seconds for `server.json`.
3. Open the session URL in the browser, unless `--no-open` or `canOpenBrowser()` is false.
4. Print the result. Text: the plan id, the URL, and one line on what happens next. JSON:
   `{ id, url, opened, app: "running" | "started" | "unavailable", next }`.

If the app cannot be started, the session still exists: print the command that starts the app
(`appLine`) and exit 1.

**`--exit-when-idle`** (web app flag, also documented in `--help`): the app quits when, for 30
minutes, no browser is connected and no agent call is running. Use `clients.size` and
`inflight.size`, and stop through the same path as Ctrl+C so `server.json` is cleared. Without
the flag the app behaves as today. This keeps an agent-started app from running forever.

**`plan wait`** watches the session in the store (poll once a second) until its plan is
written (`status === "plated"` with a plan), or until `--timeout` (default 540 seconds, under
the 10-minute limit some harnesses put on a shell command).

- Ready: print what `plan get` prints. JSON adds `status: "ready"`.
- Not yet: exit 0 with `status: "waiting"` and where the interview is (status, rounds
  answered, decisions so far), plus the session's error message if the agent run failed, so
  the coding agent can tell the user to look at the browser.

**`plan get`** prints the plan Markdown (`markdownOf`, which marks a draft). `--json` gives
what `get_plan` returns as `structuredContent`. **`plan list`** matches `list_plans`.
**`plan comment`** matches `add_comment`, including its refusal on drafts and on a quote that
is not in the plan.

`list_project_sources` and `import_source` stay MCP-only.

### 4. A simple README

New `README.md`, about 70 lines, in this order:

1. **Grillado**: the one-line description, `npx grillado`, and three sentences on what happens
   (a browser tab opens; describe the idea and answer the questions; get a plan saved in
   `docs/plans/`). Requirements in one line: Node.js 22 or newer and one of Claude Code, Codex,
   Grok or pi, logged in.
2. **Use it from your coding agent**:
   - The skill: `npx skills add victor-teles/grillado`, then "plan … with Grillado".
   - One short block per harness (Claude Code, Codex, Cursor): the skill line, and the MCP
     line for those who prefer MCP (moved from the current README, unchanged).
   - Any other agent: the `AGENTS.md` snippet.
3. **More**: links to options, agents and MCP reference, security, contributing, license.

Nothing is deleted. Content moves:

| From README | To |
|---|---|
| Options, plan storage and the project-context paragraph | `docs/cli.md` |
| MCP tool list and behavior, the new `plan` and `skills` commands | `docs/agents.md` |
| Security | `docs/security.md` |
| Development, Publishing to npm | `CONTRIBUTING.md` |

Use relative links. `docs/` is not in the published package, which is fine: npm resolves
README links through the `repository` field.

## Scope

**In scope**:

- `src/cli/main.ts`, `src/cli/args.ts`
- `src/cli/plans.ts` (create: the shared plan operations), `src/cli/mcp.ts` (call them)
- `src/cli/plan-command.ts`, `src/cli/skills-command.ts` (create; names are a suggestion)
- `src/cli/server.ts` (idle exit only), `src/cli/launch.ts` (the background start line)
- `skills/grillado/SKILL.md` (create), `skill-data/plan/SKILL.md`, `skill-data/build/SKILL.md`,
  `skill-data/mcp/SKILL.md` (create)
- `scripts/build-cli.mjs` (copy `skill-data`), `scripts/check-banned.mjs` (scan the skill text)
- `package.json` (`description`, `keywords`; the `e2e` script if a file is added)
- `README.md`, `docs/cli.md`, `docs/agents.md`, `docs/security.md`, `CONTRIBUTING.md` (create)
- `test/` (new tests), `e2e/` (one new file, optional if the unit tests reach the built CLI)
- `.factory/plans/README.md` (status only)

**Out of scope**:

- Any change to MCP tool names, schemas or results.
- The web app's "Use in your editor" panel (`web/src/app/mcp/UseInEditor.tsx`). It keeps
  showing MCP setup. Adding the skill there is a follow-up.
- A built-in installer that writes into agents' skill folders. `npx skills add` owns that.
- Adding a marker to `plan.md` files. See "Maintenance notes".
- A command that answers questions or confirms a plan from the terminal.
- New MCP tools or commands for the build loop (plan 001, slice D).
- Rewriting the moved documentation. Move it; fix only what the move breaks (links, headings).
- Version bump and publish.

## Git workflow

- Branch: `feat/agent-skills`, from `main`.
- Commit only if the operator asked; `feat: …` / `docs: …` messages as in `git log`.
- Do not push or open a pull request unless the operator asked.

## Steps

### Step 1: Share the plan operations

Move the bodies of `list_plans`, `get_plan`, `get_decisions`, `start_plan` and `add_comment`
into `src/cli/plans.ts` as functions over `Store` that return plain values and throw the
existing errors. `mcp.ts` calls them and shapes the MCP result.

**Evidence**: `bun test test/mcp.test.ts` passes with no change to the test file;
`npm run build` passes (its banned check reads the MCP surface).

### Step 2: `grillado skills` and the skill text

Add the command, the three `skill-data` files, the build copy and the banned-term scan of
`skills/` and `skill-data/`.

**Evidence**: tests show `list` names the three skills, `get plan` starts with the version
line and contains the `plan start` and `plan wait` commands exactly as Step 3 implements them,
an unknown name exits 2, and `GRILLADO_SKILLS_DIR` is honored. After `npm run build`,
`node dist/cli.js skills get plan` prints the skill.

### Step 3: `grillado plan` commands

Add the parser and the five commands on top of Step 1's functions.

**Evidence**: tests with `tempStore`, `platedSession` and `draftSession` cover each command in
text and JSON form: `list` and `get` equal the MCP results' data; `get` on a draft carries the
draft note; `comment` adds a thread and refuses a draft and a wrong quote; `wait` returns
`ready` for a plated session at once, and `waiting` at a short timeout for a draft, then
`ready` when the test plates the session while it waits; an unknown id exits 1 with the
existing message; wrong usage exits 2.

### Step 4: Start the app from `plan start`, and idle exit

Add the background start, the browser open and `--exit-when-idle`.

**Evidence**: an integration test runs the built CLI with fake agent binaries on `PATH`
(pattern: `test/helpers.ts` `fakeBinDir`, `fakeEnv`) and `--no-open`: with no app running,
`plan start --json` returns `app: "started"` and a URL that answers HTTP 200, and
`server.json` exists; a second `plan start` returns `app: "running"` and the same port. A
server test with a short idle period (make the period injectable; do not sleep 30 minutes)
shows the app quits when no browser is connected and stays up while one is or a run is going.
The test stops every process it started.

### Step 5: The stub and discoverability

Write `skills/grillado/SKILL.md`, the `--help` paragraph and the `package.json` fields.

**Evidence**: a test parses the stub's front matter (name, description, allowed-tools) and
checks every command the stub and the three skills mention against the real parser, so a
renamed flag fails the test.

### Step 6: README and docs

Write the new README and move the rest as listed. Update `HELP` for the new commands and flag.

**Evidence**: `README.md` has only the three sections in Design; every section that left it
exists in its new file with the same text; every relative link in `README.md`, `docs/*.md` and
`CONTRIBUTING.md` points at a file that exists.

### Step 7: Full check and a real run

**Evidence**: `npm run typecheck`, `bun test test/`, `npm run build` and
`CHROME_PATH=<chrome> npm run e2e` exit 0. Then by hand, with a real agent CLI: copy
`skills/grillado` into `~/.claude/skills/` (or link it), open Claude Code in a test project,
say "let's plan a dark mode toggle", and record what happened.

## Test plan

- Parser: every new command and flag; the old forms unchanged (`grillado`, `--port 5000`,
  `mcp --data-dir x`, the `mcp only takes …` error); `plan` and `skills` reject flags that
  belong to the web app.
- Shared operations: covered through both `test/mcp.test.ts` (unchanged) and the new command
  tests. Model the new tests on `test/mcp.test.ts`.
- Output contract: `--json` output parses and has the documented keys; text output puts
  nothing but the result on stdout (assert stderr separately).
- Skills: list, get, unknown name, env override, version line, banned terms absent, commands
  in the text accepted by the parser.
- App start and idle exit: as in Step 4.
- Docs: the link check in Step 6, as a test so it keeps holding.

## Done criteria

- [ ] `npm run typecheck`, `bun test test/` and `npm run build` exit 0.
- [ ] `CHROME_PATH=<chrome> npm run e2e` exits 0 (existing flows unchanged).
- [ ] `test/mcp.test.ts` is unmodified and passes.
- [ ] `node dist/cli.js skills list` shows `plan`, `build` and `mcp`;
      `node dist/cli.js skills get plan` prints the version line and the skill.
- [ ] With no app running, `node dist/cli.js plan start "x" --no-open --json` creates a
      session, starts the app, and prints a URL that loads; `plan wait <id> --timeout 2`
      prints `waiting` and exits 0; after the interview is finished in the browser,
      `plan wait <id>` prints the plan.
- [ ] An app started that way exits by itself after the idle period and removes `server.json`.
- [ ] `skills/grillado/SKILL.md` exists with `name`, `description` and `allowed-tools`, and no
      skill file contains a banned term (`npm run build` enforces it).
- [ ] Manual run recorded: in Claude Code with the stub installed, a planning request led the
      agent to run `grillado skills get plan` and `grillado plan start` without being told the
      commands.
- [ ] `README.md` is the three sections in Design; `docs/cli.md`, `docs/agents.md`,
      `docs/security.md` and `CONTRIBUTING.md` hold everything that moved; all relative links
      resolve.
- [ ] `git status` shows changes only in the in-scope paths; `.factory/plans/README.md` row
      for 004 is updated.

After merge to the default branch (not part of the local done state, needs the operator):
`npx skills add victor-teles/grillado` installs the stub. Record the result.

## STOP conditions

Pause and report when:

- Sharing the operations cannot keep an MCP result identical. The MCP surface is a contract
  with editors already configured.
- A background app cannot be started reliably from the built CLI on the operator's platform
  (for example the process dies with its parent). Ship `plan start` with `app: "unavailable"`
  and the start line, and report the gap; do not replace it with a foreground server that
  blocks the agent's shell.
- The skills installer needs a repository layout other than `skills/<name>/SKILL.md` to pick
  up the stub. Report what it needs before restructuring.
- Moving documentation would drop a statement the Security text makes and no new home fits.

A harness that ignores the stub's description is a reason to improve the wording and note the
result, not a stop.

## Maintenance notes

- **README overlap with plan 002.** Plan 002 rewrites the Security text. Whichever lands
  second adapts: after this plan, that text lives in `docs/security.md` (and in `HELP`).
- **Skill text is tied to the CLI.** Step 5's test fails when a command in the skills no longer
  parses. Update the skill in the same change as the command.
- **Reviewers**: check that `mcp.ts` only lost logic it now calls, that `plan start` cannot
  leave a background app running without the idle flag, and that the stub's description is
  specific enough not to fire on every message.
- **Follow-ups, deliberately left out**: showing the skill line in the web app's "Use in your
  editor" panel; a short marker in each `plan.md` telling any agent that reads it to run
  `grillado skills get build` (it needs care: the editor and the plan parsers read that file);
  commands for project sources and import.
- **Plan 001, slice D** (the build loop) will add commands and MCP tools for slices and asks.
  They belong next to the `plan` commands and in the `build` skill.

## Execution notes (2026-11-25)

- `plan wait --json` reports `"result": "ready" | "waiting"` (the plan's own `status` field was
  already taken by the session status).
- Agent-facing CLI text (`plans.ts`, `plan-command.ts`) joins `mcp.ts` in the apostrophe check's
  "not shown on screen" list.
- Browser tests now start their servers in their temp home folder: run from the repository root
  they used to write plan files into this repo's `docs/plans/` and (after 002) read the repo.
- **Manual run (Claude Code 2.1.332, stub as a project skill, recording shim for `npx grillado`):**
  "let's plan a dark mode toggle for this app" → `skills get plan` → `plan start "<idea>"
  --context "<what it saw in the project>" --json` → `plan wait` twice → told the user the
  questions were open. In a profile with very many installed skills, Claude Code listed the skill
  by name only (no description), and the same request was planned in chat; naming Grillado in the
  request still works. Not yet verified: `npx skills add victor-teles/grillado` (needs the stub on
  the default branch) and `npx -y grillado` resolving to a published version with these commands.
