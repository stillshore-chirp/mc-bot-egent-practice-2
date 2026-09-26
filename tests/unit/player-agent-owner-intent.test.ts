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
  PlayerConversationAgent,
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
  it("carries bounded owner chat context into a short follow-up proposal", async () => {
    const fixture = openPurposeFixture(createMemoryPort());
    const memory = createMemoryPort();
    const messages: string[] = [];
    let proposalWakeups = 0;
    const conversation = new PlayerConversationAgent({
      client: scriptedClient(fixture.responses, fixture.requests),
      apiKey: "test-only",
      model: "test-model",
      ownerUsername: "owner",
      mind: fixture.mind,
      memory,
      logger: pino({ level: "silent" }),
      say: async (message) => {
        messages.push(message);
      },
      onProposal: () => {
        proposalWakeups += 1;
      },
      onStop: async () => undefined,
      onResume: () => undefined,
    });
    const priorFoodMessage = "I have cooked pork chops in my inventory.";
    const followUp = "Eat one now, please.";
    fixture.responses.push(terminalResponse("I can check what is available."));

    try {
      await conversation.handleOwnerMessage({
        username: "owner",
        message: priorFoodMessage,
        turn: conversation.nextTurn(),
      });

      fixture.responses.push(
        functionCallResponse("meal-proposal", "propose_goal_change", {
          title: "Eat one of the foods the owner mentioned",
          reason:
            "The owner is now asking me to eat one of the foods from the recent conversation.",
          priority: 3,
        }),
        terminalResponse("I will consider that alongside my current state."),
      );
      await conversation.handleOwnerMessage({
        username: "owner",
        message: followUp,
        turn: conversation.nextTurn(),
      });

      const secondRequest = record(fixture.requests[1]);
      expect(JSON.stringify(secondRequest.input)).toContain(priorFoodMessage);
      expect(JSON.stringify(secondRequest.input)).toContain(followUp);
      expect(JSON.stringify(secondRequest.input)).toContain(
        "I can check what is available.",
      );
      expect(String(secondRequest.instructions)).toContain(
        "直近4件までのowner会話",
      );
      expect(String(secondRequest.instructions)).toContain(
        "質問、否定、引用、他者を対象にした発話",
      );
      expect(proposalWakeups).toBe(1);
      expect(fixture.mind.snapshot().proposals).toContainEqual(
        expect.objectContaining({
          title: "Eat one of the foods the owner mentioned",
          status: "pending",
        }),
      );
      expect(fixture.mind.snapshot().stateFacts).toHaveLength(0);
      expect(messages).toHaveLength(2);
    } finally {
      fixture.close();
    }
  });

  it("grounds a meal refusal in the fresh food observation without guessing", async () => {
    const fixture = openPurposeFixture(createMemoryPort());
    const proposal = fixture.mind.addProposal({
      title: "Eat something now",
      reason: "The owner asked the bot to eat.",
      priority: 4,
    });

    try {
      fixture.responses.push(
        functionCallResponse(
          "decline-meal",
          "commit_action_decision",
          actionArguments(
            proposalResolutionArguments(proposal, "declined"),
            "wait",
          ),
        ),
      );
      const result = await fixture.agent.think({
        snapshot: fixture.mind.snapshot(),
        events: [
          {
            id: "owner-meal-proposal",
            kind: "owner_proposal",
            summary: "The owner asked the bot to eat.",
            createdAt: "2026-09-27T00:00:00.000Z",
          },
        ],
      });

      expect(result).toMatchObject({
        accepted: true,
        decision: { kind: "wait" },
      });
      const request = record(fixture.requests[0]);
      if (!Array.isArray(request.input))
        throw new Error("TEST_EXPECTED_RESPONSES_INPUT_ITEMS");
      const firstItem = record(request.input[0]);
      const purposeInput = JSON.parse(String(firstItem.content)) as {
        observation: {
          self: {
            food: number | null;
            foodSaturation: number | null;
            inventory: readonly unknown[];
          };
        };
      };
      expect(purposeInput.observation.self).toMatchObject({
        food: 20,
        foodSaturation: 5,
        inventory: [],
      });
      expect(String(request.instructions)).toContain(
        "self.foodSaturation、self.inventory",
      );
      expect(String(request.instructions)).toContain(
        "満腹や食料なしと断定せず",
      );
      expect(fixture.mind.snapshot().proposals).toContainEqual(
        expect.objectContaining({
          id: proposal.id,
          status: "declined",
        }),
      );
    } finally {
      fixture.close();
    }
  });

  it("does not turn guest chat or a prior request into current owner authorization", async () => {
    const fixture = openPurposeFixture(createMemoryPort());
    const conversation = new PlayerConversationAgent({
      client: scriptedClient(fixture.responses, fixture.requests),
      apiKey: "test-only",
      model: "test-model",
      ownerUsername: "owner",
      mind: fixture.mind,
      memory: createMemoryPort(),
      logger: pino({ level: "silent" }),
      say: async () => undefined,
      onProposal: () => undefined,
      onStop: async () => undefined,
      onResume: () => undefined,
    });
    fixture.responses.push(
      terminalResponse("I understand that you have bread."),
      terminalResponse("That sounds like a question about your guest."),
      terminalResponse("I will wait until you ask me to do something."),
      terminalResponse("I will not act on the earlier request by itself."),
    );

    try {
      await conversation.handleOwnerMessage({
        username: "owner",
        message: "I have bread in my inventory.",
        turn: conversation.nextTurn(),
      });
      await conversation.handleOwnerMessage({
        username: "guest",
        message: "Please eat the bread.",
        turn: conversation.nextTurn(),
      });
      await conversation.handleOwnerMessage({
        username: "owner",
        message: "Should my guest eat it?",
        turn: conversation.nextTurn(),
      });
      await conversation.handleOwnerMessage({
        username: "owner",
        message: "Do not eat it yet.",
        turn: conversation.nextTurn(),
      });

      expect(fixture.requests).toHaveLength(3);
      const lastRequest = record(fixture.requests[2]);
      expect(JSON.stringify(lastRequest.input)).toContain(
        "I have bread in my inventory.",
      );
      expect(JSON.stringify(lastRequest.input)).toContain("Do not eat it yet.");
      expect(JSON.stringify(lastRequest.input)).not.toContain(
        "Please eat the bread.",
      );
      expect(JSON.stringify(lastRequest.tools)).toContain(
        "propose_goal_change",
      );
      expect(fixture.mind.snapshot().proposals).toHaveLength(0);

      fixture.mind.stop();
      fixture.responses.push(terminalResponse("Autonomy is still stopped."));
      await conversation.handleOwnerMessage({
        username: "owner",
        message: "Is autonomy still stopped?",
        turn: conversation.nextTurn(),
      });
      const afterStopRequest = record(fixture.requests[3]);
      expect(JSON.stringify(afterStopRequest.input)).not.toContain(
        "I have bread in my inventory.",
      );
      expect(fixture.mind.snapshot().stopped).toBe(true);
    } finally {
      fixture.close();
    }
  });

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
      const observation = bodyObservationFixture();
      if (options?.ownerPositionException === true) {
        ownerPositionExceptions.push(true);
        return {
          ...observation,
          perception: {
            ...observation.perception,
            ownerPositionException: {
              username: "owner",
              position: { x: 0, y: 64, z: 1, dimension: "overworld" },
              source: "owner_position_exception",
              currentlyVisible: false,
            },
          },
        };
      }
      return observation;
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

function bodyObservationFixture(): PlayerBodyObservation {
  return {
    observedAt: "2026-09-27T00:00:00.000Z",
    source: "minecraft",
    gameVersion: "test",
    dimension: "overworld",
    time: { day: 1, timeOfDay: 5_000, isDay: true, raining: false },
    self: {
      username: "bot",
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

function terminalResponse(outputText: string): Response {
  return {
    status: "completed",
    output: [],
    output_text: outputText,
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
