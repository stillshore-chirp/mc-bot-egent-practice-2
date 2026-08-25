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
  connected: true,
  spawned: true,
  health: 20,
  food: 20,
  oxygen: 20,
  position: { x: 0, y: 64, z: 0, dimension: "overworld" },
  inventory: {},
  activeTaskState: null,
};

function toolContext(): ToolContext {
  const game: GameController = {
    observeStatus: async () => status,
    observeSurroundings: async () => ({
      blocks: [],
      entities: [],
      hazards: [],
    }),
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
