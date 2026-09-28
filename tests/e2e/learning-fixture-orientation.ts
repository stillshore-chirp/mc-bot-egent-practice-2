export interface LearningFixtureOrientationDiagnostic {
  readonly yawMatched: boolean;
  readonly pitchMatched: boolean;
  readonly activeOperationAtOrient: boolean;
}

export interface EntityRotation {
  readonly yaw: number;
  readonly pitch: number;
}

const ROTATION_MATCH_TOLERANCE_DEGREES = 2;

/** Return Minecraft Java yaw for a horizontal direction from the observer. */
export function javaYawForDirection(deltaX: number, deltaZ: number): number {
  return (Math.atan2(-deltaX, deltaZ) * 180) / Math.PI;
}

export function angularDistance(left: number, right: number): number {
  return Math.abs(((((left - right) % 360) + 540) % 360) - 180);
}

/** Report orientation readback matches without making them a fixture gate. */
export function classifyLearningFixtureOrientation(
  expectedYaw: number,
  expectedPitch: number,
  actual: EntityRotation,
  activeOperationAtOrient: boolean,
): LearningFixtureOrientationDiagnostic {
  return {
    yawMatched:
      angularDistance(actual.yaw, expectedYaw) <=
      ROTATION_MATCH_TOLERANCE_DEGREES,
    pitchMatched:
      Math.abs(actual.pitch - expectedPitch) <=
      ROTATION_MATCH_TOLERANCE_DEGREES,
    activeOperationAtOrient,
  };
}
