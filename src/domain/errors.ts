export const errorCategories = [
  "connection",
  "observation",
  "path",
  "resource",
  "inventory",
  "permission",
  "timeout",
  "cancelled",
  "llm",
  "persistence",
  "safety",
  "validation",
] as const;

export type ErrorCategory = (typeof errorCategories)[number];

export interface FailureDetail {
  readonly category: ErrorCategory;
  readonly code: string;
  readonly message: string;
  readonly retryable: boolean;
  readonly failedAt?: string;
  readonly confirmedState?: Readonly<Record<string, unknown>>;
}

export class AppError extends Error {
  public readonly detail: FailureDetail;

  public constructor(detail: FailureDetail, options?: ErrorOptions) {
    super(detail.message, options);
    this.name = "AppError";
    this.detail = detail;
  }
}

export function toFailureDetail(
  error: unknown,
  fallback: FailureDetail,
): FailureDetail {
  return error instanceof AppError ? error.detail : fallback;
}
