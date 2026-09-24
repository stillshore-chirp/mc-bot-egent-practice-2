import { playerOperationNames } from "../../src/minecraft/player-body-schema.js";

export type SafeUnknownOperationKind =
  (typeof playerOperationNames)[number] | "unknown";

export interface UnknownTaskVisibilityEvidence {
  readonly status: "available" | "unknown";
  readonly targetBlockVisible?: boolean;
  readonly waterBlockVisible?: boolean;
  readonly wallMaterialVisible?: boolean;
}

export interface EntityRotation {
  readonly yaw: number;
  readonly pitch: number;
}

// The fixture wall and task target are along +X; Java yaw -90 faces east (+X).
export const UNKNOWN_FIXTURE_YAW = -90;
export const UNKNOWN_FIXTURE_PITCH = 0;
const FACING_TOLERANCE_DEGREES = 2;

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

export function parseEntityRotation(reply: string): EntityRotation | undefined {
  const match =
    /\[\s*(-?(?:\d+(?:\.\d*)?|\.\d+))(?:[fFdD])?\s*,\s*(-?(?:\d+(?:\.\d*)?|\.\d+))(?:[fFdD])?\s*\]\s*$/u.exec(
      reply.trim(),
    );
  if (match === null) return undefined;
  const yaw = Number(match[1]);
  const pitch = Number(match[2]);
  if (!Number.isFinite(yaw) || !Number.isFinite(pitch)) return undefined;
  return { yaw, pitch };
}

export function isFacingUnknownFixture(
  rotation: EntityRotation | undefined,
): boolean {
  return (
    rotation !== undefined &&
    angularDistance(rotation.yaw, UNKNOWN_FIXTURE_YAW) <=
      FACING_TOLERANCE_DEGREES &&
    Math.abs(rotation.pitch - UNKNOWN_FIXTURE_PITCH) <= FACING_TOLERANCE_DEGREES
  );
}

function angularDistance(left: number, right: number): number {
  const normalized = ((((left - right) % 360) + 540) % 360) - 180;
  return Math.abs(normalized);
}
