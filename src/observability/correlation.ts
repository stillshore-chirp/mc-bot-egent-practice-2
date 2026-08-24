import { randomUUID } from "node:crypto";
import { AsyncLocalStorage } from "node:async_hooks";

const correlationStorage = new AsyncLocalStorage<string>();

export function createCorrelationId(): string {
  return randomUUID();
}

export function currentCorrelationId(): string | undefined {
  return correlationStorage.getStore();
}

export function runWithCorrelation<T>(
  correlationId: string,
  operation: () => T,
): T {
  return correlationStorage.run(correlationId, operation);
}
