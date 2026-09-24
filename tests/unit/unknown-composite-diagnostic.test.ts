import { describe, expect, it } from "vitest";

import {
  classifyUnknownTaskVisibility,
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
