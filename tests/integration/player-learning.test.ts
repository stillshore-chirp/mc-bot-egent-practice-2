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
import { PlayerPurposeAgent } from "../../src/player/agents.js";
import type { PlayerMemoryPort } from "../../src/player/contracts.js";
import { PlayerMindStore } from "../../src/player/mind-store.js";
import type { PlayerResponsesClient } from "../../src/player/responses.js";

const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe("player skill learning", () => {
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

function observationOnlyBody(): PlayerBody {
  const observe = async (): Promise<PlayerBodyObservation> =>
    ({
      observedAt: new Date().toISOString(),
      dimension: "overworld",
      time: { day: 1, timeOfDay: 5_000, isDay: true, raining: false },
      self: {
        username: "bot",
        position: { x: 0, y: 64, z: 0, dimension: "overworld" },
        yaw: 0,
        pitch: 0,
        velocity: { x: 0, y: 0, z: 0 },
        health: 20,
        food: 20,
        saturation: 5,
        oxygen: 20,
        inWater: false,
        inLava: false,
        onFire: false,
        suffocating: false,
        sleeping: false,
        mountedEntityId: null,
        gameMode: "survival",
        inventory: [],
        equipment: {},
      },
      perception: {
        fov: { horizontalDegrees: 110, verticalDegrees: 80 },
        range: 16,
        blocks: [],
        entities: [],
        candidateSearchMayBeTruncated: false,
      },
      window: null,
    }) as unknown as PlayerBodyObservation;
  return {
    observe,
    execute: async () => {
      throw new Error("body execution is not part of this learning test");
    },
    stop: async () => undefined,
    knowledge: () => ({}) as never,
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
