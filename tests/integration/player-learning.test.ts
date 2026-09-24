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
import {
  PlayerConversationAgent,
  PlayerPurposeAgent,
} from "../../src/player/agents.js";
import type { PlayerMemoryPort } from "../../src/player/contracts.js";
import { PlayerMindStore } from "../../src/player/mind-store.js";
import { PlayerRuntime } from "../../src/player/runtime.js";
import type { PlayerResponsesClient } from "../../src/player/responses.js";

const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe("player skill learning", () => {
  it("turns an owner chat proposal into a reasoned body operation", async () => {
    const directory = mkdtempSync(join(tmpdir(), "player-proposal-test-"));
    temporaryDirectories.push(directory);
    const databasePath = join(directory, "player.sqlite");
    const exchangeDirectory = join(directory, "exchange");
    const mind = PlayerMindStore.open(databasePath);
    const skills = McSkillRepository.open({
      databasePath,
      exchangeDirectory,
      allowedOperationNames: playerOperationNames,
    });
    const memory = createMemoryPort();
    const observationBody = observationOnlyBody();
    const executed: string[] = [];
    const body: PlayerBody = {
      ...observationBody,
      execute: async (operation, signal) => {
        executed.push(operation.kind);
        await new Promise((resolve) => setTimeout(resolve, 15));
        const before = await observationBody.observe();
        const after = await observationBody.observe();
        return {
          operationId: `observed-${executed.length}`,
          operation,
          status: signal?.aborted === true ? "interrupted" : "successful",
          startedAt: new Date().toISOString(),
          completedAt: new Date().toISOString(),
          before,
          after,
          recoveryRequired: false,
          detail:
            "The ordinary player action completed against the observed state.",
        };
      },
    };
    const runtimeRef: { current?: PlayerRuntime } = {};
    const conversation = new PlayerConversationAgent({
      client: scriptedClient([
        functionCallResponse("proposal-1", "propose_goal_change", {
          title: "Explore the nearby forest clearing",
          reason: "The area may have useful resources and paths to learn.",
          priority: 4,
        }),
        textResponse(
          "proposal-final",
          "I will weigh that against my current goals.",
        ),
      ]),
      apiKey: "test-only",
      model: "gpt-6-luna",
      ownerUsername: "owner",
      mind,
      memory,
      logger: pino({ level: "silent" }),
      say: async () => undefined,
      onProposal: () => runtimeRef.current?.onOwnerProposal(),
      onStop: async () => undefined,
      onResume: () => undefined,
    });
    const purpose = new PlayerPurposeAgent({
      client: scriptedClient([
        proposalResolutionResponse,
        functionCallResponse(
          "decision-1",
          "commit_action_decision",
          actionArguments(),
        ),
        textResponse(
          "decision-final",
          "The nearby route is a useful first step.",
        ),
        functionCallResponse(
          "outcome-wait-1",
          "commit_action_decision",
          waitArguments(),
        ),
        textResponse("outcome-wait-final", "I will wait for another change."),
      ]),
      apiKey: "test-only",
      model: "gpt-6-luna",
      body,
      skills,
      mind,
      memory,
      ownerPlayerId: "owner-player",
      logger: pino({ level: "silent" }),
      onCommitted: (snapshot, decision) =>
        runtimeRef.current?.handleCommittedDecision(snapshot, decision),
    });
    const runtime = new PlayerRuntime({
      ownerUsername: "owner",
      playerId: "owner-player",
      body,
      mind,
      memory,
      skills,
      conversation,
      purpose,
      logger: pino({ level: "silent" }),
      say: async () => undefined,
    });
    runtimeRef.current = runtime;

    try {
      runtime.receiveChat(
        "owner",
        "Could you explore the nearby forest clearing?",
      );
      await waitFor(() => executed.length === 1);
      await waitFor(() => mind.snapshot().lastOutcome !== undefined);

      const proposal = mind.snapshot().proposals[0];
      expect(proposal?.status).toBe("adopted");
      expect(proposal?.resolution).toContain("reassess");
      expect(executed).toEqual(["move_to"]);
      expect(
        mind
          .snapshot()
          .recentJudgments.some(
            ({ operationKind }) => operationKind === "move_to",
          ),
      ).toBe(true);
      expect(mind.snapshot().lastOutcome?.status).toBe("successful");
    } finally {
      await runtime.shutdown();
      skills.close();
      mind.close();
    }
  });

  it("creates a durable hypothesis from a trusted seed receipt without recounting the seed run", async () => {
    const directory = mkdtempSync(join(tmpdir(), "player-learning-test-"));
    temporaryDirectories.push(directory);
    const databasePath = join(directory, "player.sqlite");
    const exchangeDirectory = join(directory, "exchange");
    let mind = PlayerMindStore.open(databasePath);
    let skills = McSkillRepository.open({
      databasePath,
      exchangeDirectory,
      allowedOperationNames: playerOperationNames,
    });
    const seed = skills.search({ limit: 1 })[0];
    if (seed === undefined) throw new Error("seed skill is missing");
    const operationName = seed.operationRefs[0];
    if (operationName === undefined)
      throw new Error("seed operation reference is missing");
    const runId = "learning-run-observed-success";
    const seedStatisticsBefore = skills.get(seed.id).nativeStatistics;
    skills.recordTrustedEvidence({
      runId,
      operationName,
      inputSummary: `operation=${operationName}`,
      conditions: ["dimension:overworld", "time:day"],
      expectedOutcome: "reach the selected landmark",
      observedOutcome: "successful",
      observationSummary: "The game observation confirmed the expected change.",
      skillIdAtUse: seed.id,
      skillVersionAtUse: seed.version,
      observedAt: new Date().toISOString(),
    });

    const title = "Reach a landmark using an observed route";
    const responses = [
      functionCallResponse(
        "learn-1",
        "propose_skill_learning",
        learningArguments(runId, title, operationName),
      ),
      functionCallResponse(
        "learn-2",
        "commit_action_decision",
        waitArguments(),
      ),
      textResponse("learn-final", "Learning hypothesis recorded."),
      functionCallResponse(
        "retry-1",
        "propose_skill_learning",
        learningArguments(runId, title, operationName),
      ),
      functionCallResponse(
        "retry-2",
        "commit_action_decision",
        waitArguments(),
      ),
      textResponse("retry-final", "Existing hypothesis reused."),
    ];
    const client = {
      responses: {
        create: async () => {
          const response = responses.shift();
          if (response === undefined)
            throw new Error("test response queue is empty");
          return response;
        },
      },
    } as unknown as PlayerResponsesClient;
    const committed: string[] = [];
    const agent = new PlayerPurposeAgent({
      client,
      apiKey: "test-only",
      model: "gpt-6-luna",
      body: observationOnlyBody(),
      skills,
      mind,
      memory: createMemoryPort(),
      ownerPlayerId: "owner-player",
      logger: pino({ level: "silent" }),
      onCommitted: (_snapshot, decision) => committed.push(decision.kind),
    });

    const first = await agent.think({ snapshot: mind.snapshot(), events: [] });
    expect(first.accepted).toBe(true);
    const created = skills.search({ query: title, limit: 4 })[0];
    expect(created).toBeDefined();
    if (created === undefined) throw new Error("hypothesis was not created");
    expect(skills.listDerivedHypotheses(created.id)).toHaveLength(1);
    expect(skills.listDerivedHypotheses(created.id)[0]?.runId).toBe(runId);
    expect(
      skills.listDerivedHypotheses(created.id)[0]?.nativeOutcomeRecorded,
    ).toBe(false);
    expect(skills.get(seed.id).nativeStatistics).toEqual(seedStatisticsBefore);
    expect(mind.snapshot().learningReferences).toHaveLength(1);
    expect(mind.snapshot().counters.learningUpdates).toBe(1);

    const replay = await agent.think({ snapshot: mind.snapshot(), events: [] });
    expect(replay.accepted).toBe(true);
    expect(skills.search({ query: title, limit: 4 })).toHaveLength(1);
    expect(skills.listDerivedHypotheses(created.id)).toHaveLength(1);
    expect(mind.snapshot().learningReferences).toHaveLength(1);
    expect(mind.snapshot().counters.learningUpdates).toBe(1);
    expect(committed).toEqual(["wait", "wait"]);

    skills.close();
    mind.close();
    skills = McSkillRepository.open({
      databasePath,
      exchangeDirectory,
      allowedOperationNames: playerOperationNames,
    });
    mind = PlayerMindStore.open(databasePath);
    expect(skills.get(created.id).title).toBe(title);
    expect(skills.listDerivedHypotheses(created.id)[0]?.runId).toBe(runId);
    expect(skills.get(seed.id).nativeStatistics).toEqual(seedStatisticsBefore);
    expect(mind.snapshot().learningReferences).toHaveLength(1);
    expect(mind.snapshot().counters.learningUpdates).toBe(1);
    skills.close();
    mind.close();
  });
});

function learningArguments(
  runId: string,
  title: string,
  operationName: string,
): Record<string, unknown> {
  return {
    runId,
    mode: "create",
    skillId: "",
    expectedVersion: 0,
    category: "navigation",
    title,
    purpose: "reach a chosen landmark using the current visible route",
    conditions: ["A landmark is selected and a route is visible."],
    body: "Compare the visible route to the landmark, select a suitable path, and verify arrival from the next body observation.",
    operationRefs: [operationName],
    expectedOutcome: "The next observation confirms arrival at the landmark.",
    confidence: 0.65,
    changeKind: "revise",
    changeNote:
      "Created from one trusted observed success; the next use can validate it.",
  };
}

function waitArguments(): Record<string, unknown> {
  return {
    kind: "wait",
    purpose: "wait for the next meaningful world change",
    operationJson: "",
    expectedOutcome: "",
    skillId: "",
    skillVersion: 0,
    reason: "The learning proposal has been recorded; wait for a new event.",
    wakeOn: ["state_changed"],
    wakeAt: "",
  };
}

function actionArguments(): Record<string, unknown> {
  return {
    kind: "act",
    purpose: "Explore the visible route to the nearby clearing.",
    operationJson: JSON.stringify({
      kind: "move_to",
      position: { x: 8, y: 64, z: 3 },
      range: 1,
    }),
    expectedOutcome:
      "The next body observation shows progress toward the clearing.",
    skillId: "",
    skillVersion: 0,
    reason: "",
    wakeOn: ["body_outcome"],
    wakeAt: "",
  };
}

type ScriptedResponse = Response | ((request: unknown) => Response);

function scriptedClient(responses: ScriptedResponse[]): PlayerResponsesClient {
  return {
    responses: {
      create: async (request: unknown) => {
        const response = responses.shift();
        if (response === undefined)
          throw new Error("proposal test response queue is empty");
        return typeof response === "function" ? response(request) : response;
      },
    },
  } as unknown as PlayerResponsesClient;
}

function proposalResolutionResponse(request: unknown): Response {
  const requestRecord = recordOf(request);
  if (requestRecord === undefined)
    throw new Error("purpose request is not an object");
  const input = requestRecord.input;
  if (!Array.isArray(input))
    throw new Error("purpose input is not a message list");
  const userMessage: unknown = input.find((item: unknown) => {
    const message = recordOf(item);
    return message?.role === "user" && typeof message.content === "string";
  });
  const userMessageRecord = recordOf(userMessage);
  if (typeof userMessageRecord?.content !== "string")
    throw new Error("purpose user message was not supplied");
  const payload: unknown = JSON.parse(userMessageRecord.content);
  const payloadRecord = recordOf(payload);
  if (payloadRecord === undefined)
    throw new Error("purpose user payload is invalid");
  const proposals = payloadRecord.pendingProposals;
  if (!Array.isArray(proposals) || proposals.length === 0)
    throw new Error("pending owner proposal was not supplied");
  const proposal: unknown = proposals[0];
  const proposalId = recordOf(proposal)?.id;
  if (typeof proposalId !== "string")
    throw new Error("pending owner proposal has no id");
  return functionCallResponse("resolution-1", "commit_goal_state", {
    proposalId,
    proposalDisposition: "adopted",
    resolution: "Explore the nearby clearing first, then reassess.",
    goalId: "",
    goalTitle: "",
    goalStatus: "none",
    goalPriority: 3,
    changeReason: "",
    goalSource: "none",
  });
}

function recordOf(value: unknown): Record<string, unknown> | undefined {
  if (value === null || typeof value !== "object" || Array.isArray(value))
    return undefined;
  return value as Record<string, unknown>;
}

function functionCallResponse(
  id: string,
  name: string,
  argumentsValue: Record<string, unknown>,
): Response {
  return {
    id,
    status: "completed",
    output: [
      {
        type: "function_call",
        id: `${id}-item`,
        call_id: `${id}-call`,
        name,
        arguments: JSON.stringify(argumentsValue),
        status: "completed",
      },
    ],
    output_text: "",
    usage: { input_tokens: 80, output_tokens: 10, total_tokens: 90 },
  } as unknown as Response;
}

function textResponse(id: string, outputText: string): Response {
  return {
    id,
    status: "completed",
    output: [],
    output_text: outputText,
    usage: { input_tokens: 20, output_tokens: 5, total_tokens: 25 },
  } as unknown as Response;
}

function observationOnlyBody(): PlayerBody {
  const observe = async (): Promise<PlayerBodyObservation> => ({
    observedAt: new Date().toISOString(),
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
      horizontalFieldOfViewDegrees: 110,
      verticalFieldOfViewDegrees: 80,
      maxDistance: 16,
      coverage: "visible_subset",
      blockCountLimit: 96,
      entityCountLimit: 48,
      blockCandidateLimit: 192,
      entityCandidateLimit: 128,
      omittedBlockCandidates: 0,
      omittedEntityCandidates: 0,
      candidateSearchMayBeTruncated: false,
      blocks: [],
      entities: [],
    },
    window: null,
  });
  return {
    observe,
    execute: async () => {
      throw new Error("body execution is not part of this learning test");
    },
    stop: async () => undefined,
    knowledge: (query) => ({
      source: "minecraft_registry",
      gameVersion: "test",
      registryVersion: "test",
      observedAt: new Date().toISOString(),
      query,
      facts: [],
      inferences: [],
      truncated: false,
    }),
    onEvent: () => () => undefined,
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

async function waitFor(predicate: () => boolean): Promise<void> {
  const deadline = Date.now() + 2_000;
  while (!predicate()) {
    if (Date.now() >= deadline)
      throw new Error("condition was not reached before timeout");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}
