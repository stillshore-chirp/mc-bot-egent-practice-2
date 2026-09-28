import { describe, expect, it } from "vitest";

import {
  angularDistance,
  classifyLearningFixtureOrientation,
  javaYawForDirection,
} from "../e2e/learning-fixture-orientation.js";

describe("learning fixture orientation diagnostics", () => {
  it("maps horizontal directions to Minecraft Java yaw", () => {
    expect(angularDistance(javaYawForDirection(0, 1), 0)).toBe(0);
    expect(angularDistance(javaYawForDirection(1, 0), -90)).toBe(0);
    expect(angularDistance(javaYawForDirection(0, -1), 180)).toBe(0);
    expect(angularDistance(javaYawForDirection(-1, 0), 90)).toBe(0);
  });

  it("accepts equivalent wrapped yaw and matching pitch as diagnostics", () => {
    expect(
      classifyLearningFixtureOrientation(
        179,
        15,
        {
          yaw: -179,
          pitch: 15,
        },
        false,
      ),
    ).toEqual({
      yawMatched: true,
      pitchMatched: true,
      activeOperationAtOrient: false,
    });
  });

  it("reports each mismatch separately without exposing angle values", () => {
    expect(
      classifyLearningFixtureOrientation(
        -90,
        15,
        {
          yaw: -70,
          pitch: 2,
        },
        true,
      ),
    ).toEqual({
      yawMatched: false,
      pitchMatched: false,
      activeOperationAtOrient: true,
    });
  });
});
