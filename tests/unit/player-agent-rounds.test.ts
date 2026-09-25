import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import pino from "pino";
import { afterEach, describe, expect, it } from "vitest";
import { z } from "zod";
import type { Response } from "openai/resources/responses/responses.js";

import { McSkillRepository } from "../../src/mc-skills/index.js";
import { playerOperationNames } from "../../src/minecraft/player-body-schema.js";
import type {
  PlayerBody,
  PlayerBodyObservation,
} from "../../src/minecraft/player-body.js";
import type {
  PlayerMemoryPort,
  PlayerThoughtDecision,
  PlayerRuntimeSnapshot,
} from "../../src/player/contracts.js";
import {
  compactDecisionObservation,
  compactSnapshot,
  PlayerConversationAgent,
  PlayerPurposeAgent,
} from "../../src/player/agents.js";
import { PlayerMindStore } from "../../src/player/mind-store.js";
import type { PlayerResponsesClient } from "../../src/player/responses.js";
import { toSpatialView } from "../../src/player/spatial-view.js";

const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0))
    rmSync(directory, { recursive: true, force: true });
});

describe("player agent response rounds", () => {
  it("uses the fresh initial observation without exposing a duplicate observe tool", async () => {
    const observation = bodyObservationFixture();
    const fixture = openPurposeFixture(
      [
        functionCallResponse(
          "fresh-observation-action",
          "commit_action_decision",
          actionArguments(),
        ),
      ],
      undefined,
      undefined,
      async () => observation,
    );

    try {
      const result = await fixture.agent.think({
        snapshot: fixture.mind.snapshot(),
        events: [],
      });

      expect(result.accepted).toBe(true);
      expect(fixture.observationCalls).toBe(1);
      const request = z
        .record(z.string(), z.unknown())
        .parse(fixture.requests[0]);
      const tools = z
        .array(z.record(z.string(), z.unknown()))
        .parse(request.tools);
      expect(tools.map((tool) => tool.name)).not.toContain("observe_body");
      const knowledgeTool = tools.find(
        (tool) => tool.name === "ask_body_knowledge",
      );
      expect(knowledgeTool?.description).toContain("初回観測");
      const inputItems = z
        .array(z.record(z.string(), z.unknown()))
        .parse(request.input);
      const userInput = z.record(z.string(), z.unknown()).parse(inputItems[0]);
      const purposeInput = z
        .record(z.string(), z.unknown())
        .parse(JSON.parse(String(userInput.content)));
      expect(purposeInput.observation).toEqual(
        compactDecisionObservation(observation),
      );
      const fullSnapshot = fixture.mind.snapshot();
      const judgment = fullSnapshot.recentJudgments.at(-1);
      if (judgment === undefined) throw new Error("judgment missing");
      const longHistory = {
        ...fullSnapshot,
        recentJudgments: Array.from({ length: 7 }, (_, index) => ({
          ...judgment,
          revision: index + 1,
        })),
        recentOutcomes: Array.from(
          { length: 6 },
          (_, index): PlayerRuntimeSnapshot["recentOutcomes"][number] => ({
            runId: `run-${index}`,
            operationId: `run-${index}`,
            kind:
              index === 0 ? "move_to" : index === 1 ? "move_relative" : "look",
            status: index === 1 ? "failed" : "successful",
            summary:
              index === 0
                ? "期待したstep=観測した移動差分=Δx:999.0,Δy:0.0,Δz:0.0,距離:999.0。"
                : index === 1
                  ? "結果概要=経路が塞がれている。観測した移動差分=Δx:999.0,Δy:0.0,Δz:0.0,距離:999.0。"
                  : "view changed",
            observedAt: observation.observedAt,
            ...(index === 0
              ? { movementDelta: { x: 2, y: 0, z: -1 } }
              : index === 1
                ? { movementDelta: { x: 0, y: 0, z: 0 } }
                : {}),
          }),
        ),
      };
      const compactedRuntime = z
        .record(z.string(), z.unknown())
        .parse(compactSnapshot(longHistory));
      expect(compactedRuntime.recentJudgments).toHaveLength(4);
      expect(compactedRuntime.omittedJudgmentCount).toBe(3);
      expect(compactedRuntime.recentOutcomes).toEqual(
        longHistory.recentOutcomes.slice(-4),
      );
      expect(compactedRuntime.omittedOutcomeCount).toBe(2);
      expect(compactedRuntime.olderMovementOutcomes).toEqual([
        {
          kind: "move_to",
          status: "successful",
          observedAt: observation.observedAt,
          displacement: { x: 2, y: 0, z: -1 },
        },
        {
          kind: "move_relative",
          status: "failed",
          observedAt: observation.observedAt,
          displacement: { x: 0, y: 0, z: 0 },
        },
      ]);
      expect(compactedRuntime.recentMovement).toEqual({
        scope: "retained_outcomes",
        sampleCount: 2,
        netApproxBlocks: { x: 2, y: 0, z: -1 },
      });
      expect(compactedRuntime.recentJudgments).toEqual(
        longHistory.recentJudgments.slice(-4),
      );
      expect(longHistory.recentJudgments).toHaveLength(7);
      expect(longHistory.recentOutcomes).toHaveLength(6);
    } finally {
      fixture.close();
    }
  });

  it("summarizes only retained movement after the latest active owner proposal", () => {
    const fixture = openPurposeFixture([]);
    try {
      const snapshot = fixture.mind.snapshot();
      const proposalId = "owner-proposal-movement";
      const withOwnerGoal: PlayerRuntimeSnapshot = {
        ...snapshot,
        goals: [
          {
            id: "owner-goal-movement",
            ownerProposalId: proposalId,
            title: "目的地へ進む",
            status: "active",
            priority: 4,
            changeReason: "依頼を採用",
            source: "owner",
            updatedAt: "2026-01-02T00:00:00.000Z",
          },
        ],
        proposals: [
          {
            id: proposalId,
            title: "目的地へ進む",
            reason: "合成fixture",
            createdAt: "2026-01-02T00:00:00.000Z",
            priorityPreference: 4,
            status: "adopted",
            resolution: "採用",
          },
        ],
        recentOutcomes: [
          {
            runId: "before-proposal",
            operationId: "before-proposal",
            kind: "move_relative",
            status: "successful",
            summary: "earlier movement",
            observedAt: "2026-01-01T00:00:00.000Z",
            movementDelta: { x: 5, y: 0, z: 0 },
          },
          {
            runId: "after-proposal",
            operationId: "after-proposal",
            kind: "move_relative",
            status: "successful",
            summary: "later movement",
            observedAt: "2026-01-02T00:01:00.000Z",
            movementDelta: { x: -0.14, y: 0, z: 4.06 },
          },
        ],
      };
      const compacted = z
        .record(z.string(), z.unknown())
        .parse(compactSnapshot(withOwnerGoal));
      expect(compacted.recentMovement).toEqual({
        scope: "since_latest_active_owner_proposal_in_retained_outcomes",
        sampleCount: 1,
        netApproxBlocks: { x: -0.1, y: 0, z: 4.1 },
      });
    } finally {
      fixture.close();
    }
  });

  it("shows prior visible positions without duplicating the current view", async () => {
    const current = bodyObservationFixture();
    const prior: PlayerBodyObservation = {
      ...current,
      observedAt: "2026-09-24T23:59:00.000Z",
      self: {
        ...current.self,
        position: { ...current.self.position, x: 3 },
      },
      perception: {
        ...current.perception,
        blocks: [
          {
            name: "stone",
            stateId: 1,
            position: { x: 5, y: 64, z: 2, dimension: "overworld" },
            distance: 2,
            properties: {},
          },
        ],
      },
    };
    const fixture = openPurposeFixture(
      [
        functionCallResponse(
          "act-after-history",
          "commit_action_decision",
          actionArguments(),
        ),
      ],
      undefined,
      undefined,
      async () => current,
    );
    try {
      const priorView = toSpatialView(prior);
      const currentView = toSpatialView(current);
      if (priorView === undefined || currentView === undefined)
        throw new Error("spatial test view missing");
      fixture.mind.recordSpatialView(priorView);
      fixture.mind.recordSpatialView(currentView);

      const result = await fixture.agent.think({
        snapshot: fixture.mind.snapshot(),
        events: [],
      });
      expect(result.accepted).toBe(true);
      const request = z
        .record(z.string(), z.unknown())
        .parse(fixture.requests[0]);
      const inputItem = z
        .record(z.string(), z.unknown())
        .parse(z.array(z.unknown()).parse(request.input)[0]);
      const input = z
        .record(z.string(), z.unknown())
        .parse(JSON.parse(String(inputItem.content)));
      expect(input.spatialHistory).toEqual([priorView]);
    } finally {
      fixture.close();
    }
  });

  it("compacts repeated block metadata without hiding visible evidence", () => {
    const base = bodyObservationFixture();
    const blocks = Array.from({ length: 96 }, (_, index) => ({
      name: index === 95 ? "oak_log" : "stone",
      stateId: index + 1,
      position: {
        x: index,
        y: 64,
        z: index % 8,
        dimension: "overworld",
      },
      distance: index / 10,
      properties: index === 95 ? { axis: "x" } : {},
    }));
    const observation: PlayerBodyObservation = {
      ...base,
      perception: {
        ...base.perception,
        blocks,
        omittedBlockCandidates: 17,
        candidateSearchMayBeTruncated: true,
      },
    };

    const compacted = z
      .record(z.string(), z.unknown())
      .parse(compactDecisionObservation(observation));
    const perception = z
      .record(z.string(), z.unknown())
      .parse(compacted.perception);
    const visibleBlocks = z
      .array(z.record(z.string(), z.unknown()))
      .parse(perception.blocks);

    expect(compacted.dimension).toBe("overworld");
    expect(visibleBlocks).toHaveLength(96);
    expect(visibleBlocks[95]).toEqual({
      name: "oak_log",
      position: { x: 95, y: 64, z: 7 },
      distance: 9.5,
      properties: { axis: "x" },
    });
    expect(visibleBlocks[0]).not.toHaveProperty("stateId");
    expect(visibleBlocks[0]?.position).not.toHaveProperty("dimension");
    expect(perception.omittedBlockCandidates).toBe(17);
    expect(perception.candidateSearchMayBeTruncated).toBe(true);
    expect(observation.perception.blocks[95]?.stateId).toBe(96);
    expect(JSON.stringify(compacted).length).toBeLessThan(
      JSON.stringify(observation).length,
    );
  });

  it.each([
    [0, "north"],
    [-Math.PI / 2, "east"],
    [Math.PI, "south"],
    [Math.PI / 2, "west"],
  ] as const)("adds the observed cardinal facing for yaw %s", (yaw, facing) => {
    const base = bodyObservationFixture();
    const compacted = z.record(z.string(), z.unknown()).parse(
      compactDecisionObservation({
        ...base,
        self: { ...base.self, yaw },
      }),
    );
    expect(compacted.coordinateAxes).toEqual({
      east: "+x",
      west: "-x",
      south: "+z",
      north: "-z",
    });
    expect(
      z.record(z.string(), z.unknown()).parse(compacted.self),
    ).toMatchObject({ facingCardinal: facing, yaw });
  });

  it("retains observe_body as recovery when the initial observation is unavailable", async () => {
    const observation = bodyObservationFixture();
    let observationAttempts = 0;
    const fixture = openPurposeFixture(
      [
        functionCallResponse("recover-observation", "observe_body", {}),
        functionCallResponse(
          "action-after-recovery",
          "commit_action_decision",
          actionArguments(),
        ),
      ],
      undefined,
      undefined,
      async () => {
        observationAttempts += 1;
        if (observationAttempts === 1)
          throw new Error("INITIAL_OBSERVATION_UNAVAILABLE");
        return observation;
      },
    );

    try {
      const result = await fixture.agent.think({
        snapshot: fixture.mind.snapshot(),
        events: [],
      });

      expect(result.accepted).toBe(true);
      expect(fixture.observationCalls).toBe(2);
      const firstRequest = z
        .record(z.string(), z.unknown())
        .parse(fixture.requests[0]);
      const tools = z
        .array(z.record(z.string(), z.unknown()))
        .parse(firstRequest.tools);
      expect(tools.map((tool) => tool.name)).toContain("observe_body");
    } finally {
      fixture.close();
    }
  });

  it("commits action, goal, proposal resolution, and understanding in one CAS", async () => {
    const persistedGoals: unknown[] = [];
    const memory = createMemoryPort();
    memory.persistGoals = (goals) => persistedGoals.push(goals);
    let proposalId = "";
    const fixture = openPurposeFixture(
      [
        () =>
          functionCallResponse(
            "atomic-action-state",
            "commit_action_decision",
            actionArguments({
              goalState: {
                proposalId,
                proposalDisposition: "adopted",
                resolution: "It fits the current purpose.",
                goalId: "",
                goalTitle: "Explore the nearby valley",
                goalStatus: "active",
                goalPriority: 3,
                changeReason: "The observed route is useful.",
                goalSource: "self",
              },
              understanding: {
                facts: [
                  { summary: "A valley is visible.", source: "observed" },
                ],
                uncertainties: [
                  { summary: "The route may be blocked.", source: "inferred" },
                ],
              },
            }),
          ),
        functionCallResponse(
          "continue-with-understanding",
          "commit_action_decision",
          {
            ...actionArguments(),
            kind: "continue",
            operationJson: "",
            stateUpdates: {
              goalState: null,
              understanding: {
                facts: [
                  {
                    summary: "The current operation remains active.",
                    source: "observed",
                  },
                ],
                uncertainties: [],
              },
            },
          },
        ),
      ],
      undefined,
      memory,
    );
    const proposal = fixture.mind.addProposal({
      title: "Explore the valley",
      reason: "It may reveal useful landmarks.",
      priority: 3,
    });
    proposalId = proposal.id;
    const before = fixture.mind.snapshot();

    try {
      const first = await fixture.agent.think({ snapshot: before, events: [] });
      expect(first.accepted).toBe(true);
      expect(fixture.requests).toHaveLength(1);
      const request = z
        .record(z.string(), z.unknown())
        .parse(fixture.requests[0]);
      const toolDefinitions = z
        .array(z.record(z.string(), z.unknown()))
        .parse(request.tools);
      const actionTool = toolDefinitions.find(
        (tool) => tool.name === "commit_action_decision",
      );
      expect(actionTool).toBeDefined();
      const parameters = z
        .record(z.string(), z.unknown())
        .parse(actionTool?.parameters);
      const properties = z
        .record(z.string(), z.unknown())
        .parse(parameters.properties);
      expect(parameters.required).toContain("stateUpdates");
      expect(properties.reason).toMatchObject({
        type: "string",
        maxLength: 400,
      });
      expect(JSON.stringify(properties.stateUpdates)).toContain(
        '"type":"null"',
      );
      const afterAction = fixture.mind.snapshot();
      expect(afterAction.revision).toBe(before.revision + 1);
      expect(afterAction.actionRevision).toBe(before.actionRevision + 1);
      expect(afterAction.goals).toContainEqual(
        expect.objectContaining({ title: "Explore the nearby valley" }),
      );
      expect(afterAction.proposals).toContainEqual(
        expect.objectContaining({
          id: proposal.id,
          status: "adopted",
          resolution: "It fits the current purpose.",
        }),
      );
      expect(afterAction.stateFacts).toContainEqual(
        expect.objectContaining({
          summary: "A valley is visible.",
          source: "observed",
        }),
      );
      expect(afterAction.uncertainties).toContainEqual(
        expect.objectContaining({
          summary: "The route may be blocked.",
          source: "inferred",
        }),
      );
      expect(persistedGoals).toHaveLength(1);

      const continued = await fixture.agent.think({
        snapshot: afterAction,
        events: [],
      });
      expect(continued.decision?.kind).toBe("continue");
      expect(fixture.mind.snapshot().revision).toBe(afterAction.revision + 1);
      expect(fixture.mind.snapshot().actionRevision).toBe(
        afterAction.actionRevision,
      );
      expect(fixture.mind.snapshot().activeOperation).toEqual(
        afterAction.activeOperation,
      );
      expect(persistedGoals).toHaveLength(1);
    } finally {
      fixture.close();
    }
  });

  it("carries the bounded action reason into the next thought and reopened mind", async () => {
    const reason = "r".repeat(400);
    const fixture = openPurposeFixture([
      functionCallResponse("action-with-reason", "commit_action_decision", {
        ...actionArguments(),
        reason,
      }),
      functionCallResponse("continue-after-action", "commit_action_decision", {
        ...actionArguments(),
        kind: "continue",
        operationJson: "",
        reason: "Continue observing the result.",
      }),
    ]);
    let fixtureOpen = true;

    try {
      const acted = await fixture.agent.think({
        snapshot: fixture.mind.snapshot(),
        events: [],
      });
      expect(acted.accepted).toBe(true);
      const expectedSummary = `目的に沿って look を開始: ${reason}`;
      expect(fixture.mind.snapshot().recentJudgments.at(-1)).toMatchObject({
        kind: "act",
        summary: expectedSummary,
      });
      expect(expectedSummary.length).toBeLessThanOrEqual(500);

      const continued = await fixture.agent.think({
        snapshot: fixture.mind.snapshot(),
        events: [],
      });
      expect(continued.decision?.kind).toBe("continue");
      const request = z
        .record(z.string(), z.unknown())
        .parse(fixture.requests[1]);
      const inputItems = z
        .array(z.record(z.string(), z.unknown()))
        .parse(request.input);
      const userInput = z.record(z.string(), z.unknown()).parse(inputItems[0]);
      const purposeInput = z
        .record(z.string(), z.unknown())
        .parse(JSON.parse(String(userInput.content)));
      const runtime = z
        .record(z.string(), z.unknown())
        .parse(purposeInput.runtime);
      expect(runtime.recentJudgments).toContainEqual(
        expect.objectContaining({
          kind: "act",
          summary: expectedSummary,
        }),
      );

      fixture.close();
      fixtureOpen = false;
      const reopened = PlayerMindStore.open(fixture.databasePath);
      try {
        expect(reopened.snapshot().recentJudgments).toContainEqual(
          expect.objectContaining({
            kind: "act",
            summary: expectedSummary,
          }),
        );
      } finally {
        reopened.close();
      }
    } finally {
      if (fixtureOpen) fixture.close();
    }
  });

  it("uses the legacy action summary when the model supplies an empty reason", async () => {
    const fixture = openPurposeFixture([
      functionCallResponse("action-empty-reason", "commit_action_decision", {
        ...actionArguments(),
        reason: "   ",
      }),
    ]);

    try {
      const result = await fixture.agent.think({
        snapshot: fixture.mind.snapshot(),
        events: [],
      });
      expect(result.accepted).toBe(true);
      expect(fixture.mind.snapshot().recentJudgments.at(-1)).toMatchObject({
        kind: "act",
        summary: "目的に沿って look を開始",
      });
    } finally {
      fixture.close();
    }
  });

  it("rejects all combined updates when the proposal is no longer pending", async () => {
    const fixture = openPurposeFixture([
      functionCallResponse(
        "invalid-atomic-proposal",
        "commit_action_decision",
        actionArguments({
          goalState: {
            proposalId: "missing-proposal",
            proposalDisposition: "adopted",
            resolution: "Accepted.",
            goalId: "",
            goalTitle: "A new goal",
            goalStatus: "active",
            goalPriority: 2,
            changeReason: "It seems useful.",
            goalSource: "self",
          },
          understanding: {
            facts: [{ summary: "Observed fact.", source: "observed" }],
            uncertainties: [],
          },
        }),
      ),
      functionCallResponse(
        "repaired-action-after-proposal-rejection",
        "commit_action_decision",
        actionArguments(),
      ),
    ]);
    const proposal = fixture.mind.addProposal({
      title: "Existing proposal",
      reason: "Pending proposal fixture.",
    });
    const before = fixture.mind.snapshot();

    try {
      const result = await fixture.agent.think({
        snapshot: before,
        events: [],
      });
      expect(result.accepted).toBe(true);
      expect(fixture.requests).toHaveLength(2);
      expect(JSON.stringify(fixture.requests[1])).toContain(
        "PROPOSAL_NOT_PENDING",
      );
      expect(fixture.mind.snapshot().goals).toEqual(before.goals);
      expect(fixture.mind.snapshot().proposals).toEqual(before.proposals);
      expect(fixture.mind.snapshot().stateFacts).toEqual(before.stateFacts);
      expect(fixture.mind.snapshot().uncertainties).toEqual(
        before.uncertainties,
      );
      expect(fixture.mind.snapshot().proposals).toContainEqual(
        expect.objectContaining({ id: proposal.id, status: "pending" }),
      );
      expect(
        fixture.mind.snapshot().recentAgentActivity[0]?.toolCalls[0],
      ).toMatchObject({
        name: "commit_action_decision",
        resultClass: "rejected",
        resultCode: "PROPOSAL_NOT_PENDING",
      });
    } finally {
      fixture.close();
    }
  });

  it("still delivers an accepted action if the external goal mirror fails", async () => {
    const memory = createMemoryPort();
    memory.persistGoals = () => {
      throw new Error("fixture persistence error");
    };
    const committed: PlayerThoughtDecision[] = [];
    const fixture = openPurposeFixture(
      [
        functionCallResponse(
          "goal-mirror-failure",
          "commit_action_decision",
          actionArguments({
            goalState: {
              proposalId: "",
              proposalDisposition: "none",
              resolution: "",
              goalId: "",
              goalTitle: "Explore the nearby valley",
              goalStatus: "active",
              goalPriority: 3,
              changeReason: "The route looks useful.",
              goalSource: "self",
            },
            understanding: null,
          }),
        ),
      ],
      (_snapshot, decision) => committed.push(decision),
      memory,
    );

    try {
      const result = await fixture.agent.think({
        snapshot: fixture.mind.snapshot(),
        events: [],
      });

      expect(result.accepted).toBe(true);
      expect(committed).toHaveLength(1);
      expect(fixture.mind.snapshot().goals).toContainEqual(
        expect.objectContaining({ title: "Explore the nearby valley" }),
      );
      expect(fixture.mind.snapshot().activeOperation).toBeDefined();
      expect(fixture.requests).toHaveLength(1);
    } finally {
      fixture.close();
    }
  });

  it("replans after a failed owner-goal action without marking the goal complete", async () => {
    const failedTarget = { x: 4, y: 65, z: 2 };
    const alternateTarget = { x: 5, y: 65, z: 2 };
    const fixture = openPurposeFixture([
      functionCallResponse(
        "replan-after-occupied-place",
        "commit_action_decision",
        {
          ...actionArguments(),
          purpose: "Repair the nearby wall",
          operationJson: JSON.stringify({
            kind: "place",
            item: "oak_planks",
            position: alternateTarget,
          }),
          expectedOutcome: "The visible wall gap is filled.",
          reason:
            "The last target was occupied, so inspect the wall and choose an empty position.",
        },
      ),
    ]);
    const proposal = fixture.mind.addProposal({
      title: "Repair the nearby wall",
      reason: "The owner asked to fill a visible gap in the wall.",
      priority: 4,
    });
    const accepted = fixture.mind.commitGoalState({
      expectedRevision: fixture.mind.snapshot().revision,
      proposalResolution: {
        proposalId: proposal.id,
        disposition: "adopted",
        resolution: "Keep the wall repair as an active owner goal.",
      },
    });
    expect(accepted.accepted).toBe(true);
    const ownerGoal = accepted.snapshot.goals.find(
      (goal) => goal.ownerProposalId === proposal.id,
    );
    expect(ownerGoal).toMatchObject({ source: "owner", status: "active" });
    const failedAt = new Date().toISOString();
    const failureSummary =
      "place は failed: Error: Target position is occupied by oak_planks";
    fixture.mind.recordOutcome({
      evidence: {
        operationId: "failed-wall-placement",
        kind: "place",
        status: "failed",
        summary: failureSummary,
        observedAt: failedAt,
      },
    });
    const beforeReplan = fixture.mind.snapshot();

    try {
      const result = await fixture.agent.think({
        snapshot: beforeReplan,
        events: [
          {
            id: "failed-place-event",
            kind: "body_outcome",
            summary: failureSummary,
            createdAt: failedAt,
          },
        ],
      });

      expect(result.accepted).toBe(true);
      expect(result.decision).toMatchObject({
        kind: "act",
        operation: { kind: "place", position: alternateTarget },
      });
      expect(alternateTarget).not.toEqual(failedTarget);
      expect(fixture.mind.snapshot().lastOutcome).toMatchObject({
        kind: "place",
        status: "failed",
      });
      expect(fixture.mind.snapshot().goals).toContainEqual(
        expect.objectContaining({
          id: ownerGoal?.id,
          ownerProposalId: proposal.id,
          status: "active",
        }),
      );
      const request = z
        .record(z.string(), z.unknown())
        .parse(fixture.requests[0]);
      expect(request.instructions).toContain(
        "body操作がfailed、unverified、interrupted、cancelledになったら",
      );
      expect(JSON.stringify(request.input)).toContain(
        "Target position is occupied by oak_planks",
      );
      const inputItems = z
        .array(z.record(z.string(), z.unknown()))
        .parse(request.input);
      const userInput = z.record(z.string(), z.unknown()).parse(inputItems[0]);
      const purposeInput = z
        .record(z.string(), z.unknown())
        .parse(JSON.parse(String(userInput.content)));
      const runtime = z
        .record(z.string(), z.unknown())
        .parse(purposeInput.runtime);
      expect(runtime.lastOutcome).toMatchObject({
        kind: "place",
        status: "failed",
      });
      expect(purposeInput.events).toContainEqual(
        expect.objectContaining({ kind: "body_outcome" }),
      );
    } finally {
      fixture.close();
    }
  });

  it("shows a successful look's expected step and observed result to the next judgment", async () => {
    const expectedOutcome =
      "The view exposes the wall gap for the next repair step.";
    const outcomeSummary =
      "look は successful。視点変更を確認。ブロック変更は観測されていない。";
    const alternateTarget = { x: 5, y: 65, z: 2 };
    const fixture = openPurposeFixture([
      functionCallResponse(
        "plan-after-successful-look",
        "commit_action_decision",
        {
          ...actionArguments(),
          purpose: "Repair the visible wall gap",
          operationJson: JSON.stringify({
            kind: "place",
            item: "oak_planks",
            position: alternateTarget,
          }),
          expectedOutcome: "The visible gap is filled.",
          reason: "The view step succeeded; continue the active repair goal.",
        },
      ),
    ]);
    const proposal = fixture.mind.addProposal({
      title: "Repair the visible wall gap",
      reason: "The owner asked to repair a gap in the nearby wall.",
      priority: 4,
    });
    const accepted = fixture.mind.commitGoalState({
      expectedRevision: fixture.mind.snapshot().revision,
      proposalResolution: {
        proposalId: proposal.id,
        disposition: "adopted",
        resolution: "Keep the repair as an active owner goal.",
      },
    });
    expect(accepted.accepted).toBe(true);
    const ownerGoal = accepted.snapshot.goals.find(
      (goal) => goal.ownerProposalId === proposal.id,
    );
    const observedAt = new Date().toISOString();
    fixture.mind.recordOutcome({
      evidence: {
        operationId: "successful-look-step",
        kind: "look",
        status: "successful",
        summary: outcomeSummary,
        observedAt,
        expectedOutcome,
      },
    });

    try {
      const result = await fixture.agent.think({
        snapshot: fixture.mind.snapshot(),
        events: [
          {
            id: "successful-look-event",
            kind: "body_outcome",
            summary: outcomeSummary,
            createdAt: observedAt,
          },
        ],
      });

      expect(result.accepted).toBe(true);
      expect(result.decision).toMatchObject({
        kind: "act",
        operation: { kind: "place", position: alternateTarget },
      });
      expect(fixture.mind.snapshot().goals).toContainEqual(
        expect.objectContaining({
          id: ownerGoal?.id,
          ownerProposalId: proposal.id,
          status: "active",
        }),
      );
      const request = z
        .record(z.string(), z.unknown())
        .parse(fixture.requests[0]);
      expect(request.instructions).toContain(
        "successfulは操作単体の効果確認であり、owner goalの達成確認ではありません。",
      );
      expect(request.instructions).toContain(
        "expectedOutcomeと最新の観測を照合",
      );
      const inputItems = z
        .array(z.record(z.string(), z.unknown()))
        .parse(request.input);
      const userInput = z.record(z.string(), z.unknown()).parse(inputItems[0]);
      const purposeInput = z
        .record(z.string(), z.unknown())
        .parse(JSON.parse(String(userInput.content)));
      const runtime = z
        .record(z.string(), z.unknown())
        .parse(purposeInput.runtime);
      expect(runtime.lastOutcome).toMatchObject({
        kind: "look",
        status: "successful",
        expectedOutcome,
        summary: outcomeSummary,
      });
    } finally {
      fixture.close();
    }
  });

  it("returns a successful purpose commit on the sixth tool round", async () => {
    const responses = [
      ...Array.from({ length: 5 }, (_, index) =>
        functionCallResponse(`memory-${index}`, "search_memory", {
          query: "landmark",
        }),
      ),
      functionCallResponse(
        "last-round-commit",
        "commit_action_decision",
        actionArguments(),
      ),
    ];
    const committed: PlayerThoughtDecision[] = [];
    const fixture = openPurposeFixture(responses, (_snapshot, decision) => {
      committed.push(decision);
    });

    try {
      const result = await fixture.agent.think({
        snapshot: fixture.mind.snapshot(),
        events: [],
      });

      expect(result.accepted).toBe(true);
      expect(result.decision?.kind).toBe("act");
      expect(fixture.requests).toHaveLength(6);
      expect(committed).toHaveLength(1);
    } finally {
      fixture.close();
    }
  });

  it("finishes on a stale action CAS and preserves its uncommitted wake event", async () => {
    const mindRef: { current?: PlayerMindStore } = {};
    const responses: ScriptedResponse[] = [
      functionCallResponse("unknown", "not_a_registered_tool", {}),
      functionCallResponse(
        "rejected-goal",
        "commit_goal_state",
        emptyGoalStateArguments(),
      ),
      (_request, index) => {
        const mind = mindRef.current;
        if (index !== 2 || mind === undefined)
          throw new Error("TEST_REVISION_FIXTURE_MISSING");
        const current = mind.snapshot();
        const saved = mind.commitUnderstanding({
          expectedRevision: current.revision,
          facts: [{ summary: "A newer observed fact", source: "observed" }],
          uncertainties: [],
        });
        if (!saved.accepted) throw new Error("TEST_REVISION_CHANGE_REJECTED");
        return functionCallResponse(
          "stale-commit",
          "commit_action_decision",
          actionArguments(),
        );
      },
    ];
    const committed: PlayerThoughtDecision[] = [];
    const fixture = openPurposeFixture(responses, (_snapshot, decision) => {
      committed.push(decision);
    });
    mindRef.current = fixture.mind;
    const event = fixture.mind.enqueueEvent(
      "state_changed",
      "meaningful change: nearby block changed",
    );

    try {
      const result = await fixture.agent.think({
        snapshot: fixture.mind.snapshot(),
        events: [event],
      });

      expect(result.accepted).toBe(false);
      expect(committed).toHaveLength(0);
      expect(fixture.requests).toHaveLength(3);
      expect(JSON.stringify(fixture.requests[1])).toContain("UNKNOWN_TOOL");
      expect(JSON.stringify(fixture.requests[2])).toContain("NO_STATE_CHANGE");
      expect(fixture.mind.pendingEvents()).toContainEqual(
        expect.objectContaining({ id: event.id }),
      );
      expect(
        fixture.mind.snapshot().recentAgentActivity.at(-1)?.toolCalls[0],
      ).toMatchObject({
        resultCode: "CAS_STALE",
        staleChangedComponents: ["knowledge_state"],
      });
      expect(
        JSON.stringify(fixture.mind.snapshot().recentAgentActivity),
      ).not.toContain("A newer observed fact");
    } finally {
      fixture.close();
    }
  });

  it("reports unknown when a stale revision has no observable component delta", async () => {
    const mindRef: { current?: PlayerMindStore } = {};
    const fixture = openPurposeFixture([
      (_request, index) => {
        const mind = mindRef.current;
        if (index !== 0 || mind === undefined)
          throw new Error("TEST_REVISION_FIXTURE_MISSING");
        mind.enqueueEvent("state_changed", "second event of the same kind");
        return functionCallResponse(
          "stale-commit",
          "commit_action_decision",
          actionArguments(),
        );
      },
    ]);
    mindRef.current = fixture.mind;
    const firstEvent = fixture.mind.enqueueEvent(
      "state_changed",
      "first event of the same kind",
    );

    try {
      const result = await fixture.agent.think({
        snapshot: fixture.mind.snapshot(),
        events: [firstEvent],
      });

      expect(result.accepted).toBe(false);
      expect(fixture.mind.pendingEvents()).toHaveLength(2);
      expect(
        fixture.mind.snapshot().recentAgentActivity.at(-1)?.toolCalls[0],
      ).toMatchObject({
        resultCode: "CAS_STALE",
        staleChangedComponents: ["unknown"],
      });
      const activity = JSON.stringify(
        fixture.mind.snapshot().recentAgentActivity,
      );
      expect(activity).not.toContain("first event of the same kind");
      expect(activity).not.toContain("second event of the same kind");
    } finally {
      fixture.close();
    }
  });

  it("allows repairable operation errors and consumes wake events after commit", async () => {
    const invalidAction = actionArguments();
    invalidAction.operationJson = JSON.stringify({
      kind: "look",
      untrusted: "opaque-argument-sentinel",
    });
    const fixture = openPurposeFixture([
      functionCallResponse(
        "invalid-action",
        "commit_action_decision",
        invalidAction,
      ),
      functionCallResponse(
        "corrected-action",
        "commit_action_decision",
        actionArguments(),
      ),
    ]);
    const event = fixture.mind.enqueueEvent(
      "state_changed",
      "meaningful change: position moved",
    );

    try {
      const result = await fixture.agent.think({
        snapshot: fixture.mind.snapshot(),
        events: [event],
      });

      expect(result.accepted).toBe(true);
      expect(fixture.requests).toHaveLength(2);
      expect(JSON.stringify(fixture.requests[1])).toContain(
        "INVALID_PLAYER_OPERATION",
      );
      const secondRequest = z
        .record(z.string(), z.unknown())
        .parse(fixture.requests[1]);
      const inputItems = z
        .array(z.record(z.string(), z.unknown()))
        .parse(secondRequest.input);
      const errorOutput = inputItems.find(
        (item) => item.type === "function_call_output",
      );
      const errorResult = z
        .record(z.string(), z.unknown())
        .parse(JSON.parse(String(errorOutput?.output)));
      expect(errorResult).toMatchObject({
        ok: false,
        code: "INVALID_PLAYER_OPERATION",
        operationSchema: { kind: "look", schema: { type: "object" } },
      });
      expect(JSON.stringify(errorResult)).not.toContain(
        "opaque-argument-sentinel",
      );
      expect(fixture.mind.pendingEvents()).not.toContainEqual(
        expect.objectContaining({ id: event.id }),
      );
    } finally {
      fixture.close();
    }
  });

  it("keeps a continue-without-active-operation rejection repairable", async () => {
    const fixture = openPurposeFixture([
      functionCallResponse(
        "continue-without-operation",
        "commit_action_decision",
        { ...actionArguments(), kind: "continue", operationJson: "" },
      ),
      functionCallResponse(
        "repaired-action",
        "commit_action_decision",
        actionArguments(),
      ),
    ]);

    try {
      const result = await fixture.agent.think({
        snapshot: fixture.mind.snapshot(),
        events: [],
      });

      expect(result.accepted).toBe(true);
      expect(fixture.requests).toHaveLength(2);
      expect(JSON.stringify(fixture.requests[1])).toContain(
        "NO_ACTIVE_OPERATION",
      );
      expect(
        fixture.mind.snapshot().recentAgentActivity[0]?.toolCalls[0],
      ).toMatchObject({ resultCode: "NO_ACTIVE_OPERATION" });
    } finally {
      fixture.close();
    }
  });

  it("finishes on a stopped action CAS and preserves its uncommitted wake event", async () => {
    const mindRef: { current?: PlayerMindStore } = {};
    const fixture = openPurposeFixture([
      (_request, index) => {
        if (index !== 0) throw new Error("TEST_STOP_LATCH_NOT_SET");
        const stopped = mindRef.current?.stop();
        if (!stopped?.stopped) throw new Error("TEST_STOP_LATCH_NOT_SET");
        return functionCallResponse(
          "stopped-action",
          "commit_action_decision",
          actionArguments(),
        );
      },
    ]);
    mindRef.current = fixture.mind;
    const event = fixture.mind.enqueueEvent(
      "state_changed",
      "meaningful change: health changed",
    );

    try {
      const result = await fixture.agent.think({
        snapshot: fixture.mind.snapshot(),
        events: [event],
      });

      expect(result.accepted).toBe(false);
      expect(fixture.requests).toHaveLength(1);
      expect(fixture.mind.pendingEvents()).toContainEqual(
        expect.objectContaining({ id: event.id }),
      );
      expect(
        fixture.mind.snapshot().recentAgentActivity[0]?.toolCalls[0],
      ).toMatchObject({ resultCode: "STOPPED" });
    } finally {
      fixture.close();
    }
  });

  it("does not report completion when stop aborts immediately after commit", async () => {
    const controller = new AbortController();
    const mindRef: { current?: PlayerMindStore } = {};
    const fixture = openPurposeFixture(
      [
        functionCallResponse(
          "commit-before-stop",
          "commit_action_decision",
          actionArguments(),
        ),
      ],
      () => {
        const stopped = mindRef.current?.stop();
        if (stopped?.stopped !== true)
          throw new Error("TEST_STOP_LATCH_NOT_SET");
        controller.abort();
      },
    );
    mindRef.current = fixture.mind;

    try {
      await expect(
        fixture.agent.think({
          snapshot: fixture.mind.snapshot(),
          events: [],
          signal: controller.signal,
        }),
      ).rejects.toMatchObject({ name: "AbortError" });

      expect(fixture.mind.snapshot().stopped).toBe(true);
      expect(fixture.requests).toHaveLength(1);
    } finally {
      fixture.close();
    }
  });

  it("keeps requesting a user-facing final answer after conversation tools", async () => {
    const directory = mkdtempSync(
      join(tmpdir(), "player-conversation-rounds-"),
    );
    temporaryDirectories.push(directory);
    const mind = PlayerMindStore.open(join(directory, "player.sqlite"));
    const requests: unknown[] = [];
    const responses = [
      functionCallResponse("status-check", "inspect_player_status", {}),
      terminalResponse(
        "I am exploring nearby and can help with the next step.",
      ),
    ];
    const client = scriptedClient(responses, requests);
    const messages: string[] = [];
    const conversation = new PlayerConversationAgent({
      client,
      apiKey: "test-only",
      model: "test-model",
      ownerUsername: "owner",
      mind,
      memory: createMemoryPort(),
      logger: pino({ level: "silent" }),
      say: async (text) => {
        messages.push(text);
      },
      onProposal: () => undefined,
      onStop: async () => undefined,
      onResume: () => undefined,
    });

    try {
      const turn = conversation.nextTurn();
      await conversation.handleOwnerMessage({
        username: "owner",
        message: "What are you doing?",
        turn,
      });

      expect(messages).toEqual([
        "I am exploring nearby and can help with the next step.",
      ]);
      expect(requests).toHaveLength(2);
    } finally {
      mind.close();
    }
  });

  it("persists concise owner facts once and retains them after reopening the same database", async () => {
    const fixture = openConversationFixture();
    const fact = "合言葉は maple-47";
    fixture.responses.push(
      functionCallResponse("remember-once", "remember_owner_fact", {
        summary: fact,
      }),
      functionCallResponse("remember-again", "remember_owner_fact", {
        summary: " 合言葉は   maple-47 ",
      }),
      terminalResponse("合言葉を記憶しました。"),
    );
    const initialRevision = fixture.mind.snapshot().revision;

    try {
      const turn = fixture.conversation.nextTurn();
      await fixture.conversation.handleOwnerMessage({
        username: "owner",
        message: "次回も覚えてください。合言葉は maple-47 です。",
        turn,
      });

      const saved = fixture.mind.snapshot();
      expect(
        saved.stateFacts.filter((note) => note.summary === fact),
      ).toHaveLength(1);
      expect(saved.stateFacts).toContainEqual(
        expect.objectContaining({
          kind: "fact",
          source: "owner",
          summary: fact,
        }),
      );
      expect(saved.revision).toBe(initialRevision + 1);
      expect(fixture.messages).toEqual(["合言葉を記憶しました。"]);

      const tool = z
        .array(z.record(z.string(), z.unknown()))
        .parse(
          z.record(z.string(), z.unknown()).parse(fixture.requests[0]).tools,
        )
        .find((entry) => entry.name === "remember_owner_fact");
      expect(tool).toBeDefined();
      const request = z
        .record(z.string(), z.unknown())
        .parse(fixture.requests[0]);
      expect(request.instructions).toContain(
        "返答を作る前にremember_owner_factを必ず呼び",
      );
      expect(request.instructions).toContain(
        "toolを呼ばなかった、または成功を確認できなかった場合は、保存した・覚えたと表現しない",
      );
      expect(JSON.stringify(tool?.parameters)).toContain(
        '"required":["summary"]',
      );
      expect(JSON.stringify(tool?.parameters)).not.toContain('"source"');

      fixture.mind.close();
      const reopened = PlayerMindStore.open(fixture.databasePath);
      try {
        expect(reopened.snapshot().stateFacts).toContainEqual(
          expect.objectContaining({
            kind: "fact",
            source: "owner",
            summary: fact,
          }),
        );
      } finally {
        reopened.close();
      }
    } finally {
      fixture.close();
    }
  });

  it("rejects guest and stale conversation attempts to remember owner facts", async () => {
    const guestFixture = openConversationFixture();
    guestFixture.responses.push(
      functionCallResponse("guest-fact", "remember_owner_fact", {
        summary: "guest fact",
      }),
    );
    try {
      const turn = guestFixture.conversation.nextTurn();
      await guestFixture.conversation.handleOwnerMessage({
        username: "guest",
        message: "Remember this: guest fact",
        turn,
      });
      expect(guestFixture.requests).toHaveLength(0);
      expect(guestFixture.mind.snapshot().stateFacts).toHaveLength(0);
      expect(guestFixture.messages).toHaveLength(0);
    } finally {
      guestFixture.close();
    }

    const staleFixture = openConversationFixture();
    staleFixture.responses.push((_request, index) => {
      if (index !== 0) throw new Error("TEST_STALE_TURN_FIXTURE_MISSING");
      staleFixture.conversation.nextTurn();
      return functionCallResponse("stale-fact", "remember_owner_fact", {
        summary: "stale fact",
      });
    });
    try {
      const turn = staleFixture.conversation.nextTurn();
      await staleFixture.conversation.handleOwnerMessage({
        username: "owner",
        message: "Remember this next time: stale fact",
        turn,
      });
      expect(staleFixture.requests).toHaveLength(1);
      expect(staleFixture.mind.snapshot().stateFacts).toHaveLength(0);
      expect(staleFixture.messages).toHaveLength(0);
    } finally {
      staleFixture.close();
    }
  });

  it("does not store the owner's complete message as a fact summary", async () => {
    const fixture = openConversationFixture();
    const message = "次回覚えてください。合言葉は maple-47 です。";
    fixture.responses.push(
      functionCallResponse("verbatim-fact", "remember_owner_fact", {
        summary: message,
      }),
    );

    try {
      const turn = fixture.conversation.nextTurn();
      await fixture.conversation.handleOwnerMessage({
        username: "owner",
        message,
        turn,
      });
      expect(fixture.mind.snapshot().stateFacts).toHaveLength(0);
      expect(fixture.messages).toEqual([
        "記憶の保存を確認できませんでした。必要ならもう一度頼んでください。",
      ]);
    } finally {
      fixture.close();
    }
  });

  it.each(["stopped", "stale CAS"] as const)(
    "does not claim an owner fact was saved after %s rejection",
    async (failure) => {
      const fixture = openConversationFixture();
      fixture.responses.push(
        failure === "stopped"
          ? () => {
              fixture.mind.stop();
              return functionCallResponse(
                "rejected-fact",
                "remember_owner_fact",
                {
                  summary: `rejected ${failure} fact`,
                },
              );
            }
          : functionCallResponse("rejected-fact", "remember_owner_fact", {
              summary: `rejected ${failure} fact`,
            }),
      );
      if (failure === "stale CAS") {
        const commitUnderstanding = fixture.mind.commitUnderstanding.bind(
          fixture.mind,
        );
        fixture.mind.commitUnderstanding = (input) => {
          fixture.mind.enqueueEvent("state_changed", "CAS test revision");
          return commitUnderstanding(input);
        };
      }

      try {
        const turn = fixture.conversation.nextTurn();
        await fixture.conversation.handleOwnerMessage({
          username: "owner",
          message: `次回覚えてください。rejected ${failure} fact`,
          turn,
        });
        expect(fixture.mind.snapshot().stateFacts).toHaveLength(0);
        expect(fixture.messages).toEqual([
          "記憶の保存を確認できませんでした。必要ならもう一度頼んでください。",
        ]);
        expect(fixture.messages.join(" ")).not.toContain("保存しました");
      } finally {
        fixture.close();
      }
    },
  );
});

type ScriptedResponse =
  Response | ((request: unknown, index: number) => Response);

interface PurposeFixture {
  readonly agent: PlayerPurposeAgent;
  readonly databasePath: string;
  readonly mind: PlayerMindStore;
  readonly observationCalls: number;
  readonly requests: unknown[];
  close(): void;
}

function openPurposeFixture(
  responses: ScriptedResponse[],
  onCommitted: (
    snapshot: PlayerRuntimeSnapshot,
    decision: PlayerThoughtDecision,
  ) => void = () => undefined,
  memory: PlayerMemoryPort = createMemoryPort(),
  observeBody?: () => Promise<PlayerBodyObservation>,
): PurposeFixture {
  const directory = mkdtempSync(join(tmpdir(), "player-agent-rounds-"));
  temporaryDirectories.push(directory);
  const databasePath = join(directory, "player.sqlite");
  const mind = PlayerMindStore.open(databasePath);
  const skills = McSkillRepository.open({
    databasePath,
    exchangeDirectory: join(directory, "skills"),
    allowedOperationNames: playerOperationNames,
  });
  const requests: unknown[] = [];
  let observationCalls = 0;
  const body = {
    observe: async () => {
      observationCalls += 1;
      if (observeBody === undefined)
        throw new Error("observation fixture unavailable");
      return observeBody();
    },
  } as unknown as PlayerBody;
  const client = scriptedClient(responses, requests);
  const agent = new PlayerPurposeAgent({
    client,
    apiKey: "test-only",
    model: "test-model",
    body,
    skills,
    mind,
    memory,
    ownerPlayerId: "owner-player",
    logger: pino({ level: "silent" }),
    onRoundActivity: (activity) => mind.recordAgentActivity(activity),
    onCommitted,
  });
  return {
    agent,
    databasePath,
    mind,
    get observationCalls() {
      return observationCalls;
    },
    requests,
    close: () => {
      skills.close();
      mind.close();
    },
  };
}

function bodyObservationFixture(): PlayerBodyObservation {
  return {
    observedAt: "2026-09-25T00:00:00.000Z",
    source: "minecraft",
    gameVersion: "1.21.11",
    dimension: "overworld",
    time: { day: 1, timeOfDay: 0, isDay: true, raining: false },
    self: {
      username: "fixture-player",
      position: { x: 0, y: 64, z: 0, dimension: "overworld" },
      eyeHeight: 1.62,
      yaw: 0,
      pitch: 0,
      velocity: { x: 0, y: 0, z: 0 },
      health: 20,
      food: 20,
      foodSaturation: 5,
      oxygen: 20,
      inWater: false,
      inLava: false,
      onFire: false,
      suffocating: false,
      sleeping: false,
      mountedEntityId: null,
      gameMode: "survival",
      experience: { level: 0, points: 0, progress: 0 },
      inventory: [],
      equipment: {},
    },
    perception: {
      horizontalFieldOfViewDegrees: 90,
      verticalFieldOfViewDegrees: 60,
      maxDistance: 12,
      coverage: "visible_subset",
      blockCountLimit: 64,
      entityCountLimit: 16,
      blockCandidateLimit: 128,
      entityCandidateLimit: 32,
      omittedBlockCandidates: 0,
      omittedEntityCandidates: 0,
      candidateSearchMayBeTruncated: false,
      blocks: [],
      placementCandidateLimit: 24,
      omittedPlacementCandidates: 0,
      placementCandidatesMayBeTruncated: false,
      placementCandidates: [],
      entities: [],
    },
    window: null,
  };
}

function createMemoryPort(): PlayerMemoryPort {
  return {
    context: () => ({
      persona: "",
      ownerUsername: "owner",
      relationship: {},
      lifeState: {},
      recalled: [],
    }),
    recall: () => [],
    persistGoals: () => undefined,
    recordEpisode: () => undefined,
  };
}

interface ConversationFixture {
  readonly conversation: PlayerConversationAgent;
  readonly databasePath: string;
  readonly messages: string[];
  readonly mind: PlayerMindStore;
  readonly requests: unknown[];
  readonly responses: ScriptedResponse[];
  close(): void;
}

function openConversationFixture(): ConversationFixture {
  const directory = mkdtempSync(join(tmpdir(), "player-conversation-facts-"));
  temporaryDirectories.push(directory);
  const databasePath = join(directory, "player.sqlite");
  const mind = PlayerMindStore.open(databasePath);
  const requests: unknown[] = [];
  const responses: ScriptedResponse[] = [];
  const messages: string[] = [];
  const conversation = new PlayerConversationAgent({
    client: scriptedClient(responses, requests),
    apiKey: "test-only",
    model: "test-model",
    ownerUsername: "owner",
    mind,
    memory: createMemoryPort(),
    logger: pino({ level: "silent" }),
    say: async (text) => {
      messages.push(text);
    },
    onProposal: () => undefined,
    onStop: async () => undefined,
    onResume: () => undefined,
  });
  return {
    conversation,
    databasePath,
    messages,
    mind,
    requests,
    responses,
    close: () => mind.close(),
  };
}

function scriptedClient(
  responses: ScriptedResponse[],
  requests: unknown[],
): PlayerResponsesClient {
  return {
    responses: {
      create: async (request: unknown) => {
        const index = requests.push(request) - 1;
        const response = responses.shift();
        if (response === undefined)
          throw new Error("TEST_RESPONSE_QUEUE_EMPTY");
        return typeof response === "function"
          ? response(request, index)
          : response;
      },
    },
  } as unknown as PlayerResponsesClient;
}

function functionCallResponse(
  callId: string,
  name: string,
  argumentsValue: unknown,
): Response {
  return {
    status: "completed",
    output: [
      {
        type: "function_call",
        call_id: callId,
        name,
        arguments: JSON.stringify(argumentsValue),
      },
    ],
    output_text: "",
    usage: { input_tokens: 1, output_tokens: 1 },
  } as unknown as Response;
}

function terminalResponse(outputText: string): Response {
  return {
    status: "completed",
    output: [],
    output_text: outputText,
    usage: { input_tokens: 1, output_tokens: 1 },
  } as unknown as Response;
}

function actionArguments(
  stateUpdates?: Record<string, unknown>,
): Record<string, unknown> {
  return {
    kind: "act",
    purpose: "Look at a nearby landmark.",
    operationJson: JSON.stringify({
      kind: "look",
      target: { x: 1, y: 64, z: 1 },
    }),
    expectedOutcome: "The view points toward the landmark.",
    skillId: "",
    skillVersion: 0,
    reason: "A visible landmark can help orient the next decision.",
    wakeOn: [],
    wakeAt: "",
    ...(stateUpdates === undefined ? {} : { stateUpdates }),
  };
}

function emptyGoalStateArguments(): Record<string, unknown> {
  return {
    proposalId: "",
    proposalDisposition: "none",
    resolution: "",
    goalId: "",
    goalTitle: "",
    goalStatus: "none",
    goalPriority: 1,
    changeReason: "",
    goalSource: "none",
  };
}
