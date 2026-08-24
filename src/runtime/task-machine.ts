import { AppError } from "../domain/errors.js";
import type { TaskRecord, TaskTransition } from "../domain/task.js";

const allowedTransitions = {
  queued: new Set(["start", "cancel"]),
  running: new Set(["advance", "suspend", "complete", "fail", "cancel"]),
  suspended: new Set(["resume", "fail", "cancel"]),
  completed: new Set<string>(),
  failed: new Set<string>(),
  cancelled: new Set<string>(),
} as const;

export function transitionTask(
  record: TaskRecord,
  transition: TaskTransition,
): TaskRecord {
  if (!allowedTransitions[record.status].has(transition.type)) {
    throw new AppError({
      category: "validation",
      code: "INVALID_TASK_TRANSITION",
      message: `Cannot apply ${transition.type} to ${record.status} task`,
      retryable: false,
      failedAt: record.phase,
    });
  }

  const common = {
    ...record,
    phase: transition.phase,
    updatedAt: new Date().toISOString(),
  };
  switch (transition.type) {
    case "start":
    case "resume":
      return { ...common, status: "running" };
    case "advance":
      return {
        ...common,
        status: "running",
        ...(transition.checkpoint === undefined
          ? {}
          : { checkpoint: transition.checkpoint }),
      };
    case "suspend":
      return {
        ...common,
        status: "suspended",
        ...(transition.checkpoint === undefined
          ? {}
          : { checkpoint: transition.checkpoint }),
      };
    case "complete":
      return { ...common, status: "completed", output: transition.output };
    case "fail":
      return { ...common, status: "failed", failure: transition.failure };
    case "cancel":
      return { ...common, status: "cancelled", failure: transition.failure };
  }
}
