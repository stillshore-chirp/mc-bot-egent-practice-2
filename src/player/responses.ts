import type OpenAI from "openai";
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
import {
  playerThoughtStaleChangeComponents,
  type PlayerThoughtCommitRejectionCode,
  type PlayerThoughtStaleChangeComponent,
} from "./contracts.js";

export type PlayerResponsesClient = Pick<OpenAI, "responses">;

/** Server compaction threshold applies to one rendered request, not run totals. */
export const playerResponseCompactionThreshold = 16_000;

export type PlayerAgentRole = "purpose" | "conversation";
export type PlayerAgentToolResultClass =
  "ok" | "rejected" | "error" | "unknown";

export const playerAgentToolNames = [
  "propose_goal_change",
  "stop_autonomy",
  "resume_autonomy",
  "inspect_player_status",
  "search_memory",
  "observe_body",
  "locate_owner",
  "ask_body_knowledge",
  "describe_operation",
  "search_skills",
  "read_skill",
  "read_skill_history",
  "export_skill_markdown",
  "import_skill_markdown",
  "propose_skill_learning",
  "commit_goal_state",
  "update_understanding",
  "commit_action_decision",
  "remember_owner_fact",
] as const;

export type PlayerAgentToolName =
  (typeof playerAgentToolNames)[number] | "unknown";

export interface PlayerAgentToolRoundActivity {
  readonly name: PlayerAgentToolName;
  readonly resultClass: PlayerAgentToolResultClass;
  readonly resultCode?: PlayerThoughtCommitRejectionCode | undefined;
  readonly staleChangedComponents?:
    readonly PlayerThoughtStaleChangeComponent[] | undefined;
  readonly outputChars: number;
}

/** Content-free per-response diagnostics. Never includes prompts or tool data. */
export interface PlayerAgentRoundActivity {
  readonly runSequence: number;
  readonly role: PlayerAgentRole;
  readonly round: number;
  readonly responseStatus:
    "completed" | "incomplete" | "failed" | "unknown" | "request_error";
  readonly processingStatus: "complete" | "interrupted";
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly latencyMs: number;
  readonly requestInputChars: number;
  readonly initialInputChars: number;
  readonly instructionsChars: number;
  readonly toolSchemaChars: number;
  readonly initialObservationChars: number;
  readonly responseOutputChars: number;
  readonly functionCallCount: number;
  readonly compactionItemPresent: boolean;
  readonly toolCalls: readonly PlayerAgentToolRoundActivity[];
}

let nextRunSequence = 0;

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
  readonly role?: PlayerAgentRole;
  /** Character count only; the observation itself is never copied here. */
  readonly initialObservationChars?: number;
  /** Allows a caller to finish on a tool result it has durably committed. */
  readonly shouldFinishAfterTool?: (
    toolName: string,
    result: unknown,
  ) => boolean;
  readonly onCall?: (metrics: Omit<PlayerAgentCallResult, "text">) => void;
  readonly onRoundActivity?: (activity: PlayerAgentRoundActivity) => void;
}

export function createPlayerTool<I extends z.ZodType>(input: {
  readonly name: string;
  readonly description: string;
  readonly schema: I;
  readonly execute: (value: z.output<I>) => unknown;
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
  const runSequence = ++nextRunSequence;
  const role = input.role ?? "purpose";
  const byName = new Map(
    input.tools.map((tool) => [tool.definition.name, tool]),
  );
  const tools = input.tools.map((tool) => tool.definition);
  const toolSchemaChars = safeSerializedLength(tools);
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
    const requestInputChars = safeSerializedLength(messages);
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
            context_management: [
              {
                type: "compaction",
                compact_threshold: playerResponseCompactionThreshold,
              },
            ],
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
      emitRoundActivity(input, {
        runSequence,
        role,
        round: round + 1,
        responseStatus: "request_error",
        processingStatus: "interrupted",
        inputTokens: 0,
        outputTokens: 0,
        latencyMs: Math.round(performance.now() - started),
        requestInputChars,
        initialInputChars: input.input.length,
        instructionsChars: input.instructions.length,
        toolSchemaChars,
        initialObservationChars: safeCount(input.initialObservationChars),
        responseOutputChars: 0,
        functionCallCount: 0,
        compactionItemPresent: false,
        toolCalls: [],
      });
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
    const responseStatus = response.status ?? "unknown";
    const activityToolCalls: PlayerAgentToolRoundActivity[] = [];
    input.logger.info(
      {
        category: "llm",
        purpose: "player_agent",
        model: input.model,
        latencyMs: elapsed,
        round,
        outcome: responseStatus,
        inputTokens: safeCount(response.usage?.input_tokens),
        outputTokens: safeCount(response.usage?.output_tokens),
      },
      "player agent response completed",
    );
    if (response.status !== "completed") {
      emitRoundActivity(input, {
        runSequence,
        role,
        round: round + 1,
        responseStatus: safeResponseStatus(response.status),
        processingStatus: "complete",
        inputTokens: safeCount(response.usage?.input_tokens),
        outputTokens: safeCount(response.usage?.output_tokens),
        latencyMs: elapsed,
        requestInputChars,
        initialInputChars: input.input.length,
        instructionsChars: input.instructions.length,
        toolSchemaChars,
        initialObservationChars: safeCount(input.initialObservationChars),
        responseOutputChars: safeSerializedLength(response.output),
        functionCallCount: response.output.filter(isFunctionCall).length,
        compactionItemPresent: containsCompactionItem(response.output),
        toolCalls: [],
      });
      throw new Error(`PLAYER_AGENT_${responseStatus.toUpperCase()}`);
    }

    messages.push(...(response.output as ResponseInputItem[]));
    const functionCalls = response.output.filter(isFunctionCall);
    const emitCompletedResponseActivity = (
      processingStatus: "complete" | "interrupted",
    ): void =>
      emitRoundActivity(input, {
        runSequence,
        role,
        round: round + 1,
        responseStatus: "completed",
        processingStatus,
        inputTokens: safeCount(response.usage?.input_tokens),
        outputTokens: safeCount(response.usage?.output_tokens),
        latencyMs: elapsed,
        requestInputChars,
        initialInputChars: input.input.length,
        instructionsChars: input.instructions.length,
        toolSchemaChars,
        initialObservationChars: safeCount(input.initialObservationChars),
        responseOutputChars: safeSerializedLength(response.output),
        functionCallCount: functionCalls.length,
        compactionItemPresent: containsCompactionItem(response.output),
        toolCalls: activityToolCalls,
      });

    // onCall may consume the remaining run budget and abort the active signal.
    // Keep the received model calls count, but record no fabricated tool result.
    if (input.signal?.aborted) {
      emitCompletedResponseActivity("interrupted");
      input.signal.throwIfAborted();
    }
    if (functionCalls.length === 0) {
      emitCompletedResponseActivity("complete");
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
      if (input.signal?.aborted) {
        emitCompletedResponseActivity("interrupted");
        input.signal.throwIfAborted();
      }
      toolCalls += 1;
      const tool = byName.get(call.name);
      let result: unknown;
      let resultClass: PlayerAgentToolResultClass;
      let resultCode: PlayerThoughtCommitRejectionCode | undefined;
      let staleChangedComponents:
        PlayerThoughtStaleChangeComponent[] | undefined;
      if (tool === undefined) {
        result = { ok: false, code: "UNKNOWN_TOOL" };
        resultClass = "unknown";
      } else {
        try {
          const parsed: unknown = JSON.parse(call.arguments);
          result = await tool.execute(parsed);
          resultClass = classifyToolResult(result);
          resultCode = safeCommitRejectionCode(call.name, result);
          staleChangedComponents = safeStaleChangedComponents(
            call.name,
            result,
          );
        } catch (error) {
          result = { ok: false, code: safeErrorCode(error) };
          resultClass = "error";
        }
      }
      if (activityToolCalls.length < 8) {
        activityToolCalls.push({
          name: safeToolName(call.name),
          resultClass,
          ...(resultCode === undefined ? {} : { resultCode }),
          ...(staleChangedComponents === undefined
            ? {}
            : { staleChangedComponents }),
          outputChars: boundedJson(result).length,
        });
      }
      messages.push({
        type: "function_call_output",
        call_id: call.call_id,
        output: boundedJson(result),
      });
      if (input.signal?.aborted) {
        emitCompletedResponseActivity("interrupted");
        input.signal.throwIfAborted();
      }
      if (
        tool !== undefined &&
        input.shouldFinishAfterTool?.(call.name, result) === true
      ) {
        emitCompletedResponseActivity("complete");
        return {
          text: response.output_text.trim(),
          calls,
          inputTokens,
          outputTokens,
          latencyMs,
          toolCalls,
        };
      }
    }
    emitCompletedResponseActivity("complete");
    pruneMessagesBeforeLatestCompaction(messages);
  }
  throw new Error("PLAYER_AGENT_TOOL_ROUND_LIMIT");
}

function emitRoundActivity(
  input: RunPlayerAgentInput,
  activity: PlayerAgentRoundActivity,
): void {
  try {
    input.onRoundActivity?.(activity);
  } catch {
    input.logger.warn(
      { category: "telemetry" },
      "player activity callback failed",
    );
  }
}

function safeResponseStatus(
  status: Response["status"],
): "completed" | "incomplete" | "failed" | "unknown" {
  if (status === "completed" || status === "incomplete" || status === "failed")
    return status;
  return "unknown";
}

function containsCompactionItem(output: readonly unknown[]): boolean {
  return output.some((item) => isRecord(item) && item.type === "compaction");
}

function safeToolName(name: string): PlayerAgentToolName {
  return (playerAgentToolNames as readonly string[]).includes(name)
    ? (name as PlayerAgentToolName)
    : "unknown";
}

function classifyToolResult(value: unknown): PlayerAgentToolResultClass {
  if (!isRecord(value)) return "unknown";
  if (value.ok === true) return "ok";
  if (value.ok === false) return "rejected";
  return "unknown";
}

function safeCommitRejectionCode(
  toolName: string,
  value: unknown,
): PlayerThoughtCommitRejectionCode | undefined {
  if (toolName !== "commit_action_decision" || !isRecord(value))
    return undefined;
  if (value.ok !== false) return undefined;
  const code = value.rejectionCode;
  return code === "CAS_STALE" ||
    code === "STOPPED" ||
    code === "NO_ACTIVE_OPERATION" ||
    code === "PROPOSAL_NOT_PENDING"
    ? code
    : undefined;
}

function safeStaleChangedComponents(
  toolName: string,
  value: unknown,
): PlayerThoughtStaleChangeComponent[] | undefined {
  if (
    toolName !== "commit_action_decision" ||
    !isRecord(value) ||
    value.rejectionCode !== "CAS_STALE" ||
    !Array.isArray(value.changedComponents)
  )
    return undefined;
  const allowed = new Set<string>(playerThoughtStaleChangeComponents);
  const components = [...new Set(value.changedComponents)].filter(
    (component): component is PlayerThoughtStaleChangeComponent =>
      typeof component === "string" && allowed.has(component),
  );
  return components.length === 0 ? ["unknown"] : components;
}

function safeSerializedLength(value: unknown): number {
  try {
    const serialized = JSON.stringify(value);
    return typeof serialized === "string" ? serialized.length : 0;
  } catch {
    return 0;
  }
}

/** Projects unknown snapshot data into a bounded, content-free activity tail. */
export function projectSafePlayerAgentActivityTail(
  value: unknown,
): PlayerAgentRoundActivity[] {
  if (!Array.isArray(value)) return [];
  const result: PlayerAgentRoundActivity[] = [];
  for (const candidate of value.slice(-64)) {
    if (!isRecord(candidate)) continue;
    const runSequence = safePositiveInteger(candidate.runSequence);
    const round = safePositiveInteger(candidate.round);
    const role = candidate.role;
    if (
      runSequence === undefined ||
      round === undefined ||
      (role !== "purpose" && role !== "conversation") ||
      (candidate.processingStatus !== "complete" &&
        candidate.processingStatus !== "interrupted")
    )
      continue;
    const numericFields = [
      candidate.inputTokens,
      candidate.outputTokens,
      candidate.latencyMs,
      candidate.requestInputChars,
      candidate.initialInputChars,
      candidate.instructionsChars,
      candidate.toolSchemaChars,
      candidate.initialObservationChars,
      candidate.responseOutputChars,
      candidate.functionCallCount,
    ];
    if (!numericFields.every(isSafeNonnegativeInteger)) continue;
    const toolCalls: PlayerAgentToolRoundActivity[] = Array.isArray(
      candidate.toolCalls,
    )
      ? candidate.toolCalls
          .slice(0, 8)
          .flatMap((tool): PlayerAgentToolRoundActivity[] => {
            if (!isRecord(tool) || !isSafeNonnegativeInteger(tool.outputChars))
              return [];
            const name =
              typeof tool.name === "string"
                ? safeToolName(tool.name)
                : "unknown";
            const resultClass = safeToolResultClass(tool.resultClass);
            const resultCode =
              resultClass === "rejected"
                ? safeCommitRejectionCode(name, {
                    ok: false,
                    rejectionCode: tool.resultCode,
                  })
                : undefined;
            const staleChangedComponents = safeStaleChangedComponents(name, {
              rejectionCode: tool.resultCode,
              changedComponents: tool.staleChangedComponents,
            });
            return [
              {
                name,
                resultClass,
                ...(resultCode === undefined ? {} : { resultCode }),
                ...(staleChangedComponents === undefined
                  ? {}
                  : { staleChangedComponents }),
                outputChars: safeNonnegativeInteger(tool.outputChars),
              },
            ];
          })
      : [];
    result.push({
      runSequence,
      role,
      round,
      responseStatus: safeActivityResponseStatus(candidate.responseStatus),
      processingStatus: candidate.processingStatus,
      inputTokens: safeNonnegativeInteger(candidate.inputTokens),
      outputTokens: safeNonnegativeInteger(candidate.outputTokens),
      latencyMs: safeNonnegativeInteger(candidate.latencyMs),
      requestInputChars: safeNonnegativeInteger(candidate.requestInputChars),
      initialInputChars: safeNonnegativeInteger(candidate.initialInputChars),
      instructionsChars: safeNonnegativeInteger(candidate.instructionsChars),
      toolSchemaChars: safeNonnegativeInteger(candidate.toolSchemaChars),
      initialObservationChars: safeNonnegativeInteger(
        candidate.initialObservationChars,
      ),
      responseOutputChars: safeNonnegativeInteger(
        candidate.responseOutputChars,
      ),
      functionCallCount: safeNonnegativeInteger(candidate.functionCallCount),
      compactionItemPresent: candidate.compactionItemPresent === true,
      toolCalls,
    });
  }
  return result;
}

function safeActivityResponseStatus(
  value: unknown,
): PlayerAgentRoundActivity["responseStatus"] {
  return value === "completed" ||
    value === "incomplete" ||
    value === "failed" ||
    value === "request_error"
    ? value
    : "unknown";
}

function safeToolResultClass(value: unknown): PlayerAgentToolResultClass {
  return value === "ok" || value === "rejected" || value === "error"
    ? value
    : "unknown";
}

function safePositiveInteger(value: unknown): number | undefined {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0
    ? value
    : undefined;
}

function safeNonnegativeInteger(value: unknown): number {
  return isSafeNonnegativeInteger(value) ? value : 0;
}

function isSafeNonnegativeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

/**
 * Trim old context only after every call in the response has an output. If a
 * call straddles the compaction item, retain the call and its complete suffix.
 */
function pruneMessagesBeforeLatestCompaction(
  messages: ResponseInputItem[],
): void {
  let latestCompaction = -1;
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const item = messages[index];
    if (isRecord(item) && item.type === "compaction") {
      latestCompaction = index;
      break;
    }
  }
  if (latestCompaction <= 0) return;

  const outputCallIds = new Set<string>();
  for (let index = latestCompaction + 1; index < messages.length; index += 1) {
    const item = messages[index];
    if (
      isRecord(item) &&
      item.type === "function_call_output" &&
      typeof item.call_id === "string"
    )
      outputCallIds.add(item.call_id);
  }
  if (outputCallIds.size === 0) {
    messages.splice(0, latestCompaction);
    return;
  }

  let keepFrom = latestCompaction;
  for (let index = 0; index < latestCompaction; index += 1) {
    const item = messages[index];
    if (
      isRecord(item) &&
      item.type === "function_call" &&
      typeof item.call_id === "string" &&
      outputCallIds.has(item.call_id)
    ) {
      keepFrom = index;
      break;
    }
  }
  if (keepFrom > 0) messages.splice(0, keepFrom);
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
    const output = JSON.stringify(value, (_key, nested: unknown) =>
      typeof nested === "bigint" ? nested.toString() : nested,
    );
    serialized = typeof output === "string" ? output : "null";
  } catch {
    return JSON.stringify({ ok: false, code: "OUTPUT_NOT_SERIALIZABLE" });
  }
  if (serialized.length <= 24_000) return serialized;
  return JSON.stringify({
    ok: false,
    code: "OUTPUT_LIMIT",
    detail: serialized.slice(0, 23_500),
  });
}
