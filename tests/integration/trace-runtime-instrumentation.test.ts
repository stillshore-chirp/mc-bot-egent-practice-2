import pino from "pino";
import { describe, expect, it } from "vitest";

import { OpenAIDeliberationAgent } from "../../src/agent/openai-agent.js";
import type { AppConfig } from "../../src/config/schema.js";
import type { MemoryStore } from "../../src/memory/store.js";
import type { PersonaCore } from "../../src/persona/persona.js";
import { TaskRuntime } from "../../src/runtime/task-service.js";
import { MoveToSkill } from "../../src/skills/move-to.js";
import { TraceService } from "../../src/trace/service.js";
import { TraceStore } from "../../src/trace/store.js";
import type {
  GameController,
  MemoryPort,
  ToolContext,
} from "../../src/tools/contracts.js";
import { ToolExecutor } from "../../src/tools/executor.js";
import { CompanionContextFactory } from "../../src/app/context-factory.js";
import { ActionArbiter } from "../../src/runtime/action-arbiter.js";
import { ScriptedOpenAI } from "../support/fake-openai.js";
import { FakeMinecraft } from "../support/fake-minecraft.js";
import { InMemoryTaskStore } from "../support/in-memory-task-store.js";

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

function game(): GameController {
  return {
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
      summary: "追従を確認しました。",
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
      summary: "到達を確認しました。",
    }),
    gatherResource: async () => ({
      before: status,
      after: status,
      outcome: "completed",
      summary: "収集を確認しました。",
    }),
    returnToOwner: async () => ({
      before: status,
      after: status,
      outcome: "completed",
      summary: "帰還を確認しました。",
    }),
    currentPosition: async () => status.position,
  };
}

function memory(): MemoryPort {
  return {
    rememberPlayerFact: () => ({ id: "memory-record" }),
    rememberLocation: () => ({ id: "location-record" }),
    recall: () => [],
    setCommitment: () => ({ id: "commitment-record" }),
    getCommitment: () => undefined,
    completeCommitment: () => ({ id: "commitment-record" }),
  };
}

function toolContext(): ToolContext {
  return {
    correlationId: "TRACE_RAW_CORRELATION_ID",
    requesterUsername: "owner",
    authorizedOwnerUsername: "owner",
    playerId: "TRACE_RAW_PLAYER_ID",
    signal: new AbortController().signal,
    requestKind: "owner_message",
    executionEvidence: { verifiedActionReceipts: [] },
    game: game(),
    memory: memory(),
    limits: {
      maxMoveDistance: 128,
      maxGatherCount: 16,
      followDistance: 3,
      memoryContextLimit: 10,
    },
  };
}

function config(): AppConfig {
  return {
    minecraft: {
      host: "127.0.0.1",
      port: 25_565,
      username: "companion",
      auth: "offline",
      version: "1.21.11",
    },
    ownerUsername: "owner",
    openai: { apiKey: "test-only", model: "gpt-5.6-luna" },
    databasePath: ":memory:",
    personaPath: "test-persona.json",
    logLevel: "silent",
    limits: {
      maxMoveDistance: 128,
      maxGatherCount: 16,
      taskTimeoutMs: 1_000,
      skillRetryLimit: 0,
      followDistance: 3,
      hungerThreshold: 14,
      memoryContextLimit: 10,
    },
    reconnect: { enabled: false, maxAttempts: 0, delayMs: 250 },
    dashboard: {
      enabled: false,
      host: "127.0.0.1",
      port: 4_310,
      staticDirectory: "dashboard/dist",
      maxAgeDays: 30,
      maxTraces: 100,
    },
  };
}

function persona(): PersonaCore {
  return {
    version: 1,
    name: "コンパニオン",
    speakingStyle: "簡潔に話す",
    values: ["安全を優先する"],
    operatingPrinciples: ["観測結果を確認する"],
    prohibitions: ["未確認の成功を断定しない"],
  };
}

function trace(): {
  readonly service: TraceService;
  readonly store: TraceStore;
} {
  const store = TraceStore.open(":memory:");
  return {
    store,
    service: new TraceService(store, pino({ level: "silent" })),
  };
}

function spanStages(store: TraceStore, traceId: string): Set<string> {
  return new Set(store.getTrace(traceId)?.spans.map(({ stage }) => stage));
}

describe("runtime trace instrumentation", () => {
  it("records context, memory reads, and perception without raw request data", async () => {
    const { service, store } = trace();
    const tasks = new TaskRuntime(
      new InMemoryTaskStore(),
      async () => undefined,
    );
    const memoryStore = {
      getRelationship: () => ({
        playerId: "TRACE_RAW_PLAYER_ID",
        trust: 50,
        intimacy: 20,
        state: {},
        updatedAt: new Date().toISOString(),
      }),
      getLifeState: () => undefined,
      searchWorldMemories: () => [],
      listRecentTaskRuns: () => [],
      recall: () => [],
    } as unknown as MemoryStore;
    const factory = new CompanionContextFactory(
      config(),
      "TRACE_RAW_PLAYER_ID",
      memoryStore,
      memory(),
      persona(),
      game(),
      tasks,
      service,
    );
    const session = await service.startTrace("利用者依頼を受信");
    await service.withTrace(session, () =>
      factory.create(
        "TRACE_RAW_USERNAME",
        "TRACE_RAW_PROMPT",
        new AbortController().signal,
        "TRACE_RAW_CORRELATION_ID",
        "owner_message",
      ),
    );
    await session.complete("succeeded", { summary: "コンテキストを構築" });

    const stages = spanStages(store, session.traceId);
    expect(stages).toEqual(
      new Set(["request", "context", "memory_read", "perception"]),
    );
    const detail = store.getTrace(session.traceId);
    expect(JSON.stringify(detail)).not.toContain("TRACE_RAW_");
    store.close();
  });

  it("keeps deliberation, tool, action, verification, and memory-write summaries redacted", async () => {
    const { service, store } = trace();
    const fake = new ScriptedOpenAI([
      {
        id: "TRACE_RAW_RESPONSE_ID",
        object: "response",
        created_at: 0,
        status: "completed",
        output: [
          {
            type: "function_call",
            call_id: "TRACE_RAW_CALL_ID",
            name: "move_to",
            arguments: JSON.stringify({
              x: 12.25,
              y: 64,
              z: 6.5,
              radius: 2,
            }),
            status: "completed",
          },
        ],
        output_text: "",
        usage: null,
      },
      {
        id: "TRACE_RAW_RESPONSE_ID_2",
        object: "response",
        created_at: 0,
        status: "completed",
        output: [],
        output_text: "TRACE_RAW_MODEL_RESPONSE",
        usage: null,
      },
    ]);
    const executor = new ToolExecutor(service);
    const agent = new OpenAIDeliberationAgent({
      apiKey: "test-only",
      model: "gpt-5.6-luna",
      client: fake.asClient(),
      executor,
      traceService: service,
      logger: pino({ level: "silent" }),
    });
    const context = toolContext();
    const session = await service.startTrace("利用者依頼を受信");
    await service.withTrace(session, async () => {
      const reply = await agent.deliberate({
        message: "TRACE_RAW_PROMPT",
        personaContext: "固定人格要約",
        memoryContext: "TRACE_RAW_MEMORY_CONTENT",
        worldContext: "固定Minecraft観測要約",
        toolContext: context,
      });
      expect(reply.text).toBe("到達を確認しました。");
      await executor.execute(
        "remember_player_fact",
        JSON.stringify({
          subject: "TRACE_RAW_MEMORY_SUBJECT",
          predicate: "TRACE_RAW_MEMORY_PREDICATE",
          value: "TRACE_RAW_MEMORY_VALUE",
        }),
        context,
      );
    });
    await session.complete("succeeded", { summary: "応答を送信" });

    const detail = store.getTrace(session.traceId);
    expect(spanStages(store, session.traceId)).toEqual(
      new Set([
        "request",
        "deliberation",
        "tool",
        "minecraft_action",
        "verification",
        "memory_write",
      ]),
    );
    const action = detail?.spans.find(
      ({ stage }) => stage === "minecraft_action",
    );
    const verification = detail?.spans.find(
      ({ stage }) => stage === "verification",
    );
    expect(action).toBeDefined();
    expect(verification?.parentSpanId).toBe(action?.spanId);
    expect(JSON.stringify(detail)).not.toContain("TRACE_RAW_");
    store.close();
  });

  it("places a deterministic skill and its verification under the active Minecraft action", async () => {
    const { service, store } = trace();
    const minecraft = new FakeMinecraft();
    const runtime = new TaskRuntime(
      new InMemoryTaskStore(),
      () => minecraft.stopCurrentAction(),
      service,
    );
    const skill = new MoveToSkill(minecraft, runtime, new ActionArbiter());
    const actionGame = game();
    actionGame.moveTo = async (destination, range, signal) => {
      if (signal.aborted) throw signal.reason;
      const result = await skill.run({
        position: { ...destination },
        range,
        timeoutMs: 1_000,
      });
      return result.status === "completed"
        ? {
            before: status,
            after: status,
            outcome: "completed" as const,
            summary: "到達を確認しました。",
          }
        : {
            before: status,
            after: status,
            outcome:
              result.status === "cancelled"
                ? ("cancelled" as const)
                : ("failed" as const),
            summary: "到達を確認できませんでした。",
          };
    };
    const executor = new ToolExecutor(service);
    const session = await service.startTrace("利用者依頼を受信");
    const result = await service.withTrace(session, () =>
      executor.execute(
        "move_to",
        JSON.stringify({ x: 12.25, y: 64, z: 6.5, radius: 1 }),
        { ...toolContext(), game: actionGame },
      ),
    );
    expect(result.success).toBe(true);
    await session.complete("succeeded", { summary: "応答を送信" });

    const detail = store.getTrace(session.traceId);
    expect(spanStages(store, session.traceId)).toEqual(
      new Set(["request", "tool", "minecraft_action", "skill", "verification"]),
    );
    const toolSpan = detail?.spans.find(({ name }) => name === "tool:move_to");
    const action = detail?.spans.find(
      ({ stage }) => stage === "minecraft_action",
    );
    const skillSpan = detail?.spans.find(({ stage }) => stage === "skill");
    const verification = detail?.spans.find(
      ({ stage }) => stage === "verification",
    );
    const phaseSpans = detail?.spans.filter(
      ({ stage, parentSpanId }) =>
        stage === "skill" && parentSpanId === skillSpan?.spanId,
    );
    expect(action?.parentSpanId).toBe(toolSpan?.spanId);
    expect(skillSpan?.parentSpanId).toBe(action?.spanId);
    expect(verification?.parentSpanId).toBe(action?.spanId);
    expect(phaseSpans?.map(({ name }) => name)).toEqual([
      "phase:starting",
      "phase:move_to",
    ]);
    for (const phase of phaseSpans ?? []) {
      expect(phase.status).toBe("succeeded");
      expect(phase.metrics?.durationMs).toEqual(expect.any(Number));
    }
    expect(JSON.stringify(detail)).not.toContain("12.25");
    expect(JSON.stringify(detail)).not.toContain("6.5");
    store.close();
  });

  it("leaves the active skill phase waiting when a task is suspended", async () => {
    const { service, store } = trace();
    const runtime = new TaskRuntime(
      new InMemoryTaskStore(),
      async () => undefined,
      service,
    );
    const session = await service.startTrace("利用者依頼を受信");
    let resolveStarted!: () => void;
    const started = new Promise<void>((resolve) => {
      resolveStarted = resolve;
    });
    const running = service.withTrace(session, () =>
      runtime.run("long_running_skill", {}, async ({ signal }) => {
        resolveStarted();
        await new Promise<void>((resolve) => {
          if (signal.aborted) {
            resolve();
            return;
          }
          signal.addEventListener("abort", () => resolve(), { once: true });
        });
        throw signal.reason;
      }),
    );
    await started;
    await runtime.suspend("安全介入");
    const result = await running;

    expect(result.status).toBe("suspended");
    const detail = store.getTrace(session.traceId);
    const skillSpan = detail?.spans.find(
      ({ stage, name }) => stage === "skill" && name.startsWith("skill:"),
    );
    const phaseSpan = detail?.spans.find(
      ({ stage, name }) => stage === "skill" && name.startsWith("phase:"),
    );
    expect(skillSpan?.status).toBe("waiting");
    expect(phaseSpan?.status).toBe("waiting");
    expect(phaseSpan?.startedAt).toBeDefined();
    expect(phaseSpan?.endedAt).toBeUndefined();
    store.close();
  });

  it("closes the active skill phase as cancelled when a task is cancelled", async () => {
    const { service, store } = trace();
    const runtime = new TaskRuntime(
      new InMemoryTaskStore(),
      async () => undefined,
      service,
    );
    const session = await service.startTrace("利用者依頼を受信");
    let resolveStarted!: () => void;
    const started = new Promise<void>((resolve) => {
      resolveStarted = resolve;
    });
    const running = service.withTrace(session, () =>
      runtime.run("long_running_skill", {}, async ({ signal }) => {
        resolveStarted();
        await new Promise<void>((resolve) => {
          if (signal.aborted) {
            resolve();
            return;
          }
          signal.addEventListener("abort", () => resolve(), { once: true });
        });
        throw signal.reason;
      }),
    );
    await started;
    await runtime.cancel("利用者停止");
    const result = await running;

    expect(result.status).toBe("cancelled");
    const detail = store.getTrace(session.traceId);
    const skillSpan = detail?.spans.find(
      ({ stage, name }) => stage === "skill" && name.startsWith("skill:"),
    );
    const phaseSpan = detail?.spans.find(
      ({ stage, name }) => stage === "skill" && name.startsWith("phase:"),
    );
    expect(skillSpan?.status).toBe("cancelled");
    expect(phaseSpan?.status).toBe("cancelled");
    expect(phaseSpan?.endedAt).toBeDefined();
    expect(phaseSpan?.metrics?.durationMs).toEqual(expect.any(Number));
    store.close();
  });

  it("keeps repeated real phase advances as separate child spans", async () => {
    const { service, store } = trace();
    const runtime = new TaskRuntime(
      new InMemoryTaskStore(),
      async () => undefined,
      service,
    );
    const session = await service.startTrace("利用者依頼を受信");
    await service.withTrace(session, () =>
      runtime.run("retrying_skill", {}, async (context) => {
        await context.advance("attempt");
        await context.advance("attempt");
        return {};
      }),
    );

    const detail = store.getTrace(session.traceId);
    const skillSpan = detail?.spans.find(
      ({ stage, name }) => stage === "skill" && name.startsWith("skill:"),
    );
    const phaseSpans = detail?.spans.filter(
      ({ stage, parentSpanId }) =>
        stage === "skill" && parentSpanId === skillSpan?.spanId,
    );
    expect(phaseSpans?.map(({ name }) => name)).toEqual([
      "phase:starting",
      "phase:attempt",
      "phase:attempt",
    ]);
    expect(phaseSpans?.every(({ status }) => status === "succeeded")).toBe(
      true,
    );
    expect(
      phaseSpans?.every(({ metrics }) => metrics?.durationMs !== undefined),
    ).toBe(true);
    store.close();
  });

  it("records retry attempts, scheduled delay, and retry_of causality", async () => {
    const { service, store } = trace();
    const runtime = new TaskRuntime(
      new InMemoryTaskStore(),
      async () => undefined,
      service,
    );
    const session = await service.startTrace("利用者依頼を受信");
    let attempts = 0;
    const result = await service.withTrace(session, () =>
      runtime.run("retrying_skill", {}, async (context) => {
        await context.retry(
          "observed_operation",
          async () => {
            attempts += 1;
            if (attempts === 1) throw new Error("test retry");
            return "ok";
          },
          {
            maxAttempts: 2,
            initialDelayMs: 0,
            maxDelayMs: 0,
            multiplier: 1,
          },
          () => true,
        );
        return {};
      }),
    );

    expect(result.status).toBe("completed");
    const detail = store.getTrace(session.traceId);
    const retrySpans = detail?.spans.filter(
      ({ stage, name }) =>
        stage === "recovery" && name === "retry:observed_operation:attempt",
    );
    expect(retrySpans).toHaveLength(2);
    expect(retrySpans?.map(({ status }) => status)).toEqual([
      "failed",
      "succeeded",
    ]);
    expect(retrySpans?.[0]?.attributes).toMatchObject({
      attempt: 1,
      maxAttempts: 2,
      scheduledDelayMs: 0,
      willRetry: true,
    });
    expect(detail?.links).toContainEqual({
      type: "retry_of",
      sourceSpanId: retrySpans?.[1]?.spanId,
      targetSpanId: retrySpans?.[0]?.spanId,
    });
    store.close();
  });
});
