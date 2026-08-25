import { randomUUID } from "node:crypto";

import { AppError } from "../domain/errors.js";
import type { CognitiveStage } from "../trace/contracts.js";
import type { TraceService, WithSpanOptions } from "../trace/service.js";
import type { ErrorCategory, ToolContext, ToolResult } from "./contracts.js";
import { getToolDefinition } from "./registry.js";

const runtimeReassessmentTools = new Set([
  "observe_status",
  "observe_surroundings",
  "recall_memory",
]);

const memoryReadTools = new Set(["recall_memory"]);
const memoryWriteTools = new Set([
  "remember_player_fact",
  "remember_location",
  "set_commitment",
  "complete_commitment",
]);

async function safeWithTraceSpan<T>(
  traceService: TraceService | undefined,
  stage: CognitiveStage,
  name: string,
  options: WithSpanOptions<T>,
  operation: () => Promise<T>,
): Promise<T> {
  if (traceService === undefined) return operation();

  let operationPromise: Promise<T> | undefined;
  const invoke = (): Promise<T> => {
    operationPromise = Promise.resolve().then(operation);
    return operationPromise;
  };

  try {
    return await traceService.withSpan(stage, name, options, invoke);
  } catch {
    if (operationPromise !== undefined) {
      return operationPromise;
    }
    return operation();
  }
}

function failure(
  code: string,
  category: ErrorCategory,
  userSummary: string,
  retryable = false,
): ToolResult<never> {
  return {
    success: false,
    error: {
      category,
      code,
      retryable,
      failedAt: "tool_executor",
      confirmedState: {},
      nextActions: [],
      userSummary,
    },
  };
}

export class ToolExecutor {
  readonly #traceService: TraceService | undefined;

  public constructor(traceService?: TraceService) {
    this.#traceService = traceService;
  }

  public async execute(
    name: string,
    serializedArguments: string,
    context: ToolContext,
  ): Promise<ToolResult<unknown>> {
    const definition = getToolDefinition(name);
    const traceName =
      definition === undefined ? "未登録tool" : `tool:${definition.name}`;
    return safeWithTraceSpan(
      this.#traceService,
      "tool",
      traceName,
      {
        summary: "toolを検証・実行",
        resultKind: "tool_result",
        summarizeResult: (result) =>
          result.success ? "tool実行を完了" : "tool実行を拒否または失敗",
      },
      () => this.#executeCore(name, serializedArguments, context),
    );
  }

  async #executeCore(
    name: string,
    serializedArguments: string,
    context: ToolContext,
  ): Promise<ToolResult<unknown>> {
    if (context.requesterUsername !== context.authorizedOwnerUsername) {
      return failure(
        "REQUESTER_NOT_AUTHORIZED",
        "authorization",
        "この操作を依頼する権限がありません。",
      );
    }

    const definition = getToolDefinition(name);
    if (definition === undefined) {
      return failure(
        "UNKNOWN_TOOL",
        "validation",
        "未登録の操作は実行しませんでした。",
      );
    }
    if (
      context.requestKind === "runtime_reassessment" &&
      !runtimeReassessmentTools.has(name)
    ) {
      return failure(
        "RUNTIME_REASSESSMENT_TOOL_NOT_ALLOWED",
        "authorization",
        "状態再評価では観測と記憶参照以外の操作を実行しません。",
      );
    }

    let rawArguments: unknown;
    try {
      rawArguments = JSON.parse(serializedArguments);
    } catch {
      return failure(
        "INVALID_TOOL_ARGUMENT_JSON",
        "validation",
        "操作引数を検証できなかったため実行しませんでした。",
      );
    }

    const parsed = definition.input.safeParse(rawArguments);
    if (!parsed.success) {
      return failure(
        "INVALID_TOOL_ARGUMENTS",
        "validation",
        "操作引数がschemaに一致しないため実行しませんでした。",
      );
    }

    try {
      const stage = memoryReadTools.has(name)
        ? "memory_read"
        : memoryWriteTools.has(name)
          ? "memory_write"
          : definition.action
            ? "minecraft_action"
            : undefined;
      const executeAction = async (): Promise<ToolResult<unknown>> => {
        const actionResult = await definition.execute(parsed.data, context);
        if (
          actionResult.success ||
          (Object.prototype.hasOwnProperty.call(
            actionResult.error.confirmedState,
            "after",
          ) &&
            actionResult.error.category !== "cancelled")
        ) {
          await safeWithTraceSpan(
            this.#traceService,
            "verification",
            "Minecraft状態を検証",
            {
              summary: "実行結果の検証",
              resultKind: "verification_result",
              summarizeResult: (value) =>
                value.success ? "完了条件を確認" : "完了条件を確認できず",
            },
            async () => actionResult,
          );
        }
        if (
          !actionResult.success &&
          actionResult.error.category === "cancelled"
        ) {
          await safeWithTraceSpan(
            this.#traceService,
            "cancellation",
            "操作を中断",
            { summary: "キャンセル結果を処理" },
            async () => undefined,
          );
        }
        return actionResult;
      };
      const result =
        stage === undefined
          ? await definition.execute(parsed.data, context)
          : await safeWithTraceSpan(
              this.#traceService,
              stage,
              stage === "memory_read"
                ? "構造化記憶を参照"
                : stage === "memory_write"
                  ? "構造化記憶を更新"
                  : "Minecraft操作を実行",
              {
                summary:
                  stage === "memory_read"
                    ? "構造化記憶を参照"
                    : stage === "memory_write"
                      ? "構造化記憶を更新"
                      : "Minecraft操作を実行",
                ...(stage === "memory_write"
                  ? {
                      resultKind: "memory_update_result" as const,
                    }
                  : stage === "minecraft_action"
                    ? {
                        resultKind: "minecraft_state_delta" as const,
                      }
                    : {}),
                summarizeResult: (value) =>
                  value.success ? "処理結果を受信" : "処理結果を確認できず",
              },
              stage === "minecraft_action"
                ? executeAction
                : () => definition.execute(parsed.data, context),
            );
      if (definition.action && result.success) {
        const commitmentId = verifiedFulfillmentCommitmentId(
          name,
          parsed.data,
          result,
          context,
        );
        if (commitmentId !== undefined) {
          const receipt = {
            receiptId: randomUUID(),
            commitmentId,
            correlationId: context.correlationId,
            toolName: name,
            evidence: result.evidence,
            used: false,
          };
          context.executionEvidence.verifiedActionReceipts.push(receipt);
          return {
            ...result,
            verificationReceipt: {
              receiptId: receipt.receiptId,
              commitmentId,
              toolName: name,
            },
          };
        }
      }
      return result;
    } catch (error) {
      if (context.signal.aborted) {
        return failure(
          "ACTION_CANCELLED",
          "cancelled",
          "停止指示により中断しました。",
        );
      }
      if (error instanceof AppError) {
        return {
          success: false,
          error: {
            category: error.detail.category,
            code: error.detail.code,
            retryable: error.detail.retryable,
            failedAt: error.detail.failedAt ?? name,
            confirmedState: { ...(error.detail.confirmedState ?? {}) },
            nextActions: error.detail.retryable
              ? ["状態を再観測して再試行可否を判断する"]
              : [],
            userSummary: `操作を完了できませんでした（${error.detail.code}）。`,
          },
        };
      }
      return {
        success: false,
        error: {
          category: "internal",
          code: "TOOL_EXECUTION_FAILED",
          retryable: false,
          failedAt: name,
          confirmedState: {},
          nextActions: ["状態を再観測する"],
          userSummary:
            "操作中に内部エラーが発生し、完了を確認できませんでした。",
        },
      };
    }
  }
}

function verifiedFulfillmentCommitmentId(
  toolName: string,
  input: unknown,
  result: Extract<ToolResult<unknown>, { success: true }>,
  context: ToolContext,
): string | undefined {
  if (
    toolName !== "gather_resource" ||
    input === null ||
    typeof input !== "object" ||
    Array.isArray(input)
  ) {
    return undefined;
  }
  const action = input as {
    readonly commitmentId?: unknown;
    readonly resource?: unknown;
    readonly count?: unknown;
  };
  if (typeof action.commitmentId !== "string") return undefined;
  const commitment = context.memory.getCommitment({
    playerId: context.playerId,
    commitmentId: action.commitmentId,
  });
  if (
    commitment?.status !== "active" ||
    commitment.fulfillment?.toolName !== "gather_resource" ||
    commitment.fulfillment.resource !== action.resource ||
    commitment.fulfillment.count !== action.count ||
    result.evidence.every(({ kind }) => kind !== "inventory_delta") ||
    result.data === null ||
    typeof result.data !== "object" ||
    Array.isArray(result.data)
  ) {
    return undefined;
  }
  const confirmedState = (result.data as { readonly confirmedState?: unknown })
    .confirmedState;
  if (
    confirmedState === null ||
    typeof confirmedState !== "object" ||
    Array.isArray(confirmedState)
  ) {
    return undefined;
  }
  const verified = confirmedState as Readonly<Record<string, unknown>>;
  return verified.resource === action.resource &&
    verified.requestedCount === action.count &&
    typeof verified.collectedCount === "number" &&
    verified.collectedCount >= commitment.fulfillment.count &&
    typeof verified.heldCount === "number" &&
    verified.heldCount >= commitment.fulfillment.count &&
    typeof verified.playerDistance === "number" &&
    verified.playerDistance <= context.limits.followDistance
    ? action.commitmentId
    : undefined;
}
