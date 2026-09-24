import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import pino from "pino";
import { afterEach, describe, expect, it } from "vitest";
import type { Response } from "openai/resources/responses/responses.js";

import { McSkillRepository } from "../../src/mc-skills/index.js";
import { playerOperationNames } from "../../src/minecraft/player-body-schema.js";
import type {
  PlayerBody,
  PlayerBodyObservation,
} from "../../src/minecraft/player-body.js";
import type {
  OwnerProposal,
  PlayerGoal,
  PlayerMemoryPort,
  PlayerRuntimeSnapshot,
} from "../../src/player/contracts.js";
import {
  compactSnapshot,
  PlayerPurposeAgent,
} from "../../src/player/agents.js";
import { PlayerMindStore } from "../../src/player/mind-store.js";
import {
  projectSafePlayerAgentActivityTail,
  type PlayerResponsesClient,
} from "../../src/player/responses.js";

const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0))
    rmSync(directory, { recursive: true, force: true });
});

describe("player owner intent context", () => {
  it("keeps a compromised owner intent after a self subgoal completes", async () => {
    const persistedGoalSnapshots: (readonly PlayerGoal[])[] = [];
    const memory = createMemoryPort();
    memory.persistGoals = (goals) => persistedGoalSnapshots.push(goals);
    const fixture = openPurposeFixture(memory);
    const proposal = fixture.mind.addProposal({
      title: "Retrieve the requested item",
      reason: "Please find the item and bring it back.",
      priority: 4,
    });

    try {
      fixture.responses.push(
        functionCallResponse(
          "resolve-proposal",
          "commit_goal_state",
          proposalResolutionArguments(proposal, "compromised"),
        ),
        functionCallResponse(
          "start-subgoal",
          "commit_action_decision",
          actionArguments(
            goalArguments({
              title: "Inspect the visible area",
              status: "active",
              source: "self",
              reason: "Check what can be seen before choosing how to search.",
            }),
          ),
        ),
      );
      const started = await fixture.agent.think({
        snapshot: fixture.mind.snapshot(),
        events: [],
      });
      expect(started.accepted).toBe(true);

      let afterStart = fixture.mind.snapshot();
      const ownerGoal = afterStart.goals.find(
        ({ ownerProposalId }) => ownerProposalId === proposal.id,
      );
      const selfGoal = afterStart.goals.find(
        ({ title }) => title === "Inspect the visible area",
      );
      if (selfGoal === undefined)
        throw new Error("TEST_SELF_SUBGOAL_NOT_CREATED");
      expect(ownerGoal).toEqual(
        expect.objectContaining({
          title: proposal.title,
          source: "owner",
          status: "active",
          ownerProposalId: proposal.id,
        }),
      );
      expect(selfGoal.status).toBe("active");
      expect(afterStart.proposals).toContainEqual(
        expect.objectContaining({
          id: proposal.id,
          status: "compromised",
          resolution:
            "I will first inspect the area, then choose a way to proceed.",
        }),
      );
      expect(persistedGoalSnapshots[0]).toContainEqual(
        expect.objectContaining({
          ownerProposalId: proposal.id,
          status: "active",
        }),
      );
      for (let index = 0; index < 12; index += 1) {
        const saved = fixture.mind.commitGoalState({
          expectedRevision: afterStart.revision,
          goal: {
            title: `Newer self goal ${index}`,
            status: "active",
            priority: 1,
            changeReason: "A newer independent purpose was considered.",
            source: "self",
          },
        });
        expect(saved.accepted).toBe(true);
        afterStart = saved.snapshot;
      }
      expect(afterStart.goals.slice(-12)).not.toContainEqual(
        expect.objectContaining({ ownerProposalId: proposal.id }),
      );

      fixture.responses.push(
        functionCallResponse(
          "complete-subgoal",
          "commit_action_decision",
          actionArguments(
            goalArguments({
              id: selfGoal.id,
              title: "Inspect the visible area",
              status: "completed",
              source: "self",
              reason: "The visible area has been inspected.",
            }),
            "wait",
          ),
        ),
      );
      const completed = await fixture.agent.think({
        snapshot: afterStart,
        events: [],
      });
      expect(completed.accepted).toBe(true);
      const afterCompletion = fixture.mind.snapshot();
      expect(
        afterCompletion.goals.find(
          ({ ownerProposalId }) => ownerProposalId === proposal.id,
        )?.status,
      ).toBe("active");
      expect(
        afterCompletion.goals.find(
          ({ title }) => title === "Inspect the visible area",
        )?.status,
      ).toBe("completed");

      fixture.responses.push(
        functionCallResponse(
          "follow-owner-intent",
          "commit_action_decision",
          actionArguments(undefined, "wait"),
        ),
      );
      const next = await fixture.agent.think({
        snapshot: afterCompletion,
        events: [],
      });
      expect(next.accepted).toBe(true);
      const nextRequest = record(fixture.requests[3]);
      expect(String(nextRequest.instructions)).toContain(
        "途中のself goalを完了してもowner intentは完了しません",
      );
      if (!Array.isArray(nextRequest.input))
        throw new Error("TEST_EXPECTED_RESPONSES_INPUT_ITEMS");
      const inputItems = nextRequest.input;
      const userItem = record(inputItems[0]);
      const purposeInput = JSON.parse(String(userItem.content)) as {
        runtime: {
          goals: readonly PlayerGoal[];
          proposals: readonly OwnerProposal[];
        };
      };
      expect(purposeInput.runtime.goals).toContainEqual(
        expect.objectContaining({
          ownerProposalId: proposal.id,
          title: proposal.title,
          source: "owner",
          status: "active",
        }),
      );
      expect(purposeInput.runtime.proposals).toContainEqual(
        expect.objectContaining({
          id: proposal.id,
          title: proposal.title,
          reason: proposal.reason,
          status: "compromised",
          resolution:
            "I will first inspect the area, then choose a way to proceed.",
        }),
      );
    } finally {
      fixture.close();
    }
  });

  it("keeps a paused linked owner intent beyond the recent-goal window", () => {
    const fixture = openPurposeFixture(createMemoryPort());
    const proposal = fixture.mind.addProposal({
      title: "Retrieve the requested item",
      reason: "Please find the item and bring it back.",
      priority: 4,
    });

    try {
      let snapshot = resolveProposal(
        fixture.mind,
        fixture.mind.snapshot(),
        proposal,
        "compromised",
      );
      const linkedGoal = snapshot.goals.find(
        ({ ownerProposalId }) => ownerProposalId === proposal.id,
      );
      if (linkedGoal === undefined)
        throw new Error("TEST_LINKED_OWNER_GOAL_NOT_CREATED");

      const paused = fixture.mind.commitGoalState({
        expectedRevision: snapshot.revision,
        goal: {
          id: linkedGoal.id,
          title: linkedGoal.title,
          status: "paused",
          priority: linkedGoal.priority,
          changeReason: "Pause while considering another approach.",
          source: "owner",
        },
      });
      expect(paused.accepted).toBe(true);
      snapshot = paused.snapshot;

      for (let index = 0; index < 13; index += 1) {
        const added = fixture.mind.commitGoalState({
          expectedRevision: snapshot.revision,
          goal: {
            title: `Newer self goal ${index}`,
            status: "active",
            priority: 1,
            changeReason: "A newer independent purpose was considered.",
            source: "self",
          },
        });
        expect(added.accepted).toBe(true);
        snapshot = added.snapshot;
      }

      expect(snapshot.goals.slice(-12)).not.toContainEqual(
        expect.objectContaining({ ownerProposalId: proposal.id }),
      );
      const compacted = record(compactSnapshot(snapshot));
      expect(compacted.goals).toContainEqual(
        expect.objectContaining({
          ownerProposalId: proposal.id,
          title: proposal.title,
          source: "owner",
          status: "paused",
        }),
      );
      expect(compacted.proposals).toContainEqual(
        expect.objectContaining({
          id: proposal.id,
          title: proposal.title,
          reason: proposal.reason,
          status: "compromised",
          resolution:
            "Resolve the owner intent based on the current situation.",
        }),
      );

      expect(
        fixture.mind
          .snapshot()
          .goals.find(({ ownerProposalId }) => ownerProposalId === proposal.id)
          ?.status,
      ).toBe("paused");
    } finally {
      fixture.close();
    }
  });

  it("allows owner-position observation only for pending or active linked intents", async () => {
    const ownerPositionExceptions: boolean[] = [];
    const fixture = openPurposeFixture(
      createMemoryPort(),
      ownerPositionExceptions,
    );
    const pending = fixture.mind.addProposal({
      title: "Pending owner request",
      reason: "The owner asked for help.",
      priority: 3,
    });
    const adopted = fixture.mind.addProposal({
      title: "Adopted owner request",
      reason: "The owner asked for help.",
      priority: 3,
    });
    const compromised = fixture.mind.addProposal({
      title: "Compromised owner request",
      reason: "The owner asked for help.",
      priority: 3,
    });
    const declined = fixture.mind.addProposal({
      title: "Declined owner request",
      reason: "The owner asked for help.",
      priority: 3,
    });
    const completed = fixture.mind.addProposal({
      title: "Completed owner request",
      reason: "The owner asked for help.",
      priority: 3,
    });
    let snapshot: PlayerRuntimeSnapshot = fixture.mind.snapshot();

    try {
      snapshot = resolveProposal(fixture.mind, snapshot, adopted, "adopted");
      snapshot = resolveProposal(
        fixture.mind,
        snapshot,
        compromised,
        "compromised",
      );
      snapshot = resolveProposal(fixture.mind, snapshot, declined, "declined");
      snapshot = resolveProposal(fixture.mind, snapshot, completed, "adopted");
      const completedGoal = snapshot.goals.find(
        ({ ownerProposalId }) => ownerProposalId === completed.id,
      );
      if (completedGoal === undefined)
        throw new Error("TEST_LINKED_GOAL_NOT_CREATED");
      const markedComplete = fixture.mind.commitGoalState({
        expectedRevision: snapshot.revision,
        goal: {
          id: completedGoal.id,
          title: completedGoal.title,
          status: "completed",
          priority: completedGoal.priority,
          changeReason: "The owner intent was explicitly completed.",
          source: "owner",
        },
      });
      expect(markedComplete.accepted).toBe(true);
      snapshot = markedComplete.snapshot;

      const allowedAndRejected = [
        pending,
        adopted,
        compromised,
        declined,
        completed,
      ];
      for (let index = 0; index < allowedAndRejected.length; index += 1) {
        const proposal = allowedAndRejected[index];
        if (proposal === undefined) continue;
        fixture.responses.push(
          functionCallResponse(`locate-${index}`, "locate_owner", {
            proposalId: proposal.id,
            purpose: "Check whether approaching the owner fits this intent.",
          }),
          functionCallResponse(
            `wait-${index}`,
            "commit_action_decision",
            actionArguments(undefined, "wait"),
          ),
        );
        const result = await fixture.agent.think({ snapshot, events: [] });
        expect(result.accepted).toBe(true);
        snapshot = fixture.mind.snapshot();
      }
      expect(ownerPositionExceptions).toEqual([true, true, true]);
    } finally {
      fixture.close();
    }
  });

  it("keeps GOAL_CAPACITY as a fixed safe tool-result code", () => {
    const projected = projectSafePlayerAgentActivityTail([
      {
        runSequence: 1,
        role: "purpose",
        round: 2,
        responseStatus: "completed",
        processingStatus: "complete",
        inputTokens: 40,
        outputTokens: 4,
        latencyMs: 12,
        requestInputChars: 800,
        initialInputChars: 400,
        instructionsChars: 300,
        toolSchemaChars: 100,
        initialObservationChars: 0,
        responseOutputChars: 200,
        functionCallCount: 1,
        compactionItemPresent: false,
        toolCalls: [
          {
            name: "commit_goal_state",
            resultClass: "rejected",
            resultCode: "GOAL_CAPACITY",
            outputChars: 80,
            privateText: "must not be retained",
          },
        ],
      },
    ]);
    expect(projected[0]?.toolCalls[0]?.resultCode).toBe("GOAL_CAPACITY");
    expect(JSON.stringify(projected)).not.toContain("must not be retained");
  });
});

type ScriptedResponse = Response | (() => Response);

interface PurposeFixture {
  readonly agent: PlayerPurposeAgent;
  readonly mind: PlayerMindStore;
  readonly requests: unknown[];
  readonly responses: ScriptedResponse[];
  close(): void;
}

function openPurposeFixture(
  memory: PlayerMemoryPort,
  ownerPositionExceptions: boolean[] = [],
): PurposeFixture {
  const directory = mkdtempSync(join(tmpdir(), "player-owner-intent-"));
  temporaryDirectories.push(directory);
  const databasePath = join(directory, "player.sqlite");
  const mind = PlayerMindStore.open(databasePath);
  const skills = McSkillRepository.open({
    databasePath,
    exchangeDirectory: join(directory, "skills"),
    allowedOperationNames: playerOperationNames,
  });
  const requests: unknown[] = [];
  const responses: ScriptedResponse[] = [];
  const body = {
    observe: async (options?: { ownerPositionException?: boolean }) => {
      if (options?.ownerPositionException === true)
        ownerPositionExceptions.push(true);
      return {} as PlayerBodyObservation;
    },
  } as unknown as PlayerBody;
  const agent = new PlayerPurposeAgent({
    client: scriptedClient(responses, requests),
    apiKey: "test-only",
    model: "test-model",
    body,
    skills,
    mind,
    memory,
    ownerPlayerId: "test-owner",
    logger: pino({ level: "silent" }),
    onRoundActivity: (activity) => mind.recordAgentActivity(activity),
    onCommitted: () => undefined,
  });
  return {
    agent,
    mind,
    requests,
    responses,
    close: () => {
      skills.close();
      mind.close();
    },
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

function scriptedClient(
  responses: ScriptedResponse[],
  requests: unknown[],
): PlayerResponsesClient {
  return {
    responses: {
      create: async (request: unknown) => {
        requests.push(request);
        const response = responses.shift();
        if (response === undefined)
          throw new Error("TEST_RESPONSE_QUEUE_EMPTY");
        return typeof response === "function" ? response() : response;
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

function proposalResolutionArguments(
  proposal: OwnerProposal,
  disposition: "adopted" | "compromised" | "declined",
): Record<string, unknown> {
  return {
    proposalId: proposal.id,
    proposalDisposition: disposition,
    resolution: "I will first inspect the area, then choose a way to proceed.",
    goalId: "",
    goalTitle: "",
    goalStatus: "none",
    goalPriority: proposal.priorityPreference,
    changeReason: "",
    goalSource: "none",
  };
}

function goalArguments(input: {
  readonly id?: string;
  readonly title: string;
  readonly status: PlayerGoal["status"];
  readonly source: PlayerGoal["source"];
  readonly reason: string;
}): Record<string, unknown> {
  return {
    proposalId: "",
    proposalDisposition: "none",
    resolution: "",
    goalId: input.id ?? "",
    goalTitle: input.title,
    goalStatus: input.status,
    goalPriority: 2,
    changeReason: input.reason,
    goalSource: input.source,
  };
}

function actionArguments(
  goalState: Record<string, unknown> | undefined,
  kind: "act" | "wait" = "act",
): Record<string, unknown> {
  const args: Record<string, unknown> = {
    kind,
    purpose: "Keep considering the owner intent.",
    operationJson:
      kind === "act"
        ? JSON.stringify({
            kind: "look",
            target: { x: 1, y: 64, z: 1 },
          })
        : "",
    expectedOutcome: "The current view informs the next choice.",
    skillId: "",
    skillVersion: 0,
    reason: "Wait until a meaningful update is available.",
    wakeOn: kind === "wait" ? ["state_changed"] : [],
    wakeAt: "",
    stateUpdates:
      goalState === undefined ? null : { goalState, understanding: null },
  };
  return args;
}

function resolveProposal(
  mind: PlayerMindStore,
  snapshot: PlayerRuntimeSnapshot,
  proposal: OwnerProposal,
  disposition: "adopted" | "compromised" | "declined",
): PlayerRuntimeSnapshot {
  const result = mind.commitGoalState({
    expectedRevision: snapshot.revision,
    proposalResolution: {
      proposalId: proposal.id,
      disposition,
      resolution: "Resolve the owner intent based on the current situation.",
    },
  });
  if (!result.accepted) throw new Error("TEST_PROPOSAL_RESOLUTION_REJECTED");
  return result.snapshot;
}

function record(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value))
    throw new Error("TEST_EXPECTED_OBJECT");
  return value as Record<string, unknown>;
}
