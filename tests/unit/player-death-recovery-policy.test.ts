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
  PlayerOperation,
} from "../../src/minecraft/player-body.js";
import type {
  PlayerMemoryPort,
  PlayerObservationEvidence,
} from "../../src/player/contracts.js";
import { PlayerPurposeAgent } from "../../src/player/agents.js";
import { PlayerMindStore } from "../../src/player/mind-store.js";
import { toObservationEvidence } from "../../src/player/observation-evidence.js";
import type { PlayerResponsesClient } from "../../src/player/responses.js";

const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0))
    rmSync(directory, { recursive: true, force: true });
});

describe("death recovery judgment policy", () => {
  it("commits a recovery action without a second validation observation", async () => {
    const deathAt = "2026-09-25T00:00:05.000Z";
    const anchor = { x: 10, y: 64, z: 0 };
    let observationCount = 0;
    const fixture = openPurposeFixture(
      [
        functionCallResponse(
          "death-recovery-action",
          "commit_action_decision",
          deathRecoveryActionArguments(deathAt, "approach", {
            kind: "move_to",
            position: anchor,
            range: 1,
          }),
        ),
      ],
      () => {
        observationCount += 1;
        return Promise.resolve(
          bodyObservationFixture("2026-09-25T00:00:20.000Z"),
        );
      },
    );

    try {
      recordDeathScenario(
        fixture.mind,
        toObservationEvidence(
          bodyObservationFixture("2026-09-25T00:00:00.000Z"),
        ),
        deathAt,
        toObservationEvidence(
          bodyObservationFixture("2026-09-25T00:00:08.000Z"),
        ),
      );
      const result = await fixture.agent.think({
        snapshot: fixture.mind.snapshot(),
        events: [],
      });
      expect(result.accepted).toBe(true);
      expect(result.decision?.kind).toBe("act");
      expect(observationCount).toBe(1);
      expect(fixture.requests).toHaveLength(1);
      expect(fixture.mind.snapshot().latestDeath?.recoveryStagesUsed).toContain(
        "approach",
      );
    } finally {
      fixture.close();
    }
  });

  it("allows ordinary movement to coordinates matching the last death observation", async () => {
    const deathAt = "2026-09-25T00:00:05.000Z";
    const anchor = { x: 10, y: 64, z: 0 };
    const operation: PlayerOperation = {
      kind: "move_to",
      position: anchor,
      range: 1,
    };
    const fixture = openPurposeFixture(
      [
        functionCallResponse("ordinary-home-move", "commit_action_decision", {
          ...actionArguments(),
          purpose: "Return to my established home.",
          operationJson: JSON.stringify(operation),
          expectedOutcome: "Reach the remembered home area.",
        }),
      ],
      async () => bodyObservationFixture("2026-09-25T00:00:20.000Z"),
    );

    try {
      recordDeathScenario(
        fixture.mind,
        toObservationEvidence(
          bodyObservationFixture("2026-09-25T00:00:00.000Z"),
        ),
        deathAt,
        toObservationEvidence(
          bodyObservationFixture("2026-09-25T00:00:08.000Z"),
        ),
      );
      const result = await fixture.agent.think({
        snapshot: fixture.mind.snapshot(),
        events: [],
      });

      expect(result.accepted).toBe(true);
      if (result.decision?.kind !== "act")
        throw new Error("TEST_ORDINARY_MOVE_NOT_COMMITTED");
      expect(result.decision.operation.kind).toBe("move_to");
      expect(
        fixture.mind.snapshot().latestDeath?.recoveryStagesUsed,
      ).toBeUndefined();
    } finally {
      fixture.close();
    }
  });

  it("allows approach and sweep when an unrelated item is visible", async () => {
    const deathAt = "2026-09-25T00:00:05.000Z";
    const anchor = { x: 10, y: 64, z: 0 };
    const scenarios: readonly {
      readonly stage: "approach" | "sweep";
      readonly operation: PlayerOperation;
    }[] = [
      {
        stage: "approach",
        operation: { kind: "move_to", position: anchor, range: 1 },
      },
      {
        stage: "sweep",
        operation: { kind: "look_sweep", pitchDegrees: -25 },
      },
    ];

    for (const { stage, operation } of scenarios) {
      let observationAt = Date.parse("2026-09-25T00:00:20.000Z");
      const fixture = openPurposeFixture(
        [
          functionCallResponse(
            `visible-item-${stage}`,
            "commit_action_decision",
            deathRecoveryActionArguments(deathAt, stage, operation),
          ),
        ],
        async () => {
          const observation = bodyObservationWithVisibleItem(
            new Date(observationAt).toISOString(),
          );
          observationAt += 1_000;
          return observation;
        },
      );

      try {
        recordDeathScenario(
          fixture.mind,
          toObservationEvidence(
            bodyObservationFixture("2026-09-25T00:00:00.000Z"),
          ),
          deathAt,
          toObservationEvidence(
            bodyObservationFixture("2026-09-25T00:00:08.000Z"),
          ),
        );
        const result = await fixture.agent.think({
          snapshot: fixture.mind.snapshot(),
          events: [],
        });

        expect(result.accepted).toBe(true);
        if (result.decision?.kind !== "act")
          throw new Error("TEST_RECOVERY_ACTION_NOT_COMMITTED");
        expect(result.decision.operation.kind).toBe(operation.kind);
        expect(
          fixture.mind.snapshot().latestDeath?.recoveryStagesUsed,
        ).toContain(stage);
      } finally {
        fixture.close();
      }
    }
  });

  it("treats danger as Purpose context and permits a same-stage redecision after a new outcome and observation", async () => {
    const deathAt = "2026-09-25T00:00:05.000Z";
    const anchor = { x: 10, y: 64, z: 0 };
    const operation: PlayerOperation = {
      kind: "move_to",
      position: anchor,
      range: 1,
    };
    const observationTimes = [
      "2026-09-25T00:00:20.000Z",
      "2026-09-25T00:00:30.000Z",
    ];
    let observationIndex = 0;
    const fixture = openPurposeFixture(
      [
        (request) => {
          expect(requestUserPayload(request).deathRecovery).toMatchObject({
            anchorStatus: "current_hazard_observed",
            approachUsed: false,
          });
          return functionCallResponse(
            "initial-recovery-approach",
            "commit_action_decision",
            deathRecoveryActionArguments(deathAt, "approach", operation),
          );
        },
        (request) => {
          const previousToolResult = lastToolResult(request);
          if (previousToolResult !== undefined)
            throw new Error(`INITIAL_RECOVERY_REJECTED:${previousToolResult}`);
          expect(requestUserPayload(request).deathRecovery).toMatchObject({
            anchorStatus: "ready",
            approachUsed: true,
          });
          return functionCallResponse(
            "reconsider-recovery-approach",
            "commit_action_decision",
            deathRecoveryActionArguments(deathAt, "approach", operation),
          );
        },
      ],
      async () => {
        const observedAt = observationTimes[observationIndex++];
        if (observedAt === undefined)
          throw new Error("TEST_OBSERVATION_SEQUENCE_EXHAUSTED");
        return bodyObservationFixture(observedAt, {
          hazard: observationIndex === 1,
        });
      },
    );

    try {
      recordDeathScenario(
        fixture.mind,
        toObservationEvidence(
          bodyObservationFixture("2026-09-25T00:00:00.000Z"),
        ),
        deathAt,
        toObservationEvidence(
          bodyObservationFixture("2026-09-25T00:00:08.000Z"),
        ),
      );

      const first = await fixture.agent.think({
        snapshot: fixture.mind.snapshot(),
        events: [],
      });
      expect(first.accepted).toBe(true);
      expect(first.decision?.kind).toBe("act");
      expect(fixture.mind.snapshot().latestDeath?.recoveryStagesUsed).toEqual([
        "approach",
      ]);

      const active = fixture.mind.snapshot().activeOperation;
      if (active?.expectedOutcome === undefined)
        throw new Error("TEST_ACTIVE_OPERATION_MISSING");
      fixture.mind.recordOutcome({
        evidence: {
          operationId: active.operationId,
          kind: active.kind,
          status: "unverified",
          summary: "Synthetic result needs another observation.",
          expectedOutcome: active.expectedOutcome,
          observedAt: "2026-09-25T00:00:25.000Z",
        },
      });

      const second = await fixture.agent.think({
        snapshot: fixture.mind.snapshot(),
        events: [],
      });
      expect(second.accepted).toBe(true);
      expect(second.decision?.kind).toBe("act");
      expect(fixture.requests).toHaveLength(2);
      expect(observationIndex).toBe(2);
    } finally {
      fixture.close();
    }
  });

  it("commits an action with a dimension-mismatched recovery context", async () => {
    const deathAt = "2026-09-25T00:00:05.000Z";
    const fixture = openPurposeFixture(
      [
        (request) => {
          expect(requestUserPayload(request).deathRecovery).toMatchObject({
            anchorStatus: "dimension_mismatch",
          });
          return functionCallResponse(
            "mismatched-recovery-approach",
            "commit_action_decision",
            deathRecoveryActionArguments(deathAt, "approach", {
              kind: "move_to",
              position: { x: 30, y: 64, z: 0 },
              range: 1,
            }),
          );
        },
      ],
      async () => {
        return bodyObservationFixture("2026-09-25T00:00:20.000Z", {
          dimension: "nether",
        });
      },
    );

    try {
      recordDeathScenario(
        fixture.mind,
        toObservationEvidence(
          bodyObservationFixture("2026-09-25T00:00:00.000Z"),
        ),
        deathAt,
      );
      const result = await fixture.agent.think({
        snapshot: fixture.mind.snapshot(),
        events: [],
      });

      expect(result.accepted).toBe(true);
      expect(result.decision?.kind).toBe("act");
      expect(fixture.requests).toHaveLength(1);
      expect(fixture.mind.snapshot().activeOperation?.kind).toBe("move_to");
    } finally {
      fixture.close();
    }
  });

  it("does not call Purpose while the persistent owner stop latch is set", async () => {
    const fixture = openPurposeFixture([], async () =>
      bodyObservationFixture("2026-09-25T00:00:20.000Z"),
    );
    try {
      fixture.mind.stop();
      const result = await fixture.agent.think({
        snapshot: fixture.mind.snapshot(),
        events: [],
      });

      expect(result.accepted).toBe(false);
      expect(fixture.requests).toHaveLength(0);
      expect(fixture.mind.snapshot().stopped).toBe(true);
    } finally {
      fixture.close();
    }
  });
});

interface PurposeFixture {
  readonly agent: PlayerPurposeAgent;
  readonly mind: PlayerMindStore;
  readonly requests: unknown[];
  close(): void;
}

type ScriptedResponse =
  Response | ((request: unknown, index: number) => Response);

function openPurposeFixture(
  responses: ScriptedResponse[],
  observeBody: () => Promise<PlayerBodyObservation>,
): PurposeFixture {
  const directory = mkdtempSync(join(tmpdir(), "player-death-recovery-"));
  temporaryDirectories.push(directory);
  const databasePath = join(directory, "player.sqlite");
  const mind = PlayerMindStore.open(databasePath);
  const skills = McSkillRepository.open({
    databasePath,
    exchangeDirectory: join(directory, "skills"),
    allowedOperationNames: playerOperationNames,
  });
  const requests: unknown[] = [];
  const body = { observe: observeBody } as unknown as PlayerBody;
  const client: PlayerResponsesClient = {
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
  const agent = new PlayerPurposeAgent({
    client,
    apiKey: "",
    model: "test-model",
    body,
    skills,
    mind,
    memory: createMemoryPort(),
    ownerPlayerId: "fixture-owner",
    logger: pino({ level: "silent" }),
    onRoundActivity: (activity) => mind.recordAgentActivity(activity),
    onCommitted: () => undefined,
  });
  return {
    agent,
    mind,
    requests,
    close: () => {
      skills.close();
      mind.close();
    },
  };
}

function recordDeathScenario(
  mind: PlayerMindStore,
  beforeObservation: PlayerObservationEvidence,
  deathAt: string,
  firstPostDeathObservation?: PlayerObservationEvidence,
): void {
  mind.recordObservation(beforeObservation);
  mind.recordDeathEvent(deathAt, "Synthetic death event.");
  if (firstPostDeathObservation !== undefined)
    mind.recordObservation(firstPostDeathObservation);
}

function bodyObservationFixture(
  observedAt: string,
  options: { readonly dimension?: string; readonly hazard?: boolean } = {},
): PlayerBodyObservation {
  const dimension = options.dimension ?? "overworld";
  return {
    observedAt,
    source: "minecraft",
    gameVersion: "1.21.11",
    dimension,
    time: { day: 1, timeOfDay: 0, isDay: true, raining: false },
    self: {
      username: "fixture-player",
      position: { x: 10, y: 64, z: 0, dimension },
      eyeHeight: 1.62,
      yaw: 0,
      pitch: 0,
      velocity: { x: 0, y: 0, z: 0 },
      health: 20,
      food: 20,
      foodSaturation: 5,
      oxygen: 20,
      inWater: false,
      inLava: options.hazard ?? false,
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

function bodyObservationWithVisibleItem(
  observedAt: string,
): PlayerBodyObservation {
  const observation = bodyObservationFixture(observedAt);
  return {
    ...observation,
    perception: {
      ...observation.perception,
      entities: [
        {
          id: 77,
          name: "item",
          kind: "item",
          category: null,
          position: observation.self.position,
          distance: 1,
          health: null,
          isPlayer: false,
        },
      ],
    },
  };
}

function createMemoryPort(): PlayerMemoryPort {
  return {
    context: () => ({
      persona: "",
      ownerUsername: "fixture-owner",
      relationship: {},
      lifeState: {},
      recalled: [],
    }),
    recall: () => [],
    persistGoals: () => undefined,
    recordEpisode: () => undefined,
  };
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

function actionArguments(): Record<string, unknown> {
  return {
    kind: "act",
    purpose: "Reconsider how to respond to the current state.",
    actionPlanId: "",
    actionPlanPurpose: "",
    actionPlanGoalId: "",
    continuationSteps: [],
    operationJson: JSON.stringify({
      kind: "look",
      target: { x: 11, y: 64, z: 1 },
    }),
    expectedOutcome: "A fresh view informs the next decision.",
    skillId: "",
    skillVersion: 0,
    reason: "The current observation may change the next step.",
    wakeOn: [],
    wakeAt: "",
  };
}

function deathRecoveryActionArguments(
  observedAt: string,
  stage: "approach" | "sweep" | "collect",
  operation: PlayerOperation,
): Record<string, unknown> {
  return {
    ...actionArguments(),
    purpose: "Reconsider whether the last observed area is relevant.",
    operationJson: JSON.stringify(operation),
    expectedOutcome: `[death-recovery:${observedAt}:${stage}] Observe the result of this recovery action.`,
    reason: "A new observation and the prior result inform this choice.",
    wakeOn: ["body_outcome"],
  };
}

function lastToolResult(request: unknown): string | undefined {
  const requestRecord = z.record(z.string(), z.unknown()).parse(request);
  const input = z.array(z.unknown()).parse(requestRecord.input);
  const toolOutput = input.find(
    (item) =>
      item !== null &&
      typeof item === "object" &&
      !Array.isArray(item) &&
      (item as Record<string, unknown>).type === "function_call_output",
  );
  if (
    toolOutput === undefined ||
    toolOutput === null ||
    typeof toolOutput !== "object" ||
    Array.isArray(toolOutput)
  )
    return undefined;
  const output = (toolOutput as Record<string, unknown>).output;
  return typeof output === "string" ? output : undefined;
}

function requestUserPayload(request: unknown): Record<string, unknown> {
  const requestRecord = z.record(z.string(), z.unknown()).parse(request);
  const messages = z
    .array(z.record(z.string(), z.unknown()))
    .parse(requestRecord.input);
  const userMessage = messages.find(
    (message) => message.role === "user" && typeof message.content === "string",
  );
  if (typeof userMessage?.content !== "string")
    throw new Error("TEST_USER_MESSAGE_MISSING");
  return z
    .record(z.string(), z.unknown())
    .parse(JSON.parse(userMessage.content));
}
