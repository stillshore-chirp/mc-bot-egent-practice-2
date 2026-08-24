import type { Position } from "../domain/snapshot.js";
import type { TaskRecord } from "../domain/task.js";
import type { MinecraftPort } from "../minecraft/port.js";
import {
  actionPriorities,
  type ActionArbiter,
} from "../runtime/action-arbiter.js";
import type { TaskRuntime } from "../runtime/task-service.js";
import { withTimeout } from "../runtime/timeout.js";
import type { Skill } from "./contract.js";

export interface MoveToInput {
  readonly position: Position;
  readonly range: number;
  readonly timeoutMs: number;
}

export interface MoveToOutput {
  readonly position: Position;
}

export class MoveToSkill implements Skill<MoveToInput, MoveToOutput> {
  public readonly name = "move_to";

  public constructor(
    private readonly minecraft: MinecraftPort,
    private readonly tasks: TaskRuntime,
    private readonly arbiter: ActionArbiter,
  ) {}

  public async run(
    input: MoveToInput,
  ): Promise<TaskRecord<MoveToInput, MoveToOutput>> {
    return this.tasks.run(this.name, input, async (context) => {
      const lease = this.arbiter.acquire(
        `task:${context.taskId}`,
        actionPriorities.task,
      );
      try {
        await context.advance("move_to", { destination: input.position });
        await withTimeout(
          (timeoutSignal) =>
            this.minecraft.moveTo(
              input.position,
              input.range,
              AbortSignal.any([context.signal, lease.signal, timeoutSignal]),
            ),
          input.timeoutMs,
          context.signal,
          "move_to",
        );
        return { position: (await this.minecraft.observe()).position };
      } finally {
        lease.release();
      }
    });
  }
}
