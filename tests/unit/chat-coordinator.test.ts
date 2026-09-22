import type { Logger } from "pino";
import { describe, expect, it, vi } from "vitest";

import type { OpenAIDeliberationAgent } from "../../src/agent/openai-agent.js";
import {
  ChatCoordinator,
  isImmediateStopCommand,
  type ChatContextFactory,
} from "../../src/agent/chat-coordinator.js";
import { TraceService } from "../../src/trace/service.js";
import { TraceStore } from "../../src/trace/store.js";
import type {
  GameController,
  MemoryPort,
  ToolContext,
} from "../../src/tools/contracts.js";

const minimalToolContext: ToolContext = {
  correlationId: "test-correlation",
  requesterUsername: "owner",
  authorizedOwnerUsername: "owner",
  playerId: "player",
  signal: new AbortController().signal,
  requestKind: "owner_message",
  executionEvidence: { verifiedActionReceipts: [] },
  game: {} as GameController,
  memory: {} as MemoryPort,
  limits: {
    maxMoveDistance: 128,
    maxGatherCount: 16,
    followDistance: 3,
    memoryContextLimit: 10,
  },
};

describe("immediate stop command", () => {
  it.each([
    "停止",
    "停止して",
    " 止まって ",
    "止めて",
    "ストップ",
    "やめて",
    "中止",
    "中断",
  ])("accepts the exact safety command %s", (message) =>
    expect(isImmediateStopCommand(message)).toBe(true),
  );

  it("does not treat an ordinary sentence as a stop command", () => {
    expect(isImmediateStopCommand("停止方法を教えて")).toBe(false);
  });

  it("notifies pending-runtime cancellation synchronously on owner stop", async () => {
    const calls: string[] = [];
    const coordinator = new ChatCoordinator({
      ownerUsername: "owner",
      game: {
        stopCurrentAction: vi.fn(async () => ({
          outcome: "cancelled",
          summary: "停止しました。",
        })),
        say: vi.fn(async () => undefined),
      } as unknown as GameController,
      agent: {} as OpenAIDeliberationAgent,
      contextFactory: {} as ChatContextFactory,
      logger: {
        warn: vi.fn(),
      } as unknown as Logger,
    });
    coordinator.onImmediateStop(() => calls.push("pending-cancelled"));

    const handled = coordinator.handleChat("owner", "停止");
    expect(calls).toEqual(["pending-cancelled"]);
    expect(await handled).toBe(true);
  });

  it("records request and response stages without copying prompt or model text", async () => {
    const store = TraceStore.open(":memory:");
    const traceService = new TraceService(store, {
      error: vi.fn(),
      warn: vi.fn(),
    } as unknown as Logger);
    const contextFactory: ChatContextFactory = {
      create: vi.fn(async () => ({
        personaContext: "固定人格要約",
        memoryContext: "固定記憶要約",
        worldContext: "固定観測要約",
        toolContext: minimalToolContext,
      })),
    };
    const game = {
      say: vi.fn(async () => undefined),
    } as unknown as GameController;
    const coordinator = new ChatCoordinator({
      ownerUsername: "TRACE_RAW_USERNAME",
      game,
      agent: {
        deliberate: vi.fn(async () => ({
          text: "TRACE_RAW_MODEL_RESPONSE",
          toolResults: [],
        })),
      } as unknown as OpenAIDeliberationAgent,
      contextFactory,
      logger: {
        error: vi.fn(),
        warn: vi.fn(),
      } as unknown as Logger,
      traceService,
    });

    await coordinator.handleChat("TRACE_RAW_USERNAME", "TRACE_RAW_PROMPT");

    const run = store.listTraces(1)[0];
    const detail = run === undefined ? undefined : store.getTrace(run.traceId);
    expect(new Set(detail?.spans.map(({ stage }) => stage))).toEqual(
      new Set(["request", "response"]),
    );
    expect(JSON.stringify(detail)).not.toContain("TRACE_RAW_");
    store.close();
  });

  it("records a cancellation and response when the owner issues stop", async () => {
    const store = TraceStore.open(":memory:");
    const traceService = new TraceService(store, {
      error: vi.fn(),
      warn: vi.fn(),
    } as unknown as Logger);
    const game = {
      stopCurrentAction: vi.fn(async () => ({
        outcome: "cancelled",
        summary: "TRACE_RAW_STOP_RESULT",
      })),
      say: vi.fn(async () => undefined),
    } as unknown as GameController;
    const coordinator = new ChatCoordinator({
      ownerUsername: "owner",
      game,
      agent: {} as OpenAIDeliberationAgent,
      contextFactory: {} as ChatContextFactory,
      logger: {
        error: vi.fn(),
        warn: vi.fn(),
      } as unknown as Logger,
      traceService,
    });

    await coordinator.handleChat("owner", "停止");

    const run = store.listTraces(1)[0];
    const detail = run === undefined ? undefined : store.getTrace(run.traceId);
    expect(new Set(detail?.spans.map(({ stage }) => stage))).toEqual(
      new Set(["request", "cancellation", "response"]),
    );
    expect(JSON.stringify(detail)).not.toContain("TRACE_RAW_STOP_RESULT");
    store.close();
  });

  it("records cancellation inside the interrupted request trace", async () => {
    const store = TraceStore.open(":memory:");
    const traceService = new TraceService(store, {
      error: vi.fn(),
      warn: vi.fn(),
    } as unknown as Logger);
    let notifyDeliberationStarted!: () => void;
    const deliberationStarted = new Promise<void>((resolve) => {
      notifyDeliberationStarted = resolve;
    });
    const game = {
      stopCurrentAction: vi.fn(async () => ({
        outcome: "cancelled",
        summary: "停止しました。",
      })),
      say: vi.fn(async () => undefined),
    } as unknown as GameController;
    const coordinator = new ChatCoordinator({
      ownerUsername: "owner",
      game,
      agent: {
        deliberate: vi.fn(
          async (request: { readonly toolContext: ToolContext }) => {
            notifyDeliberationStarted();
            await new Promise<void>((_resolve, reject) => {
              request.toolContext.signal.addEventListener(
                "abort",
                () =>
                  reject(
                    request.toolContext.signal.reason instanceof Error
                      ? request.toolContext.signal.reason
                      : new Error("request aborted"),
                  ),
                { once: true },
              );
            });
            return { text: "到達不能", toolResults: [] };
          },
        ),
      } as unknown as OpenAIDeliberationAgent,
      contextFactory: {
        create: vi.fn(
          async (_username: string, _message: string, signal: AbortSignal) => ({
            personaContext: "固定人格要約",
            memoryContext: "固定記憶要約",
            worldContext: "固定観測要約",
            toolContext: { ...minimalToolContext, signal },
          }),
        ),
      },
      logger: { error: vi.fn(), warn: vi.fn() } as unknown as Logger,
      traceService,
    });

    const activeRequest = coordinator.handleChat("owner", "長時間の依頼");
    await deliberationStarted;
    await coordinator.handleChat("owner", "停止");
    await activeRequest;

    const cancelledRun = store
      .listTraces(5)
      .find(({ status }) => status === "cancelled");
    const detail =
      cancelledRun === undefined
        ? undefined
        : store.getTrace(cancelledRun.traceId);
    expect(cancelledRun).toBeDefined();
    expect(detail?.spans.some(({ stage }) => stage === "cancellation")).toBe(
      true,
    );
    store.close();
  });

  it("records recovery for a runtime reassessment", async () => {
    const store = TraceStore.open(":memory:");
    const traceService = new TraceService(store, {
      error: vi.fn(),
      warn: vi.fn(),
    } as unknown as Logger);
    const coordinator = new ChatCoordinator({
      ownerUsername: "owner",
      game: {
        say: vi.fn(async () => undefined),
      } as unknown as GameController,
      agent: {
        deliberate: vi.fn(async () => ({
          text: "状態を確認しました。",
          toolResults: [],
        })),
      } as unknown as OpenAIDeliberationAgent,
      contextFactory: {
        create: vi.fn(async () => ({
          personaContext: "固定人格要約",
          memoryContext: "固定記憶要約",
          worldContext: "固定観測要約",
          toolContext: minimalToolContext,
        })),
      },
      logger: {
        error: vi.fn(),
        warn: vi.fn(),
      } as unknown as Logger,
      traceService,
    });

    await coordinator.handleRuntimeEvent("connection_recovered", {
      stateKey: "connection:recovered",
      causeKey: "connection",
    });

    const run = store.listTraces(1)[0];
    const detail = run === undefined ? undefined : store.getTrace(run.traceId);
    expect(new Set(detail?.spans.map(({ stage }) => stage))).toEqual(
      new Set(["request", "recovery", "response"]),
    );
    const root = detail?.spans.find(
      ({ parentSpanId }) => parentSpanId === undefined,
    );
    const recovery = detail?.spans.find(({ stage }) => stage === "recovery");
    expect(root?.attributes).toMatchObject({
      requestKind: "runtime_reassessment",
      runtimeEvent: "connection_recovered",
      runtimeStateKey: "connection:recovered",
      runtimeCauseKey: "connection",
    });
    expect(recovery?.attributes).toMatchObject({
      runtimeEvent: "connection_recovered",
      runtimeStateKey: "connection:recovered",
      runtimeCauseKey: "connection",
    });
    store.close();
  });

  it("keeps a post-reinstruction runtime report concise and owner-facing", async () => {
    const requests: {
      message: string;
      requestKind: ToolContext["requestKind"];
    }[] = [];
    const say = vi.fn(async () => undefined);
    const deliberate = vi.fn(
      async (request: {
        readonly message: string;
        readonly toolContext: ToolContext;
      }) => {
        requests.push({
          message: request.message,
          requestKind: request.toolContext.requestKind,
        });
        return {
          text:
            request.toolContext.requestKind === "runtime_reassessment"
              ? "危険が続いています。作業状態を確認してください。"
              : "新しい追従を開始しました。",
          toolResults: [],
        };
      },
    );
    const coordinator = new ChatCoordinator({
      ownerUsername: "owner",
      game: { say } as unknown as GameController,
      agent: { deliberate } as unknown as OpenAIDeliberationAgent,
      contextFactory: {
        create: vi.fn(
          async (
            _username: string,
            _message: string,
            signal: AbortSignal,
            _correlationId: string,
            requestKind: ToolContext["requestKind"],
          ) => ({
            personaContext: "固定人格要約",
            memoryContext: "固定記憶要約",
            worldContext: "確認済み作業状態: 実行中",
            toolContext: { ...minimalToolContext, signal, requestKind },
          }),
        ),
      },
      logger: { error: vi.fn(), warn: vi.fn() } as unknown as Logger,
    });

    await coordinator.handleChat("owner", "来て");
    await coordinator.handleRuntimeEvent("safety_failed", {
      stateKey: "safety:failed:stuck:REFLEX_FAILED",
      causeKey: "reflex:stuck",
    });

    expect(requests).toEqual([
      { message: "来て", requestKind: "owner_message" },
      expect.objectContaining({ requestKind: "runtime_reassessment" }),
    ]);
    expect(requests[1]?.message).toContain("2文以内");
    expect(requests[1]?.message).toContain("作業状態");
    expect(requests[1]?.message).not.toContain("新規行動");
    expect(requests[1]?.message).not.toContain("suspended");
    expect(say).toHaveBeenNthCalledWith(1, "新しい追従を開始しました。");
    expect(say).toHaveBeenNthCalledWith(
      2,
      "危険が続いています。作業状態を確認してください。",
    );
  });

  it("prioritizes a new owner question over an active automatic reassessment", async () => {
    let notifyRuntimeStarted!: () => void;
    const runtimeStarted = new Promise<void>((resolve) => {
      notifyRuntimeStarted = resolve;
    });
    const say = vi.fn(async () => undefined);
    const deliberate = vi.fn(
      async (request: {
        readonly message: string;
        readonly toolContext: ToolContext;
      }) => {
        if (request.toolContext.requestKind === "runtime_reassessment") {
          notifyRuntimeStarted();
          await new Promise<void>((_resolve, reject) => {
            request.toolContext.signal.addEventListener(
              "abort",
              () =>
                reject(
                  request.toolContext.signal.reason instanceof Error
                    ? request.toolContext.signal.reason
                    : new Error("request aborted"),
                ),
              { once: true },
            );
          });
        }
        return { text: `応答:${request.message}`, toolResults: [] };
      },
    );
    const agent = { deliberate } as unknown as OpenAIDeliberationAgent;
    const coordinator = new ChatCoordinator({
      ownerUsername: "owner",
      game: { say } as unknown as GameController,
      agent,
      contextFactory: {
        create: vi.fn(
          async (
            _username: string,
            _message: string,
            signal: AbortSignal,
            _correlationId: string,
            requestKind: ToolContext["requestKind"],
          ) => ({
            personaContext: "固定人格要約",
            memoryContext: "固定記憶要約",
            worldContext: "固定観測要約",
            toolContext: { ...minimalToolContext, signal, requestKind },
          }),
        ),
      },
      logger: {
        error: vi.fn(),
        warn: vi.fn(),
      } as unknown as Logger,
    });

    const automatic = coordinator.handleRuntimeEvent("safety_failed", {
      stateKey: "safety:failed:stuck:REFLEX_FAILED",
      causeKey: "reflex:stuck",
    });
    await runtimeStarted;
    await coordinator.handleChat("owner", "今どうなっていますか");
    await automatic;

    expect(deliberate).toHaveBeenCalledTimes(2);
    expect(say).toHaveBeenCalledTimes(1);
    expect(say).toHaveBeenCalledWith("応答:今どうなっていますか");
  });
});
