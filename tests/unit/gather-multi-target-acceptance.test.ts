import { describe, expect, it } from "vitest";

import {
  countCompletedGatherActions,
  confirmsSecondGatheredTarget,
  gatherMultiTargetPassEvidence,
  hasNewBirchGatherIntent,
  hasResolvedBirchGatherOwnerGoal,
  hasGatherContinuationDigDecision,
  identifyFirstGatheredTarget,
  newBirchGatherProposalIds,
  successfulGatherActionPairs,
} from "../e2e/gather-multi-target-acceptance.js";

const baseline = { oak_log: 0, birch_log: 0 } as const;

describe("multi-target gather E2E acceptance", () => {
  it("includes the post-cleanup confirmation in pass evidence", () => {
    expect(
      gatherMultiTargetPassEvidence(
        {
          caseStarted: true,
          fixtureConfigured: true,
          freshBodyObservationConfirmed: true,
          initialOwnerRequestObserved: true,
          shortFollowupSent: true,
          followupOwnerIntentObserved: true,
          followupOwnerResolutionObserved: true,
          firstTargetServerAndBodyProgressObserved: true,
          continuationDigDecisionObserved: true,
          secondTargetServerAndBodyProgressObserved: true,
          fixtureCleanupConfirmed: true,
          oakDropReadbackClass: "known_negative",
          birchDropReadbackClass: "known_negative",
        },
        2,
      ),
    ).toEqual({
      caseStarted: true,
      fixtureConfigured: true,
      freshBodyObservationConfirmed: true,
      initialOwnerRequestObserved: true,
      shortFollowupSent: true,
      followupOwnerIntentObserved: true,
      followupOwnerResolutionObserved: true,
      firstTargetServerAndBodyProgressObserved: true,
      continuationDigDecisionObserved: true,
      secondTargetServerAndBodyProgressObserved: true,
      fixtureCleanupConfirmed: true,
      oakDropReadbackClass: "known_negative",
      birchDropReadbackClass: "known_negative",
      completedBodyGatherCount: 2,
    });
  });

  it("requires a new birch-target proposal or a linked birch goal", () => {
    const previousProposalIds = new Set(["older"]);
    expect(
      hasNewBirchGatherIntent({
        proposals: [
          { id: "older", title: "白樺を集める" },
          { id: "new", title: "白樺の原木を集める" },
        ],
        goals: [],
        previousProposalIds,
      }),
    ).toBe(true);
    expect(
      hasNewBirchGatherIntent({
        proposals: [{ id: "new", title: "gather follow-up" }],
        goals: [{ ownerProposalId: "new", title: "birch_log" }],
        previousProposalIds,
      }),
    ).toBe(true);
    expect(
      hasNewBirchGatherIntent({
        proposals: [{ id: "new", title: "oak_logを集める" }],
        goals: [{ ownerProposalId: "unrelated", title: "birch_log" }],
        previousProposalIds,
      }),
    ).toBe(false);
    expect(
      hasNewBirchGatherIntent({
        proposals: [{ id: "older", title: "birch_log" }],
        goals: [],
        previousProposalIds,
      }),
    ).toBe(false);
    expect(
      newBirchGatherProposalIds({
        proposals: [
          { id: "new", title: "birch_log" },
          { id: "other", title: "oak_log" },
        ],
        goals: [],
        previousProposalIds,
      }),
    ).toEqual(["new"]);
  });

  it("requires the same adopted proposal and its owner goal before pass", () => {
    const proposalIds = new Set(["followup"]);
    const valid = {
      proposals: [{ id: "followup", status: "adopted" }],
      judgments: [],
      goals: [
        {
          ownerProposalId: "followup",
          source: "owner",
          status: "active",
        },
      ],
      proposalIds,
    };
    expect(hasResolvedBirchGatherOwnerGoal(valid)).toBe(true);
    expect(
      hasResolvedBirchGatherOwnerGoal({
        ...valid,
        proposals: [{ id: "followup", status: "pending" }],
        judgments: [
          { proposalId: "followup", proposalDisposition: "compromised" },
        ],
      }),
    ).toBe(true);
    expect(
      hasResolvedBirchGatherOwnerGoal({
        ...valid,
        proposals: [{ id: "followup", status: "declined" }],
      }),
    ).toBe(false);
    expect(
      hasResolvedBirchGatherOwnerGoal({
        ...valid,
        goals: [
          {
            ownerProposalId: "different",
            source: "owner",
            status: "active",
          },
        ],
      }),
    ).toBe(false);
    expect(
      hasResolvedBirchGatherOwnerGoal({
        ...valid,
        goals: [
          {
            ownerProposalId: "followup",
            source: "persona",
            status: "active",
          },
        ],
      }),
    ).toBe(false);
    expect(
      hasResolvedBirchGatherOwnerGoal({
        ...valid,
        goals: [
          {
            ownerProposalId: "followup",
            source: "owner",
            status: "paused",
          },
        ],
      }),
    ).toBe(false);
  });

  it("pairs successful dig and later pickup outcomes without reusing pickups", () => {
    expect(
      countCompletedGatherActions([
        {
          kind: "dig",
          status: "successful",
          observedAt: "2026-01-01T00:00:01Z",
        },
        {
          kind: "collect_item",
          status: "successful",
          observedAt: "2026-01-01T00:00:02Z",
        },
        {
          kind: "dig",
          status: "successful",
          observedAt: "2026-01-01T00:00:03Z",
        },
        {
          kind: "collect_item",
          status: "failed",
          observedAt: "2026-01-01T00:00:04Z",
        },
      ]),
    ).toBe(1);
    expect(
      countCompletedGatherActions([
        {
          kind: "dig",
          status: "successful",
          observedAt: "2026-01-01T00:00:01Z",
        },
        {
          kind: "collect_item",
          status: "successful",
          observedAt: "2026-01-01T00:00:02Z",
        },
        {
          kind: "dig",
          status: "successful",
          observedAt: "2026-01-01T00:00:03Z",
        },
        {
          kind: "collect_item",
          status: "successful",
          observedAt: "2026-01-01T00:00:04Z",
        },
      ]),
    ).toBe(2);
    expect(
      successfulGatherActionPairs([
        {
          kind: "dig",
          status: "successful",
          observedAt: "2026-01-01T00:00:01Z",
        },
        {
          kind: "collect_item",
          status: "successful",
          observedAt: "2026-01-01T00:00:02Z",
        },
        {
          kind: "dig",
          status: "successful",
          observedAt: "2026-01-01T00:00:03Z",
        },
        {
          kind: "collect_item",
          status: "successful",
          observedAt: "2026-01-01T00:00:04Z",
        },
      ]),
    ).toEqual([
      {
        digAt: Date.parse("2026-01-01T00:00:01Z"),
        pickupAt: Date.parse("2026-01-01T00:00:02Z"),
      },
      {
        digAt: Date.parse("2026-01-01T00:00:03Z"),
        pickupAt: Date.parse("2026-01-01T00:00:04Z"),
      },
    ]);
  });

  it("requires one server-removed target, one retained target, and a Body gather", () => {
    expect(
      identifyFirstGatheredTarget(
        {
          blockPresent: { oak_log: false, birch_log: true },
          inventoryCount: { oak_log: 1, birch_log: 0 },
          completedGatherCount: 1,
        },
        baseline,
      ),
    ).toBe("oak_log");
    expect(
      identifyFirstGatheredTarget(
        {
          blockPresent: { oak_log: false, birch_log: true },
          inventoryCount: { oak_log: 1, birch_log: 0 },
          completedGatherCount: 0,
        },
        baseline,
      ),
    ).toBeUndefined();
    expect(
      identifyFirstGatheredTarget(
        {
          blockPresent: { oak_log: true, birch_log: false },
          inventoryCount: { oak_log: 0, birch_log: 1 },
          completedGatherCount: 1,
        },
        baseline,
      ),
    ).toBe("birch_log");
    expect(
      identifyFirstGatheredTarget(
        {
          blockPresent: { oak_log: false, birch_log: false },
          inventoryCount: { oak_log: 1, birch_log: 1 },
          completedGatherCount: 2,
        },
        baseline,
      ),
    ).toBeUndefined();
  });

  it("requires a post-followup dig decision between first pickup and second dig", () => {
    const judgments = [
      {
        kind: "act",
        operationKind: "dig",
        decidedAt: "2026-01-01T00:00:03Z",
      },
    ];
    expect(
      hasGatherContinuationDigDecision(
        judgments,
        "2026-01-01T00:00:02Z",
        "2026-01-01T00:00:04Z",
        "2026-01-01T00:00:02.500Z",
      ),
    ).toBe(true);
    expect(
      hasGatherContinuationDigDecision(
        judgments,
        "2026-01-01T00:00:02Z",
        "2026-01-01T00:00:04Z",
        "2026-01-01T00:00:03Z",
      ),
    ).toBe(false);
    expect(
      hasGatherContinuationDigDecision(
        judgments,
        "2026-01-01T00:00:02Z",
        "2026-01-01T00:00:04Z",
        "2026-01-01T00:00:01Z",
      ),
    ).toBe(false);
    expect(
      hasGatherContinuationDigDecision(
        [{ ...judgments[0], kind: "wait" }],
        "2026-01-01T00:00:02Z",
        "2026-01-01T00:00:04Z",
        "2026-01-01T00:00:02.500Z",
      ),
    ).toBe(false);
  });

  it("requires the second server and Body result plus the continuation decision", () => {
    const sample = {
      blockPresent: { oak_log: false, birch_log: false },
      inventoryCount: { oak_log: 1, birch_log: 1 },
      completedGatherCount: 2,
    } as const;
    expect(
      confirmsSecondGatheredTarget({
        sample,
        baseline,
        continuationDigDecisionObserved: true,
      }),
    ).toBe(true);
    expect(
      confirmsSecondGatheredTarget({
        sample,
        baseline,
        continuationDigDecisionObserved: false,
      }),
    ).toBe(false);
    expect(
      confirmsSecondGatheredTarget({
        sample: { ...sample, inventoryCount: { oak_log: 1, birch_log: 0 } },
        baseline,
        continuationDigDecisionObserved: true,
      }),
    ).toBe(false);
  });
});
