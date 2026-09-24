import { describe, expect, it } from "vitest";

import { safeUnknownOperationKind } from "../e2e/unknown-composite-diagnostic.js";

describe("unknown composite operation-kind evidence", () => {
  it("retains only a known player operation name", () => {
    expect(safeUnknownOperationKind("move_to")).toBe("move_to");
  });

  it("uses a fixed unknown value for absent or unrecognized kinds", () => {
    expect(safeUnknownOperationKind(undefined)).toBe("unknown");
    expect(safeUnknownOperationKind("private-input-value")).toBe("unknown");
  });
});
