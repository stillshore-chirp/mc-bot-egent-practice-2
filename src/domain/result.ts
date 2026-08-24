import type { FailureDetail } from "./errors.js";

export type Result<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly error: FailureDetail };

export const ok = <T>(value: T): Result<T> => ({ ok: true, value });
export const err = <T = never>(error: FailureDetail): Result<T> => ({
  ok: false,
  error,
});
