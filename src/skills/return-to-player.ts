import { AppError } from "../domain/errors.js";
import type { TaskRecord } from "../domain/task.js";
import type { MinecraftPort } from "../minecraft/port.js";
import {
  actionPriorities,
  type ActionArbiter,
} from "../runtime/action-arbiter.js";
import type { TaskRuntime } from "../runtime/task-service.js";
import type { Skill } from "./contract.js";

export interface ReturnToPlayerInput {
  readonly username: string;
  readonly range: number;
  readonly maxAttempts: number;
}

export interface ReturnToPlayerOutput {
  readonly distance: number;
  readonly usedDescent: boolean;
  readonly predictedMaxDamage: number;
  readonly healthBefore: number;
  readonly healthAfter: number;
}

export class ReturnToPlayerSkill implements Skill<
  ReturnToPlayerInput,
  ReturnToPlayerOutput
> {
  public readonly name = "return_to_player";

  public constructor(
    private readonly minecraft: MinecraftPort,
    private readonly tasks: TaskRuntime,
    private readonly arbiter: ActionArbiter,
  ) {}

  public async run(
    input: ReturnToPlayerInput,
  ): Promise<TaskRecord<ReturnToPlayerInput, ReturnToPlayerOutput>> {
    return this.tasks.run(this.name, input, async (context) => {
      await this.arbiter.waitForAvailable(
        actionPriorities.task,
        context.signal,
      );
      const lease = this.arbiter.acquire(
        `task:${context.taskId}`,
        actionPriorities.task,
      );
      try {
        const initial = await this.minecraft.observe();
        let usedDescent = false;
        let predictedMaxDamage = 0;
        await context.retry(
          "return_to_player",
          async (attempt) => {
            const snapshot = await this.minecraft.observe();
            const player = snapshot.players.find(
              (candidate) => candidate.username === input.username,
            );
            if (player === undefined) {
              throw new AppError({
                category: "observation",
                code: "PLAYER_NOT_VISIBLE",
                message: "The requester is not visible",
                retryable: true,
                failedAt: "return_to_player",
              });
            }
            await context.advance("return_to_player", {
              attempt,
              observedDistance: player.distance,
            });
            if (player.distance > input.range) {
              const movement = await this.minecraft.moveToWithSafeDescent(
                player.position,
                input.range,
                AbortSignal.any([context.signal, lease.signal]),
              );
              usedDescent ||= movement.usedDescent;
              predictedMaxDamage += movement.predictedMaxDamage;
            }
            const verified = (await this.minecraft.observe()).players.find(
              (candidate) => candidate.username === input.username,
            );
            if (verified === undefined || verified.distance > input.range) {
              throw new AppError({
                category: "observation",
                code: "RETURN_NOT_VERIFIED",
                message: "Return position could not be verified",
                retryable: true,
                failedAt: "return_to_player",
              });
            }
          },
          {
            maxAttempts: input.maxAttempts,
            initialDelayMs: 100,
            maxDelayMs: 500,
            multiplier: 2,
          },
          (error) => error instanceof AppError && error.detail.retryable,
          context.signal,
        );
        const final = await this.minecraft.observe();
        const player = final.players.find(
          (candidate) => candidate.username === input.username,
        );
        return {
          distance: player?.distance ?? Number.POSITIVE_INFINITY,
          usedDescent,
          predictedMaxDamage,
          healthBefore: initial.health,
          healthAfter: final.health,
        };
      } finally {
        lease.release();
      }
    });
  }
}
