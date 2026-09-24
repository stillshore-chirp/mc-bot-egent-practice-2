import OpenAI from "openai";
import type {
  FunctionTool,
  Response,
  ResponseFunctionToolCall,
  ResponseInputItem,
  ResponseCreateParamsNonStreaming,
} from "openai/resources/responses/responses.js";
import { z } from "zod";

import type { Logger } from "pino";

import type { TraceService } from "../trace/service.js";

export type PlayerResponsesClient = Pick<OpenAI, "responses">;

export interface PlayerAgentTool {
  readonly definition: FunctionTool;
  execute(argumentsValue: unknown): Promise<unknown>;
}

export interface PlayerAgentCallResult {
  readonly text: string;
  readonly calls: number;
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly latencyMs: number;
  readonly toolCalls: number;
}

export interface RunPlayerAgentInput {
  readonly client: PlayerResponsesClient;
  readonly model: string;
  readonly instructions: string;
  readonly input: string;
  readonly tools: readonly PlayerAgentTool[];
  readonly logger: Logger;
  readonly trace?: TraceService;
  readonly signal?: AbortSignal;
  readonly maxRounds?: number;
  readonly onCall?: (metrics: Omit<PlayerAgentCallResult, "text">) => void;
}

export function createPlayerTool<I extends z.ZodType>(input: {
  readonly name: string;
  readonly description: string;
  readonly schema: I;
  readonly execute: (value: z.output<I>) => Promise<unknown> | unknown;
}): PlayerAgentTool {
  const parameters = toStrictOpenAISchema(
    z.toJSONSchema(input.schema, { target: "draft-7" }),
  );
  return {
    definition: {
      type: "function",
      name: input.name,
      description: input.description,
      parameters,
      strict: true,
    },
    execute: async (argumentsValue) => {
      const parsed = input.schema.safeParse(argumentsValue);
      if (!parsed.success) return { ok: false, code: "INVALID_ARGUMENTS" };
      return await input.execute(parsed.data);
    },
  };
}

/** Normalize Zod JSON Schema to the Responses strict function-tool subset. */
export function toStrictOpenAISchema(value: unknown): Record<string, unknown> {
  const normalized = normalizeStrictNode(value);
  if (!isRecord(normalized) || normalized.type !== "object") {
    throw new TypeError(
      "OpenAI strict function parameters must be an object schema",
    );
  }
  return normalized;
}

function normalizeStrictNode(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(normalizeStrictNode);
  if (!isRecord(value)) return value;
  const result: Record<string, unknown> = {};
  for (const [key, nested] of Object.entries(value)) {
    if (
      key === "$schema" ||
      key === "$id" ||
      key === "default" ||
      key === "examples"
    )
      continue;
    if (key === "oneOf") {
      result.anyOf = Array.isArray(nested)
        ? nested.map(normalizeStrictNode)
        : nested;
      continue;
    }
    result[key] = normalizeStrictNode(nested);
  }
  if (result.type === "object" || isRecord(result.properties)) {
    const properties = isRecord(result.properties) ? result.properties : {};
    result.properties = properties;
    result.required = Object.keys(properties);
    result.additionalProperties = false;
  }
  return result;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

export async function runPlayerAgent(
  input: RunPlayerAgentInput,
): Promise<PlayerAgentCallResult> {
  const byName = new Map(
    input.tools.map((tool) => [tool.definition.name, tool]),
  );
  const tools = input.tools.map((tool) => tool.definition);
  const messages: ResponseInputItem[] = [
    { role: "user", content: input.input },
  ];
  const maxRounds = input.maxRounds ?? 6;
  let calls = 0;
  let toolCalls = 0;
  let inputTokens = 0;
  let outputTokens = 0;
  let latencyMs = 0;

  for (let round = 0; round < maxRounds; round += 1) {
    input.signal?.throwIfAborted();
    const started = performance.now();
    let response: Response;
    try {
      const request = (): Promise<Response> =>
        input.client.responses.create(
          {
            model: input.model,
            instructions: input.instructions,
            input: messages,
            tools,
            tool_choice: "auto",
            parallel_tool_calls: false,
            store: false,
            include: ["reasoning.encrypted_content"],
          } satisfies ResponseCreateParamsNonStreaming,
          {
            ...(input.signal === undefined ? {} : { signal: input.signal }),
          },
        );
      response =
        input.trace === undefined
          ? await request()
          : await input.trace.withSpan(
              "deliberation",
              "Responses APIで判断",
              {
                summary: "自律プレイヤーの判断を実行",
                metrics: (result, durationMs) => ({
                  durationMs,
                  modelLatencyMs: durationMs,
                  inputTokens: safeCount(result.usage?.input_tokens),
                  outputTokens: safeCount(result.usage?.output_tokens),
                }),
                summarizeResult: (result) => `response_${result.status}`,
              },
              request,
            );
    } catch (error) {
      input.onCall?.({
        calls: 1,
        inputTokens: 0,
        outputTokens: 0,
        latencyMs: Math.round(performance.now() - started),
        toolCalls,
      });
      throw error;
    }
    calls += 1;
    const elapsed = Math.round(performance.now() - started);
    latencyMs += elapsed;
    inputTokens += safeCount(response.usage?.input_tokens);
    outputTokens += safeCount(response.usage?.output_tokens);
    input.onCall?.({
      calls: 1,
      inputTokens: safeCount(response.usage?.input_tokens),
      outputTokens: safeCount(response.usage?.output_tokens),
      latencyMs: elapsed,
      toolCalls: 0,
    });
    input.logger.info(
      {
        category: "llm",
        purpose: "player_agent",
        model: input.model,
        latencyMs: elapsed,
        round,
        outcome: response.status,
        inputTokens: safeCount(response.usage?.input_tokens),
        outputTokens: safeCount(response.usage?.output_tokens),
      },
      "player agent response completed",
    );
    if (response.status !== "completed") {
      throw new Error(`PLAYER_AGENT_${response.status.toUpperCase()}`);
    }

    messages.push(...(response.output as ResponseInputItem[]));
    const functionCalls = response.output.filter(isFunctionCall);
    if (functionCalls.length === 0) {
      return {
        text: response.output_text.trim(),
        calls,
        inputTokens,
        outputTokens,
        latencyMs,
        toolCalls,
      };
    }
    for (const call of functionCalls) {
      toolCalls += 1;
      const tool = byName.get(call.name);
      let result: unknown;
      if (tool === undefined) {
        result = { ok: false, code: "UNKNOWN_TOOL" };
      } else {
        try {
          const parsed: unknown = JSON.parse(call.arguments);
          result = await tool.execute(parsed);
        } catch (error) {
          result = { ok: false, code: safeErrorCode(error) };
        }
      }
      messages.push({
        type: "function_call_output",
        call_id: call.call_id,
        output: boundedJson(result),
      });
    }
  }
  throw new Error("PLAYER_AGENT_TOOL_ROUND_LIMIT");
}

function isFunctionCall(
  item: Response["output"][number],
): item is ResponseFunctionToolCall {
  return item.type === "function_call";
}

function safeCount(value: number | undefined): number {
  return value !== undefined && Number.isInteger(value) && value > 0
    ? value
    : 0;
}

function safeErrorCode(error: unknown): string {
  if (error instanceof Error && /^[A-Z][A-Z0-9_]{0,63}$/u.test(error.message))
    return error.message;
  return error instanceof Error ? error.name : "TOOL_ERROR";
}

function boundedJson(value: unknown): string {
  let serialized: string;
  try {
    serialized = JSON.stringify(value, (_key, nested: unknown) =>
      typeof nested === "bigint" ? nested.toString() : nested,
    );
  } catch {
    return JSON.stringify({ ok: false, code: "OUTPUT_NOT_SERIALIZABLE" });
  }
  if (serialized === undefined) return "null";
  if (serialized.length <= 24_000) return serialized;
  return JSON.stringify({
    ok: false,
    code: "OUTPUT_LIMIT",
    detail: serialized.slice(0, 23_500),
  });
}
