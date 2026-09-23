import { z } from "zod";
import { deliveryRegistrationTools } from "./delivery-tools.js";

import {
  planSafeAction,
  type SafeActionCandidate,
  type SafeActionStep,
} from "../decision/safe-action-planner.js";
import { chooseSafeCandidate } from "../decision/safe-choice.js";
import { knownSmeltInputs } from "../minecraft/general-actions.js";

import {
  actionReportResult,
  type ActionProgress,
  type ErrorCategory,
  type EvidenceReference,
  type ToolContext,
  type ToolResult,
} from "./contracts.js";
import type { ToolDefinition } from "./definition.js";

const noInput = z.object({}).strict();
const actionPosition = z
  .object({ x: z.number(), y: z.number(), z: z.number() })
  .strict();
const resourceNames = [
  "oak_log",
  "spruce_log",
  "birch_log",
  "jungle_log",
  "acacia_log",
  "dark_oak_log",
  "mangrove_log",
  "cherry_log",
  "pale_oak_log",
  "crimson_stem",
  "warped_stem",
] as const;

const resourceLabels: Readonly<Record<string, string>> = {
  oak_log: "オークの原木",
  spruce_log: "トウヒの原木",
  birch_log: "シラカバの原木",
  jungle_log: "ジャングルの原木",
  acacia_log: "アカシアの原木",
  dark_oak_log: "ダークオークの原木",
  mangrove_log: "マングローブの原木",
  cherry_log: "サクラの原木",
  pale_oak_log: "ペールオークの原木",
  crimson_stem: "真紅の幹",
  warped_stem: "歪んだ幹",
};

const memoryKinds = ["fact", "location", "commitment", "episode"] as const;
const safeActionModes = z.enum(["delegated", "explicit"]);
const maxSafeActionSteps = 8;
const maxSafeActionPlanRounds = 64;
const maxSafeActionDurationMs = 900_000;
function nowEvidence(
  kind: EvidenceReference["kind"],
  summary: string,
): EvidenceReference[] {
  return [{ kind, observedAt: new Date().toISOString(), summary }];
}

function safeActionFailure(
  category: ErrorCategory,
  code: string,
  retryable: boolean,
  failedAt: string,
  confirmedState: Record<string, unknown>,
  nextActions: readonly string[],
  userSummary: string,
): ToolResult<unknown> {
  return {
    success: false,
    error: {
      category,
      code,
      retryable,
      failedAt,
      confirmedState,
      nextActions: [...nextActions],
      userSummary,
    },
  };
}

function latestActionProgress(
  results: readonly Extract<ToolResult<unknown>, { success: true }>[],
): ActionProgress | undefined {
  for (let index = results.length - 1; index >= 0; index -= 1) {
    const progress = results[index]?.progress;
    if (progress !== undefined) return progress;
  }
  return undefined;
}

function actionProgresses(
  results: readonly Extract<ToolResult<unknown>, { success: true }>[],
): ActionProgress[] {
  return results.flatMap(({ progress }) =>
    progress === undefined ? [] : [progress],
  );
}

function progressItemKey(progress: ActionProgress): string {
  return progress.item ?? "__unidentified_item__";
}

function positiveIntegerInput(
  input: Readonly<Record<string, unknown>>,
): number | undefined {
  for (const key of ["count", "requestedCount", "targetCount", "quantity"]) {
    const value = input[key];
    if (typeof value === "number" && Number.isInteger(value) && value > 0) {
      return value;
    }
  }
  return undefined;
}

function actionStepBoundKey(step: SafeActionStep): string {
  const identity = [
    "resource",
    "resourceName",
    "block",
    "blockName",
    "item",
    "itemName",
    "targetItem",
  ].find((key) => typeof step.input[key] === "string");
  return `${step.tool}:${identity === undefined ? "" : String(step.input[identity])}`;
}

function isSignalAborted(signal: AbortSignal): boolean {
  return signal.aborted;
}

function trustedSafeActionCount(
  _inputCount: number,
  authorization: ToolContext["safeActionAuthorization"],
  usage: ToolContext["safeActionAuthorizationUsage"],
): number | undefined {
  if (authorization?.kind !== "owner_bounded_resource") return _inputCount;
  if (usage === undefined || usage.consumed) return undefined;
  if (
    !Number.isInteger(usage.remainingCount) ||
    usage.remainingCount < 1 ||
    !Number.isInteger(authorization.maxCount) ||
    usage.remainingCount > authorization.maxCount
  )
    return undefined;
  return usage.remainingCount;
}

function defineTool<Name extends string, Input extends z.ZodType, Output>(
  definition: ToolDefinition<Name, Input, Output>,
): ToolDefinition<Name, Input, Output> {
  return definition;
}

export const toolDefinitions = [
  ...deliveryRegistrationTools,
  defineTool({
    name: "observe_status",
    description:
      "Bot自身について、Minecraftで現在観測できる体力、空腹、酸素、水中状態、位置、所持品、作業状態を返す。利用者の体力・空腹・酸素・水中状態は観測しない。",
    input: noInput,
    fixtures: { valid: [{}], invalid: [{ unexpected: true }] },
    action: false,
    execute: async (_input, context) => {
      const status = await context.game.observeStatus();
      return {
        success: true,
        data: status,
        evidence: nowEvidence("minecraft_snapshot", "現在状態を観測した"),
        userSummary: "現在のMinecraft状態を確認しました。",
      };
    },
  }),
  defineTool({
    name: "observe_surroundings",
    description:
      "Botの位置を基準に、指定半径内で実際に観測できるblock、entity、危険を返す。酸素と水中状態もBot自身の同時刻の観測であり、利用者の状態は観測しない。",
    input: z
      .object({
        radius: z.number().int().min(1).max(32),
        includeEntities: z.boolean(),
      })
      .strict(),
    fixtures: {
      valid: [{ radius: 8, includeEntities: true }],
      invalid: [{ radius: 100, includeEntities: false }],
    },
    action: false,
    execute: async (input, context) => {
      const surroundings = await context.game.observeSurroundings(
        input.radius,
        input.includeEntities,
      );
      return {
        success: true,
        data: surroundings,
        evidence: nowEvidence("minecraft_snapshot", "周囲を観測した"),
        userSummary: "周囲のMinecraft状態を確認しました。",
      };
    },
  }),
  defineTool({
    name: "plan_safe_action",
    description:
      "利用者の目的を一度の計画にまとめ、実際に観測した候補から安全な複数手順を選んでその場で順に実行する。利用者へ個々のtool引数を再入力させない。候補不足・未対応の目的・保護対象・危険・権限不明では実行せず、理由と必要な確認を返す。",
    input: z
      .object({
        goal: z.string().trim().min(1).max(240),
        count: z.number().int().min(1).max(64),
        mode: safeActionModes,
        candidateId: z.string().trim().min(1).max(160).nullable(),
      })
      .strict(),
    fixtures: {
      valid: [
        {
          goal: "collect_resource",
          count: 1,
          mode: "delegated",
          candidateId: null,
        },
      ],
      invalid: [
        {
          goal: "",
          count: 1,
          mode: "delegated",
          candidateId: null,
        },
      ],
    },
    action: true,
    execute: async (input, context) => {
      const startedAt = Date.now();
      const authorization = context.safeActionAuthorization;
      const smeltQuantity =
        authorization?.kind === "owner_bounded_resource" &&
        knownSmeltInputs[authorization.targetItem] !== undefined
          ? (context.safeActionAuthorizationUsage?.remainingCount ??
            authorization.targetCount)
          : 0;
      const desiredDurationMs =
        smeltQuantity > 0 ? 30_000 + smeltQuantity * 13_000 : 60_000;
      const configuredDuration = context.limits.maxSafeActionDurationMs;
      const durationMs =
        typeof configuredDuration === "number" &&
        Number.isFinite(configuredDuration)
          ? Math.min(
              Math.max(1, configuredDuration),
              desiredDurationMs,
              maxSafeActionDurationMs,
            )
          : Math.min(desiredDurationMs, maxSafeActionDurationMs);
      const deadline = startedAt + durationMs;
      const deadlineSignal = AbortSignal.timeout(durationMs);
      const planSignal = AbortSignal.any([context.signal, deadlineSignal]);
      const planContext: ToolContext = {
        ...context,
        signal: planSignal,
      };
      const timedOut = (): boolean =>
        deadlineSignal.aborted || Date.now() >= deadline;
      if (context.safeActionClarification !== undefined) {
        return safeActionFailure(
          "authorization",
          "OWNER_GOAL_CLARIFICATION_REQUIRED",
          false,
          "owner_goal_boundary",
          { goal: input.goal, ownerGoal: "clarification_required" },
          [context.safeActionClarification],
          context.safeActionClarification,
        );
      }
      const actionCount = trustedSafeActionCount(
        input.count,
        context.safeActionAuthorization,
        context.safeActionAuthorizationUsage,
      );
      if (actionCount === undefined) {
        return safeActionFailure(
          "authorization",
          "SAFE_ACTION_AUTHORIZATION_INVALID",
          false,
          "owner_goal_boundary",
          { goal: input.goal, modelRequestedCount: input.count },
          ["所有者の目的と数量上限を確認してから再依頼する"],
          "所有者の目的または数量上限を確認できないため、操作を開始しません。",
        );
      }
      const authorizedGoalItem =
        context.safeActionAuthorization?.kind === "owner_bounded_resource" &&
        context.safeActionAuthorization.targetItem !== "*"
          ? context.safeActionAuthorization.targetItem
          : undefined;
      let initialGoalHeld: number | undefined;
      if (authorizedGoalItem !== undefined) {
        try {
          initialGoalHeld =
            (await context.game.observeStatus()).inventory[
              authorizedGoalItem
            ] ?? 0;
        } catch {
          return safeActionFailure(
            "observation",
            "SAFE_ACTION_BASELINE_UNAVAILABLE",
            true,
            "observe_status",
            { goal: input.goal },
            ["所持品を観測できる状態で目的を再依頼する"],
            "開始前の所持数を確認できないため、資源操作を開始しませんでした。",
          );
        }
      }
      if (
        context.safeActionAuthorization?.kind === "owner_bounded_resource" &&
        knownSmeltInputs[context.safeActionAuthorization.targetItem] !==
          undefined &&
        context.allowedActionToolNames !== undefined &&
        !context.allowedActionToolNames.includes("smelt_item")
      ) {
        return safeActionFailure(
          "authorization",
          "OWNER_GOAL_REQUIRES_DISALLOWED_STEP",
          false,
          "owner_goal_boundary",
          { goal: input.goal, requiredStep: "smelt_item" },
          ["精錬を許可するか、原料の収集だけに目的を変更する"],
          "希望する完成品には精錬が必要ですが、今回は許可されていないため採掘も開始しませんでした。",
        );
      }
      if (context.safeActionAuthorization?.kind === "owner_bounded_resource") {
        const usage = context.safeActionAuthorizationUsage;
        if (usage === undefined) {
          return safeActionFailure(
            "authorization",
            "SAFE_ACTION_AUTHORIZATION_INVALID",
            false,
            "owner_goal_boundary",
            { goal: input.goal, ownerGoal: "usage_state_missing" },
            ["所有者の目的を新しい依頼として再指定する"],
            "所有者の目的の実行状態を確認できないため、操作を開始しません。",
          );
        }
        usage.consumed = true;
      }
      if (context.game.findSafeActionCandidates === undefined) {
        return {
          success: false,
          error: {
            category: "observation",
            code: "SAFE_ACTION_OBSERVATION_UNAVAILABLE",
            retryable: true,
            failedAt: "observe_safe_action_candidates",
            confirmedState: { candidateObservation: "unavailable" },
            nextActions: [
              "目的に対応する観測プロバイダを追加してから計画を再試行する",
            ],
            userSummary:
              "目的に対応する安全な候補を観測できないため、操作を推測して開始しません。",
          },
        };
      }

      const executeStep = context.executeSafeActionStep;
      if (executeStep === undefined) {
        return {
          success: false,
          error: {
            category: "internal",
            code: "SAFE_ACTION_EXECUTION_UNAVAILABLE",
            retryable: true,
            failedAt: "execute_safe_action_plan",
            confirmedState: {
              goal: input.goal,
            },
            nextActions: ["計画実行境界を初期化してから再試行する"],
            userSummary:
              "安全な計画は作成できましたが、実行境界を利用できないため開始しません。",
          },
        };
      }

      const completedSteps: {
        readonly tool: string;
        readonly summary: string;
      }[] = [];
      const completedCandidateIds: string[] = [];
      const failedCandidateIds = new Set<string>();
      const planReasons: string[] = [];
      let completedCount = 0;
      let remainingCount = actionCount;
      let planRounds = 0;
      let inventoryReconciledCount = 0;
      const intermediateProgress: ActionProgress[] = [];
      while (remainingCount > 0) {
        if (context.signal.aborted) {
          return safeActionFailure(
            "cancelled",
            "SAFE_ACTION_PLAN_CANCELLED",
            false,
            "plan_safe_action",
            {
              completedCount,
              remainingCount,
              planRounds,
              completedSteps: completedSteps.length,
            },
            ["必要なら安全状態を確認して新しい目的として再依頼する"],
            `安全計画を${String(completedCount)}個分まで実行し、停止しました。`,
          );
        }
        if (timedOut()) {
          return safeActionFailure(
            "timeout",
            "SAFE_ACTION_PLAN_TIMEOUT",
            true,
            "plan_safe_action",
            {
              completedCount,
              remainingCount,
              planRounds,
              completedSteps: completedSteps.length,
              elapsedMs: Date.now() - startedAt,
            },
            ["現在状態と数量を再観測してから新しい目的として再依頼する"],
            `安全計画を${String(completedCount)}個分まで実行し、制限時間を超えたため停止しました。`,
          );
        }
        planRounds += 1;
        if (planRounds > maxSafeActionPlanRounds) {
          return safeActionFailure(
            "safety",
            "SAFE_ACTION_REPLAN_LIMIT",
            false,
            "plan_safe_action",
            {
              completedCount,
              remainingCount,
              planRounds: maxSafeActionPlanRounds,
              completedSteps: completedSteps.length,
            },
            ["残量と安全状態を確認してから、新しい目的として再依頼する"],
            `安全計画を上限の${String(maxSafeActionPlanRounds)}回まで実行しましたが、残りを安全に確認できないため停止しました。`,
          );
        }

        let observed: readonly SafeActionCandidate[];
        try {
          observed = await context.game.findSafeActionCandidates(
            {
              goal: input.goal,
              count: remainingCount,
              maxCandidates: 8,
              ...(context.safeActionAuthorization === undefined
                ? {}
                : { authorization: context.safeActionAuthorization }),
            },
            planSignal,
          );
        } catch (error) {
          if (isSignalAborted(context.signal)) {
            return safeActionFailure(
              "cancelled",
              "SAFE_ACTION_PLAN_CANCELLED",
              false,
              "observe_safe_action_candidates",
              {
                completedCount,
                remainingCount,
                planRounds,
                completedSteps: completedSteps.length,
              },
              ["必要なら安全状態を確認して新しい目的として再依頼する"],
              `安全計画を${String(completedCount)}個分まで実行し、停止しました。`,
            );
          }
          if (timedOut()) {
            return safeActionFailure(
              "timeout",
              "SAFE_ACTION_PLAN_TIMEOUT",
              true,
              "observe_safe_action_candidates",
              {
                completedCount,
                remainingCount,
                planRounds,
                completedSteps: completedSteps.length,
                elapsedMs: Date.now() - startedAt,
              },
              ["現在状態と数量を再観測してから新しい目的として再依頼する"],
              `安全計画を${String(completedCount)}個分まで実行し、制限時間を超えたため停止しました。`,
            );
          }
          throw error;
        }
        if (isSignalAborted(context.signal)) {
          return safeActionFailure(
            "cancelled",
            "SAFE_ACTION_PLAN_CANCELLED",
            false,
            "observe_safe_action_candidates",
            {
              completedCount,
              remainingCount,
              planRounds,
              completedSteps: completedSteps.length,
            },
            ["必要なら安全状態を確認して新しい目的として再依頼する"],
            `安全計画を${String(completedCount)}個分まで実行し、停止しました。`,
          );
        }
        if (timedOut()) {
          return safeActionFailure(
            "timeout",
            "SAFE_ACTION_PLAN_TIMEOUT",
            true,
            "observe_safe_action_candidates",
            {
              completedCount,
              remainingCount,
              planRounds,
              completedSteps: completedSteps.length,
              elapsedMs: Date.now() - startedAt,
            },
            ["現在状態と数量を再観測してから新しい目的として再依頼する"],
            `安全計画を${String(completedCount)}個分まで実行し、制限時間を超えたため停止しました。`,
          );
        }
        const resourceAuthorization = context.safeActionAuthorization;
        const availableObserved = observed.filter(
          (candidate) => !failedCandidateIds.has(candidate.id),
        );
        if (
          input.mode === "delegated" &&
          input.candidateId === null &&
          resourceAuthorization?.kind === "owner_bounded_resource" &&
          resourceAuthorization.targetItem !== "*" &&
          !resourceNames.includes(
            resourceAuthorization.targetItem as (typeof resourceNames)[number],
          ) &&
          !availableObserved.some(
            (candidate) =>
              candidate.permission === "allowed" &&
              candidate.safety === "allowed",
          ) &&
          context.game.searchSafeActionCandidates !== undefined
        ) {
          const search = await context.game.searchSafeActionCandidates(
            {
              goal: input.goal,
              count: remainingCount,
              maxCandidates: 8,
              authorization: resourceAuthorization,
            },
            planSignal,
          );
          if (search.stop !== undefined || search.candidates.length === 0) {
            return safeActionFailure(
              search.stop === undefined ||
                search.stop.code === "SMELT_STATION_NOT_OBSERVED"
                ? "resource"
                : "safety",
              search.stop?.code ?? "SAFE_ACTION_SEARCH_EXHAUSTED",
              false,
              "search_safe_action_candidates",
              {
                completedCount,
                remainingCount,
                attemptedWaypoints: search.attemptedWaypoints,
                blockedWaypoints: search.blockedWaypoints,
              },
              [
                search.stop?.reason ??
                  "許可された範囲で安全な資源候補を確認できる場所へ移動する",
              ],
              search.stop?.reason ??
                `許可された範囲で${String(search.attemptedWaypoints)}地点を調べましたが、安全な資源候補を確認できませんでした。`,
            );
          }
          observed = search.candidates;
        }
        if (
          availableObserved.length === 0 &&
          resourceAuthorization?.kind === "owner_bounded_resource" &&
          resourceAuthorization.allowedResources.some(
            (resource) =>
              resourceNames.includes(
                resource as (typeof resourceNames)[number],
              ) && !failedCandidateIds.has(`gather_resource:${resource}`),
          ) &&
          context.game.searchSafeResourceCandidates !== undefined
        ) {
          const allowedLogs = resourceAuthorization.allowedResources.filter(
            (resource) =>
              resourceNames.includes(
                resource as (typeof resourceNames)[number],
              ) && !failedCandidateIds.has(`gather_resource:${resource}`),
          );
          const search = await context.game.searchSafeResourceCandidates(
            Math.min(32, context.limits.maxMoveDistance),
            8,
            planSignal,
            allowedLogs,
          );
          if (search.stop !== undefined) {
            return safeActionFailure(
              "safety",
              search.stop.code,
              false,
              "search_safe_resource_candidates",
              {
                completedCount,
                remainingCount,
                attemptedWaypoints: search.attemptedWaypoints,
                blockedWaypoints: search.blockedWaypoints,
              },
              [search.stop.reason],
              `安全な候補を探す途中で停止しました。${search.stop.reason}`,
            );
          }
          if (search.candidates.length === 0) {
            return safeActionFailure(
              "resource",
              "SAFE_RESOURCE_SEARCH_EXHAUSTED",
              false,
              "search_safe_resource_candidates",
              {
                completedCount,
                remainingCount,
                attemptedWaypoints: search.attemptedWaypoints,
                blockedWaypoints: search.blockedWaypoints,
              },
              ["保護条件を満たす木が探索範囲に現れたら、残りを依頼する"],
              `許可された範囲で${String(search.attemptedWaypoints)}方向を調べましたが、保護条件を満たす木を確認できませんでした。`,
            );
          }
          observed = await context.game.findSafeActionCandidates(
            {
              goal: input.goal,
              count: remainingCount,
              maxCandidates: 8,
              authorization: resourceAuthorization,
            },
            planSignal,
          );
        }
        observed = observed.filter(
          (candidate) => !failedCandidateIds.has(candidate.id),
        );
        if (observed.length === 0 && failedCandidateIds.size > 0) {
          return safeActionFailure(
            "path",
            "SAFE_ACTION_ALTERNATIVES_EXHAUSTED",
            false,
            "plan_safe_action",
            {
              completedCount,
              remainingCount,
              attemptedCandidates: failedCandidateIds.size,
            },
            ["安全に到達できる別の候補が観測できる場所で残りを依頼する"],
            `候補を${String(failedCandidateIds.size)}種類試しましたが、残りに安全に到達できる候補を確認できませんでした。`,
          );
        }
        const planned = planSafeAction({
          mode: input.mode,
          requestedId: input.candidateId ?? undefined,
          candidates: observed,
          maxSteps: maxSafeActionSteps,
          remainingCount,
          ...(context.safeActionAuthorization === undefined
            ? {}
            : { authorization: context.safeActionAuthorization }),
        });
        if (planned.outcome === "clarify") {
          return safeActionFailure(
            planned.code === "CHOICE_BLOCKED" ? "safety" : "resource",
            planned.code,
            false,
            "plan_safe_action",
            {
              goal: input.goal,
              observedCandidateCount: observed.length,
              completedCount,
              remainingCount,
              planRounds,
              completedSteps: completedSteps.length,
            },
            [planned.question],
            planned.question,
          );
        }
        const outOfScopeStep = planned.steps.find((step) => {
          const definition = getToolDefinition(step.tool);
          return (
            (definition?.action === true ||
              ownerScopedMutationToolNames.has(step.tool)) &&
            context.allowedActionToolNames !== undefined &&
            !context.allowedActionToolNames.includes(step.tool)
          );
        });
        if (outOfScopeStep !== undefined) {
          return safeActionFailure(
            "authorization",
            "OWNER_ACTION_SCOPE_NOT_ALLOWED",
            false,
            "plan_safe_action",
            {
              goal: input.goal,
              completedCount,
              remainingCount,
              rejectedStep: outOfScopeStep.tool,
            },
            ["今回の依頼で許可する操作を明示してから再依頼する"],
            "今回許可されていない操作を計画に含むため、作業を開始しませんでした。",
          );
        }
        const intermediateCountBefore = intermediateProgress.reduce(
          (total, previous) => total + previous.completedCount,
          0,
        );
        const intermediateRequestedCount = planned.candidate.requestedCount;
        if (
          (planned.candidate.intermediateItems?.length ?? 0) > 0 &&
          (intermediateRequestedCount === undefined ||
            !Number.isInteger(intermediateRequestedCount) ||
            intermediateRequestedCount < 1 ||
            intermediateCountBefore + intermediateRequestedCount > actionCount)
        ) {
          return safeActionFailure(
            "safety",
            "SAFE_ACTION_INTERMEDIATE_LIMIT",
            false,
            planned.candidate.id,
            {
              candidateId: planned.candidate.id,
              completedCount,
              remainingCount,
              planRounds,
              completedSteps: completedSteps.length,
              intermediateCount: intermediateCountBefore,
              intermediateLimit: actionCount,
            },
            [
              "中間素材の所持数と最終目標を再観測してから新しい依頼として再計画する",
            ],
            "中間素材の上限に達したため、追加の資源操作を開始せず停止しました。",
          );
        }
        completedCandidateIds.push(planned.candidate.id);
        planReasons.push(planned.reason);
        const successfulResults: Extract<
          ToolResult<unknown>,
          { success: true }
        >[] = [];
        let actionStepCompleted = false;
        let replanAfterCandidateFailure = false;
        const expectedCount = planned.candidate.requestedCount;
        const declaredActionCounts = new Map<string, number>();
        for (const [index, step] of planned.steps.entries()) {
          const stepCount = getToolDefinition(step.tool)?.action
            ? positiveIntegerInput(step.input)
            : undefined;
          if (stepCount !== undefined) {
            const bound = Math.min(
              remainingCount,
              expectedCount ?? remainingCount,
            );
            const key = actionStepBoundKey(step);
            const declared = (declaredActionCounts.get(key) ?? 0) + stepCount;
            if (declared > bound) {
              return safeActionFailure(
                "safety",
                "SAFE_ACTION_STEP_COUNT_LIMIT",
                false,
                step.tool,
                {
                  candidateId: planned.candidate.id,
                  completedCount,
                  remainingCount,
                  planRounds,
                  completedSteps: completedSteps.length,
                  step: index + 1,
                  declaredCount: declared,
                  stepCountLimit: bound,
                },
                [
                  "手順ごとの数量を目標上限以内に分割してから新しい依頼として再計画する",
                ],
                "同じ操作の手順数が目標上限を超えるため、後続操作を開始せず停止しました。",
              );
            }
            declaredActionCounts.set(key, declared);
          }
          if (isSignalAborted(context.signal)) {
            return safeActionFailure(
              "cancelled",
              "SAFE_ACTION_PLAN_CANCELLED",
              false,
              step.tool,
              {
                candidateId: planned.candidate.id,
                completedCount,
                remainingCount,
                planRounds,
                completedSteps: completedSteps.length,
              },
              ["必要なら安全状態を確認して新しい目的として再依頼する"],
              `安全計画を${String(completedCount)}個分まで実行し、停止しました。`,
            );
          }
          if (timedOut()) {
            return safeActionFailure(
              "timeout",
              "SAFE_ACTION_PLAN_TIMEOUT",
              true,
              step.tool,
              {
                candidateId: planned.candidate.id,
                completedCount,
                remainingCount,
                planRounds,
                completedSteps: completedSteps.length,
                elapsedMs: Date.now() - startedAt,
              },
              ["現在状態と数量を再観測してから新しい目的として再依頼する"],
              `安全計画の${String(index + 1)}段階目の前に制限時間を超えたため停止しました。`,
            );
          }
          try {
            await context.game.observeStatus();
          } catch {
            return safeActionFailure(
              "observation",
              "SAFE_ACTION_REOBSERVATION_FAILED",
              true,
              step.tool,
              {
                candidateId: planned.candidate.id,
                completedCount,
                remainingCount,
                planRounds,
                completedSteps: completedSteps.length,
              },
              ["Minecraft状態を再観測してから計画を再試行する"],
              `安全計画の${String(index + 1)}段階目の前に現在状態を再観測できず、停止しました。`,
            );
          }
          const result = await executeStep(step, planContext);
          if (isSignalAborted(context.signal)) {
            return safeActionFailure(
              "cancelled",
              "SAFE_ACTION_PLAN_CANCELLED",
              false,
              step.tool,
              {
                ...(result.success ? {} : result.error.confirmedState),
                candidateId: planned.candidate.id,
                failedStep: index + 1,
                completedCount,
                remainingCount,
                planRounds,
                completedSteps:
                  completedSteps.length + (result.success ? 1 : 0),
                ...(result.success
                  ? {
                      partialProgress: result.progress ?? null,
                      partialStepSummary: result.userSummary,
                    }
                  : { stepCode: result.error.code }),
              },
              ["必要なら安全状態を確認して新しい目的として再依頼する"],
              `安全計画を${String(completedCount)}個分まで実行し、停止しました。`,
            );
          }
          if (timedOut()) {
            return safeActionFailure(
              "timeout",
              "SAFE_ACTION_PLAN_TIMEOUT",
              true,
              step.tool,
              {
                ...(result.success ? {} : result.error.confirmedState),
                candidateId: planned.candidate.id,
                failedStep: index + 1,
                completedCount,
                remainingCount,
                planRounds,
                completedSteps:
                  completedSteps.length + (result.success ? 1 : 0),
                ...(result.success
                  ? {
                      partialProgress: result.progress ?? null,
                      partialStepSummary: result.userSummary,
                    }
                  : { stepCode: result.error.code }),
              },
              ["現在状態と数量を再観測してから新しい目的として再依頼する"],
              result.success
                ? `安全計画の${String(index + 1)}段階目まで確認しましたが、制限時間を超えたため後続操作を停止しました。`
                : `安全計画の${String(index + 1)}段階目で制限時間を超えたため停止しました。${result.error.userSummary}`,
            );
          }
          if (!result.success) {
            if (
              input.mode === "delegated" &&
              input.candidateId === null &&
              planned.candidate.action === "mine_block" &&
              step.tool === "mine_block" &&
              !actionStepCompleted &&
              authorizedGoalItem !== undefined &&
              initialGoalHeld !== undefined &&
              (result.error.code === "DROP_NOT_COLLECTED" ||
                result.error.code === "MINE_OUTPUT_NOT_VERIFIED")
            ) {
              let observedGoalHeld: number | undefined;
              try {
                observedGoalHeld =
                  (await context.game.observeStatus()).inventory[
                    authorizedGoalItem
                  ] ?? 0;
              } catch {
                // The uncertain mining result must retain its original failure.
              }
              const observedIncrease =
                observedGoalHeld === undefined
                  ? 0
                  : Math.max(0, observedGoalHeld - initialGoalHeld);
              if (observedIncrease > actionCount) {
                return safeActionFailure(
                  "safety",
                  "SAFE_ACTION_INVENTORY_EXCEEDS_BOUND",
                  false,
                  step.tool,
                  {
                    goalItem: authorizedGoalItem,
                    observedIncrease,
                    authorizedCount: actionCount,
                    completedCount,
                  },
                  [
                    "所持品の増加と依頼数量を確認してから新しい目的として依頼する",
                  ],
                  `所持品の増加が許可された${String(actionCount)}個を超えたため、追加の採掘を停止しました。実測の増加は${String(observedIncrease)}個です。`,
                );
              }
              if (observedIncrease > completedCount) {
                inventoryReconciledCount += observedIncrease - completedCount;
                completedCount = observedIncrease;
                remainingCount = actionCount - completedCount;
                failedCandidateIds.add(planned.candidate.id);
                completedCandidateIds.pop();
                planReasons.pop();
                replanAfterCandidateFailure = true;
                break;
              }
            }
            if (
              input.mode === "delegated" &&
              input.candidateId === null &&
              planned.candidate.action === "gather_resource" &&
              step.tool === "gather_resource" &&
              !actionStepCompleted &&
              (result.error.code === "RESOURCE_PATHS_BLOCKED" ||
                result.error.code === "RESOURCE_NOT_FOUND") &&
              result.error.confirmedState.collectedCount === 0
            ) {
              failedCandidateIds.add(planned.candidate.id);
              completedCandidateIds.pop();
              planReasons.pop();
              replanAfterCandidateFailure = true;
              break;
            }
            return safeActionFailure(
              result.error.category,
              "SAFE_ACTION_STEP_FAILED",
              result.error.retryable,
              step.tool,
              {
                ...result.error.confirmedState,
                candidateId: planned.candidate.id,
                failedStep: index + 1,
                completedCount,
                remainingCount,
                planRounds,
                completedSteps: completedSteps.length,
                stepCode: result.error.code,
              },
              result.error.nextActions,
              `${planned.reason}計画の${String(index + 1)}段階目で停止しました。${result.error.userSummary}`,
            );
          }
          successfulResults.push(result);
          if (getToolDefinition(step.tool)?.action === true) {
            actionStepCompleted = true;
          }
          completedSteps.push({
            tool: step.tool,
            summary: result.userSummary,
          });
        }
        if (replanAfterCandidateFailure) continue;

        const progresses = actionProgresses(successfulResults);
        const progress = latestActionProgress(successfulResults);
        const goalItem = planned.candidate.goalItem;
        const progressByItem = new Map<string, number>();
        let invalidProgress: ActionProgress | undefined;
        for (const candidateProgress of progresses) {
          if (
            candidateProgress.completedCount < 1 ||
            candidateProgress.completedCount >
              candidateProgress.requestedCount ||
            candidateProgress.requestedCount < 1 ||
            candidateProgress.requestedCount > remainingCount ||
            (expectedCount !== undefined &&
              candidateProgress.requestedCount > expectedCount) ||
            (goalItem !== undefined && candidateProgress.item === undefined)
          ) {
            invalidProgress = candidateProgress;
            break;
          }
          const key = progressItemKey(candidateProgress);
          const total =
            (progressByItem.get(key) ?? 0) + candidateProgress.completedCount;
          progressByItem.set(key, total);
          if (
            total > Math.min(remainingCount, expectedCount ?? remainingCount)
          ) {
            invalidProgress = candidateProgress;
            break;
          }
        }
        if (invalidProgress !== undefined) {
          return safeActionFailure(
            "observation",
            "SAFE_ACTION_PROGRESS_INVALID",
            false,
            planned.candidate.id,
            {
              candidateId: planned.candidate.id,
              completedCount,
              remainingCount,
              planRounds,
              completedSteps: completedSteps.length,
              progress: invalidProgress,
              reportedProgress: progresses,
            },
            ["実行結果の数量と対象を再観測してから計画を再試行する"],
            "操作は完了したものの、対象または数量の結果を安全に確認できないため停止しました。",
          );
        }
        const intermediateResults = progresses.filter(
          (candidateProgress) =>
            goalItem !== undefined &&
            candidateProgress.item !== undefined &&
            candidateProgress.item !== goalItem,
        );
        for (const intermediate of intermediateResults) {
          const intermediateItem = intermediate.item;
          if (
            intermediateItem === undefined ||
            !planned.candidate.intermediateItems?.includes(intermediateItem)
          ) {
            return safeActionFailure(
              "observation",
              "SAFE_ACTION_PROGRESS_INVALID",
              false,
              planned.candidate.id,
              {
                candidateId: planned.candidate.id,
                completedCount,
                remainingCount,
                planRounds,
                completedSteps: completedSteps.length,
                progress: intermediate,
              },
              ["実行結果の数量と対象を再観測してから計画を再試行する"],
              "中間素材の結果は確認しましたが、最終目標の数量へ変換する計画を確認できないため停止しました。",
            );
          }
          intermediateProgress.push(intermediate);
        }
        const intermediateCount = intermediateProgress.reduce(
          (total, previous) => total + previous.completedCount,
          0,
        );
        if (intermediateCount > actionCount) {
          return safeActionFailure(
            "safety",
            "SAFE_ACTION_INTERMEDIATE_LIMIT",
            false,
            planned.candidate.id,
            {
              candidateId: planned.candidate.id,
              completedCount,
              remainingCount,
              planRounds,
              completedSteps: completedSteps.length,
              intermediateCount,
              intermediateLimit: actionCount,
              progress,
            },
            [
              "中間素材の所持数と最終目標を再観測してから新しい依頼として再計画する",
            ],
            "中間素材の累積量が目標数の上限に達したため、追加操作を停止しました。",
          );
        }
        const finalProgressCount = progresses
          .filter(
            (candidateProgress) =>
              goalItem === undefined ||
              candidateProgress.item === undefined ||
              candidateProgress.item === goalItem,
          )
          .reduce(
            (total, candidateProgress) =>
              total + candidateProgress.completedCount,
            0,
          );
        if (intermediateResults.length > 0 && finalProgressCount === 0) {
          continue;
        }
        const requiresProgress =
          planned.candidate.goalItem !== undefined ||
          (remainingCount > 1 &&
            (expectedCount === undefined || expectedCount < remainingCount));
        if (
          progress === undefined &&
          (!actionStepCompleted || requiresProgress)
        ) {
          return safeActionFailure(
            "observation",
            "SAFE_ACTION_PROGRESS_UNCONFIRMED",
            true,
            planned.candidate.id,
            {
              candidateId: planned.candidate.id,
              completedCount,
              remainingCount,
              planRounds,
              completedSteps: completedSteps.length,
            },
            ["実行結果の数量を再観測してから残りを再計画する"],
            "操作結果の数量を確認できないため、残りの計画を開始せず停止しました。",
          );
        }
        const advanced = Math.min(
          remainingCount,
          finalProgressCount > 0 ? finalProgressCount : remainingCount,
        );
        completedCount += advanced;
        remainingCount -= advanced;
      }

      const lastCandidateId =
        completedCandidateIds[completedCandidateIds.length - 1];
      const firstReason = planReasons[0] ?? "安全条件を確認した計画";
      return {
        success: true,
        data: {
          goal: input.goal,
          candidateId: lastCandidateId,
          candidateIds: completedCandidateIds,
          reason: firstReason,
          completedCount,
          targetCount: actionCount,
          planRounds,
          inventoryReconciledCount,
          intermediateProgress,
          completedSteps,
        },
        evidence: nowEvidence(
          "minecraft_snapshot",
          `安全計画を${String(planRounds)}回、${String(completedCount)}個分実行し、各段階の結果を確認した`,
        ),
        userSummary: `${firstReason}計画した${String(completedSteps.length)}段階を実行し、${String(completedCount)}個分の結果を確認しました。${inventoryReconciledCount > 0 ? `途中の採掘は完了判定できませんでしたが、目標品${String(inventoryReconciledCount)}個の所持増加を再観測しました。` : ""}${completedSteps.map(({ summary }) => summary).join(" ")}`,
      };
    },
  }),
  defineTool({
    name: "select_safe_resource",
    description:
      "利用者が原木の種類の選択を任せた時だけ使う。サーバーの保護判定を通った観測済み候補から最も近い原木を一つ選び、結果のresourceを同じ会話処理内でgather_resourceへ渡す。候補がない・保護対象・権限不明なら実行対象を推測せず具体的に確認する。",
    input: z
      .object({
        count: z.number().int().min(1).max(64),
      })
      .strict(),
    fixtures: {
      valid: [{ count: 1 }],
      invalid: [{ count: 0 }],
    },
    action: true,
    execute: async (input, context) => {
      if (input.count > context.limits.maxGatherCount) {
        return {
          success: false,
          error: {
            category: "validation",
            code: "GATHER_COUNT_EXCEEDED",
            retryable: false,
            failedAt: "precondition",
            confirmedState: {
              requested: input.count,
              maximum: context.limits.maxGatherCount,
            },
            nextActions: ["数量を減らして依頼する"],
            userSummary: "許可された採取数を超えるため候補を選びませんでした。",
          },
        };
      }
      if (context.game.findSafeResourceCandidates === undefined) {
        return {
          success: false,
          error: {
            category: "observation",
            code: "SAFE_RESOURCE_OBSERVATION_UNAVAILABLE",
            retryable: true,
            failedAt: "observe_resource_candidates",
            confirmedState: { candidateObservation: "unavailable" },
            nextActions: [
              "対象の原木種類を指定するか、保護判定を含む候補観測を再試行する",
            ],
            userSummary:
              "安全な候補を観測できないため、原木の種類を推測して採取しません。",
          },
        };
      }

      const ownerAuthorization = context.safeActionAuthorization;
      const allowedLogNames =
        ownerAuthorization?.kind === "owner_bounded_resource"
          ? ownerAuthorization.allowedResources.filter((resource) =>
              resourceNames.includes(
                resource as (typeof resourceNames)[number],
              ),
            )
          : undefined;
      let observed = await context.game.findSafeResourceCandidates(
        Math.min(32, context.limits.maxMoveDistance),
        Math.min(8, input.count),
        context.signal,
        allowedLogNames,
      );
      const usage = context.safeActionAuthorizationUsage;
      if (
        observed.length === 0 &&
        ownerAuthorization?.kind === "owner_bounded_resource" &&
        usage !== undefined &&
        !usage.consumed &&
        input.count <= usage.remainingCount &&
        context.game.searchSafeResourceCandidates !== undefined
      ) {
        if (allowedLogNames !== undefined && allowedLogNames.length > 0) {
          const search = await context.game.searchSafeResourceCandidates(
            Math.min(32, context.limits.maxMoveDistance),
            Math.min(8, input.count),
            AbortSignal.any([context.signal, AbortSignal.timeout(120_000)]),
            allowedLogNames,
          );
          if (search.stop !== undefined) {
            return safeActionFailure(
              "safety",
              search.stop.code,
              false,
              "search_safe_resource_candidates",
              {
                attemptedWaypoints: search.attemptedWaypoints,
                blockedWaypoints: search.blockedWaypoints,
              },
              [search.stop.reason],
              `安全な候補を探す途中で停止しました。${search.stop.reason}`,
            );
          }
          observed = search.candidates;
          if (observed.length === 0) {
            return safeActionFailure(
              "resource",
              "SAFE_RESOURCE_SEARCH_EXHAUSTED",
              false,
              "search_safe_resource_candidates",
              {
                attemptedWaypoints: search.attemptedWaypoints,
                blockedWaypoints: search.blockedWaypoints,
              },
              ["保護条件を満たす木が探索範囲に現れたら再依頼する"],
              `許可された範囲で${String(search.attemptedWaypoints)}方向を調べましたが、保護条件を満たす木を確認できませんでした。`,
            );
          }
        }
      }
      const decision = chooseSafeCandidate({
        mode: "delegated",
        candidates: observed.map((candidate, index) => ({
          id: candidate.resource,
          label: resourceLabels[candidate.resource] ?? "観測した原木",
          action: "gather_resource",
          observed: true,
          purposeFit: "direct",
          permission: "allowed",
          safety: "allowed",
          reversible: true,
          impact: "low",
          distance: candidate.distance,
          order: index,
        })),
      });
      if (decision.outcome === "clarify") {
        return {
          success: false,
          error: {
            category:
              decision.code === "CHOICE_BLOCKED" ? "safety" : "resource",
            code: decision.code,
            retryable: false,
            failedAt: "choose_safe_resource",
            confirmedState: {
              observedCandidateCount: observed.length,
            },
            nextActions: [decision.question],
            userSummary: decision.question,
          },
        };
      }
      const authorization = context.safeActionAuthorization;
      if (
        authorization?.kind === "owner_bounded_resource" &&
        authorization.selectionRequired === true
      ) {
        const usage = context.safeActionAuthorizationUsage;
        if (
          usage === undefined ||
          usage.consumed ||
          input.count > usage.remainingCount ||
          !authorization.allowedResources.includes(decision.candidate.id)
        ) {
          return safeActionFailure(
            "authorization",
            "SAFE_ACTION_AUTHORIZATION_INVALID",
            false,
            "choose_safe_resource",
            { selectedResource: decision.candidate.id },
            ["所有者の対象と数量を確認してから再依頼する"],
            "選択した原木が所有者の認可範囲に含まれないため、採取を開始しませんでした。",
          );
        }
        Object.assign(authorization, {
          allowedResources: [decision.candidate.id],
          targetItem: decision.candidate.id,
          selectionRequired: false,
        });
      }
      return {
        success: true,
        data: {
          resource: decision.candidate.id,
          count: input.count,
          selectedDistance: decision.candidate.distance ?? null,
          reason: decision.reason,
        },
        evidence: nowEvidence(
          "minecraft_snapshot",
          "保護判定済みの観測候補から安全な原木を選択した",
        ),
        userSummary: `${decision.reason}この原木を${String(input.count)}個集めます。`,
      };
    },
  }),
  defineTool({
    name: "observe_action_candidates",
    description:
      "現在観測できる採掘、回収、クラフト、設置、精錬の候補と、server guardが返した権限・安全状態を取得する。候補のmetadataは説明用で、実行時に再検査される。",
    input: z
      .object({
        radius: z.number().int().min(1).max(32),
        requestedItems: z.array(z.string().trim().min(1).max(64)).max(16),
        maxCandidates: z.number().int().min(1).max(16),
      })
      .strict(),
    fixtures: {
      valid: [{ radius: 8, requestedItems: ["iron_ore"], maxCandidates: 8 }],
      invalid: [{ radius: 0, requestedItems: [], maxCandidates: 8 }],
    },
    action: false,
    execute: async (input, context) => ({
      success: true,
      data: await context.game.observeActionCandidates(input, context.signal),
      evidence: nowEvidence("minecraft_snapshot", "一般操作候補を観測した"),
      userSummary: "周囲から実行可能性を観測できる操作候補を取得しました。",
    }),
  }),
  defineTool({
    name: "mine_block",
    description:
      "観測した単一ブロックを、距離・停止・server guardを再確認して採掘し、所持品差分を確認する。",
    input: z
      .object({
        name: z.string().trim().min(1).max(64),
        position: actionPosition,
      })
      .strict(),
    fixtures: {
      valid: [{ name: "iron_ore", position: { x: 1, y: 63, z: 0 } }],
      invalid: [{ name: "", position: { x: 1, y: 63, z: 0 } }],
    },
    action: true,
    execute: async (input, context) =>
      actionReportResult(await context.game.mineBlock(input, context.signal)),
  }),
  defineTool({
    name: "collect_item",
    description:
      "観測したitem dropへ移動して指定数を回収し、所持品差分を確認する。",
    input: z
      .object({
        name: z.string().trim().min(1).max(64),
        position: actionPosition,
        count: z.number().int().min(1).max(64),
      })
      .strict(),
    fixtures: {
      valid: [{ name: "raw_iron", position: { x: 1, y: 63, z: 0 }, count: 1 }],
      invalid: [
        { name: "raw_iron", position: { x: 1, y: 63, z: 0 }, count: 0 },
      ],
    },
    action: true,
    execute: async (input, context) => {
      if (input.count > context.limits.maxGatherCount)
        return {
          success: false,
          error: {
            category: "validation",
            code: "COLLECT_COUNT_EXCEEDED",
            retryable: false,
            failedAt: "precondition",
            confirmedState: {
              requested: input.count,
              maximum: context.limits.maxGatherCount,
            },
            nextActions: ["数量を減らして依頼する"],
            userSummary: "許可された回収数を超えるため開始しませんでした。",
          },
        };
      return actionReportResult(
        await context.game.collectItem(input, context.signal),
      );
    },
  }),
  defineTool({
    name: "craft_item",
    description:
      "観測したレシピと所持品を使って指定数をクラフトし、所持品差分を確認する。",
    input: z
      .object({
        name: z.string().trim().min(1).max(64),
        count: z.number().int().min(1).max(64),
      })
      .strict(),
    fixtures: {
      valid: [{ name: "iron_pickaxe", count: 1 }],
      invalid: [{ name: "", count: 1 }],
    },
    action: true,
    execute: async (input, context) => {
      if (input.count > context.limits.maxGatherCount)
        return {
          success: false,
          error: {
            category: "validation",
            code: "CRAFT_COUNT_EXCEEDED",
            retryable: false,
            failedAt: "precondition",
            confirmedState: {
              requested: input.count,
              maximum: context.limits.maxGatherCount,
            },
            nextActions: ["数量を減らして依頼する"],
            userSummary: "許可されたクラフト数を超えるため開始しませんでした。",
          },
        };
      return actionReportResult(
        await context.game.craftItem(input, context.signal),
      );
    },
  }),
  defineTool({
    name: "place_block",
    description:
      "観測した空き位置へ所持ブロックを設置する。距離・support・server guard・設置後のblock状態を確認する。",
    input: z
      .object({
        name: z.string().trim().min(1).max(64),
        position: actionPosition,
      })
      .strict(),
    fixtures: {
      valid: [{ name: "cobblestone", position: { x: 1, y: 64, z: 0 } }],
      invalid: [{ name: "", position: { x: 1, y: 64, z: 0 } }],
    },
    action: true,
    execute: async (input, context) =>
      actionReportResult(await context.game.placeBlock(input, context.signal)),
  }),
  defineTool({
    name: "smelt_item",
    description:
      "観測したfurnaceと安全な燃料を使って指定数を精錬し、出力所持品差分を確認する。",
    input: z
      .object({
        input: z.string().trim().min(1).max(64),
        output: z.string().trim().min(1).max(64),
        count: z.number().int().min(1).max(64),
        furnace: actionPosition.nullable(),
      })
      .strict(),
    fixtures: {
      valid: [
        { input: "raw_iron", output: "iron_ingot", count: 1, furnace: null },
      ],
      invalid: [
        { input: "raw_iron", output: "iron_ingot", count: 0, furnace: null },
      ],
    },
    action: true,
    execute: async (input, context) => {
      if (input.count > context.limits.maxGatherCount)
        return {
          success: false,
          error: {
            category: "validation",
            code: "SMELT_COUNT_EXCEEDED",
            retryable: false,
            failedAt: "precondition",
            confirmedState: {
              requested: input.count,
              maximum: context.limits.maxGatherCount,
            },
            nextActions: ["数量を減らして依頼する"],
            userSummary: "許可された精錬数を超えるため開始しませんでした。",
          },
        };
      return actionReportResult(
        await context.game.smeltItem(input, context.signal),
      );
    },
  }),
  defineTool({
    name: "say",
    description: "指定利用者へMinecraft chatで日本語の短いメッセージを送る。",
    input: z.object({ message: z.string().trim().min(1).max(240) }).strict(),
    fixtures: {
      valid: [{ message: "分かりました。" }],
      invalid: [{ message: "" }],
    },
    action: false,
    execute: async (input, context) => {
      await context.game.say(input.message);
      context.recordDeliveredAssistantMessage?.(input.message);
      return {
        success: true,
        data: { delivered: true },
        evidence: [],
        userSummary: "メッセージを送信しました。",
      };
    },
  }),
  defineTool({
    name: "follow_player",
    description:
      "認可済み利用者を安全な距離で追従する。距離・時間を省略した場合は設定済み安全距離と最大60秒（作業上限が短ければその上限）を使い、無期限にはしない。",
    input: z
      .object({
        // Responses API strict function schemas require every property to be
        // present. `null` keeps these values optional to the executor while
        // preserving a required, schema-compatible tool input.
        safeDistance: z.number().min(2).max(16).nullable(),
        maxDurationSeconds: z.number().int().min(1).max(900).nullable(),
      })
      .strict(),
    fixtures: {
      valid: [
        { safeDistance: null, maxDurationSeconds: null },
        { safeDistance: 3, maxDurationSeconds: 60 },
      ],
      invalid: [{ safeDistance: 0, maxDurationSeconds: 60 }],
    },
    action: true,
    execute: async (input, context) => {
      const safeDistance = input.safeDistance ?? context.limits.followDistance;
      const maxDurationSeconds =
        input.maxDurationSeconds ??
        Math.min(
          60,
          Math.max(
            1,
            Math.floor(
              (context.limits.maxSafeActionDurationMs ?? 60_000) / 1_000,
            ),
          ),
        );
      if (safeDistance < 2 || safeDistance > 16) {
        return {
          success: false,
          error: {
            category: "validation",
            code: "FOLLOW_DISTANCE_DEFAULT_INVALID",
            retryable: false,
            failedAt: "precondition",
            confirmedState: { requested: safeDistance },
            nextActions: ["安全距離を2〜16ブロックで指定する"],
            userSummary:
              "設定済みの安全距離を利用できないため、追従を開始しませんでした。",
          },
        };
      }
      if (safeDistance < context.limits.followDistance) {
        return {
          success: false,
          error: {
            category: "validation",
            code: "FOLLOW_DISTANCE_BELOW_CONFIGURED_MINIMUM",
            retryable: false,
            failedAt: "precondition",
            confirmedState: {
              requested: safeDistance,
              minimum: context.limits.followDistance,
            },
            nextActions: ["設定された安全距離以上を指定する"],
            userSummary:
              "設定された安全距離より近いため追従を開始しませんでした。",
          },
        };
      }
      return actionReportResult(
        await context.game.followOwner(
          safeDistance,
          maxDurationSeconds,
          context.signal,
        ),
      );
    },
  }),
  defineTool({
    name: "stop_current_action",
    description: "現在の移動・採掘・長時間作業を直ちに中断する。",
    input: z.object({ reason: z.string().trim().min(1).max(160) }).strict(),
    fixtures: {
      valid: [{ reason: "利用者の停止指示" }],
      invalid: [{ reason: "" }],
    },
    action: true,
    execute: async (input, context) =>
      actionReportResult(await context.game.stopCurrentAction(input.reason)),
  }),
  defineTool({
    name: "move_to",
    description:
      "現在dimension内の上限距離内にある座標へ移動し、前後状態で到達を判定する。",
    input: z
      .object({
        x: z.number(),
        y: z.number(),
        z: z.number(),
        radius: z.number().min(1).max(8),
      })
      .strict(),
    fixtures: {
      valid: [{ x: 1, y: 64, z: 1, radius: 2 }],
      invalid: [{ x: 1, y: 64, z: 1, radius: 0 }],
    },
    action: true,
    execute: async (input, context) => {
      const current = await context.game.currentPosition();
      const distance = Math.hypot(
        input.x - current.x,
        input.y - current.y,
        input.z - current.z,
      );
      if (distance > context.limits.maxMoveDistance) {
        return {
          success: false,
          error: {
            category: "validation",
            code: "MOVE_DISTANCE_EXCEEDED",
            retryable: false,
            failedAt: "precondition",
            confirmedState: {
              distance,
              maximum: context.limits.maxMoveDistance,
            },
            nextActions: ["より近い目的地を指定する"],
            userSummary: "許可された移動距離を超えるため移動しませんでした。",
          },
        };
      }
      return actionReportResult(
        await context.game.moveTo(
          { x: input.x, y: input.y, z: input.z },
          input.radius,
          context.signal,
        ),
      );
    },
  }),
  defineTool({
    name: "gather_resource",
    description:
      "指定した原木を探索・採取・回収し、所持品差分を確認して利用者へ戻る。型付き収集約束の履行ならcommitmentId、通常はnullを指定する。",
    input: z
      .object({
        resource: z.enum(resourceNames),
        count: z.number().int().min(1).max(64),
        commitmentId: z.string().trim().min(1).max(100).nullable(),
      })
      .strict(),
    fixtures: {
      valid: [{ resource: "oak_log", count: 4, commitmentId: null }],
      invalid: [{ resource: "stone", count: 4, commitmentId: null }],
    },
    action: true,
    authorization: "owner_bounded_resource",
    execute: async (input, context) => {
      if (input.count > context.limits.maxGatherCount) {
        return {
          success: false,
          error: {
            category: "validation",
            code: "GATHER_COUNT_EXCEEDED",
            retryable: false,
            failedAt: "precondition",
            confirmedState: {
              requested: input.count,
              maximum: context.limits.maxGatherCount,
            },
            nextActions: ["数量を減らして依頼する"],
            userSummary: "許可された採取数を超えるため開始しませんでした。",
          },
        };
      }
      return actionReportResult(
        await context.game.gatherResource(
          input.resource,
          input.count,
          context.signal,
        ),
      );
    },
  }),
  defineTool({
    name: "return_to_player",
    description: "認可済み利用者の現在位置を再観測して安全な距離まで戻る。",
    input: z
      .object({
        safeDistance: z.number().min(2).max(16),
      })
      .strict(),
    fixtures: {
      valid: [{ safeDistance: 3 }],
      invalid: [{ safeDistance: 0 }],
    },
    action: true,
    execute: async (input, context) => {
      if (input.safeDistance < context.limits.followDistance) {
        return {
          success: false,
          error: {
            category: "validation",
            code: "RETURN_DISTANCE_BELOW_CONFIGURED_MINIMUM",
            retryable: false,
            failedAt: "precondition",
            confirmedState: {
              requested: input.safeDistance,
              minimum: context.limits.followDistance,
            },
            nextActions: ["設定された安全距離以上を指定する"],
            userSummary:
              "設定された安全距離より近いため帰還を開始しませんでした。",
          },
        };
      }
      return actionReportResult(
        await context.game.returnToOwner(input.safeDistance, context.signal),
      );
    },
  }),
  defineTool({
    name: "remember_player_fact",
    description: "利用者が明示した事実を、推論と区別して構造化記憶へ保存する。",
    input: z
      .object({
        subject: z.string().trim().min(1).max(80),
        predicate: z.string().trim().min(1).max(80),
        value: z.string().trim().min(1).max(500),
      })
      .strict(),
    fixtures: {
      valid: [{ subject: "利用者", predicate: "好きな木", value: "桜" }],
      invalid: [{ subject: "", predicate: "好きな木", value: "桜" }],
    },
    action: false,
    execute: async (input, context) => {
      const record = context.memory.rememberPlayerFact({
        playerId: context.playerId,
        ...input,
        source: "player_stated",
      });
      return {
        success: true,
        data: { stored: true, record },
        evidence: nowEvidence(
          "memory_record",
          "利用者が明示した事実を保存した",
        ),
        userSummary: "教えてもらった事実を記憶しました。",
      };
    },
  }),
  defineTool({
    name: "remember_location",
    description: "現在観測している場所へ名前と用途を付けて記憶する。",
    input: z
      .object({
        name: z.string().trim().min(1).max(100),
        purpose: z.string().trim().min(1).max(300),
      })
      .strict(),
    fixtures: {
      valid: [{ name: "拠点", purpose: "帰還場所" }],
      invalid: [{ name: "", purpose: "帰還場所" }],
    },
    action: false,
    execute: async (input, context) => {
      const position = await context.game.currentPosition();
      const record = context.memory.rememberLocation({
        playerId: context.playerId,
        ...input,
        ...position,
      });
      return {
        success: true,
        data: { stored: true, record },
        evidence: nowEvidence(
          "memory_record",
          "現在地をMinecraft観測とともに保存した",
        ),
        userSummary: `${input.name}を場所として記憶しました。`,
      };
    },
  }),
  defineTool({
    name: "recall_memory",
    description: "現在の会話・作業に関連する構造化記憶だけを検索する。",
    input: z
      .object({
        query: z.string().trim().min(1).max(200),
        kinds: z.array(z.enum(memoryKinds)).min(1).max(memoryKinds.length),
        limit: z.number().int().min(1).max(20),
      })
      .strict(),
    fixtures: {
      valid: [{ query: "拠点", kinds: ["location"], limit: 5 }],
      invalid: [{ query: "", kinds: [], limit: 5 }],
    },
    action: false,
    execute: async (input, context) => {
      const limit = Math.min(input.limit, context.limits.memoryContextLimit);
      const records = context.memory.recall({
        playerId: context.playerId,
        query: input.query,
        kinds: input.kinds,
        limit,
      });
      return {
        success: true,
        data: { records },
        evidence: nowEvidence(
          "memory_record",
          `${String(records.length)}件の関連記憶を取得した`,
        ),
        userSummary: `${String(records.length)}件の関連記憶を確認しました。`,
      };
    },
  }),
  defineTool({
    name: "set_commitment",
    description:
      "利用者との約束を未完了状態で保存する。原木収集をMinecraft観測で自動完了する約束だけfulfillmentTool/resource/countを指定し、それ以外は3項目をnullにする。",
    input: z
      .object({
        description: z.string().trim().min(1).max(500),
        fulfillmentTool: z.literal("gather_resource").nullable(),
        resource: z.enum(resourceNames).nullable(),
        count: z.number().int().min(1).max(64).nullable(),
      })
      .strict(),
    fixtures: {
      valid: [
        {
          description: "オークの原木を4個集めて戻る",
          fulfillmentTool: "gather_resource",
          resource: "oak_log",
          count: 4,
        },
        {
          description: "あとで相談する",
          fulfillmentTool: null,
          resource: null,
          count: null,
        },
      ],
      invalid: [
        {
          description: "",
          fulfillmentTool: null,
          resource: null,
          count: null,
        },
      ],
    },
    action: false,
    execute: async (input, context) => {
      const fulfillment =
        input.fulfillmentTool === "gather_resource" &&
        input.resource !== null &&
        input.count !== null
          ? {
              toolName: "gather_resource" as const,
              resource: input.resource,
              count: input.count,
            }
          : undefined;
      const noFulfillment =
        input.fulfillmentTool === null &&
        input.resource === null &&
        input.count === null;
      if (fulfillment === undefined && !noFulfillment) {
        return {
          success: false,
          error: {
            category: "validation",
            code: "COMMITMENT_FULFILLMENT_INVALID",
            retryable: false,
            failedAt: "set_commitment",
            confirmedState: {},
            nextActions: ["収集条件3項目をすべて指定するか、すべてnullにする"],
            userSummary: "約束の完了条件が不完全なため、保存しませんでした。",
          },
        };
      }
      const commitment = context.memory.setCommitment({
        playerId: context.playerId,
        description: input.description,
        ...(fulfillment === undefined ? {} : { fulfillment }),
      });
      return {
        success: true,
        data: commitment,
        evidence: nowEvidence("memory_record", "未完了の約束を保存した"),
        userSummary: "約束として記憶しました。",
      };
    },
  }),
  defineTool({
    name: "complete_commitment",
    description:
      "既存の約束を完了にする。tool結果が根拠なら同じ会話内で約束に束縛した成功行動のreceiptIdを使いevidenceSummaryはnull、利用者確認ならreceiptIdはnullにする。",
    input: z
      .object({
        commitmentId: z.string().trim().min(1).max(100),
        outcome: z.string().trim().min(1).max(500),
        basis: z.enum(["owner_confirmation", "verified_tool_result"]),
        receiptId: z.uuid().nullable(),
        evidenceSummary: z.string().trim().min(1).max(500).nullable(),
      })
      .strict(),
    fixtures: {
      valid: [
        {
          commitmentId: "commitment-id",
          outcome: "観測済みの結果",
          basis: "owner_confirmation",
          receiptId: null,
          evidenceSummary: "指定利用者が現在の発話で完了を確認した",
        },
        {
          commitmentId: "commitment-id",
          outcome: "観測済みの結果",
          basis: "verified_tool_result",
          receiptId: "00000000-0000-4000-8000-000000000001",
          evidenceSummary: null,
        },
      ],
      invalid: [
        {
          commitmentId: "",
          outcome: "結果",
          basis: "owner_confirmation",
          receiptId: null,
          evidenceSummary: "確認済み",
        },
      ],
    },
    action: false,
    execute: async (input, context) => {
      if (
        input.basis === "owner_confirmation" &&
        (input.receiptId !== null || input.evidenceSummary === null)
      ) {
        return {
          success: false,
          error: {
            category: "validation",
            code: "COMMITMENT_VERIFICATION_BASIS_MISMATCH",
            retryable: false,
            failedAt: "complete_commitment",
            confirmedState: { basis: input.basis },
            nextActions: [
              "利用者確認ではreceiptIdをnullにし、確認内容を指定する",
            ],
            userSummary:
              "利用者確認とtool証跡が混在しているため、約束を完了にしませんでした。",
          },
        };
      }
      const receipt = context.executionEvidence.verifiedActionReceipts.find(
        (candidate) =>
          !candidate.used &&
          candidate.receiptId === input.receiptId &&
          candidate.commitmentId === input.commitmentId &&
          candidate.correlationId === context.correlationId,
      );
      if (
        input.basis === "verified_tool_result" &&
        (input.evidenceSummary !== null || receipt === undefined)
      ) {
        return {
          success: false,
          error: {
            category: "validation",
            code: "COMMITMENT_VERIFIED_ACTION_MISSING",
            retryable: false,
            failedAt: "complete_commitment",
            confirmedState: {
              verifiedActionEvidenceMatched: false,
              receiptId: input.receiptId,
            },
            nextActions: [
              "同じ会話処理内で約束に束縛した行動を成功させ、そのreceiptを使用する",
            ],
            userSummary:
              "一致する一回限りのMinecraft行動証跡がないため、約束を完了にしませんでした。",
          },
        };
      }
      const commitment = context.memory.completeCommitment({
        playerId: context.playerId,
        commitmentId: input.commitmentId,
        outcome: input.outcome,
        verificationSource: input.basis,
        verificationEvidence:
          receipt === undefined
            ? (input.evidenceSummary ?? "利用者確認")
            : receiptEvidence(receipt),
      });
      if (receipt !== undefined) receipt.used = true;
      return {
        success: true,
        data: commitment,
        evidence: nowEvidence("memory_record", "約束を完了状態へ更新した"),
        userSummary: "約束の完了を記録しました。",
      };
    },
  }),
] as const;

/** Persistent writes need owner scope even when not marked as game actions. */
export const ownerScopedMutationToolNames: ReadonlySet<string> = new Set([
  "register_delivery_target",
  "forget_delivery_target",
  "remember_player_fact",
  "remember_location",
  "set_commitment",
  "complete_commitment",
]);

function receiptEvidence(receipt: {
  receiptId: string;
  correlationId: string;
  toolName: string;
  evidence: readonly EvidenceReference[];
}): string {
  const summaries = receipt.evidence.map(({ summary }) => summary).join(" / ");
  return [
    `receipt=${receipt.receiptId}`,
    `correlation=${receipt.correlationId}`,
    `tool=${receipt.toolName}`,
    `evidence=${summaries}`,
  ]
    .join("; ")
    .slice(0, 500);
}

export type RegisteredToolName = (typeof toolDefinitions)[number]["name"];

export function getToolDefinition(name: string): ToolDefinition | undefined {
  return toolDefinitions.find((definition) => definition.name === name);
}

export function isToolResult(value: unknown): value is ToolResult<unknown> {
  return (
    typeof value === "object" &&
    value !== null &&
    "success" in value &&
    typeof value.success === "boolean"
  );
}
