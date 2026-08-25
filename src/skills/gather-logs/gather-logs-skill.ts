import { AppError } from "../../domain/errors.js";
import { countInventory, type WorldSnapshot } from "../../domain/snapshot.js";
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
      const lease = this.arbiter.acquire(
        `task:${context.taskId}`,
        actionPriorities.task,
      );
      const signal = AbortSignal.any([context.signal, lease.signal]);
      const itemName = input.resource;
      const before = await this.minecraft.observe();
      const startedAt = before.observedAt;
      this.requireRequester(before, input.requester);
      const baseline = countInventory(before, itemName);
      let frontierIndex = 0;
      const frontier = createSearchFrontier(
        before.position,
        this.limits.searchStep,
        this.limits.maxSearchDistance,
      );

      try {
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
          let targets = await this.minecraft.findResources(
            [itemName],
            this.limits.localSearchDistance,
            Math.min(input.count - acquired, 8),
          );
          if (targets.length === 0) {
            const searchPoint = frontier[frontierIndex];
            if (searchPoint === undefined) {
              throw new AppError({
                category: "resource",
                code: "RESOURCE_NOT_FOUND",
                message:
                  "No requested logs were observed within the configured search area",
                retryable: false,
                failedAt: "locate_resource",
                confirmedState: {
                  acquired,
                  maxSearchDistance: this.limits.maxSearchDistance,
                },
              });
            }
            frontierIndex += 1;
            await context.advance("explore", { frontierIndex, searchPoint });
            await this.minecraft.moveTo(
              searchPoint,
              this.limits.moveRange,
              signal,
            );
            continue;
          }

          let resourceChanged = false;
          for (const target of targets) {
            const latest = await this.minecraft.observe();
            if (countInventory(latest, itemName) - baseline >= input.count)
              break;
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
              );
            } catch (error) {
              if (
                error instanceof AppError &&
                error.detail.code === "RESOURCE_CHANGED"
              ) {
                resourceChanged = true;
                break;
              }
              throw error;
            }
          }
          targets = [];
          if (resourceChanged) continue;
        }

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
  ): Promise<void> {
    await advance("move_to_resource", { target: target.position });
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
    const beforeDig = await this.minecraft.observe();
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
          await this.minecraft.moveTo(player.position, range, signal);
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
