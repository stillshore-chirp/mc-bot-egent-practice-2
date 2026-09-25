import { describe, expect, it } from "vitest";

import {
  classifyUnknownTaskVisibility,
  isFacingUnknownFixture,
  parseEntityRotation,
  safeUnknownOperationKind,
} from "../e2e/unknown-composite-diagnostic.js";

describe("unknown composite operation-kind evidence", () => {
  it("retains only a known player operation name", () => {
    expect(safeUnknownOperationKind("move_to")).toBe("move_to");
  });

  it("uses a fixed unknown value for absent or unrecognized kinds", () => {
    expect(safeUnknownOperationKind(undefined)).toBe("unknown");
    expect(safeUnknownOperationKind("private-input-value")).toBe("unknown");
  });

  it("keeps an unavailable task observation unknown instead of false", () => {
    expect(classifyUnknownTaskVisibility(undefined)).toEqual({
      status: "unknown",
    });
  });

  it("records visible target, water, and wall material as fixed booleans", () => {
    expect(
      classifyUnknownTaskVisibility(["minecraft:blue_wool", "water", "stone"]),
    ).toEqual({
      status: "available",
      targetBlockVisible: true,
      waterBlockVisible: true,
      wallMaterialVisible: true,
    });
    expect(classifyUnknownTaskVisibility([])).toEqual({
      status: "available",
      targetBlockVisible: false,
      waterBlockVisible: false,
      wallMaterialVisible: false,
    });
  });
});

describe("unknown fixture facing evidence", () => {
  it("parses yaw and pitch and accepts equivalent wrapped angles", () => {
    const rotation = parseEntityRotation("Entity data: [270.0f, 0.0f]");

    expect(rotation).toEqual({ yaw: 270, pitch: 0 });
    expect(isFacingUnknownFixture(rotation)).toBe(true);
  });

  it("parses finite scientific notation with optional NBT suffixes", () => {
    const rotation = parseEntityRotation("Entity data: [2.7E+2f, 0e0d]");

    expect(rotation).toEqual({ yaw: 270, pitch: 0 });
    expect(isFacingUnknownFixture(rotation)).toBe(true);
    expect(parseEntityRotation("Entity data: [1e999, 0]")).toBeUndefined();
  });

  it("rejects unparsable or misdirected rotation readback", () => {
    expect(parseEntityRotation("Entity data unavailable")).toBeUndefined();
    expect(parseEntityRotation("Entity data [270, 0], readback failed")).toBe(
      undefined,
    );
    expect(isFacingUnknownFixture(undefined)).toBe(false);
    expect(isFacingUnknownFixture({ yaw: 0, pitch: 0 })).toBe(false);
    expect(isFacingUnknownFixture({ yaw: -90, pitch: 10 })).toBe(false);
  });
});
