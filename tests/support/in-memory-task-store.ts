import type { TaskRecord } from "../../src/domain/task.js";
import type { TaskStore } from "../../src/runtime/task-service.js";

export class InMemoryTaskStore implements TaskStore {
  public readonly records: TaskRecord[] = [];

  public async save(record: TaskRecord): Promise<void> {
    this.records.push(structuredClone(record));
  }
}
