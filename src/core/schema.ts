import { z } from "zod";

/** Machine-readable key for a decision, unique within a session (e.g. "storage-engine"). */
const DecisionKey = z
  .string()
  .min(1)
  .max(64)
  .regex(/^[a-z0-9][a-z0-9-]*$/, "use lowercase-kebab-case keys");

export const OptionSchema = z.object({
  id: z.string().min(1).max(40),
  label: z.string().min(1).max(200),
  description: z.string().max(600),
});

export const QuestionSchema = z.object({
  key: DecisionKey,
  title: z.string().min(1).max(160),
  body: z.string().max(2000),
  options: z.array(OptionSchema).min(2).max(6),
  recommendedOptionId: z.string().min(1),
  /** Keys of decisions settled in earlier rounds that this question builds on. */
  dependsOn: z.array(DecisionKey),
});

/** What the agent returns for a round request. One flat object so every CLI's schema mode accepts it. */
export const RoundReplySchema = z.object({
  type: z.enum(["ask_round", "frontier_empty"]),
  questions: z.array(QuestionSchema).max(9),
  summary: z.string().max(2000),
});

export const CitationSchema = z.object({
  round: z.number().int().min(1),
  questionId: DecisionKey,
});

export const PlanReplySchema = z.object({
  type: z.literal("plan"),
  title: z.string().min(1).max(200),
  markdown: z.string().min(1).max(60_000),
  decisions: z
    .array(
      z.object({
        round: z.number().int().min(1),
        questionId: DecisionKey,
        statement: z.string().min(1).max(600),
      }),
    )
    .min(0),
  openDecisions: z.array(z.string().max(400)),
});

export type Option = z.infer<typeof OptionSchema>;
export type Question = z.infer<typeof QuestionSchema>;
export type RoundReply = z.infer<typeof RoundReplySchema>;
export type PlanReply = z.infer<typeof PlanReplySchema>;

/**
 * JSON Schema for the CLI schema flags. OpenAI-style strict structured output (Codex) needs every
 * property listed in `required` and `additionalProperties: false`, so we normalize to that.
 */
export function toStrictJsonSchema(schema: z.ZodType): Record<string, unknown> {
  const json = z.toJSONSchema(schema, { target: "draft-7" }) as Record<string, unknown>;
  delete json.$schema;
  const walk = (node: unknown) => {
    if (!node || typeof node !== "object") return;
    if (Array.isArray(node)) return node.forEach(walk);
    const obj = node as Record<string, unknown>;
    if (obj.type === "object" && obj.properties && typeof obj.properties === "object") {
      obj.required = Object.keys(obj.properties as object);
      obj.additionalProperties = false;
    }
    // Strict structured-output modes reject some keywords. Zod still enforces them after parsing.
    delete obj.pattern;
    delete obj.minLength;
    delete obj.maxLength;
    if (obj.maximum === Number.MAX_SAFE_INTEGER) delete obj.maximum;
    if ("const" in obj) {
      obj.enum = [obj.const];
      delete obj.const;
    }
    for (const value of Object.values(obj)) walk(value);
  };
  walk(json);
  return json;
}

export const roundJsonSchema = () => toStrictJsonSchema(RoundReplySchema);
export const planJsonSchema = () => toStrictJsonSchema(PlanReplySchema);
