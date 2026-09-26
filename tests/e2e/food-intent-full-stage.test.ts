import { describe, expect, it } from "vitest";

import {
  explainsFullHunger,
  hasNewConsumeDecisionSince,
  hasNewNonConsumingDecisionSince,
  hasNewResolvedOwnerProposalSince,
  type FoodIntentDecisionSnapshot,
} from "./food-intent-full-stage.js";

const before: FoodIntentDecisionSnapshot = {
  proposals: [{ id: "prior-proposal" }],
  recentJudgments: [
    {
      revision: 1,
      decidedAt: "before",
      kind: "act",
      operationKind: "consume",
    },
  ],
  recentOutcomes: [{ operationId: "prior-outcome", kind: "consume" }],
};

describe("food intent full-hunger decision evidence", () => {
  it.each([
    "満腹なので今回は食べません。",
    "満腹です。そのため、今は食べません。",
    "お腹が空いていないので今は食べません。",
    "I'm full, so I can't eat now.",
    "I'm not hungry, so I won't eat now.",
  ])("accepts an affirmative full-hunger explanation: %s", (text) => {
    expect(explainsFullHunger(text)).toBe(true);
  });

  it.each([
    "満腹ではありません。",
    "満腹ではありませんが、今回は食べません。",
    "満腹なので食べませんか？",
    "満腹なので食べませんか",
    "「満腹なので食べません」と言いました。",
    "満腹です。",
    "I'm not full, so I won't eat.",
    "I'm full, so I can't eat?",
    'They said "I am full, so I will not eat."',
    "I'm full.",
  ])("rejects non-affirmative or mention-only text: %s", (text) => {
    expect(explainsFullHunger(text)).toBe(false);
  });

  it("accepts a new declined owner proposal resolved with another action", () => {
    const after: FoodIntentDecisionSnapshot = {
      proposals: [...before.proposals, { id: "full-hunger-proposal" }],
      recentJudgments: [
        ...before.recentJudgments,
        {
          revision: 2,
          decidedAt: "after",
          kind: "act",
          operationKind: "look_sweep",
          proposalId: "full-hunger-proposal",
          proposalDisposition: "declined",
        },
      ],
      recentOutcomes: [
        ...before.recentOutcomes,
        { operationId: "after-outcome", kind: "look_sweep" },
      ],
    };

    expect(hasNewResolvedOwnerProposalSince(before, after)).toBe(true);
    expect(hasNewNonConsumingDecisionSince(before, after)).toBe(true);
    expect(hasNewConsumeDecisionSince(before, after)).toBe(false);
  });

  it.each(["wait", "complete", "continue"])(
    "accepts a new %s decision without requiring a specific action kind",
    (kind) => {
      const after = {
        ...before,
        recentJudgments: [
          ...before.recentJudgments,
          { revision: 2, decidedAt: "after", kind },
        ],
      } satisfies FoodIntentDecisionSnapshot;

      expect(hasNewNonConsumingDecisionSince(before, after)).toBe(true);
      expect(hasNewConsumeDecisionSince(before, after)).toBe(false);
    },
  );

  it("rejects a new consume decision before an outcome is recorded", () => {
    const after: FoodIntentDecisionSnapshot = {
      ...before,
      recentJudgments: [
        ...before.recentJudgments,
        {
          revision: 2,
          decidedAt: "after",
          kind: "act",
          operationKind: "consume",
        },
      ],
    };

    expect(hasNewConsumeDecisionSince(before, after)).toBe(true);
    expect(hasNewNonConsumingDecisionSince(before, after)).toBe(false);
  });

  it("rejects a consume outcome even when its decision is no longer recent", () => {
    const after: FoodIntentDecisionSnapshot = {
      ...before,
      recentOutcomes: [
        ...before.recentOutcomes,
        { operationId: "new-consume", kind: "consume" },
      ],
    };

    expect(hasNewConsumeDecisionSince(before, after)).toBe(true);
  });

  it("does not count a prior proposal resolution as a new one", () => {
    const alreadyResolved: FoodIntentDecisionSnapshot = {
      ...before,
      proposals: [...before.proposals, { id: "resolved-proposal" }],
      recentJudgments: [
        ...before.recentJudgments,
        {
          revision: 2,
          decidedAt: "before",
          kind: "act",
          operationKind: "look_sweep",
          proposalId: "resolved-proposal",
          proposalDisposition: "declined",
        },
      ],
    };
    const after = {
      ...alreadyResolved,
      recentJudgments: [
        ...alreadyResolved.recentJudgments,
        {
          revision: 3,
          decidedAt: "after",
          kind: "act",
          operationKind: "look_sweep",
          proposalId: "resolved-proposal",
          proposalDisposition: "declined",
        },
      ],
    } satisfies FoodIntentDecisionSnapshot;

    expect(hasNewResolvedOwnerProposalSince(alreadyResolved, after)).toBe(
      false,
    );
  });
});
