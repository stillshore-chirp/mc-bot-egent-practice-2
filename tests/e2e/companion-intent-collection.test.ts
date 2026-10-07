import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import {
  COMPANION_INTENT_COLLECTION_CASE_BUDGET,
  COMPANION_INTENT_COLLECTION_CASE_DEADLINE_MS,
  createOwnerReturnApplicationWithBodyCapture,
  runBudgetCoversCase,
} from "./ai-player-live.js";
import { createApplication } from "../../src/app/application.js";
import type { AppConfig } from "../../src/config/schema.js";
import {
  COMPANION_HOSTILE_PURPOSE_CASE_BUDGET,
  COMPANION_HOSTILE_PURPOSE_CASE_DEADLINE_MS,
  COMPANION_HOSTILE_PURPOSE_RUN_BUDGET,
  COMPANION_HOSTILE_DETAIL_LIMIT,
  COMPANION_HOSTILE_FIXTURE_COUNT,
  bodyOakLogInventoryCount,
  companionHostileSameGoalNextActionObserved,
  companionHostileObservationConfirmed,
  companionHostilePurposeModeAllowed,
  companionHostilePurposeMoveConfirmed,
  companionIntentCollectionProgressConfirmed,
  completionJudgmentObservedAfter,
  freshResolvedOwnerWoodGoalCount,
  ownerGoalAndObservationFreshAfterRequest,
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

  it("accepts the same goal update and observation in either post-request order", () => {
    const requestSentAt = Date.parse("2026-10-07T00:00:01.000Z");
    const goalUpdatedAt = "2026-10-07T00:00:02.000Z";
    expect(
      ownerGoalAndObservationFreshAfterRequest({
        goalId: "goal-1",
        expectedGoalId: "goal-1",
        goalUpdatedAt,
        observationAt: Date.parse("2026-10-07T00:00:03.000Z"),
        requestSentAt,
      }),
    ).toBe(true);
    expect(
      ownerGoalAndObservationFreshAfterRequest({
        goalId: "goal-1",
        expectedGoalId: "goal-1",
        goalUpdatedAt: "2026-10-07T00:00:03.000Z",
        observationAt: Date.parse("2026-10-07T00:00:02.000Z"),
        requestSentAt,
      }),
    ).toBe(true);
    expect(
      ownerGoalAndObservationFreshAfterRequest({
        goalId: "goal-2",
        expectedGoalId: "goal-1",
        goalUpdatedAt,
        observationAt: Date.parse("2026-10-07T00:00:03.000Z"),
        requestSentAt,
      }),
    ).toBe(false);
    expect(
      ownerGoalAndObservationFreshAfterRequest({
        goalId: "goal-1",
        expectedGoalId: "goal-1",
        goalUpdatedAt: "2026-10-07T00:00:00.000Z",
        observationAt: Date.parse("2026-10-07T00:00:03.000Z"),
        requestSentAt,
      }),
    ).toBe(false);
    expect(
      ownerGoalAndObservationFreshAfterRequest({
        goalId: "goal-1",
        expectedGoalId: "goal-1",
        goalUpdatedAt,
        observationAt: Date.parse("2026-10-07T00:00:00.000Z"),
        requestSentAt,
      }),
    ).toBe(false);
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

  it("keeps the real hostile-Purpose submode on its real-API target only", () => {
    expect(
      companionHostilePurposeModeAllowed({
        selected: false,
        targetCase: undefined,
        noGptDiagnosticSelected: false,
      }),
    ).toBe(true);
    expect(
      companionHostilePurposeModeAllowed({
        selected: true,
        targetCase: "companion_intent_collection",
        noGptDiagnosticSelected: false,
      }),
    ).toBe(true);
    expect(
      companionHostilePurposeModeAllowed({
        selected: true,
        targetCase: "companion_intent_collection",
        noGptDiagnosticSelected: true,
      }),
    ).toBe(false);
    expect(
      companionHostilePurposeModeAllowed({
        selected: true,
        targetCase: "damage_response",
        noGptDiagnosticSelected: false,
      }),
    ).toBe(false);
  });

  it("reserves the real-Purpose case deadline and rejects setup that consumes it", () => {
    expect(
      runBudgetCoversCase(
        COMPANION_HOSTILE_PURPOSE_RUN_BUDGET,
        COMPANION_HOSTILE_PURPOSE_CASE_BUDGET,
        COMPANION_HOSTILE_PURPOSE_CASE_DEADLINE_MS,
        3 * 60_000,
      ),
    ).toBe(true);
    expect(
      runBudgetCoversCase(
        COMPANION_HOSTILE_PURPOSE_RUN_BUDGET,
        COMPANION_HOSTILE_PURPOSE_CASE_BUDGET,
        COMPANION_HOSTILE_PURPOSE_CASE_DEADLINE_MS,
        3 * 60_000 + 1,
      ),
    ).toBe(false);
  });

  it("requires a real post-request Purpose-selected sameLife retreat and cross-oracle distance gain", () => {
    const evidence = {
      requestSentAt: Date.parse("2026-10-07T00:00:01.000Z"),
      judgment: {
        kind: "act",
        operationKind: "move_relative",
        decidedAt: "2026-10-07T00:00:02.000Z",
      },
      operation: {
        kind: "move_relative",
        status: "successful",
        startedAt: "2026-10-07T00:00:02.100Z",
        completedAt: "2026-10-07T00:00:03.000Z",
        sameLife: true,
        recoveryRequired: false,
      },
      bodyCountBefore: 4,
      bodyCountAfter: 4,
      serverCountBefore: 4,
      serverCountAfter: 4,
      bodyDistanceBefore: 3.5,
      bodyDistanceAfter: 5.2,
      serverDistanceBefore: 3.5,
      serverDistanceAfter: 5,
      bodyServerDistanceAligned: true,
      bodyServerPositionAligned: true,
      bodyServerHealthAligned: true,
      bodyHealthDidNotDecrease: true,
      serverHealthDidNotDecrease: true,
    } as const;
    expect(companionHostilePurposeMoveConfirmed(evidence)).toBe(true);
    expect(
      companionHostilePurposeMoveConfirmed({
        ...evidence,
        operation: { ...evidence.operation, sameLife: false },
      }),
    ).toBe(false);
    expect(
      companionHostilePurposeMoveConfirmed({
        ...evidence,
        serverDistanceAfter: evidence.serverDistanceBefore,
      }),
    ).toBe(false);
  });

  it("records the same active owner goal and a later action without inferring intent", () => {
    const input = {
      goalIdBefore: "goal-1",
      goalIdAfter: "goal-1",
      goalStatusAfter: "active",
      afterRevision: 4,
      actionCompletedAt: "2026-10-07T00:00:03.000Z",
      judgments: [
        {
          revision: 5,
          kind: "act",
          operationKind: "move_relative",
          decidedAt: "2026-10-07T00:00:04.000Z",
        },
      ],
    } as const;
    expect(companionHostileSameGoalNextActionObserved(input)).toBe(true);
    expect(
      companionHostileSameGoalNextActionObserved({
        ...input,
        goalIdAfter: "goal-2",
      }),
    ).toBe(false);
    expect(
      companionHostileSameGoalNextActionObserved({
        ...input,
        goalStatusAfter: "completed",
      }),
    ).toBe(false);
    expect(
      companionHostileSameGoalNextActionObserved({
        ...input,
        judgments: [
          { ...input.judgments[0], decidedAt: "2026-10-07T00:00:02.000Z" },
        ],
      }),
    ).toBe(false);
    expect(
      companionHostileSameGoalNextActionObserved({
        ...input,
        judgments: [
          {
            revision: 5,
            kind: "act",
            decidedAt: "2026-10-07T00:00:04.000Z",
          },
        ],
      }),
    ).toBe(false);
  });

  it("captures the application's Body before the targeted case starts", async () => {
    const temporaryRoot = mkdtempSync(
      join(tmpdir(), "companion-intent-body-capture-"),
    );
    const config: AppConfig = {
      minecraft: {
        host: "127.0.0.1",
        port: 25565,
        username: "companion-body-capture-bot",
        auth: "offline",
        version: "1.21.11",
      },
      ownerUsername: "companion-body-capture-owner",
      openai: { apiKey: "test-only-value", model: "test-model" },
      databasePath: join(temporaryRoot, "player.sqlite"),
      personaPath: fileURLToPath(
        new URL("../../config/persona.example.json", import.meta.url),
      ),
      logLevel: "silent",
      limits: {
        maxMoveDistance: 128,
        maxGatherCount: 64,
        taskTimeoutMs: 900_000,
        skillRetryLimit: 2,
        followDistance: 3,
        hungerThreshold: 14,
        memoryContextLimit: 12,
      },
      reconnect: { enabled: false, maxAttempts: 0, delayMs: 250 },
      dashboard: {
        enabled: false,
        host: "127.0.0.1",
        port: 4310,
        staticDirectory: "dashboard/dist",
        maxAgeDays: 30,
        maxTraces: 500,
      },
    };
    let capturedBodies = 0;
    let application: ReturnType<typeof createApplication> | undefined;
    let restoreProbe: (() => void) | undefined;
    try {
      const created = createOwnerReturnApplicationWithBodyCapture(
        "companion_intent_collection",
        createApplication,
        config,
        () => {
          throw new Error("PROVIDER_REQUEST_NOT_EXPECTED_IN_FACTORY_TEST");
        },
        () => {
          capturedBodies += 1;
        },
      );
      application = created.application;
      restoreProbe = created.restoreProbe;
      expect(capturedBodies).toBe(1);
    } finally {
      try {
        await application?.shutdown("test_complete");
      } finally {
        restoreProbe?.();
        rmSync(temporaryRoot, { recursive: true, force: true });
      }
    }
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

  it("does not require collection from the nearby fixture blocks", () => {
    expect(
      companionIntentCollectionProgressConfirmed({
        successfulBodyCollectionAfterFollowup: true,
        inventoryThresholdAchievedAt: Date.parse("2026-10-07T00:00:03.000Z"),
        fixtureLogRemovedFromInitial: 0,
      }),
    ).toBe(true);
    expect(
      companionIntentCollectionProgressConfirmed({
        successfulBodyCollectionAfterFollowup: false,
        inventoryThresholdAchievedAt: Date.parse("2026-10-07T00:00:03.000Z"),
        fixtureLogRemovedFromInitial: 0,
      }),
    ).toBe(false);
    expect(
      companionIntentCollectionProgressConfirmed({
        successfulBodyCollectionAfterFollowup: true,
        inventoryThresholdAchievedAt: undefined,
        fixtureLogRemovedFromInitial: 0,
      }),
    ).toBe(false);
  });
});
