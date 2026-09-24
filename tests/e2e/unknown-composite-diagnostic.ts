import { playerOperationNames } from "../../src/minecraft/player-body-schema.js";

export type SafeUnknownOperationKind =
  (typeof playerOperationNames)[number] | "unknown";

const knownOperationNames = new Set<string>(playerOperationNames);

export function safeUnknownOperationKind(
  value: string | undefined,
): SafeUnknownOperationKind {
  return value !== undefined && knownOperationNames.has(value)
    ? (value as SafeUnknownOperationKind)
    : "unknown";
}
