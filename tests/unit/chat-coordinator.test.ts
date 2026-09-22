import type { Logger } from "pino";
import { describe, expect, it, vi } from "vitest";

import type { OpenAIDeliberationAgent } from "../../src/agent/openai-agent.js";
import {
  ChatCoordinator,
  isReadOnlyStatusQuestion,
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

  it.each([
    "採取を止めて",
    "今の作業をやめて",
    "追従を停止して",
    "止めてください",
  ])("accepts a targeted affirmative safety command %s", (message) =>
    expect(isImmediateStopCommand(message)).toBe(true),
  );

  it.each([
    "採取を止めていい？",
    "採取を止めて？",
    "停止？",
    "採取を止めないで",
    "今の作業をやめなくていい",
    "停止方法を教えて",
    "どうして採取が止まった？",
    "「採取を止めて」と言った？",
  ])(
    "does not stop for a question, negation, quote, or explanation %s",
    (message) => expect(isImmediateStopCommand(message)).toBe(false),
  );

  it("does not treat an ordinary sentence as a stop command", () => {
    expect(isImmediateStopCommand("停止方法を教えて")).toBe(false);
  });

  it("prioritizes a compound stop clause over a status question", () => {
    expect(isImmediateStopCommand("今どうなってる、止まって")).toBe(true);
    expect(isReadOnlyStatusQuestion("今どうなってる、止まって")).toBe(false);
  });

  it("executes a compound stop clause before answering its status prefix", async () => {
    const stopCurrentAction = vi.fn(async () => ({
      outcome: "completed",
      summary: "停止しました。",
    }));
    const coordinator = new ChatCoordinator({
      ownerUsername: "owner",
      game: {
        stopCurrentAction,
        say: vi.fn(async () => undefined),
      } as unknown as GameController,
      agent: {} as OpenAIDeliberationAgent,
      contextFactory: {} as ChatContextFactory,
      logger: { warn: vi.fn() } as unknown as Logger,
    });

    await coordinator.handleChat("owner", "今どうなってる、止まって");

    expect(stopCurrentAction).toHaveBeenCalledWith("利用者の即時停止指示");
  });

  it.each(["採取を止めて、拠点へ戻って", "採取を止めて代わりに拠点へ戻って"])(
    "starts an explicit replacement only after a targeted stop succeeds: %s",
    async (message) => {
      const events: string[] = [];
      const coordinator = new ChatCoordinator({
        ownerUsername: "owner",
        game: {
          stopCurrentAction: vi.fn(async () => {
            events.push("stop");
            return { outcome: "completed", summary: "停止しました。" };
          }),
          say: vi.fn(async (message: string) => {
            events.push(`say:${message}`);
          }),
        } as unknown as GameController,
        agent: {
          deliberate: vi.fn(async ({ message }: { message: string }) => {
            events.push(`deliberate:${message}`);
            return { text: "拠点へ戻ります。", toolResults: [] };
          }),
        } as unknown as OpenAIDeliberationAgent,
        contextFactory: {
          create: vi.fn(async () => ({
            personaContext: "固定人格要約",
            memoryContext: "固定記憶要約",
            worldContext: "確認済み状態",
            toolContext: minimalToolContext,
          })),
        },
        logger: { warn: vi.fn(), error: vi.fn() } as unknown as Logger,
      });

      await coordinator.handleChat("owner", message);

      expect(events).toEqual([
        "stop",
        "say:停止しました。",
        "deliberate:拠点へ戻って",
        "say:拠点へ戻ります。",
      ]);
    },
  );

  it("does not start a replacement when a targeted stop fails", async () => {
    const deliberate = vi.fn();
    const coordinator = new ChatCoordinator({
      ownerUsername: "owner",
      game: {
        stopCurrentAction: vi.fn(async () => {
          throw new Error("STOP_FAILED");
        }),
        say: vi.fn(async () => undefined),
      } as unknown as GameController,
      agent: { deliberate } as unknown as OpenAIDeliberationAgent,
      contextFactory: {} as ChatContextFactory,
      logger: { warn: vi.fn(), error: vi.fn() } as unknown as Logger,
    });

    await expect(
      coordinator.handleChat("owner", "採取を止めて、拠点へ戻って"),
    ).rejects.toThrow("STOP_FAILED");
    expect(deliberate).not.toHaveBeenCalled();
  });

  it.each(["採取を止めて、もういい", "採取を止めて、拠点へ戻っていい？"])(
    "does not treat a non-action tail as a replacement: %s",
    async (message) => {
      const deliberate = vi.fn();
      const say = vi.fn(async () => undefined);
      const coordinator = new ChatCoordinator({
        ownerUsername: "owner",
        game: {
          stopCurrentAction: vi.fn(async () => ({
            outcome: "completed",
            summary: "停止しました。",
          })),
          say,
        } as unknown as GameController,
        agent: { deliberate } as unknown as OpenAIDeliberationAgent,
        contextFactory: {} as ChatContextFactory,
        logger: { warn: vi.fn(), error: vi.fn() } as unknown as Logger,
      });

      await coordinator.handleChat("owner", message);

      expect(deliberate).not.toHaveBeenCalled();
      expect(say).toHaveBeenCalledWith("停止しました。");
    },
  );

  it.each([
    "今どうなってる？",
    "今どうなってる",
    "何してる？",
    "何してる",
    "なぜ止まった？",
    "なぜ採取が止まった？",
  ])("recognizes a standalone read-only status question: %s", (message) => {
    expect(isReadOnlyStatusQuestion(message)).toBe(true);
  });

  it.each([
    "今の状況を教えて、木を集めて？",
    "今どうなってる、木を集めて",
    "今どうなってる、止まらないで",
    "なぜ建築できない？",
    "なぜ止まった？ もう一度来て",
    "なぜ失敗？木を集めて",
  ])(
    "keeps a mixed status and action request on the normal path: %s",
    (message) => {
      expect(isReadOnlyStatusQuestion(message)).toBe(false);
    },
  );

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

  it("keeps an exact stop command on the stopped cancellation path", async () => {
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
    coordinator.onOwnerMessage(() => calls.push("owner_message"));
    coordinator.onImmediateStop(() => calls.push("stopped"));

    await coordinator.handleChat("owner", "停止");

    expect(calls).toEqual(["stopped"]);
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

  it("records only the assistant response that reaches Minecraft chat", async () => {
    const recordDeliveredReply = vi.fn();
    let sayCalls = 0;
    const coordinator = new ChatCoordinator({
      ownerUsername: "owner",
      game: {
        say: vi.fn(async () => {
          sayCalls += 1;
          if (sayCalls === 1) throw new Error("CHAT_DELIVERY_FAILED");
        }),
      } as unknown as GameController,
      agent: {
        deliberate: vi.fn(async () => ({
          text: "依頼を受けました。",
          toolResults: [],
        })),
        recordDeliveredReply,
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
    });

    await coordinator.handleChat("owner", "依頼");

    expect(sayCalls).toBe(2);
    expect(recordDeliveredReply).toHaveBeenCalledTimes(1);
    expect(recordDeliveredReply).toHaveBeenCalledWith(
      "owner",
      "owner_message",
      "会話処理に失敗しました。直前のMinecraft状態と作業結果を再確認してください。",
    );
  });

  it("records a delivered error response", async () => {
    const recordDeliveredReply = vi.fn();
    const coordinator = new ChatCoordinator({
      ownerUsername: "owner",
      game: {
        say: vi.fn(async () => undefined),
      } as unknown as GameController,
      agent: {
        deliberate: vi.fn(async () => {
          throw new Error("DELIBERATION_FAILED");
        }),
        recordDeliveredReply,
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
    });

    await coordinator.handleChat("owner", "依頼");

    expect(recordDeliveredReply).toHaveBeenCalledWith(
      "owner",
      "owner_message",
      "会話処理に失敗しました。直前のMinecraft状態と作業結果を再確認してください。",
    );
  });

  it("seeds the owner request before context construction can fail", async () => {
    const beginOwnerRequest = vi.fn(() => 17);
    const recordDeliveredReply = vi.fn();
    const coordinator = new ChatCoordinator({
      ownerUsername: "owner",
      game: {
        say: vi.fn(async () => undefined),
      } as unknown as GameController,
      agent: {
        beginOwnerRequest,
        deliberate: vi.fn(),
        recordDeliveredReply,
      } as unknown as OpenAIDeliberationAgent,
      contextFactory: {
        create: vi.fn(async () => {
          throw new Error("CONTEXT_FAILED");
        }),
      },
      logger: {
        error: vi.fn(),
        warn: vi.fn(),
      } as unknown as Logger,
    });

    await coordinator.handleChat("owner", "依頼");

    expect(beginOwnerRequest).toHaveBeenCalledWith("owner", "依頼");
    expect(recordDeliveredReply).toHaveBeenCalledWith(
      "owner",
      "owner_message",
      "会話処理に失敗しました。直前のMinecraft状態と作業結果を再確認してください。",
      17,
    );
  });

  it("does not mark cancellation when stopping the action fails", async () => {
    const recordCancelledRequest = vi.fn();
    const say = vi.fn(async () => undefined);
    const coordinator = new ChatCoordinator({
      ownerUsername: "owner",
      game: {
        stopCurrentAction: vi.fn(async () => {
          throw new Error("STOP_FAILED");
        }),
        say,
      } as unknown as GameController,
      agent: {
        recordCancelledRequest,
      } as unknown as OpenAIDeliberationAgent,
      contextFactory: {} as ChatContextFactory,
      logger: {
        error: vi.fn(),
        warn: vi.fn(),
      } as unknown as Logger,
    });

    await expect(coordinator.handleChat("owner", "停止")).rejects.toThrow(
      "STOP_FAILED",
    );
    expect(recordCancelledRequest).not.toHaveBeenCalled();
    expect(say).toHaveBeenCalledWith(
      "Minecraftの停止処理を完了できなかったため、新しい作業は開始しません。",
    );
  });

  it("does not mark an idle stop as a cancelled conversation", async () => {
    const recordCancelledRequest = vi.fn();
    const coordinator = new ChatCoordinator({
      ownerUsername: "owner",
      game: {
        stopCurrentAction: vi.fn(async () => ({
          before: null,
          after: null,
          outcome: "completed",
          summary: "実行中のMinecraft作業はありません。",
        })),
        say: vi.fn(async () => undefined),
      } as unknown as GameController,
      agent: {
        recordCancelledRequest,
      } as unknown as OpenAIDeliberationAgent,
      contextFactory: {} as ChatContextFactory,
      logger: {
        error: vi.fn(),
        warn: vi.fn(),
      } as unknown as Logger,
    });

    await coordinator.handleChat("owner", "停止");

    expect(recordCancelledRequest).not.toHaveBeenCalled();
  });

  it("does not start a new owner action after the stop boundary fails", async () => {
    const say = vi.fn(async () => undefined);
    const deliberate = vi.fn(async () => ({
      text: "新しい作業を始めます。",
      toolResults: [],
    }));
    const coordinator = new ChatCoordinator({
      ownerUsername: "owner",
      game: {
        stopCurrentAction: vi.fn(async () => {
          throw new Error("STOP_FAILED");
        }),
        say,
      } as unknown as GameController,
      agent: { deliberate } as unknown as OpenAIDeliberationAgent,
      contextFactory: {
        create: vi.fn(async () => ({
          personaContext: "固定人格要約",
          memoryContext: "固定記憶要約",
          worldContext: "確認済み状態",
          toolContext: minimalToolContext,
        })),
      },
      logger: { error: vi.fn(), warn: vi.fn() } as unknown as Logger,
    });

    await expect(coordinator.handleChat("owner", "停止")).rejects.toThrow(
      "STOP_FAILED",
    );
    await coordinator.handleChat("owner", "来て");

    expect(deliberate).not.toHaveBeenCalled();
    expect(say).toHaveBeenCalledWith(
      "前のMinecraft作業を安全に停止できなかったため、新しい作業は開始しません。",
    );
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

    const outcome = await coordinator.handleRuntimeEvent(
      "connection_recovered",
      {
        stateKey: "connection:recovered",
        causeKey: "connection",
      },
    );
    expect(outcome).toBe("completed");

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

  it("returns a failed outcome when runtime deliberation cannot complete", async () => {
    const say = vi.fn(async () => undefined);
    const coordinator = new ChatCoordinator({
      ownerUsername: "owner",
      game: { say } as unknown as GameController,
      agent: {
        deliberate: vi.fn(async () => {
          throw new Error("synthetic runtime failure");
        }),
      } as unknown as OpenAIDeliberationAgent,
      contextFactory: {
        create: vi.fn(async () => ({
          personaContext: "固定人格要約",
          memoryContext: "固定記憶要約",
          worldContext: "固定観測要約",
          toolContext: minimalToolContext,
        })),
      },
      logger: { error: vi.fn(), warn: vi.fn() } as unknown as Logger,
    });

    const outcome = await coordinator.handleRuntimeEvent("safety_failed", {
      stateKey: "safety:failed:stuck:REFLEX_FAILED",
      causeKey: "reflex:stuck",
    });

    expect(outcome).toBe("failed");
    expect(say).toHaveBeenCalledWith(
      "会話処理に失敗しました。直前のMinecraft状態と作業結果を再確認してください。",
    );
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
    await coordinator.handleChat("owner", "なぜ続けているのですか");
    await automatic;

    expect(deliberate).toHaveBeenCalledTimes(2);
    expect(say).toHaveBeenCalledTimes(1);
    expect(say).toHaveBeenCalledWith("応答:なぜ続けているのですか");
  });

  it("answers a read-only status question while an owner action is running", async () => {
    let releaseAction!: () => void;
    let notifyActionStarted!: () => void;
    const actionStarted = new Promise<void>((resolve) => {
      notifyActionStarted = resolve;
    });
    const say = vi.fn(async () => undefined);
    const recordDeliveredOwnerExchange = vi.fn();
    const deliberate = vi.fn(async () => {
      notifyActionStarted();
      await new Promise<void>((resolve) => {
        releaseAction = resolve;
      });
      return { text: "作業を開始しました。", toolResults: [] };
    });
    const coordinator = new ChatCoordinator({
      ownerUsername: "owner",
      game: {
        observeStatus: vi.fn(async () => ({
          ...minimalToolContext.game,
          observedAt: "2026-09-22T00:00:00.000Z",
          subject: "bot",
          source: "minecraft",
          requesterVitals: "unobserved",
          connected: true,
          spawned: true,
          health: 20,
          food: 20,
          oxygen: 20,
          oxygenState: "not_applicable",
          inWater: false,
          position: null,
          inventory: {},
          activeTaskState: "follow_player:following:running",
        })),
        say,
      } as unknown as GameController,
      agent: {
        beginOwnerRequest: vi.fn(() => 1),
        deliberate,
        recordDeliveredReply: vi.fn(),
        recordDeliveredOwnerExchange,
      } as unknown as OpenAIDeliberationAgent,
      contextFactory: {
        create: vi.fn(async () => ({
          personaContext: "固定人格要約",
          memoryContext: "固定記憶要約",
          worldContext: "固定観測要約",
          toolContext: minimalToolContext,
        })),
      },
      logger: { error: vi.fn(), warn: vi.fn() } as unknown as Logger,
    });

    const action = coordinator.handleChat("owner", "来て");
    await actionStarted;
    const question = coordinator.handleChat(
      "owner",
      "専門用語なしで、今どうなってる？",
    );
    await question;

    expect(deliberate).toHaveBeenCalledTimes(1);
    expect(say).toHaveBeenCalledWith("利用者への追従を続けています。");
    expect(recordDeliveredOwnerExchange).toHaveBeenCalledWith(
      "owner",
      "専門用語なしで、今どうなってる？",
      "利用者への追従を続けています。",
    );

    releaseAction();
    await action;
  });

  it("does not shortcut a bare why without a confirmed live task", async () => {
    const deliberate = vi.fn(async () => ({
      text: "直前の説明を続けます。",
      toolResults: [],
    }));
    const coordinator = new ChatCoordinator({
      ownerUsername: "owner",
      game: {
        observeStatus: vi.fn(async () => ({
          ...minimalToolContext.game,
          observedAt: "2026-09-22T00:00:00.000Z",
          subject: "bot",
          source: "minecraft",
          requesterVitals: "unobserved",
          connected: true,
          spawned: true,
          health: 20,
          food: 20,
          oxygen: 20,
          oxygenState: "not_applicable",
          inWater: false,
          position: null,
          inventory: {},
          activeTaskState: null,
        })),
        say: vi.fn(async () => undefined),
      } as unknown as GameController,
      agent: { deliberate } as unknown as OpenAIDeliberationAgent,
      contextFactory: {
        create: vi.fn(async () => ({
          personaContext: "固定人格要約",
          memoryContext: "直前の停止理由",
          worldContext: "確認済み状態",
          toolContext: minimalToolContext,
        })),
      },
      logger: { error: vi.fn(), warn: vi.fn() } as unknown as Logger,
    });

    await coordinator.handleChat("owner", "なぜ");

    expect(deliberate).toHaveBeenCalledWith(
      expect.objectContaining({ message: "なぜ" }),
    );
  });

  it("waits for an in-flight stop before starting a new owner action", async () => {
    let releaseStop!: () => void;
    let notifyStopStarted!: () => void;
    const stopStarted = new Promise<void>((resolve) => {
      notifyStopStarted = resolve;
    });
    const deliberate = vi.fn(async () => ({
      text: "新しい作業を始めます。",
      toolResults: [],
    }));
    const coordinator = new ChatCoordinator({
      ownerUsername: "owner",
      game: {
        stopCurrentAction: vi.fn(
          () =>
            new Promise<{ outcome: "cancelled"; summary: string }>(
              (resolve) => {
                notifyStopStarted();
                releaseStop = () =>
                  resolve({ outcome: "cancelled", summary: "停止しました。" });
              },
            ),
        ),
        say: vi.fn(async () => undefined),
      } as unknown as GameController,
      agent: { deliberate } as unknown as OpenAIDeliberationAgent,
      contextFactory: {
        create: vi.fn(async () => ({
          personaContext: "固定人格要約",
          memoryContext: "固定記憶要約",
          worldContext: "確認済み状態",
          toolContext: minimalToolContext,
        })),
      },
      logger: { error: vi.fn(), warn: vi.fn() } as unknown as Logger,
    });

    const stopping = coordinator.handleChat("owner", "停止");
    await stopStarted;
    const followup = coordinator.handleChat("owner", "来て");
    await Promise.resolve();
    expect(deliberate).not.toHaveBeenCalled();

    releaseStop();
    await stopping;
    await followup;
    expect(deliberate).toHaveBeenCalledTimes(1);
  });

  it("reports the latest completed task without reviving an older failure", async () => {
    const say = vi.fn(async () => undefined);
    const recordDeliveredOwnerExchange = vi.fn();
    const coordinator = new ChatCoordinator({
      ownerUsername: "owner",
      game: {
        observeStatus: vi.fn(async () => ({
          ...minimalToolContext.game,
          observedAt: "2026-09-22T00:00:00.000Z",
          subject: "bot",
          source: "minecraft",
          requesterVitals: "unobserved",
          connected: true,
          spawned: true,
          health: 20,
          food: 20,
          oxygen: 20,
          oxygenState: "not_applicable",
          inWater: false,
          position: null,
          inventory: {},
          activeTaskState: null,
          latestTaskState: "直前のMinecraft作業は完了しました。",
        })),
        say,
      } as unknown as GameController,
      agent: {
        recordDeliveredOwnerExchange,
      } as unknown as OpenAIDeliberationAgent,
      contextFactory: {} as ChatContextFactory,
      logger: { error: vi.fn(), warn: vi.fn() } as unknown as Logger,
    });

    await coordinator.handleChat("owner", "なぜ止まった？");

    expect(say).toHaveBeenCalledWith(
      "直前のMinecraft作業は完了しました。現在、進行中のMinecraft作業はありません。",
    );
    expect(recordDeliveredOwnerExchange).toHaveBeenCalled();
  });

  it("returns cancelled when an owner message invalidates queued runtime work", async () => {
    let releaseOwner!: () => void;
    let notifyOwnerStarted!: () => void;
    const ownerStarted = new Promise<void>((resolve) => {
      notifyOwnerStarted = resolve;
    });
    const deliberate = vi.fn(
      async (request: {
        readonly message: string;
        readonly toolContext: ToolContext;
      }) => {
        if (request.message === "長い依頼") {
          notifyOwnerStarted();
          await new Promise<void>((resolve) => {
            releaseOwner = resolve;
          });
        }
        return { text: `応答:${request.message}`, toolResults: [] };
      },
    );
    const coordinator = new ChatCoordinator({
      ownerUsername: "owner",
      game: { say: vi.fn(async () => undefined) } as unknown as GameController,
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
            worldContext: "固定観測要約",
            toolContext: { ...minimalToolContext, signal, requestKind },
          }),
        ),
      },
      logger: { error: vi.fn(), warn: vi.fn() } as unknown as Logger,
    });

    const ownerRequest = coordinator.handleChat("owner", "長い依頼");
    await ownerStarted;
    const runtimeRequest = coordinator.handleRuntimeEvent("safety_failed", {
      stateKey: "safety:failed:stuck:REFLEX_FAILED",
      causeKey: "reflex:stuck",
    });
    const followup = coordinator.handleChat("owner", "別の質問");
    releaseOwner();

    await ownerRequest;
    expect(await runtimeRequest).toBe("cancelled");
    await followup;
    expect(deliberate).toHaveBeenCalledTimes(2);
  });
});
