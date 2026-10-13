import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it, vi } from "vitest";
import type { Response } from "openai/resources/responses/responses.js";

import {
  CompanionAgent,
  companionDecisionSchema,
  type CompanionDecisionInput,
  type CompanionResponsesClient,
} from "../../src/player/agent.js";
import type {
  CompanionOutcomeHistoryEntry,
  CompanionMemory,
  CompanionSnapshot,
} from "../../src/player/contracts.js";
import type {
  PlayerBodyObservation,
  PlayerHomePoi,
  PlayerHomePoiScan,
} from "../../src/minecraft/player-body.js";
import type { PersonaCore } from "../../src/persona/persona.js";
import { CompanionStore } from "../../src/player/store.js";

const persona: PersonaCore = {
  version: 1,
  name: "Mori",
  speakingStyle: "落ち着いた日本語で話す。",
  values: ["観測を大切にする"],
  operatingPrinciples: ["実際の結果を確かめる"],
  prohibitions: ["秘密を保存しない"],
};

const snapshot: CompanionSnapshot = {
  stopped: false,
  stopGeneration: 0,
  goal: null,
  plan: null,
  waitUntil: null,
  activeOperation: null,
  lastOutcome: null,
  replyLifecycle: [],
  relationshipSummary: "一緒に探索した経験を重ねている。",
  interests: ["森の探索"],
};

const observation: PlayerBodyObservation = {
  observedAt: "2026-10-10T00:00:00.000Z",
  source: "minecraft",
  gameVersion: "1.21.4",
  dimension: "overworld",
  time: { day: 1, timeOfDay: 6000, isDay: true, raining: false },
  self: {
    username: "Mori",
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
    verticalFieldOfViewDegrees: 70,
    maxDistance: 64,
    coverage: "visible_subset",
    blockCountLimit: 32,
    entityCountLimit: 20,
    blockCandidateLimit: 100,
    entityCandidateLimit: 100,
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

function createInput(): CompanionDecisionInput {
  const memories: CompanionMemory[] = [
    {
      id: "memory-1",
      kind: "preference",
      content: "Owner prefers oak signs.",
      source: "player_stated",
      status: "active",
      importance: 4,
      createdAt: "2026-10-01T00:00:00.000Z",
      updatedAt: "2026-10-09T00:00:00.000Z",
      metadata: {},
    },
  ];
  return {
    snapshot,
    observation,
    ownerMessage: "今度は白樺で作って。",
    wakeReason: "owner message",
    messages: [
      {
        sequence: 1,
        role: "owner",
        text: "前はオークが好き。",
        recordedAt: "2026-10-01T00:00:00.000Z",
      },
      {
        sequence: 2,
        role: "owner",
        text: "今度は白樺で作って。",
        recordedAt: "2026-10-10T00:00:00.000Z",
      },
    ],
    memories,
    recentOutcomes: [],
  };
}

function syntheticOutcome(index: number): CompanionOutcomeHistoryEntry {
  const observedAt = `2026-10-10T00:00:${String(index).padStart(2, "0")}.000Z`;
  const evidence = {
    source: "minecraft" as const,
    observedAt,
    dimension: "overworld",
    position: { x: index, y: 64, z: 0 },
    yaw: 0,
    pitch: 0,
    health: 20,
    food: 20,
    oxygen: 20,
    inWater: false,
    inLava: false,
    onFire: false,
    suffocating: false,
    sleeping: false,
  };
  return {
    operationId: `private-correlation-${index}`,
    operation: { kind: "look_sweep" },
    status: "successful",
    summary: `Synthetic Body result ${index}.`,
    expectedOutcome: "The visible area is checked.",
    observedAt,
    purpose: `Declared purpose ${index}.`,
    preActionObservation: evidence,
    bodyEvidence: {
      source: "body_result",
      startedAt: observedAt,
      completedAt: observedAt,
      sameLife: true,
      recoveryRequired: false,
      reasonCode: null,
      before: evidence,
      after: { ...evidence, inWater: true },
    },
    recordedAt: observedAt,
  };
}

function response(output: unknown, usage?: unknown): Response {
  return {
    status: "completed",
    output_text: JSON.stringify(output),
    usage,
  } as unknown as Response;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function assertStrictObjects(schema: unknown): void {
  if (Array.isArray(schema)) {
    for (const item of schema) assertStrictObjects(item);
    return;
  }
  if (!isRecord(schema)) return;
  if (schema.type === "object" && isRecord(schema.properties)) {
    expect(schema.additionalProperties).toBe(false);
    expect(Array.isArray(schema.required)).toBe(true);
    expect([...(schema.required as string[])].sort()).toEqual(
      Object.keys(schema.properties).sort(),
    );
  }
  for (const value of Object.values(schema)) assertStrictObjects(value);
}

function schemaContainsNullableOptional(schema: unknown): boolean {
  if (Array.isArray(schema)) return schema.some(schemaContainsNullableOptional);
  if (!isRecord(schema)) return false;
  if (
    schema.type === "null" ||
    (Array.isArray(schema.anyOf) &&
      schema.anyOf.some(schemaContainsNullableOptional))
  )
    return true;
  return Object.values(schema).some(schemaContainsNullableOptional);
}

function hasRequiredNullableProperty(
  schema: unknown,
  propertyName: string,
): boolean {
  if (Array.isArray(schema))
    return schema.some((item) =>
      hasRequiredNullableProperty(item, propertyName),
    );
  if (!isRecord(schema)) return false;
  const properties = isRecord(schema.properties)
    ? schema.properties
    : undefined;
  const required = Array.isArray(schema.required) ? schema.required : [];
  if (
    properties !== undefined &&
    required.includes(propertyName) &&
    schemaContainsNullableOptional(properties[propertyName])
  )
    return true;
  return Object.values(schema).some((value) =>
    hasRequiredNullableProperty(value, propertyName),
  );
}

describe("CompanionAgent", () => {
  it("serializes the newest confirmed life episode before the 400-character memory cap", async () => {
    const directory = mkdtempSync(join(tmpdir(), "companion-agent-life-"));
    const store = CompanionStore.open(join(directory, "memory.sqlite3"), {
      now: () => "2026-10-10T00:00:00.000Z",
    });
    try {
      const deathTimes = Array.from({ length: 8 }, (_, index) =>
        new Date(
          Date.parse("2026-10-01T00:00:00.000Z") + index * 60_000,
        ).toISOString(),
      );
      for (const deathAt of deathTimes) {
        store.recordObservedLifeEvent({ type: "bot_death", at: deathAt });
        store.recordObservedLifeEvent({
          type: "bot_respawn",
          at: new Date(Date.parse(deathAt) + 30_000).toISOString(),
          deathAt,
        });
      }
      const lifeMemory = store.latestObservedLifeMemory();
      if (lifeMemory === null) throw new Error("expected life memory");
      const latestDeathAt = deathTimes.at(-1);
      if (latestDeathAt === undefined) throw new Error("expected latest death");
      const latestRespawnAt = new Date(
        Date.parse(latestDeathAt) + 30_000,
      ).toISOString();
      const create = vi.fn().mockResolvedValue(
        response({
          speech: "記録を確認したよ。",
          ownerMessageDisposition: "answer_only",
          goal: null,
          plan: null,
          memoryUpdates: [],
          relationshipSummary: null,
          waitMs: 10_000,
          knowledgeQuery: null,
        }),
      );
      const agent = new CompanionAgent({
        client: {
          responses: { create },
        } as unknown as CompanionResponsesClient,
        model: "gpt-6-luna",
        persona,
      });

      await agent.decide({ ...createInput(), memories: [lifeMemory] });

      const [request] = create.mock.calls[0] as unknown as [{ input: string }];
      const providerInput = JSON.parse(request.input) as {
        memories: { kind: string; source: string; content: string }[];
      };
      const serializedLifeMemory = providerInput.memories.find(
        (memory) => memory.kind === "life",
      );
      expect(serializedLifeMemory?.source).toBe("minecraft_observed");
      expect(serializedLifeMemory?.content).toContain(latestDeathAt);
      expect(serializedLifeMemory?.content).toContain(latestRespawnAt);
      expect(serializedLifeMemory?.content).toContain("死因: 未確認");
      expect(serializedLifeMemory?.content).toContain("復活: Minecraftで確認");
      expect(serializedLifeMemory?.content.length).toBeLessThanOrEqual(400);
    } finally {
      store.close();
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("serializes bounded stored HOME POIs through the real Agent request", async () => {
    const directory = mkdtempSync(join(tmpdir(), "companion-agent-home-poi-"));
    const store = CompanionStore.open(join(directory, "memory.sqlite3"), {
      now: () => "2026-10-13T00:00:00.000Z",
    });
    try {
      const makeHome = (index: number, observedAt: string): PlayerHomePoi => {
        const verified = index === 0 || index === 20;
        return {
          bedName: "minecraft:white_bed",
          bedHead: { x: 20 + index, y: 64, z: 10 },
          observedAt,
          doorRelationStatus: verified ? "verified" : "unknown",
          doorRelationReason: verified
            ? "verified_flat_room_boundary"
            : "no_supported_closed_wood_door_boundary",
          connectedRoomCellCount: verified ? 7 : 0,
          roomSearchTruncated: false,
          doorSearchMayBeTruncated: false,
          doors: verified
            ? [
                {
                  position: { x: 22 + index, y: 64, z: 10 },
                  facing: "east",
                  observedState: "closed",
                  relation: "verified",
                  reason: "closed_flat_room_boundary",
                  insideCell: { x: 21 + index, y: 64, z: 10 },
                  outsideCell: { x: 23 + index, y: 64, z: 10 },
                  relationObservedAt: observedAt,
                  observedAt,
                },
              ]
            : [],
        };
      };
      const firstObservedAt = "2026-10-12T23:58:00.000Z";
      const firstScan: PlayerHomePoiScan = {
        source: "loaded_home_poi_scan",
        observedAt: firstObservedAt,
        dimension: "overworld",
        center: { x: 20, y: 64, z: 10 },
        radius: 128,
        coverage: "loaded_blocks_only",
        candidateLimit: 8,
        omittedCandidatesAtLeast: 0,
        candidateSearchMayBeTruncated: false,
        worldAbsenceEstablished: false,
        homes: Array.from({ length: 8 }, (_, index) =>
          makeHome(index, firstObservedAt),
        ),
      };
      const olderHomes = store.rememberObservedHomePoiScan(firstScan);
      const newestObservedAt = "2026-10-12T23:59:00.000Z";
      const newestHome = makeHome(20, newestObservedAt);
      const newestHomes = store.rememberObservedHomePoiScan({
        ...firstScan,
        observedAt: newestObservedAt,
        center: newestHome.bedHead,
        homes: [newestHome],
      });
      const memories = [...newestHomes, ...olderHomes];
      const unrelatedMemories: CompanionMemory[] = [
        {
          id: "unrelated-bed-memory",
          kind: "world",
          content: "Preserve the remembered bed location.",
          source: "minecraft_observed",
          status: "active",
          importance: 4,
          createdAt: firstObservedAt,
          updatedAt: firstObservedAt,
          metadata: {
            bedMemory: {
              version: 1,
              kind: "location",
              locationKey: "overworld:5:64:6",
              dimension: "overworld",
              position: { x: 5, y: 64, z: 6 },
              observedAt: firstObservedAt,
            },
          },
        },
        {
          id: "unrelated-chest-memory",
          kind: "world",
          content: "Preserve the remembered chest observation.",
          source: "minecraft_observed",
          status: "active",
          importance: 4,
          createdAt: firstObservedAt,
          updatedAt: firstObservedAt,
          metadata: {
            chestMemory: {
              version: 1,
              kind: "location",
              locationKey: "overworld:7:64:8",
              dimension: "overworld",
              position: { x: 7, y: 64, z: 8 },
              observedAt: firstObservedAt,
            },
          },
        },
        {
          id: "unrelated-life-memory",
          kind: "life",
          content: "Preserve the observed life memory.",
          source: "minecraft_observed",
          status: "active",
          importance: 4,
          createdAt: firstObservedAt,
          updatedAt: firstObservedAt,
          metadata: {},
        },
        {
          id: "unrelated-purpose-memory",
          kind: "goal",
          content: "Preserve the owner's declared purpose.",
          source: "player_stated",
          status: "active",
          importance: 4,
          createdAt: firstObservedAt,
          updatedAt: firstObservedAt,
          metadata: {},
        },
        {
          id: "malformed-home-memory",
          kind: "world",
          content: "Malformed HOME metadata must not bypass projection.",
          source: "minecraft_observed",
          status: "active",
          importance: 4,
          createdAt: firstObservedAt,
          updatedAt: firstObservedAt,
          metadata: { homeMemory: { version: 1, kind: "invalid" } },
        },
      ];

      const create = vi.fn().mockResolvedValue(
        response({
          speech: "記録したベッド位置を確認したよ。",
          ownerMessageDisposition: "answer_only",
          goal: null,
          plan: null,
          memoryUpdates: [],
          relationshipSummary: null,
          waitMs: 10_000,
          knowledgeQuery: null,
        }),
      );
      const agent = new CompanionAgent({
        client: {
          responses: { create },
        } as unknown as CompanionResponsesClient,
        model: "gpt-6-luna",
        persona,
      });

      await agent.decide({
        ...createInput(),
        memories: [...memories, ...unrelatedMemories],
        homePoiMemories: memories,
      });

      const [request] = create.mock.calls[0] as unknown as [
        { readonly input: string; readonly instructions: string },
      ];
      const providerInput = JSON.parse(request.input) as {
        rememberedHomePois: {
          dimension: string;
          scan: {
            coverage: string;
            candidateSearchMayBeTruncated: boolean;
            worldAbsenceEstablished: boolean;
          };
          home: PlayerHomePoi;
        }[];
        memories: {
          kind: string;
          source: string;
          content: string;
          chestObservation?: Record<string, unknown>;
        }[];
        rememberedBedLocation: {
          dimension: string;
          position: { x: number; y: number; z: number };
          observedAt: string;
        } | null;
      };
      expect(providerInput.rememberedHomePois).toHaveLength(8);
      expect(
        providerInput.rememberedHomePois.some(
          ({ dimension, home }) =>
            dimension === "overworld" &&
            home.bedHead.x === newestHome.bedHead.x &&
            home.doors[0]?.relation === "verified",
        ),
      ).toBe(true);
      expect(
        providerInput.rememberedHomePois.every(
          ({ scan }) =>
            scan.coverage === "loaded_blocks_only" &&
            !scan.worldAbsenceEstablished,
        ),
      ).toBe(true);
      expect(JSON.stringify(providerInput.rememberedHomePois)).not.toContain(
        "memoryId",
      );
      expect(providerInput.memories).toHaveLength(4);
      const genericMemoryContents = providerInput.memories.map(
        ({ content }) => content,
      );
      for (const homeMemory of memories) {
        if (homeMemory.content.length > 0)
          expect(genericMemoryContents).not.toContain(
            homeMemory.content.slice(0, 400),
          );
      }
      expect(genericMemoryContents).not.toContain(
        "Malformed HOME metadata must not bypass projection.",
      );
      expect(genericMemoryContents).toEqual(
        expect.arrayContaining([
          "Preserve the remembered bed location.",
          "Preserve the remembered chest observation.",
          "Preserve the observed life memory.",
          "Preserve the owner's declared purpose.",
        ]),
      );
      expect(
        providerInput.memories.find(
          ({ content }) =>
            content === "Preserve the remembered chest observation.",
        )?.chestObservation,
      ).toMatchObject({
        kind: "location",
        dimension: "overworld",
        position: { x: 7, y: 64, z: 8 },
        observedAt: firstObservedAt,
      });
      expect(providerInput.rememberedBedLocation).toEqual({
        dimension: "overworld",
        position: { x: 5, y: 64, z: 6 },
        observedAt: firstObservedAt,
      });
      expect(request.instructions).toContain("最新の最大8件の限定記憶");
    } finally {
      store.close();
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("keeps the explicit none effort for callers without an override", async () => {
    const create = vi.fn().mockResolvedValue(
      response({
        speech: null,
        ownerMessageDisposition: null,
        goal: null,
        plan: null,
        memoryUpdates: [],
        relationshipSummary: null,
        waitMs: 10_000,
        knowledgeQuery: null,
      }),
    );
    const agent = new CompanionAgent({
      client: { responses: { create } } as unknown as CompanionResponsesClient,
      model: "gpt-6-luna",
      persona,
    });

    await agent.decide(createInput());

    const [request] = create.mock.calls[0] as unknown as [
      { reasoning: { effort: string } },
    ];
    expect(request.reasoning.effort).toBe("none");
    expect(agent.status()).toMatchObject({
      requestedModel: "gpt-6-luna",
      requestedReasoningEffort: "none",
    });
  });

  it("accepts speech up to 2000 characters and rejects longer speech", () => {
    const validOutput = {
      speech: "a".repeat(2_000),
      ownerMessageDisposition: null,
      goal: null,
      plan: null,
      memoryUpdates: [],
      relationshipSummary: null,
      waitMs: 10_000,
      knowledgeQuery: null,
    };

    expect(companionDecisionSchema.safeParse(validOutput).success).toBe(true);
    expect(
      companionDecisionSchema.safeParse({
        ...validOutput,
        speech: "a".repeat(2_001),
      }).success,
    ).toBe(false);
  });

  it("uses one strict response, keeps prior context, and restores omitted optional operation fields", async () => {
    const output = {
      speech: null,
      goal: null,
      plan: {
        purpose: "Use food already in inventory.",
        steps: [
          {
            operation: { kind: "consume", item: null },
            expectedOutcome: "Food level rises after eating.",
          },
        ],
      },
      memoryUpdates: [],
      relationshipSummary: null,
      waitMs: 10_000,
      knowledgeQuery: null,
    };
    const create = vi.fn().mockResolvedValue(
      response(output, {
        input_tokens: 41,
        output_tokens: 17,
        input_tokens_details: { cached_tokens: 8, cache_write_tokens: 0 },
        output_tokens_details: { reasoning_tokens: 0 },
        total_tokens: 58,
      }),
    );
    const client = {
      responses: { create },
    } as unknown as CompanionResponsesClient;
    const agent = new CompanionAgent({
      client,
      model: "gpt-6-luna",
      persona,
      reasoningEffort: "medium",
    });

    const decision = await agent.decide(createInput());

    expect(create).toHaveBeenCalledTimes(1);
    const [request, options] = create.mock.calls[0] as unknown as [
      {
        input: string;
        instructions: string;
        text: { format: { strict: boolean; schema: unknown } };
        store: boolean;
        model: string;
        reasoning: { effort: string };
      },
      { maxRetries: number },
    ];
    expect(request.model).toBe("gpt-6-luna");
    expect(request.reasoning.effort).toBe("medium");
    expect(request.instructions).toContain(
      "ownerMessageがある時は、その発言の意味・対象・直前の出来事を優先して自然に返答してください。話題が切り替わったら古い別件を代わりに説明せず、感情を決めつけずにペルソナと会話の流れに沿ってください。",
    );
    expect(request.store).toBe(false);
    expect(options.maxRetries).toBe(0);
    expect("max_output_tokens" in request).toBe(false);
    assertStrictObjects(request.text.format.schema);
    expect(JSON.stringify(request.text.format.schema)).not.toContain(
      "follow_owner",
    );
    expect(
      hasRequiredNullableProperty(request.text.format.schema, "item"),
    ).toBe(true);
    expect(
      hasRequiredNullableProperty(
        request.text.format.schema,
        "relationshipSummary",
      ),
    ).toBe(true);

    const parsedInput = JSON.parse(request.input) as {
      ownerMessage: string;
      recentMessages: { text: string }[];
      memories: { updatedAt: string; status: string }[];
      companion: { relationshipSummary: string };
    };
    expect(parsedInput.ownerMessage).toBe("今度は白樺で作って。");
    expect(parsedInput.recentMessages.map(({ text }) => text)).toEqual([
      "前はオークが好き。",
    ]);
    expect(parsedInput.memories[0]).toMatchObject({
      updatedAt: "2026-10-09T00:00:00.000Z",
      status: "active",
    });
    expect(parsedInput.companion.relationshipSummary).toContain("経験");
    expect(decision.plan?.steps[0]?.operation).toEqual({ kind: "consume" });
    expect(decision.relationshipSummary).toBeNull();
    expect(agent.status()).toMatchObject({
      requestedModel: "gpt-6-luna",
      requestedReasoningEffort: "medium",
      requests: 1,
      usageResponses: 1,
      missingUsageRequests: 0,
      errors: 0,
      inputTokens: 41,
      outputTokens: 17,
      cachedInputTokens: 8,
    });
  });

  it("supplies bounded prior purpose separately from later Body state", async () => {
    const output = {
      speech:
        "実行前に宣言した目的は記録上の採掘です。実行前は水中ではなく、Body結果では水中が観測されました。今は水中ではありません。過去に水へ入った理由は記録されていません。",
      ownerMessageDisposition: "answer_only",
      goal: null,
      plan: null,
      memoryUpdates: [],
      relationshipSummary: null,
      waitMs: 10_000,
      knowledgeQuery: null,
    };
    const create = vi.fn().mockResolvedValue(response(output));
    const agent = new CompanionAgent({
      client: { responses: { create } } as unknown as CompanionResponsesClient,
      model: "gpt-6-luna",
      persona,
    });
    const outcomes = Array.from({ length: 7 }, (_, index) =>
      syntheticOutcome(6 - index),
    );
    const currentObservation: PlayerBodyObservation = {
      ...observation,
      self: { ...observation.self, inWater: false, oxygen: 20 },
    };
    const latestOutcome = outcomes[0];
    if (latestOutcome === undefined)
      throw new Error("Missing synthetic outcome.");

    const decision = await agent.decide({
      ...createInput(),
      snapshot: {
        ...snapshot,
        lastOutcome: latestOutcome,
        activeOperation: {
          operationId: "private-active-correlation",
          operation: latestOutcome.operation,
          expectedOutcome:
            latestOutcome.expectedOutcome ?? "The area is checked.",
          purpose: latestOutcome.purpose,
          preActionObservation: latestOutcome.preActionObservation,
          bodyStartedAt: latestOutcome.bodyEvidence.startedAt ?? undefined,
        },
      },
      ownerMessage: "復活した今、さっき何を目指して水へ行ったの？",
      ownerReplyContext: { pendingOwnerRequest: null },
      observation: currentObservation,
      recentOutcomes: outcomes,
    });

    const [request] = create.mock.calls[0] as unknown as [
      { input: string; instructions: string },
    ];
    const parsed = JSON.parse(request.input) as {
      observation: { self: { inWater: boolean } };
      recentOutcomes: Record<string, unknown>[];
      companion: {
        lastOutcome: Record<string, unknown>;
        activeOperation: Record<string, unknown>;
      };
    };
    expect(parsed.recentOutcomes).toHaveLength(5);
    expect(parsed.recentOutcomes[0]).toMatchObject({
      purpose: "Declared purpose 6.",
      preActionObservation: { inWater: false },
      bodyEvidence: { after: { inWater: true } },
    });
    expect(parsed.recentOutcomes[4]?.purpose).toBe("Declared purpose 2.");
    expect(parsed.companion.lastOutcome).toMatchObject({
      operation: { kind: "look_sweep" },
      status: "successful",
      summary: "Synthetic Body result 6.",
      expectedOutcome: "The visible area is checked.",
      purpose: "Declared purpose 6.",
      bodyEvidence: { after: { inWater: true } },
    });
    expect(parsed.companion.activeOperation).toMatchObject({
      operation: { kind: "look_sweep" },
      expectedOutcome: "The visible area is checked.",
      purpose: "Declared purpose 6.",
      preActionObservation: { inWater: false },
    });
    expect(JSON.stringify(parsed)).not.toContain("operationId");
    expect(JSON.stringify(parsed)).not.toContain("private-correlation");
    expect(JSON.stringify(parsed)).not.toContain("private-active-correlation");
    expect(parsed.observation.self.inWater).toBe(false);
    expect(request.instructions).toContain(
      "purposeや観測がunknown/nullなら後から推測で埋めず、実行理由・過去状態・死因を断定しないでください。",
    );
    expect(decision.speech).toContain("実行前に宣言した目的");
  });

  it("encodes pending work and conditional dream disposition rules", async () => {
    const output = {
      speech: "いま確認しているよ。",
      ownerMessageDisposition: "answer_only",
      goal: null,
      plan: null,
      memoryUpdates: [],
      relationshipSummary: null,
      waitMs: 10_000,
      knowledgeQuery: null,
    };
    const create = vi.fn().mockResolvedValue(response(output));
    const agent = new CompanionAgent({
      client: {
        responses: { create },
      } as unknown as CompanionResponsesClient,
      model: "gpt-6-luna",
      persona,
    });

    const decision = await agent.decide({
      ...createInput(),
      ownerMessage: "いま何を確認しているの？",
      pendingOwnerRequest: "周囲を確認して",
      ownerReplyContext: { pendingOwnerRequest: "周囲を確認して" },
    });

    const [request] = create.mock.calls[0] as unknown as [
      {
        input: string;
        instructions: string;
        text: { format: { schema: unknown } };
      },
    ];
    const parsedInput = JSON.parse(request.input) as {
      ownerMessage: string;
      pendingOwnerRequest: string;
      ownerReplyContext: { pendingOwnerRequest: string | null };
    };
    expect(parsedInput).toMatchObject({
      ownerMessage: "いま何を確認しているの？",
      pendingOwnerRequest: "周囲を確認して",
      ownerReplyContext: { pendingOwnerRequest: "周囲を確認して" },
    });
    expect(request.instructions).toContain(
      "ownerReplyContextがある独立返信ではownerMessageDispositionを必ず選んでください。",
    );
    expect(request.instructions).toContain(
      "ownerが進行中の依頼の取消し・置換を明示する場合、または明示的な新しいゲーム内行動を要求する場合は、夢の話題を含んでもupdate_goalだけを選び",
    );
    expect(request.instructions).toContain(
      "事実・状況・進捗の質問はanswer_onlyとし、speechだけで答え、goal/plan/memoryUpdates/relationshipSummary/knowledgeQueryを更新せず",
    );
    expect(request.instructions).toContain(
      "夢・将来やりたいこと・大きな目標についての純粋な質問（ゲーム内行動の実行を明示依頼していない場合）だけは、runnableなpendingOwnerRequestがある、companion.activeOperationがある、またはcompanion.goal.source=ownerの成功条件が現在のBody観測で未達と分かる間、answer_only",
    );
    expect(request.instructions).toContain(
      "companion.goal.source=ownerという保存値だけで未完了と決めつけず",
    );
    expect(request.instructions).toContain(
      "interleaved返信でgoalやplanを作らず、そのowner発言を既存の通常判断へ渡してください。",
    );
    expect(request.instructions).toContain(
      "plan.purposeに必要な複数段階の方針、stepsに現在の観測から着手可能な1〜3操作",
    );
    expect(
      hasRequiredNullableProperty(
        request.text.format.schema,
        "ownerMessageDisposition",
      ),
    ).toBe(true);
    expect(decision.ownerMessageDisposition).toBe("answer_only");
  });

  it("sends only the current owner's bounded reply evidence to the Agent", async () => {
    const create = vi.fn().mockResolvedValue(
      response({
        speech: "送信結果は分からないよ。",
        goal: null,
        plan: null,
        memoryUpdates: [],
        relationshipSummary: null,
        waitMs: 10_000,
        knowledgeQuery: null,
      }),
    );
    const agent = new CompanionAgent({
      client: {
        responses: { create },
      } as unknown as CompanionResponsesClient,
      model: "gpt-6-luna",
      persona,
    });

    await agent.decide({
      ...createInput(),
      ownerMessage: "返事が来なかった理由を教えて。",
      ownerMessageSequence: 2,
      snapshot: {
        ...snapshot,
        replyLifecycle: [
          {
            ownerMessageSequence: 1,
            events: [{ state: "send_unknown", at: "2026-10-10T00:00:00.000Z" }],
          },
          {
            ownerMessageSequence: 2,
            events: [
              {
                state: "interrupted",
                at: "2026-10-10T00:01:00.000Z",
                reasonCode: "damage_response",
              },
            ],
          },
        ],
      },
    });

    const [request] = create.mock.calls[0] as unknown as [
      { input: string; instructions: string },
    ];
    const parsedInput = JSON.parse(request.input) as {
      ownerMessageSequence: number;
      companion: {
        replyLifecycle: {
          ownerMessageSequence: number;
          latestEvent: { state: string; reasonCode?: string } | null;
          eventCount: number;
        } | null;
      };
    };
    expect(parsedInput.ownerMessageSequence).toBe(2);
    expect(parsedInput.companion.replyLifecycle).toMatchObject({
      ownerMessageSequence: 2,
      latestEvent: { state: "interrupted", reasonCode: "damage_response" },
      eventCount: 1,
    });
    expect(JSON.stringify(parsedInput)).not.toContain("send_unknown");
    expect(request.instructions).toContain(
      "send_call_resolvedはsay呼び出しが戻ったことだけを示し、ゲーム内画面への表示確認ではありません。",
    );
    expect(request.instructions).toContain(
      "明示再開でも停止前の返答は復活しません。",
    );
  });

  it("sends exactly the newest 24 mixed-role messages to the provider", async () => {
    const output = {
      speech: null,
      goal: null,
      plan: null,
      memoryUpdates: [],
      relationshipSummary: null,
      waitMs: 10_000,
      knowledgeQuery: null,
    };
    const create = vi.fn().mockResolvedValue(response(output));
    const agent = new CompanionAgent({
      client: {
        responses: { create },
      } as unknown as CompanionResponsesClient,
      model: "gpt-6-luna",
      persona,
    });
    const messages = Array.from({ length: 30 }, (_, index) => ({
      sequence: index + 1,
      role:
        index % 2 === 0 || index === 29
          ? ("owner" as const)
          : ("companion" as const),
      text: `synthetic-message-${index + 1}`,
      recordedAt: `2026-10-10T00:${String(index).padStart(2, "0")}:00.000Z`,
    }));
    const currentOwnerMessage = "synthetic-message-30";

    await agent.decide({
      ...createInput(),
      ownerMessage: currentOwnerMessage,
      messages,
    });

    const [request] = create.mock.calls[0] as unknown as [{ input: string }];
    const providerInput = JSON.parse(request.input) as {
      ownerMessage: string;
      recentMessages: { role: string; text: string }[];
    };
    expect(providerInput.ownerMessage).toBe(currentOwnerMessage);
    expect(providerInput.recentMessages).toHaveLength(23);
    expect(providerInput.recentMessages.length + 1).toBe(24);
    expect(
      providerInput.recentMessages.map(({ role, text }) => ({ role, text })),
    ).toEqual(messages.slice(6, 29).map(({ role, text }) => ({ role, text })));
  });

  it("sends historical chest contents beside the current observation with explicit time boundaries", async () => {
    const create = vi.fn().mockResolvedValue(
      response({
        speech: null,
        goal: null,
        plan: null,
        memoryUpdates: [],
        relationshipSummary: null,
        waitMs: 10_000,
        knowledgeQuery: null,
      }),
    );
    const agent = new CompanionAgent({
      client: { responses: { create } } as unknown as CompanionResponsesClient,
      model: "gpt-6-luna",
      persona,
    });
    const memories: CompanionMemory[] = [
      {
        id: "chest-location",
        kind: "world",
        content: "確認済みチェストの場所: overworld (12, 64, -3)",
        source: "minecraft_observed",
        status: "active",
        importance: 5,
        createdAt: "2026-10-10T00:00:00.000Z",
        updatedAt: "2026-10-10T00:00:00.000Z",
        metadata: {
          chestMemory: {
            version: 1,
            kind: "location",
            locationKey: "overworld:12:64:-3",
            dimension: "overworld",
            position: { x: 12, y: 64, z: -3 },
            observedAt: "2026-10-10T00:00:00.000Z",
            privateInternalField: "not-forwarded",
          },
        },
      },
      {
        id: "chest-contents",
        kind: "world",
        content:
          "チェスト中身の過去観測 (overworld 12,64,-3; 2026-10-10T00:00:00.000Z): 0:diamond x3",
        source: "minecraft_observed",
        status: "active",
        importance: 5,
        createdAt: "2026-10-10T00:00:00.000Z",
        updatedAt: "2026-10-10T00:00:00.000Z",
        metadata: {
          chestMemory: {
            version: 1,
            kind: "contents",
            locationKey: "overworld:12:64:-3",
            dimension: "overworld",
            position: { x: 12, y: 64, z: -3 },
            observedAt: "2026-10-10T00:00:00.000Z",
            expiresAt: "2026-10-10T01:00:00.000Z",
            contents: [{ slot: 0, name: "diamond", count: 3 }],
            privateInternalField: "not-forwarded",
          },
        },
      },
      {
        id: "bed-location",
        kind: "world",
        content: "確認済みベッドの場所: the_nether (12, 64, -3)",
        source: "minecraft_observed",
        status: "active",
        importance: 5,
        createdAt: "2026-10-10T00:00:00.000Z",
        updatedAt: "2026-10-10T00:00:00.000Z",
        metadata: {
          bedMemory: {
            version: 1,
            kind: "location",
            locationKey: "the_nether:12:64:-3",
            dimension: "the_nether",
            position: { x: 12, y: 64, z: -3 },
            observedAt: "2026-10-10T00:00:00.000Z",
            privateInternalField: "not-forwarded",
          },
        },
      },
    ];

    await agent.decide({
      ...createInput(),
      observation: {
        ...observation,
        observedAt: "2026-10-10T00:59:00.000Z",
        perception: { ...observation.perception, blocks: [] },
        window: null,
      },
      memories,
    });

    const [request] = create.mock.calls[0] as unknown as [
      { readonly input: string; readonly instructions: string },
    ];
    const providerInput = JSON.parse(request.input) as {
      observation: {
        observedAt: string;
        perception: { blocks: unknown[] };
        window: unknown;
      };
      rememberedBedLocation: {
        dimension: string;
        position: { x: number; y: number; z: number };
        observedAt: string;
      } | null;
      memories: { chestObservation?: Record<string, unknown> }[];
    };
    expect(request.instructions).toContain("過去に視認した最終位置");
    expect(request.instructions).toContain(
      "rememberedBedLocationは過去に視認した位置です。現在のobservation.dimensionと同じ場合だけ移動先に使い、現在のperception.blocksにないだけで消失と扱わずmove_toできます。到着や記憶だけでベッド現存・睡眠成功を主張せず、到着後の新しいBody観測で判断してください。",
    );
    expect(request.instructions).toContain(
      "現在のblocks一覧にないだけで不存在とせず",
    );
    expect(request.instructions).toContain(
      "現在のblocksにない既知チェストへはmove_toだけを計画し、到着後に新しいBody観測を受けて再判断し、chest/trapped_chestを確認してから開いてください。",
    );
    expect(request.instructions).toContain("observedAt時点の過去の中身");
    expect(request.instructions).toContain(
      "新しいBody観測で対象チェストとwindowを確認",
    );
    expect(providerInput.observation).toMatchObject({
      observedAt: "2026-10-10T00:59:00.000Z",
      perception: { blocks: [] },
      window: null,
    });
    expect(
      providerInput.memories
        .map(({ chestObservation }) => chestObservation)
        .filter((value) => value !== undefined),
    ).toEqual([
      {
        kind: "location",
        dimension: "overworld",
        position: { x: 12, y: 64, z: -3 },
        observedAt: "2026-10-10T00:00:00.000Z",
      },
      {
        kind: "contents",
        dimension: "overworld",
        position: { x: 12, y: 64, z: -3 },
        observedAt: "2026-10-10T00:00:00.000Z",
        expiresAt: "2026-10-10T01:00:00.000Z",
        contents: [{ slot: 0, name: "diamond", count: 3 }],
      },
    ]);
    expect(providerInput.observation).toMatchObject({ dimension: "overworld" });
    expect(providerInput.rememberedBedLocation).toEqual({
      dimension: "the_nether",
      position: { x: 12, y: 64, z: -3 },
      observedAt: "2026-10-10T00:00:00.000Z",
    });
    expect(request.input).not.toContain("privateInternalField");
  });

  it("rejects the internal owner-follow operation from model decisions", () => {
    const decision = companionDecisionSchema.safeParse({
      speech: null,
      goal: null,
      plan: {
        purpose: "Follow the owner.",
        steps: [
          {
            operation: { kind: "follow_owner" },
            expectedOutcome: "Stay near the owner.",
          },
        ],
      },
      memoryUpdates: [],
      relationshipSummary: null,
      waitMs: 10_000,
      knowledgeQuery: null,
    });

    expect(decision.success).toBe(false);
  });

  it("accepts a concise relationship update and rejects an empty one", async () => {
    const validOutput = {
      speech: null,
      goal: null,
      plan: null,
      memoryUpdates: [],
      relationshipSummary:
        "一緒に森を歩いた経験から、相手の慎重さを理解している。",
      waitMs: 10_000,
      knowledgeQuery: null,
    };
    const create = vi
      .fn()
      .mockResolvedValueOnce(response(validOutput))
      .mockResolvedValueOnce(
        response({ ...validOutput, relationshipSummary: "   " }),
      );
    const agent = new CompanionAgent({
      client: { responses: { create } } as unknown as CompanionResponsesClient,
      model: "gpt-6-luna",
      persona,
    });

    await expect(agent.decide(createInput())).resolves.toMatchObject({
      relationshipSummary:
        "一緒に森を歩いた経験から、相手の慎重さを理解している。",
    });
    await expect(agent.decide(createInput())).rejects.toMatchObject({
      name: "CompanionAgentError",
      code: "invalid_response",
    });
  });

  it("marks totals unknown when a request has no usage telemetry", async () => {
    const create = vi
      .fn()
      .mockResolvedValueOnce(
        response({
          speech: null,
          goal: null,
          plan: null,
          memoryUpdates: [],
          relationshipSummary: null,
          waitMs: 10_000,
          knowledgeQuery: null,
        }),
      )
      .mockRejectedValueOnce(
        new Error("provider details are deliberately hidden"),
      );
    const agent = new CompanionAgent({
      client: { responses: { create } } as unknown as CompanionResponsesClient,
      model: "gpt-6-luna",
      persona,
    });

    await agent.decide(createInput());
    await expect(agent.decide(createInput())).rejects.toMatchObject({
      name: "CompanionAgentError",
      code: "invalid_response",
    });

    expect(agent.status()).toMatchObject({
      requests: 2,
      usageResponses: 0,
      missingUsageRequests: 2,
      errors: 1,
      inputTokens: null,
      outputTokens: null,
      cachedInputTokens: null,
      lastErrorCode: "request_failed",
    });
  });
});
