import { AppError } from "../domain/errors.js";
import type { ErrorCategory, ToolContext, ToolResult } from "./contracts.js";
import { getToolDefinition } from "./registry.js";

const runtimeReassessmentTools = new Set([
  "observe_status",
  "observe_surroundings",
  "recall_memory",
]);

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
  public async execute(
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
      const result = await definition.execute(parsed.data, context);
      if (definition.action && result.success) {
        context.executionEvidence.verifiedActionSuccess = true;
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
