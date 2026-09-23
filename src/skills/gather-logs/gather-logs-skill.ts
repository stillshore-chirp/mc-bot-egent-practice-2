import { AppError } from "../../domain/errors.js";
import {
  countInventory,
  distance,
  type Position,
  type WorldSnapshot,
} from "../../domain/snapshot.js";
import type { TaskRecord } from "../../domain/task.js";
import type { MinecraftPort, ResourceTarget } from "../../minecraft/port.js";
import {
  actionPriorities,
  type ActionArbiter,
} from "../../runtime/action-arbiter.js";
import type { TaskContext, TaskRuntime } from "../../runtime/task-service.js";
import {
  verifyGatherCompletion,
  type GatherVerification,
} from "../../verification/conditions.js";
import type { Skill } from "../contract.js";
import type { GatherableLog } from "./resource-catalog.js";
import { createSearchFrontier } from "./search-strategy.js";

export interface GatherLogsInput {
  readonly resource: GatherableLog;
  readonly count: number;
  readonly requester: string;
}

export interface GatherLogsOutput extends GatherVerification {
  readonly startedAt: string;
  readonly completedAt: string;
}

export interface GatherLogsLimits {
  readonly maxCount: number;
  readonly localSearchDistance: number;
  readonly maxSearchDistance: number;
  readonly searchStep: number;
  readonly moveRange: number;
  readonly returnRange: number;
  readonly maxPathAttempts: number;
}

function positionKey(position: Position): string {
  return `${position.x}:${position.y}:${position.z}`;
}

export class GatherLogsSkill implements Skill<
  GatherLogsInput,
  GatherLogsOutput
> {
  public readonly name = "gather_resource";

  public constructor(
    private readonly minecraft: MinecraftPort,
    private readonly tasks: TaskRuntime,
    private readonly arbiter: ActionArbiter,
    private readonly limits: GatherLogsLimits,
  ) {}

  public async run(
    input: GatherLogsInput,
  ): Promise<TaskRecord<GatherLogsInput, GatherLogsOutput>> {
    this.validateInput(input);
    return this.tasks.run(this.name, input, async (context) => {
      await this.arbiter.waitForAvailable(
        actionPriorities.task,
        context.signal,
      );
      const lease = this.arbiter.acquire(
        `task:${context.taskId}`,
        actionPriorities.task,
      );
      const signal = AbortSignal.any([context.signal, lease.signal]);
      const itemName = input.resource;
      try {
        const { before, startedAt } = await this.collect(
          input,
          context,
          signal,
          true,
        );
        await this.returnToRequester(
          input.requester,
          this.limits.returnRange,
          (phase, checkpoint) => context.advance(phase, checkpoint),
          (operationName, operation, policy, shouldRetry, retrySignal) =>
            context.retry(
              operationName,
              operation,
              policy,
              shouldRetry,
              retrySignal,
            ),
          signal,
        );
        await context.advance("final_verify");
        const after = await this.minecraft.observe();
        const verified = verifyGatherCompletion(
          before,
          after,
          itemName,
          input.count,
          input.requester,
          this.limits.returnRange,
        );
        return { ...verified, startedAt, completedAt: after.observedAt };
      } finally {
        lease.release();
      }
    });
  }

  /** Called only inside a task that already owns the action lease. */
  public async collect(
    input: GatherLogsInput,
    context: TaskContext,
    signal: AbortSignal,
    requireRequester = false,
    returnBoundary?: { center: Position; radius: number },
  ) {
    this.validateInput(input);
    const itemName = input.resource;
    const before = await this.minecraft.observe();
    const startedAt = before.observedAt;
    if (requireRequester) this.requireRequester(before, input.requester);
    const baseline = countInventory(before, itemName);
    let frontierIndex = 0;
    let blockedFrontiers = 0;
    const blockedTargets = new Set<string>();
    // 回収対象は原木から8ブロック以内。到達半径と座標丸めも内側に確保する。
    const reserve = Math.max(10, this.limits.moveRange + 0.75);
    const withinReturnRange = (position: Position) =>
      returnBoundary === undefined ||
      distance(position, returnBoundary.center) + reserve <=
        returnBoundary.radius;
    const frontier = createSearchFrontier(
      before.position,
      this.limits.searchStep,
      this.limits.maxSearchDistance,
    ).filter(withinReturnRange);

    await context.advance("precheck", {
      itemName,
      baseline,
      requestedCount: input.count,
    });
    while (
      countInventory(await this.minecraft.observe(), itemName) - baseline <
      input.count
    ) {
      const current = await this.minecraft.observe();
      const acquired = countInventory(current, itemName) - baseline;
      await context.advance("locate_resource", {
        acquired,
        requestedCount: input.count,
        frontierIndex,
      });
      const targets = (
        await this.minecraft.findResources(
          [itemName],
          this.limits.localSearchDistance,
          16,
          signal,
        )
      ).filter(
        (target) =>
          withinReturnRange(target.position) &&
          !blockedTargets.has(positionKey(target.position)),
      );
      if (targets.length === 0) {
        const searchPoint = frontier[frontierIndex];
        if (searchPoint === undefined) {
          const blocked = blockedTargets.size + blockedFrontiers;
          throw new AppError({
            category: blocked > 0 ? "path" : "resource",
            code: blocked > 0 ? "RESOURCE_PATHS_BLOCKED" : "RESOURCE_NOT_FOUND",
            message:
              blockedTargets.size > 0
                ? "保護条件を満たす原木は確認しましたが、探索した経路からは安全に近づけませんでした。"
                : blockedFrontiers > 0
                  ? "一部の探索経路が塞がれており、範囲内に採取可能な原木があるか確認できませんでした。"
                  : "保護条件を満たす原木が探索範囲にありません。成長履歴のない木や建築に接する木は残しています。補助の稼働中に育った木を用意してください。",
            retryable: false,
            failedAt: "locate_resource",
            confirmedState: {
              acquired,
              maxSearchDistance: this.limits.maxSearchDistance,
              blockedTargets: blockedTargets.size,
              blockedFrontiers,
            },
          });
        }
        frontierIndex += 1;
        await context.advance("explore", { frontierIndex, searchPoint });
        try {
          await this.minecraft.moveTo(
            searchPoint,
            this.limits.moveRange,
            signal,
          );
        } catch (error) {
          if (error instanceof AppError && error.detail.category === "path") {
            blockedFrontiers += 1;
            continue;
          }
          throw error;
        }
        continue;
      }

      let resourceChanged = false;
      for (const target of targets) {
        const latest = await this.minecraft.observe();
        if (countInventory(latest, itemName) - baseline >= input.count) break;
        try {
          await this.collectTarget(
            target,
            itemName,
            baseline,
            (phase, checkpoint) => context.advance(phase, checkpoint),
            (operationName, operation, policy, shouldRetry, retrySignal) =>
              context.retry(
                operationName,
                operation,
                policy,
                shouldRetry,
                retrySignal,
              ),
            signal,
            returnBoundary,
          );
        } catch (error) {
          if (
            error instanceof AppError &&
            error.detail.code === "RESOURCE_CHANGED"
          ) {
            resourceChanged = true;
            break;
          }
          if (
            error instanceof AppError &&
            error.detail.category === "path" &&
            error.detail.failedAt === "move_to_resource"
          ) {
            blockedTargets.add(positionKey(target.position));
            continue;
          }
          throw error;
        }
      }
      if (resourceChanged) continue;
    }

    return { before, startedAt, baseline };
  }

  private async collectTarget(
    target: ResourceTarget,
    itemName: string,
    baseline: number,
    advance: (
      phase: string,
      checkpoint?: Readonly<Record<string, unknown>>,
    ) => Promise<void>,
    retryOperation: TaskContext["retry"],
    signal: AbortSignal,
    returnBoundary?: { center: Position; radius: number },
  ): Promise<void> {
    await advance("move_to_resource", { target: target.position });
    try {
      await retryOperation(
        "move_to_resource",
        async () =>
          this.minecraft.moveTo(target.position, this.limits.moveRange, signal),
        {
          maxAttempts: this.limits.maxPathAttempts,
          initialDelayMs: 100,
          maxDelayMs: 500,
          multiplier: 2,
        },
        (error) => error instanceof AppError && error.detail.retryable,
        signal,
      );
    } catch (error) {
      if (error instanceof AppError && error.detail.category === "path") {
        throw new AppError(
          { ...error.detail, failedAt: "move_to_resource" },
          { cause: error },
        );
      }
      throw error;
    }
    const beforeDig = await this.minecraft.observe();
    if (
      returnBoundary &&
      distance(beforeDig.position, returnBoundary.center) >
        returnBoundary.radius
    )
      throw new AppError({
        category: "validation",
        code: "DELIVERY_DISTANCE_EXCEEDED",
        message: "帰還可能な範囲外にいるため採掘しません。",
        retryable: false,
      });
    await advance("dig", {
      target: target.position,
      heldCount: countInventory(beforeDig, itemName),
    });
    await retryOperation(
      "dig_resource",
      () => this.minecraft.dig(target, signal),
      {
        maxAttempts: this.limits.maxPathAttempts,
        initialDelayMs: 100,
        maxDelayMs: 500,
        multiplier: 2,
      },
      (error) =>
        error instanceof AppError &&
        error.detail.retryable &&
        error.detail.code !== "RESOURCE_CHANGED",
      signal,
    );
    const expectedInventoryCount = Math.max(
      baseline + 1,
      countInventory(beforeDig, itemName) + 1,
    );
    await advance("collect_drop", {
      target: target.position,
      expectedInventoryCount,
    });
    await this.minecraft.collectDropsNear(
      target.position,
      itemName,
      expectedInventoryCount,
      signal,
    );
    const after = await this.minecraft.observe();
    if (countInventory(after, itemName) < expectedInventoryCount) {
      throw new AppError({
        category: "inventory",
        code: "INVENTORY_INCREMENT_NOT_VERIFIED",
        message: "The expected log was not observed in inventory",
        retryable: true,
        failedAt: "verify_increment",
      });
    }
    await advance("verify_increment", {
      heldCount: countInventory(after, itemName),
    });
  }

  private async returnToRequester(
    username: string,
    range: number,
    advance: (
      phase: string,
      checkpoint?: Readonly<Record<string, unknown>>,
    ) => Promise<void>,
    retryOperation: TaskContext["retry"],
    signal: AbortSignal,
  ): Promise<void> {
    await retryOperation(
      "return_to_requester",
      async (attempt) => {
        const snapshot = await this.minecraft.observe();
        const player = this.requireRequester(snapshot, username);
        await advance("return_to_requester", {
          attempt,
          observedDistance: player.distance,
        });
        if (player.distance > range)
          // ブロック単位の到着判定による端数を見込み、実座標の許容範囲内を目指す。
          await this.minecraft.moveTo(
            player.position,
            Math.max(0, range - 1),
            signal,
          );
        const verified = (await this.minecraft.observe()).players.find(
          (candidate) => candidate.username === username,
        );
        if (verified === undefined || verified.distance > range) {
          throw new AppError({
            category: "observation",
            code: "RETURN_NOT_VERIFIED",
            message: "Requester return could not be verified",
            retryable: true,
            failedAt: "return_to_requester",
          });
        }
      },
      {
        maxAttempts: this.limits.maxPathAttempts,
        initialDelayMs: 100,
        maxDelayMs: 500,
        multiplier: 2,
      },
      (error) => error instanceof AppError && error.detail.retryable,
      signal,
    );
  }

  private requireRequester(snapshot: WorldSnapshot, username: string) {
    const player = snapshot.players.find(
      (candidate) => candidate.username === username,
    );
    if (player === undefined) {
      throw new AppError({
        category: "observation",
        code: "REQUESTER_NOT_VISIBLE",
        message: "The requester is not currently visible",
        retryable: true,
        failedAt: "precheck",
      });
    }
    return player;
  }

  private validateInput(input: GatherLogsInput): void {
    if (
      !Number.isInteger(input.count) ||
      input.count < 1 ||
      input.count > this.limits.maxCount
    ) {
      throw new AppError({
        category: "validation",
        code: "INVALID_GATHER_COUNT",
        message: `count must be an integer between 1 and ${String(this.limits.maxCount)}`,
        retryable: false,
      });
    }
  }
}
