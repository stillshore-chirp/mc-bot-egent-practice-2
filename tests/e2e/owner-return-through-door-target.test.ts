import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it, vi } from "vitest";

import {
  createOwnerReturnApplicationWithBodyCapture,
  createOwnerReturnRequestTracking,
  isOwnerProposalProgressable,
  ownerReturnAcceptanceEvidenceConfirmed,
  ownerReturnRequestGateEnabled,
  OWNER_RETURN_THROUGH_DOOR_CASE_BUDGET,
  ownerReturnArrivalConfirmed,
  ownerReturnToolNamesSince,
  runBudgetCoversCase,
} from "./ai-player-live.js";
import { createApplication } from "../../src/app/application.js";
import type { AppConfig } from "../../src/config/schema.js";
import {
  isCaseSelectedForTarget,
  TARGETABLE_CASES,
} from "./target-case-selection.js";
import {
  AcceptedProviderRequestGate,
  classifyAcceptedProviderRequestUsage,
  waitForAcceptedProviderRequestsSettled,
} from "./no-food-replan-request-gate.js";

describe("owner return through door targeted E2E case", () => {
  it("captures the Body created by the real application factory before startup", async () => {
    const temporaryRoot = mkdtempSync(
      join(tmpdir(), "owner-return-body-capture-"),
    );
    const config: AppConfig = {
      minecraft: {
        host: "127.0.0.1",
        port: 25565,
        username: "body-capture-bot",
        auth: "offline",
        version: "1.21.11",
      },
      ownerUsername: "body-capture-owner",
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
    const beforeCall = vi.fn(() => {
      throw new Error("PROVIDER_REQUEST_NOT_EXPECTED_IN_FACTORY_TEST");
    });
    let capturedBodies = 0;
    let application: ReturnType<typeof createApplication> | undefined;
    let restoreProbe: (() => void) | undefined;
    try {
      const created = createOwnerReturnApplicationWithBodyCapture(
        "owner_return_through_door",
        createApplication,
        config,
        beforeCall,
        () => {
          capturedBodies += 1;
        },
      );
      application = created.application;
      restoreProbe = created.restoreProbe;
      expect(capturedBodies).toBe(1);
      expect(beforeCall).not.toHaveBeenCalled();
    } finally {
      try {
        await application?.shutdown("test_complete");
      } finally {
        restoreProbe?.();
        rmSync(temporaryRoot, { recursive: true, force: true });
      }
    }
  });

  it("keeps request admission settling scoped to a targeted owner-return run", () => {
    expect(ownerReturnRequestGateEnabled("owner_return_through_door")).toBe(
      true,
    );
    expect(ownerReturnRequestGateEnabled(undefined)).toBe(false);
    expect(ownerReturnRequestGateEnabled("no_food_replan")).toBe(false);
  });

  it("accounts for a startup request whose usage is recorded after the case baseline", () => {
    const preStartCounters = {
      llmCalls: 0,
      usageUnknownCalls: 0,
      usageUnknownRequestErrorCalls: 0,
      usageUnknownResponseUsageMissingCalls: 0,
      inputTokens: 0,
      outputTokens: 0,
      latencyMs: 0,
      thoughts: 0,
      learningUpdates: 0,
    } satisfies Parameters<typeof createOwnerReturnRequestTracking>[1];
    const tracking = createOwnerReturnRequestTracking(
      "owner_return_through_door",
      preStartCounters,
    );
    if (tracking === undefined) throw new Error("OWNER_TRACKING_NOT_CREATED");
    expect(tracking.usageStart).toBe(preStartCounters);
    const gate = tracking.gate;
    gate.beforeCall(() => undefined);

    const recordedCallsAfterCaseStart = 1;
    const recordedCallsFromPreStart =
      recordedCallsAfterCaseStart - preStartCounters.llmCalls;
    gate.observeRecordedCalls(recordedCallsFromPreStart);
    expect(
      classifyAcceptedProviderRequestUsage({
        requestsStarted: 0,
        requestsRecorded: recordedCallsFromPreStart,
        calls: recordedCallsFromPreStart,
        tokens: 100,
        usageUnknownCalls: 0,
        caseCallLimit: 12,
        caseTokenLimit: 80_000,
      }),
    ).toBe("accounting_mismatch");
    expect(
      classifyAcceptedProviderRequestUsage({
        requestsStarted: gate.requestsStarted,
        requestsRecorded: gate.requestsRecorded,
        calls: recordedCallsFromPreStart,
        tokens: 100,
        usageUnknownCalls: 0,
        caseCallLimit: 12,
        caseTokenLimit: 80_000,
      }),
    ).toBe("settled");
  });

  it("extends only the call allowance while retaining the known-token cap", () => {
    expect(OWNER_RETURN_THROUGH_DOOR_CASE_BUDGET).toEqual({
      llmCalls: 12,
      totalTokens: 80_000,
    });
    expect(
      runBudgetCoversCase(
        { llmCalls: 12, totalTokens: 80_000 },
        OWNER_RETURN_THROUGH_DOOR_CASE_BUDGET,
      ),
    ).toBe(true);
    expect(
      runBudgetCoversCase(
        { llmCalls: 11, totalTokens: 80_000 },
        OWNER_RETURN_THROUGH_DOOR_CASE_BUDGET,
      ),
    ).toBe(false);
  });

  it("selects only the owner return case without prerequisites", () => {
    expect(TARGETABLE_CASES).toContain("owner_return_through_door");
    expect(
      isCaseSelectedForTarget(
        "owner_return_through_door",
        "owner_return_through_door",
      ),
    ).toBe(true);
    expect(
      isCaseSelectedForTarget("owner_return_through_door", "autonomous_life"),
    ).toBe(false);
  });

  it("accepts only adopted or compromised proposals linked to an owner goal", () => {
    expect(isOwnerProposalProgressable("adopted", true)).toBe(true);
    expect(isOwnerProposalProgressable("compromised", true)).toBe(true);

    for (const disposition of ["pending", "declined", "unknown"] as const) {
      expect(isOwnerProposalProgressable(disposition, true)).toBe(false);
    }
    expect(isOwnerProposalProgressable("adopted", false)).toBe(false);
    expect(isOwnerProposalProgressable("compromised", false)).toBe(false);
  });

  it("requires matching owner-side arrival, distance, and an open door", () => {
    const confirmed = {
      bodySide: "owner_side",
      rconSide: "owner_side",
      bodyDistance: "within_1_75",
      rconDistance: "within_1_75",
      bodyRconAligned: true,
      doorState: "open",
    } as const;
    expect(ownerReturnArrivalConfirmed(confirmed)).toBe(true);

    expect(
      ownerReturnArrivalConfirmed({ ...confirmed, bodySide: "doorway" }),
    ).toBe(false);
    expect(
      ownerReturnArrivalConfirmed({ ...confirmed, rconSide: "return_side" }),
    ).toBe(false);
    expect(
      ownerReturnArrivalConfirmed({
        ...confirmed,
        bodyDistance: "over_1_75",
      }),
    ).toBe(false);
    expect(
      ownerReturnArrivalConfirmed({
        ...confirmed,
        rconDistance: "unknown",
      }),
    ).toBe(false);
    expect(
      ownerReturnArrivalConfirmed({ ...confirmed, bodyRconAligned: false }),
    ).toBe(false);
    expect(
      ownerReturnArrivalConfirmed({ ...confirmed, doorState: "closed" }),
    ).toBe(false);
  });

  it("keeps proposal, linked-goal, movement, and arrival requirements together", () => {
    const arrival = {
      bodySide: "owner_side",
      rconSide: "owner_side",
      bodyDistance: "within_1_75",
      rconDistance: "within_1_75",
      bodyRconAligned: true,
      doorState: "open",
    } as const;
    expect(
      ownerReturnAcceptanceEvidenceConfirmed(
        "compromised",
        true,
        true,
        arrival,
      ),
    ).toBe(true);
    expect(
      ownerReturnAcceptanceEvidenceConfirmed("declined", true, true, arrival),
    ).toBe(false);
    expect(
      ownerReturnAcceptanceEvidenceConfirmed("adopted", false, true, arrival),
    ).toBe(false);
    expect(
      ownerReturnAcceptanceEvidenceConfirmed("adopted", true, false, arrival),
    ).toBe(false);
    expect(
      ownerReturnAcceptanceEvidenceConfirmed("adopted", true, true, {
        ...arrival,
        doorState: "closed",
      }),
    ).toBe(false);
  });

  it("latches accepted provider requests and classifies unknown, pending, and over-budget usage", async () => {
    const gate = new AcceptedProviderRequestGate();
    let admitted = 0;
    gate.beforeCall(() => {
      admitted += 1;
    });
    expect(gate.requestsStarted).toBe(1);
    expect(gate.inFlightRequests).toBe(1);

    gate.latch();
    expect(() => gate.beforeCall(() => (admitted += 1))).toThrow(
      "ACCEPTED_PROVIDER_REQUEST_ADMISSION_LATCHED",
    );
    expect(admitted).toBe(1);
    expect(gate.providerRequestsBlockedAfterLatch).toBe(1);

    const baseline = {
      requestsStarted: 1,
      requestsRecorded: 0,
      calls: 0,
      tokens: 0,
      usageUnknownCalls: 0,
      caseCallLimit: 12,
      caseTokenLimit: 80_000,
      runCalls: 1,
      runTokens: 100,
      runCallLimit: 12,
      runTokenLimit: 80_000,
    } as const;
    expect(classifyAcceptedProviderRequestUsage(baseline)).toBe("pending");
    expect(
      classifyAcceptedProviderRequestUsage({
        ...baseline,
        requestsRecorded: 1,
        calls: 1,
        tokens: 100,
      }),
    ).toBe("settled");
    expect(
      classifyAcceptedProviderRequestUsage({
        ...baseline,
        requestsRecorded: 1,
        calls: 1,
        tokens: 100,
        usageUnknownCalls: 1,
      }),
    ).toBe("usage_unknown");
    expect(
      classifyAcceptedProviderRequestUsage({
        ...baseline,
        requestsRecorded: 1,
        calls: 1,
        tokens: 80_001,
      }),
    ).toBe("budget_exceeded");
    expect(
      classifyAcceptedProviderRequestUsage({
        ...baseline,
        requestsRecorded: 2,
      }),
    ).toBe("accounting_mismatch");

    let reads = 0;
    await expect(
      waitForAcceptedProviderRequestsSettled(
        async () => {
          reads += 1;
          return reads < 2 ? 1 : 0;
        },
        300,
        1,
      ),
    ).resolves.toBe(true);
    await expect(
      waitForAcceptedProviderRequestsSettled(async () => 1, 10, 1),
    ).resolves.toBe(false);
  });

  it("records only fresh safe tool names grouped by agent role", () => {
    const previous = [
      {
        runSequence: 1,
        round: 1,
        role: "purpose" as const,
        toolCalls: [
          {
            name: "search_skills" as const,
            resultClass: "ok" as const,
            outputChars: 12,
          },
        ],
      },
    ];
    const current = [
      ...previous,
      {
        runSequence: 1,
        round: 2,
        role: "purpose" as const,
        toolCalls: [
          {
            name: "commit_goal_state" as const,
            resultClass: "ok" as const,
            outputChars: 12,
          },
          {
            name: "commit_goal_state" as const,
            resultClass: "ok" as const,
            outputChars: 12,
          },
        ],
      },
      {
        runSequence: 1,
        round: 1,
        role: "conversation" as const,
        toolCalls: [
          {
            name: "propose_goal_change" as const,
            resultClass: "ok" as const,
            outputChars: 12,
          },
        ],
      },
    ];

    expect(ownerReturnToolNamesSince(current, previous)).toEqual({
      conversation: ["propose_goal_change"],
      purpose: ["commit_goal_state"],
    });
  });
});
