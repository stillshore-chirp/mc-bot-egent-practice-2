import { describe, expect, it } from "vitest";

import {
  hasJudgmentAfterSuccessfulOutcome,
  isStoppedHandoffBoundaryConfirmed,
} from "./autonomous-milestone.js";

describe("hasJudgmentAfterSuccessfulOutcome", () => {
  it("requires a judgment strictly after a successful outcome", () => {
    expect(
      hasJudgmentAfterSuccessfulOutcome(
        [{ status: "successful", observedAt: "2026-09-25T10:00:00.000Z" }],
        [{ decidedAt: "2026-09-25T10:00:00.001Z" }],
      ),
    ).toBe(true);
  });

  it("rejects earlier, equal, missing, and non-success evidence", () => {
    expect(
      hasJudgmentAfterSuccessfulOutcome(
        [{ status: "successful", observedAt: "2026-09-25T10:00:00.000Z" }],
        [{ decidedAt: "2026-09-25T09:59:59.999Z" }],
      ),
    ).toBe(false);
    expect(
      hasJudgmentAfterSuccessfulOutcome(
        [{ status: "successful", observedAt: "2026-09-25T10:00:00.000Z" }],
        [{ decidedAt: "2026-09-25T10:00:00.000Z" }],
      ),
    ).toBe(false);
    expect(
      hasJudgmentAfterSuccessfulOutcome(
        [{ status: "failed", observedAt: "2026-09-25T10:00:00.000Z" }],
        [{ decidedAt: "2026-09-25T10:00:01.000Z" }],
      ),
    ).toBe(false);
    expect(
      hasJudgmentAfterSuccessfulOutcome(
        [{ status: "successful" }],
        [{ decidedAt: "2026-09-25T10:00:01.000Z" }],
      ),
    ).toBe(false);
  });
});

describe("isStoppedHandoffBoundaryConfirmed", () => {
  const base = {
    stopped: true,
    activeCleared: true,
    stopGeneration: 2,
    previousStopGeneration: 1,
  } as const;

  it("requires the started operation's matching terminal outcome", () => {
    expect(
      isStoppedHandoffBoundaryConfirmed({
        ...base,
        terminalRequired: true,
        operationId: "operation-a",
        outcomes: [{ operationId: "operation-b", status: "interrupted" }],
      }),
    ).toBe(false);
    expect(
      isStoppedHandoffBoundaryConfirmed({
        ...base,
        terminalRequired: true,
        operationId: "operation-a",
        outcomes: [{ operationId: "operation-a", status: "interrupted" }],
      }),
    ).toBe(true);
  });

  it("allows no-start or no-active boundaries without a terminal receipt", () => {
    expect(
      isStoppedHandoffBoundaryConfirmed({
        ...base,
        terminalRequired: false,
        outcomes: [],
      }),
    ).toBe(true);
    expect(
      isStoppedHandoffBoundaryConfirmed({
        ...base,
        terminalRequired: false,
        outcomes: [],
        stopGeneration: 1,
      }),
    ).toBe(false);
  });
});
