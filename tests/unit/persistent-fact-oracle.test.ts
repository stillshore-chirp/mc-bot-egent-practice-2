import { describe, expect, it } from "vitest";

import { hasPersistedOwnerFact } from "../e2e/persistent-fact-oracle.js";

describe("hasPersistedOwnerFact", () => {
  it("accepts the synthetic content only in an owner-sourced fact", () => {
    const payload = JSON.stringify({
      stateFacts: [
        { kind: "fact", source: "owner", summary: "合言葉 maple-47" },
      ],
      uncertainties: [],
      proposals: [],
    });

    expect(hasPersistedOwnerFact(payload, "maple-47")).toBe(true);
  });

  it.each([
    [
      "uncertainty",
      {
        stateFacts: [],
        uncertainties: [
          { kind: "uncertainty", source: "owner", summary: "maple-47" },
        ],
      },
    ],
    [
      "non-owner source",
      {
        stateFacts: [{ kind: "fact", source: "inferred", summary: "maple-47" }],
      },
    ],
    ["proposal only", { stateFacts: [], proposals: [{ title: "maple-47" }] }],
    ["missing notes", { uncertainties: [], proposals: [] }],
  ])("rejects %s without an owner fact", (_caseName, payload) => {
    expect(hasPersistedOwnerFact(JSON.stringify(payload), "maple-47")).toBe(
      false,
    );
  });

  it("rejects malformed JSON", () => {
    expect(hasPersistedOwnerFact("{invalid", "maple-47")).toBe(false);
  });
});
