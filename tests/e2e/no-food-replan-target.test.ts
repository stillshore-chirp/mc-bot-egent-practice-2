import { describe, expect, it, vi } from "vitest";
import type { Response } from "openai/resources/responses/responses.js";

import { PlayerMindStore } from "../../src/player/mind-store.js";
import {
  runPlayerAgent,
  type PlayerResponsesClient,
} from "../../src/player/responses.js";
import {
  classifyNoFoodReplanDecision,
  isNoFoodObservationAfterDeadlineWake,
  isNoFoodReassessmentAfterFreshObservation,
  isNoFoodReplanPurposeAfterOutcome,
  noFoodReplanBeforeCallBlockReason,
  noFoodReplanConsumeUnsupported,
  noFoodReplanOraclesConfirmed,
  NO_FOOD_REPLAN_CASE_BUDGET,
  NO_FOOD_REPLAN_CASE_DEADLINE_MS,
  runBudgetCoversCase,
} from "./ai-player-live.js";
import {
  isCaseSelectedForTarget,
  TARGETABLE_CASES,
} from "./target-case-selection.js";
import {
  NoFoodReplanAcceptanceLatchedError,
  NoFoodReplanRequestGate,
  waitForNoFoodReplanRequestsSettled,
} from "./no-food-replan-request-gate.js";

describe("no-food replan targeted E2E case", () => {
  it("blocks provider sends at the call, observed-token, and unknown-usage boundary", () => {
    expect(NO_FOOD_REPLAN_CASE_BUDGET).toEqual({
      llmCalls: 20,
      totalTokens: 200_000,
    });
    expect(NO_FOOD_REPLAN_CASE_DEADLINE_MS).toBe(8 * 60_000);
    expect(
      noFoodReplanBeforeCallBlockReason(
        NO_FOOD_REPLAN_CASE_BUDGET.llmCalls - 1,
        0,
        NO_FOOD_REPLAN_CASE_BUDGET.totalTokens - 1,
      ),
    ).toBeUndefined();
    expect(
      noFoodReplanBeforeCallBlockReason(
        NO_FOOD_REPLAN_CASE_BUDGET.llmCalls,
        0,
        0,
      ),
    ).toBe("CASE_LLM_BUDGET_EXCEEDED");
    expect(
      noFoodReplanBeforeCallBlockReason(
        0,
        0,
        NO_FOOD_REPLAN_CASE_BUDGET.totalTokens,
      ),
    ).toBe("CASE_LLM_BUDGET_EXCEEDED");
    expect(noFoodReplanBeforeCallBlockReason(0, 1, 0)).toBe(
      "LLM_USAGE_PARTIAL_OR_UNKNOWN",
    );
    expect(
      runBudgetCoversCase(
        { durationMs: 10 * 60_000, llmCalls: 160, totalTokens: 800_000 },
        NO_FOOD_REPLAN_CASE_BUDGET,
        NO_FOOD_REPLAN_CASE_DEADLINE_MS,
      ),
    ).toBe(true);
    expect(
      runBudgetCoversCase(
        {
          durationMs: 10 * 60_000,
          llmCalls: NO_FOOD_REPLAN_CASE_BUDGET.llmCalls - 1,
          totalTokens: NO_FOOD_REPLAN_CASE_BUDGET.totalTokens,
        },
        NO_FOOD_REPLAN_CASE_BUDGET,
        NO_FOOD_REPLAN_CASE_DEADLINE_MS,
      ),
    ).toBe(false);
  });

  it("requires Body and RCON Health and Food to agree on a no-food oracle", () => {
    expect(noFoodReplanOraclesConfirmed(4, 4, 13, 13, true, true)).toBe(true);
    expect(noFoodReplanOraclesConfirmed(4, 3, 13, 13, true, true)).toBe(false);
    expect(noFoodReplanOraclesConfirmed(4, 4, 13, 12, true, true)).toBe(false);
  });

  it("accepts only a Purpose judgment timestamped after the successful outcome", () => {
    expect(
      isNoFoodReplanPurposeAfterOutcome(
        "2026-01-01T00:00:02.000Z",
        "2026-01-01T00:00:01.000Z",
      ),
    ).toBe(true);
    expect(
      isNoFoodReplanPurposeAfterOutcome(
        "2026-01-01T00:00:01.000Z",
        "2026-01-01T00:00:01.000Z",
      ),
    ).toBe(false);
    expect(
      isNoFoodReplanPurposeAfterOutcome(
        "2026-01-01T00:00:00.000Z",
        "2026-01-01T00:00:01.000Z",
      ),
    ).toBe(false);
  });

  it("requires a new Body observation before the reassessment judgment", () => {
    expect(
      isNoFoodReassessmentAfterFreshObservation(
        "2026-01-01T00:00:01.000Z",
        "2026-01-01T00:00:02.000Z",
        "2026-01-01T00:00:03.000Z",
      ),
    ).toBe(true);
    expect(
      isNoFoodReassessmentAfterFreshObservation(
        "2026-01-01T00:00:01.000Z",
        "2026-01-01T00:00:01.000Z",
        "2026-01-01T00:00:03.000Z",
      ),
    ).toBe(false);
    expect(
      isNoFoodReassessmentAfterFreshObservation(
        "2026-01-01T00:00:01.000Z",
        "2026-01-01T00:00:02.000Z",
        "2026-01-01T00:00:02.000Z",
      ),
    ).toBe(false);
  });

  it("keeps deadline wake evidence ordered before the new Body observation", () => {
    expect(
      isNoFoodObservationAfterDeadlineWake(
        ["deadline"],
        "2026-01-01T00:00:02.000Z",
        "2026-01-01T00:00:02.000Z",
      ),
    ).toBe(true);
    expect(
      isNoFoodObservationAfterDeadlineWake(
        ["deadline"],
        "2026-01-01T00:00:02.000Z",
        "2026-01-01T00:00:01.999Z",
      ),
    ).toBe(false);
    expect(
      isNoFoodObservationAfterDeadlineWake(
        ["deadline"],
        undefined,
        "2026-01-01T00:00:03.000Z",
      ),
    ).toBe(false);
    expect(
      isNoFoodObservationAfterDeadlineWake(
        ["deadline", "state_changed"],
        undefined,
        "2026-01-01T00:00:01.000Z",
      ),
    ).toBe(true);
  });

  it("selects no_food_replan without unrelated prerequisites", () => {
    expect(TARGETABLE_CASES).toContain("no_food_replan");
    expect(isCaseSelectedForTarget("no_food_replan", "no_food_replan")).toBe(
      true,
    );
    for (const caseId of [
      "runtime_contract",
      "autonomous_life",
      "food_intent_continuity",
      "damage_response",
      "integrated_result",
    ]) {
      expect(isCaseSelectedForTarget("no_food_replan", caseId)).toBe(false);
    }
  });

  it("projects only fixed decision classes", () => {
    expect(classifyNoFoodReplanDecision("act", "consume")).toBe("consume");
    expect(classifyNoFoodReplanDecision("act", "move_to")).toBe("alternative");
    expect(classifyNoFoodReplanDecision("wait", undefined)).toBe("wait");
    expect(classifyNoFoodReplanDecision("act", "untrusted-value")).toBe(
      "unknown",
    );
  });

  it("rejects consume when the fresh no-food oracle confirms empty inventory", () => {
    expect(noFoodReplanConsumeUnsupported("consume", true)).toBe(true);
    expect(noFoodReplanConsumeUnsupported("consume", false)).toBe(false);
    expect(noFoodReplanConsumeUnsupported("alternative", true)).toBe(false);
  });

  it("settles recorded usage and rejects a new request after full acceptance evidence", async () => {
    const gate = new NoFoodReplanRequestGate();
    const evidence = {
      startupStateConfirmed: true,
      alternativeSuccessfulBodyOutcomeObserved: true,
      postOutcomeNoFoodStateConfirmed: true,
      postOutcomePurposeJudgmentObserved: false,
      waitReasonAndWakeConditionPresent: false,
      waitStateObservationConfirmed: false,
      waitWakeReassessmentObserved: false,
      waitReassessmentDecision: "not_observed" as const,
    };
    const response = {
      status: "completed",
      output: [],
      output_text: "Done.",
      usage: { input_tokens: 123, output_tokens: 45 },
    } as unknown as Response;
    const create = vi.fn(async () => response);
    const client = {
      responses: { create },
    } as unknown as PlayerResponsesClient;
    const mind = PlayerMindStore.open(":memory:");
    let admittedCalls = 0;
    let recordedCalls = 0;
    const invoke = () =>
      runPlayerAgent({
        client,
        model: "test-model",
        instructions: "Instructions.",
        input: "Input.",
        tools: [],
        logger: { info: () => undefined } as never,
        beforeCall: () =>
          gate.beforeCall(() => {
            admittedCalls += 1;
          }),
        onCall: (metrics) => {
          recordedCalls += metrics.calls;
          mind.recordCall({
            inputTokens: metrics.inputTokens,
            outputTokens: metrics.outputTokens,
            latencyMs: metrics.latencyMs,
            ...(metrics.usageUnknown === true ? { usageUnknown: true } : {}),
            ...(metrics.usageUnknownReason === undefined
              ? {}
              : { usageUnknownReason: metrics.usageUnknownReason }),
          });
        },
      });

    try {
      await invoke();
      const usageAfterResponse = mind.snapshot().counters;
      gate.observeRecordedCalls(usageAfterResponse.llmCalls);
      expect(usageAfterResponse).toMatchObject({
        llmCalls: 1,
        inputTokens: 123,
        outputTokens: 45,
        usageUnknownCalls: 0,
      });
      expect(gate.inFlightRequests).toBe(0);

      expect(gate.latchIfAcceptedEvidence(evidence)).toBe(false);
      expect(
        gate.latchIfAcceptedEvidence({
          ...evidence,
          postOutcomePurposeJudgmentObserved: true,
        }),
      ).toBe(true);
      await expect(invoke()).rejects.toBeInstanceOf(
        NoFoodReplanAcceptanceLatchedError,
      );
      expect(create).toHaveBeenCalledTimes(1);
      expect(admittedCalls).toBe(1);
      expect(recordedCalls).toBe(1);
      expect(gate.requestsStarted).toBe(1);
      expect(gate.requestsRecorded).toBe(1);
      expect(gate.providerRequestsBlockedAfterAcceptance).toBe(1);
      expect(gate.inFlightRequests).toBe(0);
      expect(mind.snapshot().counters).toMatchObject({
        llmCalls: 1,
        inputTokens: 123,
        outputTokens: 45,
        usageUnknownCalls: 0,
      });
    } finally {
      mind.close();
    }
  });

  it("accepts a reasoned wait path only after independent state observation and fresh reassessment", () => {
    const evidence = {
      startupStateConfirmed: true,
      alternativeSuccessfulBodyOutcomeObserved: false,
      postOutcomeNoFoodStateConfirmed: false,
      postOutcomePurposeJudgmentObserved: false,
      waitReasonAndWakeConditionPresent: true,
      waitStateObservationConfirmed: true,
      waitWakeReassessmentObserved: true,
      waitReassessmentDecision: "wait" as const,
    };
    for (const waitReassessmentDecision of ["alternative", "wait"] as const) {
      const gate = new NoFoodReplanRequestGate();
      expect(
        gate.latchIfAcceptedEvidence({ ...evidence, waitReassessmentDecision }),
      ).toBe(true);
      expect(gate.acceptanceLatched).toBe(true);
    }

    for (const incompleteEvidence of [
      { ...evidence, waitReasonAndWakeConditionPresent: false },
      { ...evidence, waitStateObservationConfirmed: false },
      { ...evidence, waitWakeReassessmentObserved: false },
      { ...evidence, waitReassessmentDecision: "consume" as const },
      { ...evidence, waitReassessmentDecision: "other" as const },
      { ...evidence, startupStateConfirmed: false },
    ]) {
      expect(
        new NoFoodReplanRequestGate().latchIfAcceptedEvidence(
          incompleteEvidence,
        ),
      ).toBe(false);
    }
  });

  it("waits for recorded requests to settle and fails at its finite deadline", async () => {
    let reads = 0;
    await expect(
      waitForNoFoodReplanRequestsSettled(
        async () => {
          reads += 1;
          return reads < 3 ? 1 : 0;
        },
        500,
        1,
      ),
    ).resolves.toBe(true);
    await expect(
      waitForNoFoodReplanRequestsSettled(async () => 1, 10, 1),
    ).resolves.toBe(false);
    await expect(
      waitForNoFoodReplanRequestsSettled(
        () => new Promise<number>(() => undefined),
        10,
        1,
      ),
    ).resolves.toBe(false);
  });
});
