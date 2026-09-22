import pino from "pino";
import { describe, expect, it, vi } from "vitest";

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

function toolContext(
  requestKind: ToolContext["requestKind"] = "owner_message",
): ToolContext {
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
    requestKind,
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
  it("carries the previous subject and explanation preferences into the next turn", async () => {
    const fake = new ScriptedOpenAI([
      response([], "目の前の木を対象にします。短く伝えます。"),
      response([], "同じ木を対象に収集を始めます。"),
    ]);
    const agent = new OpenAIDeliberationAgent({
      apiKey: "test-only",
      model: "test-model",
      client: fake.asClient(),
      logger: pino({ level: "silent" }),
    });
    const first = {
      personaContext: "テスト人格",
      memoryContext: "なし",
      worldContext: "原点",
      toolContext: toolContext(),
    };

    const firstReply = await agent.deliberate({
      ...first,
      message: "目の前の木でいい。専門用語を使わず短く説明して。",
    });
    agent.recordDeliveredReply("owner", "owner_message", firstReply.text);
    await agent.deliberate({
      ...first,
      message: "それでいい。進めて。",
    });

    expect(fake.requests).toHaveLength(2);
    expect(fake.requests[0]?.instructions).toContain(
      "利用者の説明方法の希望: 短く要点だけ話す。",
    );
    expect(fake.requests[0]?.instructions).toContain(
      "利用者の説明方法の希望: 内部名や専門用語を使わず、平易に話す。",
    );
    expect(fake.requests[0]?.instructions).toContain("提供していない操作");
    expect(fake.requests[0]?.instructions).toContain(
      "許可済み原木収集の対象原木だけは収集toolで扱います",
    );
    expect(fake.requests[0]?.instructions).toContain("実行した工程");
    expect(JSON.stringify(fake.requests[1]?.input)).toContain(
      "目の前の木でいい。専門用語を使わず短く説明して。",
    );
    expect(JSON.stringify(fake.requests[1]?.input)).toContain(
      "目の前の木を対象にします。短く伝えます。",
    );
    expect(fake.requests[1]?.instructions).toContain("同じ対象として扱って");
    expect(fake.requests[1]?.instructions).toContain(
      "公開toolを安全な順序で組み合わせれば目的を達成できる場合",
    );
    expect(fake.requests[1]?.instructions).toContain(
      "利用者の説明方法の希望: 短く要点だけ話す。",
    );
    expect(fake.requests[1]?.instructions).toContain(
      "利用者の説明方法の希望: 内部名や専門用語を使わず、平易に話す。",
    );
  });

  it("does not add an automatic reassessment prompt to the user conversation", async () => {
    const fake = new ScriptedOpenAI([
      response([], "依頼を受けました。"),
      response([], "現在の状態を確認しました。"),
      response([], "続きます。"),
    ]);
    const agent = new OpenAIDeliberationAgent({
      apiKey: "test-only",
      model: "test-model",
      client: fake.asClient(),
      logger: pino({ level: "silent" }),
    });
    const context = toolContext();

    const firstReply = await agent.deliberate({
      message: "木を集めて",
      personaContext: "テスト人格",
      memoryContext: "なし",
      worldContext: "原点",
      toolContext: context,
    });
    agent.recordDeliveredReply("owner", "owner_message", firstReply.text);
    await agent.deliberate({
      message: "安全状態を再確認して",
      personaContext: "テスト人格",
      memoryContext: "なし",
      worldContext: "原点",
      toolContext: { ...context, requestKind: "runtime_reassessment" },
    });
    await agent.deliberate({
      message: "続けて",
      personaContext: "テスト人格",
      memoryContext: "なし",
      worldContext: "原点",
      toolContext: context,
    });

    const thirdInput = JSON.stringify(fake.requests[2]?.input);
    expect(thirdInput).toContain("木を集めて");
    expect(thirdInput).toContain("依頼を受けました。");
    expect(thirdInput).toContain("続けて");
    expect(thirdInput).not.toContain("安全状態を再確認して");
    expect(thirdInput).not.toContain("現在の状態を確認しました。");
    expect(fake.requests[1]?.instructions).toContain(
      "観測とtool結果を最優先し",
    );
    expect(fake.requests[1]?.instructions).toContain(
      "体力・空腹・座標・記憶の列挙は省き",
    );
    expect(fake.requests[1]?.instructions).toContain(
      "開始済みの行動があれば、その事実を優先して報告",
    );
    expect(fake.requests[1]?.instructions).toContain(
      "JSONキーやtrue/false表記",
    );
  });

  it("does not retain an owner request until a reply is delivered", async () => {
    const fake = new ScriptedOpenAI([
      response([], "送信前に中断されました。"),
      response([], "要点だけで返します。"),
    ]);
    const agent = new OpenAIDeliberationAgent({
      apiKey: "test-only",
      model: "test-model",
      client: fake.asClient(),
      logger: pino({ level: "silent" }),
    });
    const context = toolContext();

    await agent.deliberate({
      message: "中断された依頼",
      personaContext: "テスト人格",
      memoryContext: "なし",
      worldContext: "原点",
      toolContext: context,
    });
    await agent.deliberate({
      message: "もっと短く",
      personaContext: "テスト人格",
      memoryContext: "なし",
      worldContext: "原点",
      toolContext: context,
    });

    expect(JSON.stringify(fake.requests[1]?.input)).not.toContain(
      "中断された依頼",
    );
  });

  it("records a say tool message after Minecraft chat delivery", async () => {
    const fake = new ScriptedOpenAI([
      response([
        {
          type: "function_call",
          call_id: "call-say",
          name: "say",
          arguments: JSON.stringify({ message: "木の位置を確認しました。" }),
          status: "completed",
        },
      ]),
      response([], "送信処理を終えました。"),
      response([], "続けます。"),
    ]);
    const agent = new OpenAIDeliberationAgent({
      apiKey: "test-only",
      model: "test-model",
      client: fake.asClient(),
      logger: pino({ level: "silent" }),
    });
    const context = toolContext();
    const say = vi.fn(async () => undefined);
    context.game.say = say;

    const reply = await agent.deliberate({
      message: "木の位置を教えて",
      personaContext: "テスト人格",
      memoryContext: "なし",
      worldContext: "原点",
      toolContext: context,
    });
    agent.recordDeliveredReply("owner", "owner_message", reply.text);
    await agent.deliberate({
      message: "続けて",
      personaContext: "テスト人格",
      memoryContext: "なし",
      worldContext: "原点",
      toolContext: context,
    });

    expect(say).toHaveBeenCalledWith("木の位置を確認しました。");
    expect(JSON.stringify(fake.requests[2]?.input)).toContain(
      "木の位置を確認しました。",
    );
  });

  it("keeps a cancellation boundary after a delivered progress message", async () => {
    const fake = new ScriptedOpenAI([
      response([
        {
          type: "function_call",
          call_id: "call-progress",
          name: "say",
          arguments: JSON.stringify({ message: "木を探しています。" }),
          status: "completed",
        },
      ]),
      response([], "採取を続けます。"),
      response([], "停止済みなので再開の指示を待ちます。"),
    ]);
    const agent = new OpenAIDeliberationAgent({
      apiKey: "test-only",
      model: "test-model",
      client: fake.asClient(),
      logger: pino({ level: "silent" }),
    });
    const context = toolContext();

    await agent.deliberate({
      message: "木を集めて",
      personaContext: "テスト人格",
      memoryContext: "なし",
      worldContext: "原点",
      toolContext: context,
    });
    agent.recordCancelledRequest("owner", "owner_message");
    await agent.deliberate({
      message: "もっと短く",
      personaContext: "テスト人格",
      memoryContext: "なし",
      worldContext: "原点",
      toolContext: context,
    });

    expect(fake.requests[2]?.instructions).toContain(
      "直前の作業は停止済みです",
    );
    expect(JSON.stringify(fake.requests[2]?.input)).toContain(
      "明示的に再開するまで自動で続けません。",
    );
  });

  it.each([
    "再開していい？",
    "専門用語を使って説明して",
    "例を使って説明して",
    "例を作って説明して",
    "要約を作って",
    "手順を作って説明して",
    "説明を続けて",
    "もう戻ってきた？",
    "木を集めてくれた？",
    "拠点へ移動してくれた？",
    "説明を始めて",
  ])(
    "does not expose or execute action tools after a stop for %s",
    async (message) => {
      const fake = new ScriptedOpenAI([
        response([], "木を探します。"),
        response([
          {
            type: "function_call",
            call_id: "call-follow-after-stop",
            name: "follow_player",
            arguments: JSON.stringify({
              safeDistance: 3,
              maxDurationSeconds: 60,
            }),
            status: "completed",
          },
        ]),
        response([], "停止中です。明示的な再開指示を待ちます。"),
      ]);
      const agent = new OpenAIDeliberationAgent({
        apiKey: "test-only",
        model: "test-model",
        client: fake.asClient(),
        logger: pino({ level: "silent" }),
      });
      const context = toolContext();

      const firstReply = await agent.deliberate({
        message: "木を集めて",
        personaContext: "テスト人格",
        memoryContext: "なし",
        worldContext: "原点",
        toolContext: context,
      });
      agent.recordDeliveredReply("owner", "owner_message", firstReply.text);
      agent.recordCancelledRequest("owner", "owner_message");
      const permissionReply = await agent.deliberate({
        message,
        personaContext: "テスト人格",
        memoryContext: "なし",
        worldContext: "原点",
        toolContext: context,
      });

      expect(fake.requests[1]?.tools?.map((tool) => tool.name)).not.toContain(
        "follow_player",
      );
      expect(
        permissionReply.toolResults.find(
          ({ name }) => name === "follow_player",
        ),
      ).toMatchObject({
        result: {
          success: false,
          error: { code: "STOPPED_GOAL_ACTION_NOT_ALLOWED" },
        },
      });
      expect(permissionReply.text).toBe(
        "停止済みの作業は、明示的に再開するまで動かしません。",
      );
    },
  );

  it("does not let an older cancellation remove a newer pending owner turn", async () => {
    const fake = new ScriptedOpenAI([response([], "次の返答です。")]);
    const agent = new OpenAIDeliberationAgent({
      apiKey: "test-only",
      model: "test-model",
      client: fake.asClient(),
      logger: pino({ level: "silent" }),
    });

    const oldRequestId = agent.beginOwnerRequest("owner", "古い依頼");
    const newRequestId = agent.beginOwnerRequest("owner", "新しい依頼");
    expect(newRequestId).not.toBe(oldRequestId);

    agent.recordCancelledRequest("owner", "owner_message", oldRequestId);
    agent.recordDeliveredReply(
      "owner",
      "owner_message",
      "新しい返答です。",
      newRequestId,
    );
    await agent.deliberate({
      message: "続けて",
      personaContext: "テスト人格",
      memoryContext: "なし",
      worldContext: "原点",
      toolContext: toolContext(),
    });

    const input = JSON.stringify(fake.requests[0]?.input);
    expect(input).toContain("新しい依頼");
    expect(input).toContain("新しい返答です。");
    expect(input).not.toContain("古い依頼");
    expect(fake.requests[0]?.instructions).not.toContain(
      "直前の作業は停止済みです",
    );
  });

  it("keeps a concurrent status exchange between the earlier action request and its reply", async () => {
    const fake = new ScriptedOpenAI([
      response([], "木を集めました。"),
      response([], "確認しました。"),
    ]);
    const agent = new OpenAIDeliberationAgent({
      apiKey: "test-only",
      model: "test-model",
      client: fake.asClient(),
      logger: pino({ level: "silent" }),
    });

    const requestId = agent.beginOwnerRequest("owner", "木を集めて");
    agent.recordDeliveredOwnerExchange(
      "owner",
      "今何してる",
      "木を探しています。",
    );
    await agent.deliberate({
      message: "木を集めて",
      personaContext: "テスト人格",
      memoryContext: "なし",
      worldContext: "原点",
      toolContext: toolContext(),
      conversationRequestId: requestId,
    });
    agent.recordDeliveredReply(
      "owner",
      "owner_message",
      "木を集めました。",
      requestId,
    );
    await agent.deliberate({
      message: "それはどうなった",
      personaContext: "テスト人格",
      memoryContext: "なし",
      worldContext: "原点",
      toolContext: toolContext(),
    });

    const history = JSON.stringify(fake.requests[1]?.input);
    expect(history.indexOf("木を集めて")).toBeLessThan(
      history.indexOf("今何してる"),
    );
    expect(history.indexOf("今何してる")).toBeLessThan(
      history.indexOf("木を探しています。"),
    );
    expect(history.indexOf("木を探しています。")).toBeLessThan(
      history.indexOf("木を集めました。"),
    );
  });

  it("retains a delivered status exchange when the earlier action is cancelled", async () => {
    const fake = new ScriptedOpenAI([response([], "確認しました。")]);
    const agent = new OpenAIDeliberationAgent({
      apiKey: "test-only",
      model: "test-model",
      client: fake.asClient(),
      logger: pino({ level: "silent" }),
    });

    const requestId = agent.beginOwnerRequest("owner", "木を集めて");
    agent.recordDeliveredOwnerExchange(
      "owner",
      "今何してる",
      "木を探しています。",
    );
    agent.recordCancelledRequest("owner", "owner_message", requestId);
    await agent.deliberate({
      message: "なぜ止まった",
      personaContext: "テスト人格",
      memoryContext: "なし",
      worldContext: "原点",
      toolContext: toolContext(),
    });

    const history = JSON.stringify(fake.requests[0]?.input);
    expect(history).not.toContain("木を集めて");
    expect(history).toContain("今何してる");
    expect(history).toContain("木を探しています。");
  });

  it("retains an unsupported resource and quantity when the next turn says to gather it", async () => {
    const fake = new ScriptedOpenAI([
      response([], "鉄を20個ですね。確認しました。"),
      response([], "鉄の収集操作は提供していません。原木なら収集できます。"),
    ]);
    const agent = new OpenAIDeliberationAgent({
      apiKey: "test-only",
      model: "test-model",
      client: fake.asClient(),
      logger: pino({ level: "silent" }),
    });
    const context = toolContext();

    const firstReply = await agent.deliberate({
      message: "鉄が必要で、数量は20個です。",
      personaContext: "テスト人格",
      memoryContext: "なし",
      worldContext: "原点",
      toolContext: context,
    });
    agent.recordDeliveredReply("owner", "owner_message", firstReply.text);
    await agent.deliberate({
      message: "集めて。",
      personaContext: "テスト人格",
      memoryContext: "なし",
      worldContext: "原点",
      toolContext: context,
    });

    const secondInput = JSON.stringify(fake.requests[1]?.input);
    expect(secondInput).toContain("鉄");
    expect(secondInput).toContain("20個");
    expect(fake.requests[1]?.instructions).toContain("提供していない操作");
    expect(fake.requests[1]?.instructions).toContain("実行済みと扱わず");
    expect(fake.requests[1]?.instructions).toContain(
      "同じ質問を繰り返さないでください",
    );
    expect(fake.requests[1]?.instructions).toContain(
      "内部のkind、phase、status、error codeはそのまま利用者へ出さず",
    );
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

  it("keeps runtime reassessment reports concise when an action call is denied", async () => {
    const fake = new ScriptedOpenAI([
      response([
        {
          type: "function_call",
          call_id: "call-runtime-action",
          name: "move_to",
          arguments: JSON.stringify({ x: 1, y: 64, z: 0, radius: 2 }),
          status: "completed",
        },
      ]),
      response(
        [
          {
            type: "message",
            id: "message-runtime-final",
            role: "assistant",
            status: "completed",
            content: [
              {
                type: "output_text",
                text: "危険が続いています。作業状態を確認してください。",
                annotations: [],
              },
            ],
          },
        ],
        "危険が続いています。作業状態を確認してください。",
      ),
    ]);
    const agent = new OpenAIDeliberationAgent({
      apiKey: "test-only",
      model: "test-model",
      client: fake.asClient(),
      logger: pino({ level: "silent" }),
    });

    const reply = await agent.deliberate({
      message: "状態を再確認して",
      personaContext: "テスト人格",
      memoryContext: "なし",
      worldContext: "確認済み作業状態: 実行中",
      toolContext: toolContext("runtime_reassessment"),
    });

    expect(reply.text).toBe("危険が続いています。作業状態を確認してください。");
    const offeredTools = fake.requests[0]?.tools ?? [];
    expect(offeredTools.map(({ name }) => name)).toEqual(
      expect.arrayContaining([
        "observe_status",
        "observe_surroundings",
        "recall_memory",
        "get_delivery_targets",
      ]),
    );
    expect(offeredTools.map(({ name }) => name)).not.toContain("move_to");
    expect(reply.text).not.toContain("状態再評価では観測と記憶参照以外");
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
