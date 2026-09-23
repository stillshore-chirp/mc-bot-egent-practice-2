import { randomUUID } from "node:crypto";

import { AppError } from "../domain/errors.js";
import type { CognitiveStage } from "../trace/contracts.js";
import type { TraceService, WithSpanOptions } from "../trace/service.js";
import type { ErrorCategory, ToolContext, ToolResult } from "./contracts.js";
import { getToolDefinition, ownerScopedMutationToolNames } from "./registry.js";

export const runtimeReassessmentToolNames = new Set([
  "observe_status",
  "observe_surroundings",
  "recall_memory",
  "get_delivery_targets",
  "list_behavior_memory",
]);

const memoryReadTools = new Set([
  "recall_memory",
  "get_delivery_targets",
  "list_behavior_memory",
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
    if (name === "build_base" && context.baseBuildAuthorized === true) {
      context.baseBuildAuthorizationUsage ??= { consumed: false };
    }
    const executionContext: ToolContext = {
      ...context,
      executeSafeActionStep: (step, stepContext) =>
        this.execute(step.tool, JSON.stringify(step.input), {
          ...stepContext,
          safeActionStepExecution: true,
        }),
    };
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
      () => this.#executeCore(name, serializedArguments, executionContext),
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
      !runtimeReassessmentToolNames.has(name)
    ) {
      return failure(
        "RUNTIME_REASSESSMENT_TOOL_NOT_ALLOWED",
        "authorization",
        "状態再評価では観測と記憶参照以外の操作を実行しません。",
      );
    }
    if (
      context.safeActionClarification !== undefined &&
      definition.action &&
      name !== "stop_current_action"
    ) {
      return {
        success: false,
        error: {
          category: "authorization",
          code: "OWNER_GOAL_CLARIFICATION_REQUIRED",
          retryable: false,
          failedAt: "owner_goal_boundary",
          confirmedState: { ownerGoal: "clarification_required" },
          nextActions: [context.safeActionClarification],
          userSummary: context.safeActionClarification,
        },
      };
    }
    if (name === "build_base" && context.baseBuildAuthorized !== true) {
      return failure(
        "BASE_BUILD_NOT_AUTHORIZED",
        "authorization",
        context.baseBuildClarification ??
          "拠点設営は利用者の明示依頼と建築条件を確認してから始めます。",
      );
    }
    const ownerScopedMutation =
      definition.action || ownerScopedMutationToolNames.has(name);
    if (context.allowActionTools === false && ownerScopedMutation) {
      return failure(
        "STOPPED_GOAL_ACTION_NOT_ALLOWED",
        "authorization",
        "停止済みの作業は、明示的に再開するまで動かしません。",
      );
    }
    if (
      ownerScopedMutation &&
      context.allowedActionToolNames !== undefined &&
      !context.allowedActionToolNames.includes(name)
    ) {
      return failure(
        "OWNER_ACTION_SCOPE_NOT_ALLOWED",
        "authorization",
        "今回の依頼で許可された操作ではないため開始しません。",
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
    if (name === "equip_armor") {
      if (
        context.armorEquipAuthorized !== true ||
        context.armorEquipAuthorizationUsage?.consumed !== false
      ) {
        return failure(
          "ARMOR_EQUIP_NOT_AUTHORIZED",
          "authorization",
          "防具を着ける明示依頼を確認できないため、装備は変えませんでした。",
        );
      }
      context.armorEquipAuthorizationUsage.consumed = true;
    }
    if (
      (name === "register_delivery_target" ||
        name === "forget_delivery_target") &&
      context.allowedDeliveryTargetKinds !== undefined &&
      !context.allowedDeliveryTargetKinds.includes(
        (parsed.data as { kind: "home" | "chest" }).kind,
      )
    ) {
      return failure(
        "OWNER_ACTION_TARGET_NOT_ALLOWED",
        "authorization",
        "今回の依頼で指定された登録先ではないため変更しません。",
      );
    }

    if (
      definition.authorization !== undefined &&
      !context.safeActionStepExecution &&
      !isStaticGatherLimitFailure(name, parsed.data, context) &&
      !isDirectActionAuthorized(definition.authorization, parsed.data, context)
    ) {
      return failure(
        "SAFE_ACTION_AUTHORIZATION_INVALID",
        "authorization",
        "この操作の対象と数量を所有者の認可範囲で確認できないため、開始しませんでした。",
      );
    }

    if (name === "build_base") {
      if (context.baseBuildAuthorizationUsage?.consumed === true) {
        return failure(
          "BASE_BUILD_SCOPE_EXHAUSTED",
          "authorization",
          "この依頼での拠点設営は既に開始しています。続きは新しい明示依頼で確認します。",
        );
      }
      if (context.baseBuildAuthorizationUsage !== undefined)
        context.baseBuildAuthorizationUsage.consumed = true;
    }

    try {
      const stage = memoryReadTools.has(name)
        ? "memory_read"
        : ownerScopedMutationToolNames.has(name)
          ? "memory_write"
          : definition.action
            ? "minecraft_action"
            : undefined;
      const executeAction = async (): Promise<ToolResult<unknown>> => {
        const actionResult = await definition.execute(parsed.data, context);
        if (
          name === "gather_resource" &&
          !context.safeActionStepExecution &&
          context.safeActionAuthorization?.kind === "owner_bounded_resource" &&
          actionResult.success
        ) {
          const resource = firstStringField(parsed.data, ["resource"]);
          const requestedCount = firstPositiveIntegerField(parsed.data, [
            "count",
          ]);
          const progress = actionResult.progress;
          const remainingCount =
            context.safeActionAuthorizationUsage?.remainingCount;
          if (
            progress === undefined ||
            progress.item !== resource ||
            progress.requestedCount !== requestedCount ||
            progress.completedCount < 1 ||
            (progress.completedCount > progress.requestedCount &&
              !verifiedDirectGatherSurplus(actionResult, resource)) ||
            remainingCount === undefined ||
            remainingCount < 1
          ) {
            if (context.safeActionAuthorizationUsage !== undefined) {
              context.safeActionAuthorizationUsage.consumed = true;
            }
            return failure(
              progress === undefined
                ? "SAFE_ACTION_PROGRESS_UNCONFIRMED"
                : "SAFE_ACTION_PROGRESS_INVALID",
              "observation",
              "採取後の種類または数量が依頼の範囲と一致しないため、完了として扱わず停止しました。",
            );
          }
        }
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
        consumeSafeActionAuthorization(name, actionResult, context);
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
      if (name === "plan_safe_action" && stage === undefined) {
        consumeSafeActionAuthorization(name, result, context);
      }
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

function consumeSafeActionAuthorization(
  toolName: string,
  result: ToolResult<unknown>,
  context: ToolContext,
): void {
  if (
    (toolName !== "plan_safe_action" && toolName !== "gather_resource") ||
    (toolName === "gather_resource" && context.safeActionStepExecution) ||
    context.safeActionAuthorization?.kind !== "owner_bounded_resource" ||
    context.safeActionAuthorizationUsage === undefined
  ) {
    return;
  }
  const observedCompletedCount =
    result.success && result.progress !== undefined
      ? result.progress.completedCount
      : result.success && isRecord(result.data)
        ? integerField(result.data.completedCount)
        : !result.success
          ? (integerField(result.error.confirmedState.completedCount) ??
            integerField(result.error.confirmedState.collectedCount))
          : undefined;
  const remaining = context.safeActionAuthorizationUsage.remainingCount;
  const completedCount =
    toolName === "gather_resource" &&
    result.success &&
    observedCompletedCount !== undefined
      ? Math.min(remaining, observedCompletedCount)
      : observedCompletedCount;
  if (completedCount === undefined || completedCount < 0) return;
  context.safeActionAuthorizationUsage.remainingCount = Math.max(
    0,
    remaining - completedCount,
  );
  if (completedCount > remaining) {
    context.safeActionAuthorizationUsage.consumed = true;
  }
}

function verifiedDirectGatherSurplus(
  result: Extract<ToolResult<unknown>, { success: true }>,
  resource: string | undefined,
): boolean {
  const progress = result.progress;
  const report = result.data;
  if (
    resource === undefined ||
    progress === undefined ||
    !isRecord(report) ||
    report.outcome !== "completed" ||
    !isRecord(report.confirmedState) ||
    !isRecord(report.before) ||
    !isRecord(report.after) ||
    !isRecord(report.before.inventory) ||
    !isRecord(report.after.inventory)
  )
    return false;
  const before = report.before.inventory[resource] ?? 0;
  const after = report.after.inventory[resource] ?? 0;
  return (
    typeof before === "number" &&
    typeof after === "number" &&
    Number.isSafeInteger(before) &&
    Number.isSafeInteger(after) &&
    report.confirmedState.resource === resource &&
    report.confirmedState.requestedCount === progress.requestedCount &&
    report.confirmedState.collectedCount === progress.completedCount &&
    after - before === progress.completedCount
  );
}

function isDirectActionAuthorized(
  kind: "owner_bounded_resource" | "owner_scoped_change",
  input: unknown,
  context: ToolContext,
): boolean {
  const resource =
    kind === "owner_bounded_resource"
      ? firstStringField(input, [
          "resource",
          "resourceName",
          "block",
          "blockName",
          "item",
          "itemName",
          "targetItem",
        ])
      : undefined;
  const count =
    kind === "owner_bounded_resource"
      ? firstPositiveIntegerField(input, [
          "count",
          "requestedCount",
          "targetCount",
          "quantity",
        ])
      : undefined;
  const authorization = context.safeActionAuthorization;
  const usage = context.safeActionAuthorizationUsage;
  if (usage === undefined || usage.consumed || authorization === undefined) {
    return false;
  }
  if (kind === "owner_bounded_resource") {
    if (authorization.kind !== "owner_bounded_resource") return false;
    if (authorization.selectionRequired === true) return false;
    const withinGrant =
      resource !== undefined &&
      authorization.allowedResources.includes(resource) &&
      count !== undefined &&
      count <= usage.remainingCount &&
      count <= authorization.targetCount &&
      count <= authorization.maxCount;
    if (!withinGrant) return false;
    return (
      isRecord(input) &&
      (typeof input.commitmentId !== "string" ||
        isBoundCommitmentGather(input, resource, count, context))
    );
  }
  if (authorization.kind !== "owner_scoped_change") return false;
  return (
    firstStringField(input, ["scopeId", "areaId"]) === authorization.scopeId
  );
}

function isStaticGatherLimitFailure(
  toolName: string,
  input: unknown,
  context: ToolContext,
): boolean {
  return (
    toolName === "gather_resource" &&
    isRecord(input) &&
    typeof input.count === "number" &&
    input.count > context.limits.maxGatherCount
  );
}

function isBoundCommitmentGather(
  input: unknown,
  resource: string | undefined,
  count: number | undefined,
  context: ToolContext,
): boolean {
  if (!isRecord(input) || typeof input.commitmentId !== "string") return false;
  if (resource === undefined || count === undefined) return false;
  if (
    context.executionEvidence.verifiedActionReceipts.some(
      (receipt) => receipt.commitmentId === input.commitmentId && !receipt.used,
    )
  ) {
    return false;
  }
  const commitment = context.memory.getCommitment({
    playerId: context.playerId,
    commitmentId: input.commitmentId,
  });
  return (
    commitment?.status === "active" &&
    commitment.fulfillment?.toolName === "gather_resource" &&
    commitment.fulfillment.resource === resource &&
    commitment.fulfillment.count === count
  );
}

function firstStringField(
  input: unknown,
  keys: readonly string[],
): string | undefined {
  if (!isRecord(input)) return undefined;
  for (const key of keys) {
    if (typeof input[key] === "string" && input[key].length > 0) {
      return input[key];
    }
  }
  return undefined;
}

function firstPositiveIntegerField(
  input: unknown,
  keys: readonly string[],
): number | undefined {
  if (!isRecord(input)) return undefined;
  for (const key of keys) {
    const value = input[key];
    if (typeof value === "number" && Number.isInteger(value) && value > 0) {
      return value;
    }
  }
  return undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function integerField(value: unknown): number | undefined {
  return typeof value === "number" && Number.isInteger(value)
    ? value
    : undefined;
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
