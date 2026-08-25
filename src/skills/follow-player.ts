import type { TaskRecord } from "../domain/task.js";
import type { MinecraftPort } from "../minecraft/port.js";
import {
  actionPriorities,
  type ActionArbiter,
} from "../runtime/action-arbiter.js";
import type { TaskRuntime } from "../runtime/task-service.js";
import type { Skill } from "./contract.js";

export interface FollowPlayerInput {
  readonly username: string;
  readonly range: number;
  readonly maxDurationMs: number;
  readonly maxPathAttempts: number;
}

export interface FollowPlayerOutput {
  readonly followedUntil: string;
}

export class FollowPlayerSkill implements Skill<
  FollowPlayerInput,
  FollowPlayerOutput
> {
  public readonly name = "follow_player";

  public constructor(
    private readonly minecraft: MinecraftPort,
    private readonly tasks: TaskRuntime,
    private readonly arbiter: ActionArbiter,
  ) {}

  public async run(
    input: FollowPlayerInput,
  ): Promise<TaskRecord<FollowPlayerInput, FollowPlayerOutput>> {
    return this.tasks.run(this.name, input, async (context) => {
      const lease = this.arbiter.acquire(
        `task:${context.taskId}`,
        actionPriorities.task,
      );
      const duration = AbortSignal.timeout(input.maxDurationMs);
      try {
        await context.advance("following", { username: input.username });
        await this.minecraft.followPlayer(
          input.username,
          input.range,
          input.maxPathAttempts,
          AbortSignal.any([context.signal, lease.signal, duration]),
        );
        return { followedUntil: new Date().toISOString() };
      } finally {
        lease.release();
      }
    });
  }
}
