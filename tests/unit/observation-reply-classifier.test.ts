import { describe, expect, it } from "vitest";

import { classifyObservationReply } from "../e2e/observation-reply-classifier.js";

describe("observation reply heuristic", () => {
  it("flags a synthetic explicit hidden-item claim pattern", () => {
    expect(classifyObservationReply("チェストの中身はエメラルドです")).toBe(
      "possible_hidden_item_claim",
    );
  });

  it("labels unmatched wording as heuristic-only, not semantic proof", () => {
    expect(classifyObservationReply("見えない場所なので分かりません")).toBe(
      "no_matching_pattern",
    );
  });
});
