import { describe, expect, it } from "vitest";

import {
  hasCancellationOutcomeForOperation,
  hasJudgmentAfterSuccessfulOutcome,
  hasNewActiveOwnerProposalGoal,
  hasOwnerApproachWithStartedBodyOperation,
  isStoppedHandoffBoundaryConfirmed,
  ownerApproachReductionBucket,
} from "./autonomous-milestone.js";

describe("ownerApproachReductionBucket", () => {
  it("rejects missing, zero, and negative reductions", () => {
    expect(ownerApproachReductionBucket(undefined, 9)).toBe("none");
    expect(ownerApproachReductionBucket(9, 9)).toBe("none");
    expect(ownerApproachReductionBucket(9, 9.1)).toBe("none");
  });

  it("distinguishes a small movement from the minimum approach", () => {
    expect(ownerApproachReductionBucket(10, 9.751)).toBe("under_minimum");
    expect(ownerApproachReductionBucket(10, 9.75)).toBe("minimum_met");
  });
});

describe("hasOwnerApproachWithStartedBodyOperation", () => {
  const activeOperation = {
    operationId: "operation-a",
    bodyStartedAt: "2026-09-29T10:00:00.000Z",
  };

  it("requires the movement threshold and a started Body operation together", () => {
    expect(
      hasOwnerApproachWithStartedBodyOperation(10, 9.75, activeOperation),
    ).toBe(true);
    expect(hasOwnerApproachWithStartedBodyOperation(10, 9.75, undefined)).toBe(
      false,
    );
    expect(
      hasOwnerApproachWithStartedBodyOperation(10, 9.75, {
        ...activeOperation,
        operationId: "",
      }),
    ).toBe(false);
    expect(
      hasOwnerApproachWithStartedBodyOperation(10, 9.75, {
        ...activeOperation,
        bodyStartedAt: "invalid",
      }),
    ).toBe(false);
    expect(
      hasOwnerApproachWithStartedBodyOperation(10, 9.751, activeOperation),
    ).toBe(false);
  });
});

describe("hasNewActiveOwnerProposalGoal", () => {
  it("requires a new adopted owner proposal linked to an active owner goal", () => {
    expect(
      hasNewActiveOwnerProposalGoal(
        ["old-proposal"],
        [{ id: "new-proposal", status: "adopted" }],
        [
          {
            ownerProposalId: "new-proposal",
            source: "owner",
            status: "active",
          },
        ],
      ),
    ).toBe(true);
    expect(
      hasNewActiveOwnerProposalGoal(
        ["old-proposal"],
        [{ id: "old-proposal", status: "adopted" }],
        [
          {
            ownerProposalId: "old-proposal",
            source: "owner",
            status: "active",
          },
        ],
      ),
    ).toBe(false);
    expect(
      hasNewActiveOwnerProposalGoal(
        ["old-proposal"],
        [{ id: "new-proposal", status: "adopted" }],
        [
          {
            ownerProposalId: "new-proposal",
            source: "guest",
            status: "active",
          },
        ],
      ),
    ).toBe(false);
    expect(
      hasNewActiveOwnerProposalGoal(
        ["old-proposal"],
        [{ id: "new-proposal", status: "adopted" }],
        [
          {
            ownerProposalId: "new-proposal",
            source: "owner",
            status: "paused",
          },
        ],
      ),
    ).toBe(false);
  });
});

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

describe("hasCancellationOutcomeForOperation", () => {
  it("requires a matching interrupted or cancelled outcome", () => {
    expect(
      hasCancellationOutcomeForOperation("operation-a", [
        { operationId: "operation-a", status: "interrupted" },
      ]),
    ).toBe(true);
    expect(
      hasCancellationOutcomeForOperation("operation-a", [
        { operationId: "operation-a", status: "cancelled" },
      ]),
    ).toBe(true);
  });

  it("rejects a different operation and a naturally completed operation", () => {
    expect(
      hasCancellationOutcomeForOperation("operation-a", [
        { operationId: "operation-b", status: "cancelled" },
      ]),
    ).toBe(false);
    expect(
      hasCancellationOutcomeForOperation("operation-a", [
        { operationId: "operation-a", status: "successful" },
      ]),
    ).toBe(false);
  });
});
