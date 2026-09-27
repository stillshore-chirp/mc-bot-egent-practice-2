import { describe, expect, it } from "vitest";

import {
  classifyArmorProposalResolution,
  type ArmorProposalResolutionInput,
  type ArmorProposalResolutionSnapshot,
} from "../e2e/armor-proposal-resolution.js";

const requestTime = "2026-09-27T10:00:00.000Z";

function snapshot(
  overrides: Partial<ArmorProposalResolutionSnapshot> = {},
): ArmorProposalResolutionSnapshot {
  return {
    proposals: [],
    goals: [],
    judgments: [],
    outcomes: [],
    ...overrides,
  };
}

function input(
  current: ArmorProposalResolutionSnapshot,
  overrides: Partial<ArmorProposalResolutionInput> = {},
): ArmorProposalResolutionInput {
  return {
    baselineProposalIds: new Set(["baseline-proposal"]),
    baselineOutcomeIds: new Set(["baseline-outcome"]),
    ownerRequestSentAt: requestTime,
    snapshot: current,
    ...overrides,
  };
}

describe("armor owner proposal resolution", () => {
  it.each(["adopted", "compromised"] as const)(
    "accepts a direct proposal-linked %s equip judgment and later success",
    (disposition) => {
      const evidence = classifyArmorProposalResolution(
        input(
          snapshot({
            proposals: [
              {
                id: "proposal-1",
                createdAt: "2026-09-27T10:00:01.000Z",
                status: disposition,
              },
            ],
            judgments: [
              {
                proposalId: "proposal-1",
                proposalDisposition: disposition,
                kind: "act",
                operationKind: "equip",
                decidedAt: "2026-09-27T10:00:02.000Z",
              },
            ],
            outcomes: [
              {
                operationId: "equip-1",
                kind: "equip",
                status: "successful",
                observedAt: "2026-09-27T10:00:03.000Z",
              },
            ],
          }),
        ),
      );

      expect(evidence).toEqual({
        classification: "direct_proposal_equip_judgment",
        ownerProposalResolved: true,
        linkedHelmetGoalConfirmed: false,
        equipJudgmentAfterProposal: true,
        successfulEquipOutcomeAfterJudgment: true,
      });
      expect(
        Object.values(evidence).every(
          (value) => typeof value === "boolean" || typeof value === "string",
        ),
      ).toBe(true);
    },
  );

  it("joins a committed owner goal to a proposal without judgment proposalId", () => {
    const evidence = classifyArmorProposalResolution(
      input(
        snapshot({
          proposals: [
            {
              id: "proposal-1",
              createdAt: "2026-09-27T10:00:01.000Z",
              resolution: "adopted",
            },
          ],
          goals: [
            {
              id: "goal-1",
              ownerProposalId: "proposal-1",
              title: "Equip iron helmet",
              status: "active",
              source: "owner",
              updatedAt: "2026-09-27T10:00:01.000Z",
            },
          ],
          judgments: [
            {
              kind: "act",
              operationKind: "equip",
              decidedAt: "2026-09-27T10:00:02.000Z",
            },
          ],
          outcomes: [
            {
              operationId: "equip-1",
              kind: "equip",
              status: "successful",
              observedAt: "2026-09-27T10:00:03.000Z",
            },
          ],
        }),
      ),
    );

    expect(evidence).toEqual({
      classification: "owner_goal_equip_judgment",
      ownerProposalResolved: true,
      linkedHelmetGoalConfirmed: true,
      equipJudgmentAfterProposal: true,
      successfulEquipOutcomeAfterJudgment: true,
    });
  });

  it("accepts run3 when a completed goal update follows equip judgment", () => {
    const evidence = classifyArmorProposalResolution(
      input(
        snapshot({
          proposals: [
            {
              id: "proposal-1",
              createdAt: "2026-09-27T10:00:01.000Z",
              status: "compromised",
            },
          ],
          goals: [
            {
              id: "goal-1",
              ownerProposalId: "proposal-1",
              title: "鉄のヘルメットを装備する",
              status: "completed",
              source: "owner",
              updatedAt: "2026-09-27T10:00:04.000Z",
            },
          ],
          judgments: [
            {
              kind: "act",
              operationKind: "equip",
              decidedAt: "2026-09-27T10:00:02.000Z",
            },
          ],
          outcomes: [
            {
              operationId: "equip-1",
              kind: "equip",
              status: "successful",
              observedAt: "2026-09-27T10:00:03.000Z",
            },
          ],
        }),
      ),
    );

    expect(evidence.classification).toBe("owner_goal_equip_judgment");
    expect(evidence.successfulEquipOutcomeAfterJudgment).toBe(true);
  });

  it("rejects a declined proposal", () => {
    const evidence = classifyArmorProposalResolution(
      input(
        snapshot({
          proposals: [{ id: "proposal-1", status: "declined" }],
          judgments: [
            {
              proposalId: "proposal-1",
              proposalDisposition: "declined",
              kind: "wait",
              decidedAt: "2026-09-27T10:00:02.000Z",
            },
          ],
        }),
      ),
    );
    expect(evidence.classification).toBe("declined");
    expect(evidence.ownerProposalResolved).toBe(false);
  });

  it("rejects a proposal-linked equip judgment from before the owner request", () => {
    const evidence = classifyArmorProposalResolution(
      input(
        snapshot({
          proposals: [{ id: "proposal-1", status: "adopted" }],
          judgments: [
            {
              proposalId: "proposal-1",
              proposalDisposition: "adopted",
              kind: "act",
              operationKind: "equip",
              decidedAt: "2026-09-27T09:59:59.000Z",
            },
          ],
        }),
      ),
    );
    expect(evidence.classification).toBe("invalid_timeline");
    expect(evidence.equipJudgmentAfterProposal).toBe(false);
  });

  it("rejects multiple new proposals rather than choosing one", () => {
    const evidence = classifyArmorProposalResolution(
      input(
        snapshot({
          proposals: [
            { id: "proposal-1", status: "adopted" },
            { id: "proposal-2", status: "adopted" },
          ],
        }),
      ),
    );
    expect(evidence.classification).toBe("ambiguous");
  });

  it.each([
    ["autonomous", undefined],
    ["other owner proposal", "another-proposal"],
  ] as const)(
    "rejects an unrelated %s helmet goal",
    (_label, ownerProposalId) => {
      const evidence = classifyArmorProposalResolution(
        input(
          snapshot({
            proposals: [{ id: "proposal-1", status: "adopted" }],
            goals: [
              {
                id: "goal-1",
                ...(ownerProposalId === undefined ? {} : { ownerProposalId }),
                title: "Equip iron helmet",
                status: "active",
                updatedAt: "2026-09-27T10:00:01.000Z",
              },
            ],
            judgments: [
              {
                kind: "act",
                operationKind: "equip",
                decidedAt: "2026-09-27T10:00:02.000Z",
              },
            ],
          }),
        ),
      );
      expect(evidence.classification).toBe("unlinked_or_autonomous_goal");
      expect(evidence.equipJudgmentAfterProposal).toBe(false);
    },
  );

  it.each([undefined, "system"] as const)(
    "rejects a linked goal unless source is owner (source=%s)",
    (source) => {
      const evidence = classifyArmorProposalResolution(
        input(
          snapshot({
            proposals: [
              {
                id: "proposal-1",
                createdAt: "2026-09-27T10:00:01.000Z",
                status: "adopted",
              },
            ],
            goals: [
              {
                id: "goal-1",
                ownerProposalId: "proposal-1",
                title: "Equip iron helmet",
                status: "active",
                ...(source === undefined ? {} : { source }),
                updatedAt: "2026-09-27T10:00:02.000Z",
              },
            ],
            judgments: [
              {
                kind: "act",
                operationKind: "equip",
                decidedAt: "2026-09-27T10:00:03.000Z",
              },
            ],
          }),
        ),
      );
      expect(evidence.classification).toBe("unlinked_or_autonomous_goal");
      expect(evidence.linkedHelmetGoalConfirmed).toBe(false);
      expect(evidence.equipJudgmentAfterProposal).toBe(false);
    },
  );

  it("rejects a linked proposal whose owner goal is not about equipping a helmet", () => {
    const evidence = classifyArmorProposalResolution(
      input(
        snapshot({
          proposals: [
            {
              id: "proposal-1",
              createdAt: "2026-09-27T10:00:01.000Z",
              status: "adopted",
            },
          ],
          goals: [
            {
              id: "goal-1",
              ownerProposalId: "proposal-1",
              title: "Mine nearby stone",
              status: "active",
              source: "owner",
              updatedAt: "2026-09-27T10:00:01.000Z",
            },
          ],
        }),
      ),
    );
    expect(evidence.classification).toBe("wrong_goal_intent");
    expect(evidence.linkedHelmetGoalConfirmed).toBe(false);
  });

  it("rejects an unrelated concurrent equip goal as ambiguous", () => {
    const evidence = classifyArmorProposalResolution(
      input(
        snapshot({
          proposals: [
            {
              id: "proposal-1",
              createdAt: "2026-09-27T10:00:01.000Z",
              status: "adopted",
            },
          ],
          goals: [
            {
              id: "goal-1",
              ownerProposalId: "proposal-1",
              title: "Equip iron helmet",
              status: "active",
              source: "owner",
              updatedAt: "2026-09-27T10:00:01.000Z",
            },
            {
              id: "goal-2",
              title: "Equip another item",
              status: "active",
              source: "autonomous",
              updatedAt: "2026-09-27T10:00:01.500Z",
            },
          ],
          judgments: [
            {
              kind: "act",
              operationKind: "equip",
              decidedAt: "2026-09-27T10:00:02.000Z",
            },
          ],
        }),
      ),
    );
    expect(evidence.classification).toBe("ambiguous");
  });

  it("rejects an equip decision from before the proposal was created", () => {
    const evidence = classifyArmorProposalResolution(
      input(
        snapshot({
          proposals: [
            {
              id: "proposal-1",
              createdAt: "2026-09-27T10:00:02.000Z",
              status: "adopted",
            },
          ],
          goals: [
            {
              id: "goal-1",
              ownerProposalId: "proposal-1",
              title: "Equip iron helmet",
              status: "active",
              source: "owner",
              updatedAt: "2026-09-27T10:00:04.000Z",
            },
          ],
          judgments: [
            {
              kind: "act",
              operationKind: "equip",
              decidedAt: "2026-09-27T10:00:01.500Z",
            },
          ],
        }),
      ),
    );
    expect(evidence.classification).toBe("invalid_timeline");
    expect(evidence.equipJudgmentAfterProposal).toBe(false);
  });

  it("does not count an old or failed equip outcome", () => {
    const current = snapshot({
      proposals: [
        {
          id: "proposal-1",
          createdAt: "2026-09-27T10:00:01.000Z",
          status: "adopted",
        },
      ],
      goals: [
        {
          id: "goal-1",
          ownerProposalId: "proposal-1",
          title: "Equip iron helmet",
          status: "completed",
          source: "owner",
          updatedAt: "2026-09-27T10:00:01.000Z",
        },
      ],
      judgments: [
        {
          kind: "act",
          operationKind: "equip",
          decidedAt: "2026-09-27T10:00:02.000Z",
        },
      ],
      outcomes: [
        {
          operationId: "baseline-outcome",
          kind: "equip",
          status: "successful",
          observedAt: "2026-09-27T10:00:03.000Z",
        },
        {
          operationId: "equip-failed",
          kind: "equip",
          status: "failed",
          observedAt: "2026-09-27T10:00:04.000Z",
        },
      ],
    });

    const evidence = classifyArmorProposalResolution(input(current));
    expect(evidence.classification).toBe("owner_goal_equip_judgment");
    expect(evidence.equipJudgmentAfterProposal).toBe(true);
    expect(evidence.successfulEquipOutcomeAfterJudgment).toBe(false);
  });

  it("does not count a successful equip outcome that predates the judgment", () => {
    const evidence = classifyArmorProposalResolution(
      input(
        snapshot({
          proposals: [
            {
              id: "proposal-1",
              createdAt: "2026-09-27T10:00:01.000Z",
              status: "adopted",
            },
          ],
          goals: [
            {
              id: "goal-1",
              ownerProposalId: "proposal-1",
              title: "Equip iron helmet",
              status: "active",
              source: "owner",
              updatedAt: "2026-09-27T10:00:01.000Z",
            },
          ],
          judgments: [
            {
              kind: "act",
              operationKind: "equip",
              decidedAt: "2026-09-27T10:00:03.000Z",
            },
          ],
          outcomes: [
            {
              operationId: "equip-too-early",
              kind: "equip",
              status: "successful",
              observedAt: "2026-09-27T10:00:02.000Z",
            },
          ],
        }),
      ),
    );
    expect(evidence.equipJudgmentAfterProposal).toBe(true);
    expect(evidence.successfulEquipOutcomeAfterJudgment).toBe(false);
  });
});
