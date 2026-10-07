import { describe, expect, it } from "vitest";

import {
  COMPANION_INTENT_COLLECTION_CASE_BUDGET,
  COMPANION_INTENT_COLLECTION_CASE_DEADLINE_MS,
  runBudgetCoversCase,
} from "./ai-player-live.js";
import {
  COMPANION_HOSTILE_DETAIL_LIMIT,
  COMPANION_HOSTILE_FIXTURE_COUNT,
  bodyOakLogInventoryCount,
  companionHostileObservationConfirmed,
  completionJudgmentObservedAfter,
  freshResolvedOwnerWoodGoalCount,
  singleFreshWoodGoalQuantity,
  successfulCollectionActionObservedAfter,
} from "./companion-intent-collection.js";
import {
  isCaseSelectedForTarget,
  TARGETABLE_CASES,
} from "./target-case-selection.js";

describe("companion intent collection acceptance helpers", () => {
  it("requires at least three oak logs in the Body inventory", () => {
    expect(
      bodyOakLogInventoryCount([
        { name: "oak_log", count: 2 },
        { name: "birch_log", count: 4 },
        { name: "oak_log", count: 1 },
      ]),
    ).toBe(3);
    expect(bodyOakLogInventoryCount([{ name: "oak_log", count: 2 }])).toBe(2);
  });

  it("records a completion judgment only after the inventory threshold", () => {
    expect(
      completionJudgmentObservedAfter({
        judgments: [
          { kind: "complete", decidedAt: "2026-10-07T00:00:02.000Z" },
        ],
        achievedAt: Date.parse("2026-10-07T00:00:03.000Z"),
      }),
    ).toBe(false);
    expect(
      completionJudgmentObservedAfter({
        judgments: [
          { kind: "complete", decidedAt: "2026-10-07T00:00:04.000Z" },
        ],
        achievedAt: Date.parse("2026-10-07T00:00:03.000Z"),
      }),
    ).toBe(true);
  });

  it("requires a fresh client aggregate to agree with the server count", () => {
    const evidence = {
      serverCountBefore: 0,
      serverCountAfter: COMPANION_HOSTILE_FIXTURE_COUNT,
      fixtureConfiguredAt: Date.parse("2026-10-07T00:00:00.000Z"),
      requestSentAt: Date.parse("2026-10-07T00:00:01.000Z"),
      observationAt: "2026-10-07T00:00:02.000Z",
      nearbyHostilesObservedAt: "2026-10-07T00:00:02.000Z",
      source: "client_received_unoccluded_nearby_hostiles",
      aggregateSource: "client_received_hostile_entity_candidates",
      countScope: "client_entity_table_within_max_distance",
      aggregateCount: COMPANION_HOSTILE_FIXTURE_COUNT,
      zombieCount: COMPANION_HOSTILE_FIXTURE_COUNT,
      worldAbsenceEstablished: false,
      candidateLimit: 128,
      detailOutputLimit: COMPANION_HOSTILE_DETAIL_LIMIT,
      entityOutputLimit: COMPANION_HOSTILE_DETAIL_LIMIT,
      detailCount: COMPANION_HOSTILE_DETAIL_LIMIT,
      candidateSearchMayBeTruncated: false,
    } as const;
    expect(companionHostileObservationConfirmed(evidence)).toBe(true);
    expect(
      companionHostileObservationConfirmed({
        ...evidence,
        observationAt: "2026-10-07T00:00:00.500Z",
        nearbyHostilesObservedAt: "2026-10-07T00:00:00.500Z",
      }),
    ).toBe(false);
    expect(
      companionHostileObservationConfirmed({ ...evidence, detailCount: 17 }),
    ).toBe(false);
    expect(
      companionHostileObservationConfirmed({
        ...evidence,
        candidateSearchMayBeTruncated: true,
      }),
    ).toBe(false);
  });

  it("accepts one fresh, resolved owner goal with one explicit quantity", () => {
    const goals = [
      {
        ownerProposalId: "proposal-1",
        title: "Gather 3 oak logs",
        status: "active",
        source: "owner",
        updatedAt: "2026-10-07T00:00:02.000Z",
      },
    ];
    const proposals = [{ id: "proposal-1", status: "adopted" }];
    expect(
      singleFreshWoodGoalQuantity({
        goals,
        proposals,
        judgments: [],
        updatedAfter: Date.parse("2026-10-07T00:00:01.000Z"),
      }),
    ).toBe(3);
    expect(
      singleFreshWoodGoalQuantity({
        goals: [...goals, { ...goals[0], ownerProposalId: "proposal-2" }],
        proposals: [...proposals, { id: "proposal-2", status: "adopted" }],
        judgments: [],
        updatedAfter: Date.parse("2026-10-07T00:00:01.000Z"),
      }),
    ).toBeUndefined();
  });

  it("recognizes a fresh accepted wood goal before a quantity is supplied", () => {
    const input = {
      goals: [
        {
          ownerProposalId: "proposal-1",
          title: "Gather nearby wood",
          status: "active",
          source: "owner",
          updatedAt: "2026-10-07T00:00:02.000Z",
        },
      ],
      proposals: [{ id: "proposal-1", status: "adopted" }],
      judgments: [],
      updatedAfter: Date.parse("2026-10-07T00:00:01.000Z"),
    };
    expect(freshResolvedOwnerWoodGoalCount(input)).toBe(1);
    expect(
      freshResolvedOwnerWoodGoalCount({
        ...input,
        updatedAfter: Date.parse("2026-10-07T00:00:03.000Z"),
      }),
    ).toBe(0);
  });

  it("selects collection only as an explicit standalone case", () => {
    expect(TARGETABLE_CASES).toContain("companion_intent_collection");
    expect(
      isCaseSelectedForTarget(
        "companion_intent_collection",
        "companion_intent_collection",
      ),
    ).toBe(true);
    expect(
      isCaseSelectedForTarget("companion_intent_collection", "autonomous_life"),
    ).toBe(false);
  });

  it("keeps the collection case inside its short provider budget", () => {
    expect(
      runBudgetCoversCase(
        {
          durationMs: 10 * 60_000,
          llmCalls: 40,
          totalTokens: 360_000,
        },
        COMPANION_INTENT_COLLECTION_CASE_BUDGET,
        COMPANION_INTENT_COLLECTION_CASE_DEADLINE_MS,
      ),
    ).toBe(true);
    expect(
      runBudgetCoversCase(
        {
          durationMs: 6 * 60_000,
          llmCalls: 16,
          totalTokens: 100_000,
        },
        COMPANION_INTENT_COLLECTION_CASE_BUDGET,
        COMPANION_INTENT_COLLECTION_CASE_DEADLINE_MS,
      ),
    ).toBe(false);
  });

  it("requires a new successful Body collection action after the owner update", () => {
    expect(
      successfulCollectionActionObservedAfter({
        outcomes: [
          {
            operationId: "operation-1",
            kind: "dig",
            status: "successful",
            observedAt: "2026-10-07T00:00:02.000Z",
          },
        ],
        previousOperationIds: new Set(),
        requestSentAt: Date.parse("2026-10-07T00:00:01.000Z"),
      }),
    ).toBe(true);
    expect(
      successfulCollectionActionObservedAfter({
        outcomes: [
          {
            operationId: "operation-1",
            kind: "dig",
            status: "successful",
            observedAt: "2026-10-07T00:00:02.000Z",
          },
        ],
        previousOperationIds: new Set(["operation-1"]),
        requestSentAt: Date.parse("2026-10-07T00:00:01.000Z"),
      }),
    ).toBe(false);
  });
});
