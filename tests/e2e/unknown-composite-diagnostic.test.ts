import { describe, expect, it } from "vitest";

import { unknownHandoffCaseBlockCode } from "./unknown-composite-diagnostic.js";

describe("unknown handoff case dependency", () => {
  it("blocks later cases until the stopped runtime is explicitly resumed", () => {
    expect(unknownHandoffCaseBlockCode("observation_boundary", "pending")).toBe(
      "UNKNOWN_HANDOFF_DEPENDENCY_FAILED",
    );
    expect(
      unknownHandoffCaseBlockCode("unknown_composite", "pending"),
    ).toBeUndefined();
    expect(
      unknownHandoffCaseBlockCode("observation_boundary", "resumed"),
    ).toBeUndefined();
    expect(
      unknownHandoffCaseBlockCode("observation_boundary", "not_started"),
    ).toBeUndefined();
  });
});
