import { playerOperationNames } from "../../src/minecraft/player-body-schema.js";

export type SafeUnknownOperationKind =
  (typeof playerOperationNames)[number] | "unknown";

export interface UnknownTaskVisibilityEvidence {
  readonly status: "available" | "unknown";
  readonly targetBlockVisible?: boolean;
  readonly waterBlockVisible?: boolean;
  readonly wallMaterialVisible?: boolean;
}

const knownOperationNames = new Set<string>(playerOperationNames);

export function safeUnknownOperationKind(
  value: string | undefined,
): SafeUnknownOperationKind {
  return value !== undefined && knownOperationNames.has(value)
    ? (value as SafeUnknownOperationKind)
    : "unknown";
}

export function classifyUnknownTaskVisibility(
  visibleBlockNames: readonly string[] | undefined,
): UnknownTaskVisibilityEvidence {
  if (visibleBlockNames === undefined) return { status: "unknown" };
  const normalizedNames = new Set(
    visibleBlockNames.map((name) =>
      name.toLowerCase().replace(/^minecraft:/u, ""),
    ),
  );
  return {
    status: "available",
    targetBlockVisible: normalizedNames.has("blue_wool"),
    waterBlockVisible: normalizedNames.has("water"),
    wallMaterialVisible: normalizedNames.has("stone"),
  };
}
