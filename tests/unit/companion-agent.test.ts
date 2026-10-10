import { describe, expect, it, vi } from "vitest";
import type { Response } from "openai/resources/responses/responses.js";

import {
  CompanionAgent,
  companionDecisionSchema,
  type CompanionDecisionInput,
  type CompanionResponsesClient,
} from "../../src/player/agent.js";
import type {
  CompanionMemory,
  CompanionSnapshot,
} from "../../src/player/contracts.js";
import type { PlayerBodyObservation } from "../../src/minecraft/player-body.js";
import type { PersonaCore } from "../../src/persona/persona.js";

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
  it("accepts speech up to 2000 characters and rejects longer speech", () => {
    const validOutput = {
      speech: "a".repeat(2_000),
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
        text: { format: { strict: boolean; schema: unknown } };
        store: boolean;
        model: string;
      },
      { maxRetries: number },
    ];
    expect(request.model).toBe("gpt-6-luna");
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
      requests: 1,
      usageResponses: 1,
      missingUsageRequests: 0,
      errors: 0,
      inputTokens: 41,
      outputTokens: 17,
      cachedInputTokens: 8,
    });
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
