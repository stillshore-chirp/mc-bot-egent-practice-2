import type { TaskRecord } from "../domain/task.js";

export interface Skill<Input, Output> {
  readonly name: string;
  run(input: Input): Promise<TaskRecord<Input, Output>>;
}
