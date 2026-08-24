import type { TaskRecord } from "../domain/task.js";
import type { MemoryStore } from "../memory/store.js";
import type { JsonObject, JsonValue } from "../memory/types.js";
import { currentCorrelationId } from "../observability/correlation.js";
import type { TaskStore } from "../runtime/task-service.js";
import type { MemoryPort } from "../tools/contracts.js";

const PRIVATE_TASK_KEYS = new Set(["username", "requester", "playerName"]);

export class ToolMemoryAdapter implements MemoryPort {
  public constructor(private readonly store: MemoryStore) {}

  public rememberPlayerFact(
    input: Parameters<MemoryPort["rememberPlayerFact"]>[0],
  ) {
    return this.store.rememberPlayerFact(input);
  }

  public rememberLocation(
    input: Parameters<MemoryPort["rememberLocation"]>[0],
  ) {
    return this.store.rememberLocation(input);
  }

  public recall(input: Parameters<MemoryPort["recall"]>[0]) {
    return this.store.recall(input);
  }

  public setCommitment(input: Parameters<MemoryPort["setCommitment"]>[0]) {
    return this.store.setCommitment(input);
  }

  public completeCommitment(
    input: Parameters<MemoryPort["completeCommitment"]>[0],
  ) {
    return this.store.completeCommitment(input);
  }
}

export class MemoryTaskStore implements TaskStore {
  readonly #taskIds = new Map<string, string>();
  readonly #episodeTaskIds = new Set<string>();

  public constructor(
    private readonly store: MemoryStore,
    private readonly playerId: string,
  ) {}

  public async save(record: TaskRecord): Promise<void> {
    const storedId = this.#taskIds.get(record.id);
    if (storedId === undefined) {
      const correlationId = currentCorrelationId();
      const created = this.store.createTaskRun({
        playerId: this.playerId,
        kind: record.kind,
        input: {
          ...toTaskObject(record.input, "task input"),
          ...(correlationId === undefined ? {} : { correlationId }),
        },
        status: record.status,
        phase: record.phase,
      });
      this.#taskIds.set(record.id, created.id);
      return;
    }

    this.store.updateTaskRun({
      taskRunId: storedId,
      status: record.status,
      phase: record.phase,
      ...(record.output === undefined
        ? {}
        : { output: toJsonValue(record.output, "task output") }),
      ...(record.failure === undefined
        ? {}
        : {
            failure: {
              category: record.failure.category,
              code: record.failure.code,
              message: record.failure.message,
              retryable: record.failure.retryable,
              ...(record.failure.confirmedState === undefined
                ? {}
                : {
                    confirmedState: toTaskObject(
                      record.failure.confirmedState,
                      "failure state",
                    ),
                  }),
            },
          }),
      ...(record.checkpoint === undefined
        ? {}
        : { checkpoint: toTaskObject(record.checkpoint, "task checkpoint") }),
    });
    if (
      ["completed", "failed", "cancelled"].includes(record.status) &&
      !this.#episodeTaskIds.has(record.id)
    ) {
      const correlationId = currentCorrelationId();
      this.store.recordEpisode({
        playerId: this.playerId,
        summary: `${record.kind} task ${record.status}`,
        importance: record.status === "completed" ? 3 : 4,
        source: "minecraft_observed",
        details: {
          taskRunId: storedId,
          status: record.status,
          phase: record.phase,
          ...(record.failure?.code === undefined
            ? {}
            : { failureCode: record.failure.code }),
          ...(correlationId === undefined ? {} : { correlationId }),
        },
        observedAt: record.updatedAt,
      });
      this.#episodeTaskIds.add(record.id);
    }
  }
}

function toTaskObject(value: unknown, label: string): JsonObject {
  const converted = toJsonValue(value, label, true);
  if (!isJsonObject(converted)) {
    throw new TypeError(`${label} must be an object`);
  }
  return converted;
}

function isJsonObject(value: JsonValue): value is JsonObject {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function toJsonValue(
  value: unknown,
  label: string,
  stripPrivate = false,
): JsonValue {
  if (
    value === null ||
    typeof value === "string" ||
    typeof value === "boolean"
  ) {
    return value;
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value))
      throw new TypeError(`${label} contains a non-finite number`);
    return value;
  }
  if (Array.isArray(value)) {
    return value.map((item) => toJsonValue(item, label, stripPrivate));
  }
  if (typeof value === "object") {
    const result: Record<string, JsonValue> = {};
    for (const [key, item] of Object.entries(value)) {
      if (stripPrivate && PRIVATE_TASK_KEYS.has(key)) continue;
      if (item !== undefined)
        result[key] = toJsonValue(item, label, stripPrivate);
    }
    return result;
  }
  throw new TypeError(`${label} is not JSON-shaped`);
}
