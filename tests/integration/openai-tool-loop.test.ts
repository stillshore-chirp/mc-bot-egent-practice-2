import pino from "pino";
import { describe, expect, it, vi } from "vitest";

import { OpenAIDeliberationAgent } from "../../src/agent/openai-agent.js";
import type {
  GameController,
  MemoryPort,
  ToolContext,
} from "../../src/tools/contracts.js";
import { ToolExecutor } from "../../src/tools/executor.js";
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
    observeActionCandidates: async () => [],
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
    mineBlock: async () => ({
      before: status,
      after: status,
      outcome: "completed",
      summary: "採掘しました。",
    }),
    collectItem: async () => ({
      before: status,
      after: status,
      outcome: "completed",
      summary: "回収しました。",
    }),
    craftItem: async () => ({
      before: status,
      after: status,
      outcome: "completed",
      summary: "クラフトしました。",
    }),
    placeBlock: async () => ({
      before: status,
      after: status,
      outcome: "completed",
      summary: "設置しました。",
    }),
    smeltItem: async () => ({
      before: status,
      after: status,
      outcome: "completed",
      summary: "精錬しました。",
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
  it("starts follow with bounded defaults when the owner omits distance and duration", async () => {
    const fake = new ScriptedOpenAI([
      response([
        {
          type: "function_call",
          call_id: "call-follow-defaults",
          name: "follow_player",
          arguments: JSON.stringify({
            safeDistance: null,
            maxDurationSeconds: null,
          }),
          status: "completed",
        },
      ]),
      response(
        [
          {
            type: "message",
            id: "message-follow-defaults",
            role: "assistant",
            status: "completed",
            content: [
              {
                type: "output_text",
                text: "設定済みの安全距離で追従を開始しました。",
                annotations: [],
              },
            ],
          },
        ],
        "設定済みの安全距離で追従を開始しました。",
      ),
    ]);
    const context = toolContext();
    let received: { distance: number; duration: number } | undefined;
    context.game.followOwner = async (distance, duration) => {
      received = { distance, duration };
      return {
        before: status,
        after: status,
        outcome: "completed",
        summary: "追従を開始しました。",
      };
    };
    const agent = new OpenAIDeliberationAgent({
      apiKey: "test-only",
      model: "test-model",
      client: fake.asClient(),
      logger: pino({ level: "silent" }),
    });

    const reply = await agent.deliberate({
      message: "ついてきて",
      personaContext: "テスト人格",
      memoryContext: "なし",
      worldContext: JSON.stringify(status),
      toolContext: context,
    });

    expect(reply.text).toContain("追従を開始");
    expect(received).toEqual({ distance: 3, duration: 60 });
  });

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
    expect(reply.toolResults[1]?.result).toMatchObject({ success: true });
    expect(context.safeActionAuthorization).toMatchObject({
      allowedResources: ["birch_log"],
      targetItem: "birch_log",
      selectionRequired: false,
    });
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

  it("offers goal planning for a new resource goal after stopping an earlier task", async () => {
    const fake = new ScriptedOpenAI([
      response([], "木を探します。"),
      response([], "鉄の調達方法を確認します。"),
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

    await agent.deliberate({
      message: "鉄のインゴットを2個集めたい",
      personaContext: "テスト人格",
      memoryContext: "なし",
      worldContext: "原点",
      toolContext: {
        ...context,
        safeActionAuthorization: {
          kind: "owner_bounded_resource",
          goal: "鉄のインゴットを2個集めたい",
          allowedResources: ["iron_ore", "deepslate_iron_ore"],
          targetItem: "iron_ingot",
          targetCount: 2,
          maxCount: 2,
        },
      },
    });

    const availableTools = fake.requests[1]?.tools?.map((tool) => tool.name);
    expect(availableTools).toContain("plan_safe_action");
    expect(availableTools).toContain("mine_block");
    expect(availableTools).toContain("smelt_item");
  });

  it("rejects an out-of-scope plan before an earlier harmless step runs", async () => {
    const context = toolContext();
    const actions: string[] = [];
    context.allowedActionToolNames = ["plan_safe_action"];
    context.game.say = async () => {
      actions.push("say");
    };
    context.game.gatherResource = async () => {
      actions.push("gather_resource");
      return {
        before: status,
        after: status,
        outcome: "completed",
        summary: "収集しました。",
      };
    };

    const result = await new ToolExecutor().execute(
      "plan_safe_action",
      JSON.stringify({
        goal: "collect_resource",
        count: 1,
        mode: "delegated",
        candidateId: null,
      }),
      context,
    );

    expect(result).toMatchObject({
      success: false,
      error: { code: "OWNER_ACTION_SCOPE_NOT_ALLOWED" },
    });
    expect(actions).toEqual([]);
  });

  it("does not mine ore when the requested ingot needs prohibited smelting", async () => {
    const context = toolContext();
    const actions: string[] = [];
    context.allowedActionToolNames = ["plan_safe_action", "mine_block"];
    context.safeActionAuthorization = {
      kind: "owner_bounded_resource",
      goal: "鉄インゴットを1個集めたい",
      allowedResources: ["iron_ore"],
      targetItem: "iron_ingot",
      targetCount: 1,
      maxCount: 1,
    };
    context.safeActionAuthorizationUsage = {
      remainingCount: 1,
      consumed: false,
    };
    context.game.findSafeActionCandidates = async () => {
      actions.push("observe_candidates");
      return [];
    };

    const result = await new ToolExecutor().execute(
      "plan_safe_action",
      JSON.stringify({
        goal: "鉄インゴットを1個集めたい",
        count: 1,
        mode: "delegated",
        candidateId: null,
      }),
      context,
    );

    expect(result).toMatchObject({
      success: false,
      error: { code: "OWNER_GOAL_REQUIRES_DISALLOWED_STEP" },
    });
    expect(actions).toEqual([]);
    expect(context.safeActionAuthorizationUsage.consumed).toBe(false);
  });

  it("allows a replacement return but rejects gathering prohibited in that turn and the next", async () => {
    const gatherCall = (callId: string) => ({
      type: "function_call",
      call_id: callId,
      name: "gather_resource",
      arguments: JSON.stringify({
        resource: "oak_log",
        count: 1,
        commitmentId: null,
      }),
      status: "completed",
    });
    const fake = new ScriptedOpenAI([
      response([], "木を探します。"),
      response([
        gatherCall("call-prohibited"),
        {
          type: "function_call",
          call_id: "call-return",
          name: "return_to_player",
          arguments: JSON.stringify({ safeDistance: 3 }),
          status: "completed",
        },
      ]),
      response([], "拠点への帰還を確認しました。"),
      response([gatherCall("call-still-prohibited")]),
      response([], "採取は再開しません。"),
    ]);
    const agent = new OpenAIDeliberationAgent({
      apiKey: "test-only",
      model: "test-model",
      client: fake.asClient(),
      logger: pino({ level: "silent" }),
    });
    const context = toolContext();
    const request = {
      personaContext: "テスト人格",
      memoryContext: "なし",
      worldContext: "原点",
      toolContext: context,
    };

    const first = await agent.deliberate({ ...request, message: "木を集めて" });
    agent.recordDeliveredReply("owner", "owner_message", first.text);
    agent.recordCancelledRequest("owner", "owner_message");
    const replacement = await agent.deliberate({
      ...request,
      message: "採取は再開しないで、拠点に戻って",
    });
    expect(fake.requests[1]?.tools?.map((tool) => tool.name)).toContain(
      "return_to_player",
    );
    expect(fake.requests[1]?.tools?.map((tool) => tool.name)).not.toContain(
      "gather_resource",
    );
    expect(replacement.toolResults).toMatchObject([
      {
        name: "gather_resource",
        result: {
          success: false,
          error: { code: "OWNER_ACTION_SCOPE_NOT_ALLOWED" },
        },
      },
      { name: "return_to_player", result: { success: true } },
    ]);
    agent.recordDeliveredReply("owner", "owner_message", replacement.text);

    const next = await agent.deliberate({ ...request, message: "続けて" });
    expect(fake.requests[3]?.tools?.map((tool) => tool.name)).not.toContain(
      "gather_resource",
    );
    expect(next.toolResults[0]?.result).toMatchObject({
      success: false,
      error: { code: "OWNER_ACTION_SCOPE_NOT_ALLOWED" },
    });
  });

  it("keeps memory writes outside a replacement movement request", async () => {
    const fake = new ScriptedOpenAI([
      response([], "採取を始めます。"),
      response([
        {
          type: "function_call",
          call_id: "call-memory-write",
          name: "remember_player_fact",
          arguments: JSON.stringify({
            subject: "利用者",
            predicate: "希望",
            value: "帰還",
          }),
          status: "completed",
        },
      ]),
      response([], "記憶の更新は行いません。"),
    ]);
    const agent = new OpenAIDeliberationAgent({
      apiKey: "test-only",
      model: "test-model",
      client: fake.asClient(),
      logger: pino({ level: "silent" }),
    });
    const request = {
      personaContext: "テスト人格",
      memoryContext: "なし",
      worldContext: "原点",
      toolContext: toolContext(),
    };

    const first = await agent.deliberate({ ...request, message: "木を集めて" });
    agent.recordDeliveredReply("owner", "owner_message", first.text);
    agent.recordCancelledRequest("owner", "owner_message");
    const replacement = await agent.deliberate({
      ...request,
      message: "記憶しないで、拠点に戻って",
    });

    const advertised = fake.requests[1]?.tools?.map((tool) => tool.name);
    expect(advertised).toContain("return_to_player");
    expect(advertised).not.toContain("remember_player_fact");
    expect(advertised).not.toContain("forget_delivery_target");
    expect(replacement.toolResults[0]?.result).toMatchObject({
      success: false,
      error: { code: "OWNER_ACTION_SCOPE_NOT_ALLOWED" },
    });
  });

  it("keeps an explicitly requested delivery registration available after a stop", async () => {
    const fake = new ScriptedOpenAI([
      response([], "木を探します。"),
      response([
        {
          type: "function_call",
          call_id: "call-unrelated-forget",
          name: "forget_delivery_target",
          arguments: JSON.stringify({ kind: "chest" }),
          status: "completed",
        },
        {
          type: "function_call",
          call_id: "call-unrelated-completion",
          name: "complete_commitment",
          arguments: JSON.stringify({
            commitmentId: "unrelated",
            outcome: "完了",
            basis: "owner_confirmation",
            receiptId: null,
            evidenceSummary: "未確認",
          }),
          status: "completed",
        },
        {
          type: "function_call",
          call_id: "call-wrong-target-kind",
          name: "register_delivery_target",
          arguments: JSON.stringify({ kind: "chest", position: null }),
          status: "completed",
        },
      ]),
      response([], "登録する対象を確認します。"),
    ]);
    const agent = new OpenAIDeliberationAgent({
      apiKey: "test-only",
      model: "test-model",
      client: fake.asClient(),
      logger: pino({ level: "silent" }),
    });
    const request = {
      personaContext: "テスト人格",
      memoryContext: "なし",
      worldContext: "原点",
      toolContext: toolContext(),
    };

    const first = await agent.deliberate({ ...request, message: "木を集めて" });
    agent.recordDeliveredReply("owner", "owner_message", first.text);
    agent.recordCancelledRequest("owner", "owner_message");
    const registration = await agent.deliberate({
      ...request,
      message: "拠点を登録して",
    });

    expect(fake.requests[1]?.tools?.map((tool) => tool.name)).toContain(
      "register_delivery_target",
    );
    expect(fake.requests[1]?.tools?.map((tool) => tool.name)).not.toContain(
      "gather_resource",
    );
    expect(fake.requests[1]?.tools?.map((tool) => tool.name)).not.toContain(
      "forget_delivery_target",
    );
    expect(fake.requests[1]?.tools?.map((tool) => tool.name)).not.toContain(
      "complete_commitment",
    );
    expect(registration.toolResults.map(({ result }) => result)).toMatchObject([
      {
        success: false,
        error: { code: "OWNER_ACTION_SCOPE_NOT_ALLOWED" },
      },
      {
        success: false,
        error: { code: "OWNER_ACTION_SCOPE_NOT_ALLOWED" },
      },
      {
        success: false,
        error: { code: "OWNER_ACTION_TARGET_NOT_ALLOWED" },
      },
    ]);
  });

  it.each([
    ["拠点を忘れて", "forget_delivery_target"],
    ["この場所を覚えて", "remember_location"],
    ["この約束を完了として記録して", "complete_commitment"],
  ])("scopes a stopped memory request %s to %s", async (message, allowed) => {
    const fake = new ScriptedOpenAI([
      response([], "前の作業を始めます。"),
      response([], "依頼を確認しました。"),
    ]);
    const agent = new OpenAIDeliberationAgent({
      apiKey: "test-only",
      model: "test-model",
      client: fake.asClient(),
      logger: pino({ level: "silent" }),
    });
    const request = {
      personaContext: "テスト人格",
      memoryContext: "なし",
      worldContext: "原点",
      toolContext: toolContext(),
    };
    const first = await agent.deliberate({ ...request, message: "木を集めて" });
    agent.recordDeliveredReply("owner", "owner_message", first.text);
    agent.recordCancelledRequest("owner", "owner_message");
    await agent.deliberate({ ...request, message });

    const advertised = fake.requests[1]?.tools?.map((tool) => tool.name) ?? [];
    expect(advertised).toContain(allowed);
    expect(
      advertised.filter((name) =>
        [
          "register_delivery_target",
          "forget_delivery_target",
          "remember_player_fact",
          "remember_location",
          "set_commitment",
          "complete_commitment",
        ].includes(name),
      ),
    ).toEqual([allowed]);
  });

  it.each([
    ["拠点ではなくチェストを登録して", "home"],
    ["チェストじゃなく拠点を登録して", "chest"],
    ["拠点でなくチェストを忘れて", "home"],
  ] as const)(
    "does not mutate a contrasted delivery target in %s",
    async (message, rejectedKind) => {
      const toolName = message.includes("忘れて")
        ? "forget_delivery_target"
        : "register_delivery_target";
      const fake = new ScriptedOpenAI([
        response([], "停止しました。"),
        response([
          {
            type: "function_call",
            call_id: "call-contrasted-target",
            name: toolName,
            arguments: JSON.stringify(
              toolName === "forget_delivery_target"
                ? { kind: rejectedKind }
                : { kind: rejectedKind, position: null },
            ),
            status: "completed",
          },
        ]),
        response([], "対象を確認しました。"),
      ]);
      const agent = new OpenAIDeliberationAgent({
        apiKey: "test-only",
        model: "test-model",
        client: fake.asClient(),
        logger: pino({ level: "silent" }),
      });
      const request = {
        personaContext: "テスト人格",
        memoryContext: "なし",
        worldContext: "原点",
        toolContext: toolContext(),
      };
      const first = await agent.deliberate({
        ...request,
        message: "木を集めて",
      });
      agent.recordDeliveredReply("owner", "owner_message", first.text);
      agent.recordCancelledRequest("owner", "owner_message");
      const result = await agent.deliberate({ ...request, message });

      expect(fake.requests[1]?.tools?.map((tool) => tool.name)).toContain(
        toolName,
      );
      expect(result.toolResults[0]?.result).toMatchObject({
        success: false,
        error: { code: "OWNER_ACTION_TARGET_NOT_ALLOWED" },
      });
    },
  );

  it.each([
    "この約束はまだ未完了だと記録して",
    "この約束は完了していないと記録して",
    "この約束はまだ済んでいないと記録して",
  ])("does not complete a negated commitment in %s", async (message) => {
    const fake = new ScriptedOpenAI([
      response([], "停止しました。"),
      response([], "未完了として受け取りました。"),
    ]);
    const agent = new OpenAIDeliberationAgent({
      apiKey: "test-only",
      model: "test-model",
      client: fake.asClient(),
      logger: pino({ level: "silent" }),
    });
    const request = {
      personaContext: "テスト人格",
      memoryContext: "なし",
      worldContext: "原点",
      toolContext: toolContext(),
    };
    const first = await agent.deliberate({ ...request, message: "木を集めて" });
    agent.recordDeliveredReply("owner", "owner_message", first.text);
    agent.recordCancelledRequest("owner", "owner_message");
    await agent.deliberate({ ...request, message });

    expect(fake.requests[1]?.tools?.map((tool) => tool.name)).not.toContain(
      "complete_commitment",
    );
  });

  it("does not turn a generic restart into authorization for every memory write", async () => {
    const fake = new ScriptedOpenAI([
      response([], "登録を始めます。"),
      response([], "登録する内容をもう一度指定してください。"),
    ]);
    const agent = new OpenAIDeliberationAgent({
      apiKey: "test-only",
      model: "test-model",
      client: fake.asClient(),
      logger: pino({ level: "silent" }),
    });
    const request = {
      personaContext: "テスト人格",
      memoryContext: "なし",
      worldContext: "原点",
      toolContext: toolContext(),
    };
    const first = await agent.deliberate({
      ...request,
      message: "拠点を登録して",
    });
    agent.recordDeliveredReply("owner", "owner_message", first.text);
    agent.recordCancelledRequest("owner", "owner_message");
    await agent.deliberate({ ...request, message: "続けて" });

    const advertised = fake.requests[1]?.tools?.map((tool) => tool.name) ?? [];
    expect(advertised).toContain("recall_memory");
    expect(advertised).not.toContain("register_delivery_target");
    expect(advertised).not.toContain("forget_delivery_target");
    expect(advertised).not.toContain("complete_commitment");
  });

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
