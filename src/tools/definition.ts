import { z } from "zod";

import type { ToolContext, ToolResult } from "./contracts.js";

export interface ToolFixtures {
  valid: readonly unknown[];
  invalid: readonly unknown[];
}

export interface ToolDefinition<
  Name extends string = string,
  Input extends z.ZodType = z.ZodType,
  Output = unknown,
> {
  name: Name;
  description: string;
  input: Input;
  fixtures: ToolFixtures;
  action: boolean;
  execute(
    input: z.output<Input>,
    context: ToolContext,
  ): Promise<ToolResult<Output>>;
}

export function toOpenAIFunctionTool(definition: ToolDefinition) {
  const schema = z.toJSONSchema(definition.input, {
    target: "draft-7",
  }) as Record<string, unknown>;
  delete schema.$schema;
  return {
    type: "function" as const,
    name: definition.name,
    description: definition.description,
    parameters: schema,
    strict: true,
  };
}
