// `grillado mcp` (v1.2 item 1): a stdio MCP server over the same data dir as the web app, so the
// coding agent the user builds with can read plans and decisions, start a new plan, and comment.
// Local only: no network. stdout carries the protocol; anything else goes to stderr.
// The operations themselves live in plans.ts (plan 004), shared with `grillado plan …`.
import { McpServer, ResourceTemplate } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { PROVIDER_IDS } from "../core/providers/types.ts";
import { ImportError } from "../core/found/import.ts";
import { FoundService } from "./found.ts";
import { shellQuote } from "./launch.ts";
import { type Store, defaultDataDir } from "./store.ts";
import { buildAsk, buildDone, buildNext, buildStart, buildWait, buildWithdraw } from "./build.ts";
import {
  MAX_COMMENT,
  MAX_CONTEXT,
  MAX_IDEA,
  MAX_QUOTE,
  PLAN_ID,
  URI,
  agentFor,
  commentOnPlan,
  getDecisions,
  getPlan,
  isDraft,
  listPlans,
  loadPlan,
  markdownOf,
  sessionUrl,
  startPlan,
  titleOf,
} from "./plans.ts";

export { UnknownPlan, decisionsOf, markdownOf, summary } from "./plans.ts";

const planId = z.string().regex(PLAN_ID, "A plan id looks like 2026-10-26-1a2b3c4d (see list_plans).");

const text = (t: string) => ({ type: "text" as const, text: t });
const json = (v: unknown) => text(JSON.stringify(v, null, 2));

type Result = { content: ReturnType<typeof text>[]; structuredContent?: Record<string, unknown> };

export interface McpOptions {
  home?: string;
  env?: NodeJS.ProcessEnv;
  scan?: boolean;
}

/** Tool errors come back as `isError` results the agent can read, not protocol errors. */
async function safely(fn: () => Result | Promise<Result>) {
  try {
    return await fn();
  } catch (err: any) {
    return { content: [text(String(err?.message ?? err))], isError: true };
  }
}

/** appLine: how to start the web app for this build and data dir, for start_plan's app-closed hint
 *  (main passes launch.ts's appLine; the fallback is the published package with this data dir). */
export function createMcpServer(
  store: Store,
  version = "0.0.0-dev",
  appLine = `npx grillado${store.dir === defaultDataDir() ? "" : ` --data-dir ${shellQuote(store.dir)}`}`,
  options: McpOptions = {},
): McpServer {
  const mcp = new McpServer({ name: "grillado", version });
  const clientName = () => mcp.server.getClientVersion()?.name;
  const projectPath = z.string().min(1).max(4096).optional().describe("The project folder (default: the folder the MCP server runs in)");

  mcp.registerTool(
    "list_plans",
    {
      title: "List plans",
      description: "List the plans in Grillado, newest first: id, title, status, whether it is still a draft, and its resource URI.",
      inputSchema: {},
    },
    async () =>
      safely(() => {
        const plans = listPlans(store);
        return { content: [plans.length ? json(plans) : text("No plans yet. Use start_plan to send an idea to Grillado.")], structuredContent: { plans } };
      }),
  );

  mcp.registerTool(
    "get_plan",
    {
      title: "Get a plan",
      description:
        "Get one plan's Markdown and its resolved decisions with their answers. A plan whose interview isn't finished comes back as a draft (draft: true) built from the decisions so far. Once the plan has been sent to GitHub or Linear from the browser, issues holds the links (null before).",
      inputSchema: { plan: planId.describe("The plan id from list_plans") },
    },
    async ({ plan }) =>
      safely(() => {
        const p = getPlan(store, plan);
        return {
          content: [text(p.markdown), json({ id: p.id, title: p.title, status: p.status, draft: p.draft, decisions: p.decisions, open: p.open, issues: p.issues })],
          structuredContent: p,
        };
      }),
  );

  mcp.registerTool(
    "get_decisions",
    {
      title: "Get a plan's decisions",
      description: "Get the decisions behind one plan: each question's answer, the round it was settled in and what it depends on, plus decisions still open or waiting to be asked again.",
      inputSchema: { plan: planId.describe("The plan id from list_plans") },
    },
    async ({ plan }) =>
      safely(() => {
        const d = getDecisions(store, plan);
        return { content: [json(d)], structuredContent: d };
      }),
  );

  mcp.registerTool(
    "start_plan",
    {
      title: "Start a plan",
      description:
        "Send a new idea to Grillado to be planned. Creates the session and returns its local URL; the user answers the interview questions in the browser. Give the URL to the user.",
      inputSchema: {
        idea: z.string().trim().min(1, "Describe the idea.").max(MAX_IDEA).describe("The idea, in the user's words"),
        context: z.string().max(MAX_CONTEXT).optional().describe("Optional background: the codebase, constraints, what exists already"),
        path: projectPath,
        agent: z.string().max(40).optional().describe("The agent that asks and writes the plan (claude, grok): one that can read the project. Default: the one selected in Grillado"),
      },
    },
    async ({ idea, context, path, agent }) =>
      safely(async () => {
        const env = options.env ?? process.env;
        const r = await startPlan(store, { idea, context, cwd: path ?? process.cwd(), agent: agentFor(agent), from: clientName() ?? "", appLine, home: options.home, scanOff: options.scan === false || env.GRILLADO_NO_SCAN === "1" });
        return { content: [text(`Started plan ${r.id}. ${r.next}`)], structuredContent: r };
      }),
  );

  mcp.registerTool(
    "add_comment",
    {
      title: "Comment on a plan",
      description:
        "Leave a comment on a passage of a written plan. It shows in Grillado's Comments rail as from the coding agent. `quote` must be copied exactly from the plan's Markdown (get_plan).",
      inputSchema: {
        plan: planId.describe("The plan id from list_plans"),
        quote: z.string().min(1, "Quote the passage the comment is on.").max(MAX_QUOTE).describe("The exact plan text the comment is on"),
        text: z.string().trim().min(1, "Write the comment.").max(MAX_COMMENT).describe("The comment"),
      },
    },
    async ({ plan, quote, text: body }) =>
      safely(() => {
        const r = commentOnPlan(store, { plan, quote, text: body, client: clientName() });
        return { content: [text(`Comment added to plan ${plan}. It's in Grillado's Comments rail.`)], structuredContent: r };
      }),
  );

  // The plan-to-build loop: the same six operations as `grillado build …`, with the same results.
  const plan = planId.describe("The plan id from list_plans");
  const stepRef = z.union([z.string().max(80), z.number().int().min(1)]).optional().describe("The step's number (1, 2, …) or key. Default: the step in progress, else the next one");
  const built = (r: { next: string }) => ({ content: [text(r.next), json(r)], structuredContent: r as Record<string, unknown> });

  mcp.registerTool(
    "build_next",
    {
      title: "Next build step",
      description:
        "Get the build step to work on in a plan: one already in progress, else the first not done, in the user's order, with its done check. Every build_* reply gives the plan's revision and, when the plan changed since you last read it (get_plan), what changed: read the plan again before going on.",
      inputSchema: { plan },
    },
    async ({ plan: id }) => safely(() => built(buildNext(store, id))),
  );

  mcp.registerTool(
    "build_start",
    {
      title: "Start a build step",
      description: "Report that you started a build step, so the user sees what you are working on.",
      inputSchema: { plan, step: stepRef },
    },
    async ({ plan: id, step }) => safely(() => built(buildStart(store, id, step))),
  );

  mcp.registerTool(
    "build_done",
    {
      title: "Finish a build step",
      description:
        "Report a build step done. `verified` is required: the checks you ran and what they showed. `deviation` says where you moved away from the plan, if you did. The user can reopen the step.",
      inputSchema: {
        plan,
        step: stepRef,
        verified: z.string().trim().min(1, "Say what you verified.").max(1000).describe("The checks you ran and what they showed"),
        deviation: z.string().max(1000).optional().describe("Where you moved away from the plan, if you did"),
      },
    },
    async ({ plan: id, step, verified, deviation }) => safely(() => built(buildDone(store, id, step, { verified, deviation }))),
  );

  mcp.registerTool(
    "build_ask",
    {
      title: "Ask the user a decision",
      description:
        "Ask the user a decision the plan doesn't cover, with 2 to 6 options of yours. It shows in Grillado as a card; only the user answers it, and the answer becomes a cited decision in the plan. Then call build_wait. Never answer it yourself and never guess meanwhile.",
      inputSchema: {
        plan,
        key: z.string().max(64).describe('A new lowercase-kebab-case key for this ask, like "ask-storage"'),
        title: z.string().trim().min(1).max(200).describe("The question"),
        body: z.string().max(1000).optional().describe("What the user needs to know to decide"),
        options: z
          .array(z.object({ id: z.string().max(64), label: z.string().max(200), description: z.string().max(400).optional() }))
          .min(2)
          .max(6)
          .describe("The options, each with a short id and a label"),
        suggest: z.string().max(64).optional().describe("The id of the option you would pick; shown as suggested, never applied for the user"),
        step: stepRef,
      },
    },
    async ({ plan: id, key, title, body, options: opts, suggest, step }) =>
      safely(() => {
        const r = buildAsk(store, id, { key, title, body, options: opts, recommended: suggest, step });
        // Over MCP nothing starts the web app: say how, when it isn't running.
        const next = r.url ? r.next : `${r.next} They start it with: ${appLine}`;
        return built({ ...r, next });
      }),
  );

  mcp.registerTool(
    "build_wait",
    {
      title: "Wait for the user's answer",
      description:
        "Wait for the user to answer an ask. Returns the answer, or result \"waiting\" when `timeout` seconds pass first (call it again), or \"withdrawn\".",
      inputSchema: {
        plan,
        ask: z.string().max(64).describe("The key you gave build_ask"),
        timeout: z.number().int().min(0).max(540).optional().describe("Seconds to wait before returning \"waiting\" (default 50; keep it under your client's tool timeout)"),
      },
    },
    async ({ plan: id, ask, timeout }) => safely(async () => built(await buildWait(store, id, ask, timeout ?? 50))),
  );

  mcp.registerTool(
    "build_withdraw",
    {
      title: "Withdraw an ask",
      description: "Take back an ask you no longer need. A withdrawn ask is shown as withdrawn and is never recorded as a decision.",
      inputSchema: { plan, ask: z.string().max(64).describe("The key you gave build_ask"), reason: z.string().max(300).optional().describe("Why you no longer need it") },
    },
    async ({ plan: id, ask, reason }) => safely(() => built(buildWithdraw(store, id, ask, reason))),
  );

  // v1.3 item 1: what's in the agent's project that Grillado could import. Same scan as the web app.
  const services = new Map<string, FoundService>();
  const found = (dir?: string) => {
    const cwd = dir || process.cwd();
    let f = services.get(cwd);
    if (!f) services.set(cwd, (f = new FoundService({ store, cwd, home: options.home, env: options.env, off: options.scan === false || (options.env ?? process.env).GRILLADO_NO_SCAN === "1" })));
    if (f.skip) throw new Error(f.skip === "off" ? "The project scan is off (GRILLADO_NO_SCAN)." : `Not a project folder (${f.skip === "home" ? "the home folder" : f.skip === "root" ? "a filesystem root" : "Grillado's data folder"}). Pass the project's path.`);
    return f;
  };

  mcp.registerTool(
    "list_project_sources",
    {
      title: "List plans found in a project",
      description:
        "List the planning sessions (Claude Code, Codex) and plan files (Cursor plans, PLAN.md, docs/plans) found in a project that Grillado can import as a plan. Read-only: nothing is imported.",
      inputSchema: { path: projectPath },
    },
    async ({ path }) =>
      safely(async () => {
        const f = found(path);
        const r = await f.scan();
        const sources = r.rows;
        const head = `${r.project.name}${r.partial ? " (partial: the scan ran out of time)" : ""}`;
        return { content: [sources.length ? json({ project: head, sources }) : text(`Nothing to import found in ${head}.`)], structuredContent: { project: r.project, partial: r.partial, sources } };
      }),
  );

  mcp.registerTool(
    "import_source",
    {
      title: "Import a found plan",
      description:
        "Import one source from list_project_sources as a Grillado plan (or update the plan it was imported into before). Only its text is copied: the idea, the answered questions and the plan. Returns the plan id.",
      inputSchema: { id: z.string().regex(/^[0-9a-f]{16}$/, "An id from list_project_sources.").describe("The source id from list_project_sources"), path: projectPath },
    },
    async ({ id, path }) =>
      safely(async () => {
        try {
          const r = await found(path).import(id, store.readConfig().defaultProvider ?? PROVIDER_IDS[0]);
          const url = sessionUrl(store, r.planId);
          const what = { created: "Imported as", updated: "Updated", unchanged: "Already imported, unchanged:", conflict: "The plan was edited in Grillado; the new version is in plan.conflict.md of" }[r.result];
          return { content: [text(`${what} plan ${r.planId}.${url ? ` Open ${url}` : ""}`)], structuredContent: { ...r, url, uri: URI + r.planId } };
        } catch (err) {
          if (err instanceof ImportError) throw new Error(`${err.message} (${err.code})`);
          throw err;
        }
      }),
  );

  mcp.registerResource(
    "plan",
    new ResourceTemplate(`${URI}{id}`, {
      list: async () => ({
        resources: store.list().map((s) => ({
          uri: URI + s.id,
          name: titleOf(s),
          description: isDraft(s) ? `Draft (${s.status})` : "Plan",
          mimeType: "text/markdown",
        })),
      }),
    }),
    { title: "Grillado plan", description: "One plan's Markdown (a draft while its interview isn't finished)", mimeType: "text/markdown" },
    async (uri, { id }) => {
      const s = loadPlan(store, String(id));
      return { contents: [{ uri: uri.href, mimeType: "text/markdown", text: markdownOf(store, s) }] };
    },
  );

  return mcp;
}

export async function runMcp(store: Store, version: string, appLine?: string, options?: McpOptions): Promise<void> {
  const mcp = createMcpServer(store, version, appLine, options);
  await mcp.connect(new StdioServerTransport());
  console.error(`grillado mcp: serving ${store.dir} over stdio`);
}

