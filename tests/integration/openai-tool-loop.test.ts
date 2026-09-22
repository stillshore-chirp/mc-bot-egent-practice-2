import pino from "pino";
import { describe, expect, it } from "vitest";

import { OpenAIDeliberationAgent } from "../../src/agent/openai-agent.js";
import type {
  GameController,
  MemoryPort,
  ToolContext,
} from "../../src/tools/contracts.js";
import { ScriptedOpenAI } from "../support/fake-openai.js";

const status = {
  observedAt: "2026-09-22T00:00:00.000Z",
  subject: "bot" as const,
  source: "minecraft" as const,
  requesterVitals: "unobserved" as const,
  connected: true,
  spawned: true,
  health: 20,
  food: 20,
  oxygen: 20,
  oxygenState: "not_applicable" as const,
  inWater: false,
  inLava: false,
  suffocating: false,
  position: { x: 0, y: 64, z: 0, dimension: "overworld" },
  inventory: {},
  activeTaskState: null,
};

function toolContext(): ToolContext {
  const game: GameController = {
    observeStatus: async () => status,
    observeSurroundings: async () => ({
      observedAt: status.observedAt,
      subject: status.subject,
      source: status.source,
      requesterVitals: status.requesterVitals,
      oxygen: status.oxygen,
      oxygenState: status.oxygenState,
      inWater: status.inWater,
      blocks: [],
      entities: [],
      hazards: [],
    }),
    findSafeResourceCandidates: async () => [
      { resource: "birch_log", distance: 2 },
    ],
    findSafeActionCandidates: async ({ count }) => [
      {
        id: "collect-birch",
        label: "近くのシラカバを集める",
        action: "gather_resource",
        observed: true,
        purposeFit: "direct",
        permission: "allowed",
        safety: "allowed",
        reversible: true,
        impact: "low",
        distance: 2,
        order: 0,
        steps: [
          { tool: "say", input: { message: "安全な候補を選びました。" } },
          {
            tool: "gather_resource",
            input: {
              resource: "birch_log",
              count,
              commitmentId: null,
            },
          },
        ],
      },
    ],
    say: async () => undefined,
    followOwner: async () => ({
      before: status,
      after: status,
      outcome: "completed",
      summary: "追従しました。",
    }),
    stopCurrentAction: async () => ({
      before: status,
      after: status,
      outcome: "cancelled",
      summary: "停止しました。",
    }),
    moveTo: async () => ({
      before: status,
      after: status,
      outcome: "completed",
      summary: "到達しました。",
    }),
    gatherResource: async () => ({
      before: status,
      after: status,
      outcome: "completed",
      summary: "収集しました。",
    }),
    returnToOwner: async () => ({
      before: status,
      after: status,
      outcome: "completed",
      summary: "戻りました。",
    }),
    currentPosition: async () => status.position,
  };
  const memory: MemoryPort = {
    rememberPlayerFact: () => ({}),
    rememberLocation: () => ({}),
    recall: () => [],
    setCommitment: () => ({ id: "commitment" }),
    getCommitment: () => undefined,
    completeCommitment: () => ({}),
  };
  return {
    correlationId: "correlation",
    requesterUsername: "owner",
    authorizedOwnerUsername: "owner",
    playerId: "player",
    signal: new AbortController().signal,
    requestKind: "owner_message",
    executionEvidence: { verifiedActionReceipts: [] },
    game,
    memory,
    limits: {
      maxMoveDistance: 8,
      maxGatherCount: 16,
      followDistance: 3,
      memoryContextLimit: 10,
    },
  };
}

function response(output: unknown[], outputText = "") {
  return {
    id: "response-test",
    object: "response",
    created_at: 0,
    status: "completed",
    output,
    output_text: outputText,
    usage: null,
  };
}

describe("OpenAI tool loop", () => {
  it("executes a bounded multi-step goal plan inside one delegated tool call", async () => {
    const fake = new ScriptedOpenAI([
      response([
        {
          type: "function_call",
          call_id: "call-plan",
          name: "plan_safe_action",
          arguments: JSON.stringify({
            goal: "collect_resource",
            count: 1,
            mode: "delegated",
            candidateId: null,
          }),
          status: "completed",
        },
      ]),
      response(
        [
          {
            type: "message",
            id: "message-plan-final",
            role: "assistant",
            status: "completed",
            content: [
              {
                type: "output_text",
                text: "目的の作業が完了しました。",
                annotations: [],
              },
            ],
          },
        ],
        "目的の作業が完了しました。",
      ),
    ]);
    const context = toolContext();
    const actions: string[] = [];
    context.game.say = async (message) => {
      actions.push(`say:${message}`);
    };
    context.game.gatherResource = async () => {
      actions.push("gather_resource");
      return {
        before: status,
        after: status,
        outcome: "completed",
        summary: "シラカバを収集して戻りました。",
      };
    };
    const agent = new OpenAIDeliberationAgent({
      apiKey: "test-only",
      model: "test-model",
      client: fake.asClient(),
      logger: pino({ level: "silent" }),
    });

    const reply = await agent.deliberate({
      message: "必要な作業を安全に組み立てて実行して",
      personaContext: "テスト人格",
      memoryContext: "なし",
      worldContext: JSON.stringify(status),
      toolContext: context,
    });

    expect(reply.text).toContain("計画した2段階を実行");
    expect(reply.toolResults.map(({ name }) => name)).toEqual([
      "plan_safe_action",
    ]);
    expect(fake.requests).toHaveLength(2);
    expect(actions).toEqual([
      "say:安全な候補を選びました。",
      "gather_resource",
    ]);
  });

  it("hands a delegated safe selection to the observed action without a second confirmation", async () => {
    const fake = new ScriptedOpenAI([
      response([
        {
          type: "function_call",
          call_id: "call-select",
          name: "select_safe_resource",
          arguments: JSON.stringify({ count: 1 }),
          status: "completed",
        },
      ]),
      response([
        {
          type: "function_call",
          call_id: "call-gather",
          name: "gather_resource",
          arguments: JSON.stringify({
            resource: "birch_log",
            count: 1,
            commitmentId: null,
          }),
          status: "completed",
        },
      ]),
      response(
        [
          {
            type: "message",
            id: "message-final",
            role: "assistant",
            status: "completed",
            content: [
              {
                type: "output_text",
                text: "近くで安全を確認できたシラカバの原木を1個集めました。",
                annotations: [],
              },
            ],
          },
        ],
        "近くで安全を確認できたシラカバの原木を1個集めました。",
      ),
    ]);
    const context = toolContext();
    context.safeActionAuthorization = {
      kind: "owner_bounded_resource",
      goal: "原木を1個集めて、種類は任せる",
      allowedResources: [
        "oak_log",
        "spruce_log",
        "birch_log",
        "jungle_log",
        "acacia_log",
        "dark_oak_log",
        "mangrove_log",
        "cherry_log",
        "pale_oak_log",
        "crimson_stem",
        "warped_stem",
      ],
      targetItem: "*",
      targetCount: 1,
      maxCount: 16,
      selectionRequired: true,
    };
    context.safeActionAuthorizationUsage = {
      remainingCount: 1,
      consumed: false,
    };
    context.game.gatherResource = async (resource, count) => ({
      before: status,
      after: status,
      outcome: "completed",
      confirmedState: {
        resource,
        requestedCount: count,
        collectedCount: count,
        heldCount: count,
      },
      summary: "シラカバを収集しました。",
    });
    const agent = new OpenAIDeliberationAgent({
      apiKey: "test-only",
      model: "test-model",
      client: fake.asClient(),
      logger: pino({ level: "silent" }),
    });

    const reply = await agent.deliberate({
      message: "目の前の安全な原木を1個、種類は任せる",
      personaContext: "テスト人格",
      memoryContext: "なし",
      worldContext: JSON.stringify(status),
      toolContext: context,
    });

    expect(reply.text).toContain("安全条件を確認できた");
    expect(reply.toolResults.map(({ name }) => name)).toEqual([
      "select_safe_resource",
      "gather_resource",
    ]);
    expect(fake.requests).toHaveLength(3);
    expect(JSON.stringify(fake.requests[1]?.input)).toContain("birch_log");
  });

  it("turns a missing candidate into one concrete clarification and performs no action", async () => {
    const fake = new ScriptedOpenAI([
      response([
        {
          type: "function_call",
          call_id: "call-select-empty",
          name: "select_safe_resource",
          arguments: JSON.stringify({ count: 1 }),
          status: "completed",
        },
      ]),
      response(
        [
          {
            type: "message",
            id: "message-clarify",
            role: "assistant",
            status: "completed",
            content: [
              {
                type: "output_text",
                text: "安全な原木を観測できません。種類を指定してください。",
                annotations: [],
              },
            ],
          },
        ],
        "安全な原木を観測できません。種類を指定してください。",
      ),
    ]);
    const context = toolContext();
    context.game.findSafeResourceCandidates = async () => [];
    const agent = new OpenAIDeliberationAgent({
      apiKey: "test-only",
      model: "test-model",
      client: fake.asClient(),
      logger: pino({ level: "silent" }),
    });

    const reply = await agent.deliberate({
      message: "安全な原木を1個、選ぶのは任せる",
      personaContext: "テスト人格",
      memoryContext: "なし",
      worldContext: JSON.stringify(status),
      toolContext: context,
    });

    expect(reply.text).toContain("観測できません");
    expect(reply.toolResults).toHaveLength(1);
    expect(reply.toolResults[0]?.result).toMatchObject({
      success: false,
      error: { code: "CHOICE_NOT_OBSERVED" },
    });
  });

  it("revalidates function arguments and uses deterministic action failure reporting", async () => {
    const fake = new ScriptedOpenAI([
      response([
        {
          type: "function_call",
          call_id: "call-1",
          name: "move_to",
          arguments: JSON.stringify({
            x: 100,
            y: 64,
            z: 0,
            radius: 2,
          }),
          status: "completed",
        },
      ]),
      response(
        [
          {
            type: "message",
            id: "message-1",
            role: "assistant",
            status: "completed",
            content: [
              { type: "output_text", text: "到着しました。", annotations: [] },
            ],
          },
        ],
        "到着しました。",
      ),
    ]);
    const agent = new OpenAIDeliberationAgent({
      apiKey: "test-only",
      model: "test-model",
      client: fake.asClient(),
      logger: pino({ level: "silent" }),
    });

    const reply = await agent.deliberate({
      message: "遠くへ移動して",
      personaContext: "テスト人格",
      memoryContext: "なし",
      worldContext: "原点",
      toolContext: toolContext(),
    });

    expect(reply.text).toBe(
      "許可された移動距離を超えるため移動しませんでした。",
    );
    expect(fake.requests).toHaveLength(2);
    expect(fake.requests[0]).toMatchObject({
      parallel_tool_calls: false,
      store: false,
    });
    expect(fake.requests[0]?.instructions).toContain(
      "requesterVitalsがunobserved",
    );
    expect(fake.requests[0]?.instructions).toContain(
      "利用者の体力・空腹・酸素・水中状態をBotの値から推測せず",
    );
    expect(JSON.stringify(fake.requests[1]?.input)).toContain(
      "MOVE_DISTANCE_EXCEEDED",
    );
  });

  it("rejects a non-completed Responses API result", async () => {
    const fake = new ScriptedOpenAI([
      {
        ...response([], "途中の応答"),
        status: "incomplete",
        incomplete_details: { reason: "max_output_tokens" },
      },
    ]);
    const agent = new OpenAIDeliberationAgent({
      apiKey: "test-only",
      model: "test-model",
      client: fake.asClient(),
      logger: pino({ level: "silent" }),
    });

    await expect(
      agent.deliberate({
        message: "状態を教えて",
        personaContext: "テスト人格",
        memoryContext: "なし",
        worldContext: "原点",
        toolContext: toolContext(),
      }),
    ).rejects.toMatchObject({
      detail: { code: "LLM_RESPONSE_NOT_COMPLETED" },
    });
  });

  it("rejects an unrelated action as commitment completion evidence", async () => {
    const fake = new ScriptedOpenAI([
      response([
        {
          type: "function_call",
          call_id: "call-recall",
          name: "recall_memory",
          arguments: JSON.stringify({
            query: "約束",
            kinds: ["commitment"],
            limit: 5,
          }),
          status: "completed",
        },
      ]),
      response([
        {
          type: "function_call",
          call_id: "call-move",
          name: "move_to",
          arguments: JSON.stringify({
            x: 1,
            y: 64,
            z: 0,
            radius: 2,
          }),
          status: "completed",
        },
      ]),
      response([
        {
          type: "function_call",
          call_id: "call-complete",
          name: "complete_commitment",
          arguments: JSON.stringify({
            commitmentId: "commitment",
            outcome: "done",
            basis: "verified_tool_result",
            receiptId: "00000000-0000-4000-8000-000000000001",
            evidenceSummary: null,
          }),
          status: "completed",
        },
      ]),
      response(
        [
          {
            type: "message",
            id: "message-final",
            role: "assistant",
            status: "completed",
            content: [
              { type: "output_text", text: "確認しました。", annotations: [] },
            ],
          },
        ],
        "確認しました。",
      ),
    ]);
    let completionWrites = 0;
    const context = toolContext();
    context.memory.completeCommitment = () => {
      completionWrites += 1;
      return {};
    };
    const agent = new OpenAIDeliberationAgent({
      apiKey: "test-only",
      client: fake as never,
      logger: pino({ enabled: false }),
      model: "test-model",
    });

    const reply = await agent.deliberate({
      message: "約束を確認して移動して完了にして",
      personaContext: "test persona",
      memoryContext: "active commitment",
      worldContext: JSON.stringify(status),
      toolContext: context,
    });

    expect(completionWrites).toBe(0);
    expect(reply.toolResults.at(-1)?.result).toMatchObject({
      success: false,
      error: { code: "COMMITMENT_VERIFIED_ACTION_MISSING" },
    });
  });
});
