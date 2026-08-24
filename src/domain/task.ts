import type { FailureDetail } from "./errors.js";

export const taskStatuses = [
  "queued",
  "running",
  "suspended",
  "completed",
  "failed",
  "cancelled",
] as const;
export type TaskStatus = (typeof taskStatuses)[number];

export interface TaskRecord<Input = unknown, Output = unknown> {
  readonly id: string;
  readonly kind: string;
  readonly status: TaskStatus;
  readonly phase: string;
  readonly input: Input;
  readonly output?: Output;
  readonly failure?: FailureDetail;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly checkpoint?: Readonly<Record<string, unknown>>;
}

export type TaskTransition =
  | { readonly type: "start"; readonly phase: string }
  | {
      readonly type: "advance";
      readonly phase: string;
      readonly checkpoint?: Readonly<Record<string, unknown>>;
    }
  | {
      readonly type: "suspend";
      readonly phase: string;
      readonly checkpoint?: Readonly<Record<string, unknown>>;
    }
  | { readonly type: "resume"; readonly phase: string }
  | {
      readonly type: "complete";
      readonly phase: string;
      readonly output: unknown;
    }
  | {
      readonly type: "fail";
      readonly phase: string;
      readonly failure: FailureDetail;
    }
  | {
      readonly type: "cancel";
      readonly phase: string;
      readonly failure: FailureDetail;
    };
