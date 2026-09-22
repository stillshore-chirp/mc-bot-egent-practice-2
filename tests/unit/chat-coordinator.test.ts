import type { Logger } from "pino";
import { describe, expect, it, vi } from "vitest";

import type { OpenAIDeliberationAgent } from "../../src/agent/openai-agent.js";
import {
  ChatCoordinator,
  isReadOnlyStatusQuestion,
  isImmediateStopCommand,
  isHostileResponseCommand,
  isHostileEvadeIntent,
  type ChatContextFactory,
} from "../../src/agent/chat-coordinator.js";
import { TraceService } from "../../src/trace/service.js";
import { TraceStore } from "../../src/trace/store.js";
import type {
  GameController,
  GameStatus,
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

describe("hostile response command", () => {
  it("recognizes a contextual elimination request but not questions or negation", () => {
    expect(isHostileResponseCommand("そいつらを撃滅せよ")).toBe(true);
    expect(isHostileResponseCommand("敵をどうにかして")).toBe(true);
    expect(isHostileResponseCommand("敵を倒せる？")).toBe(false);
    expect(isHostileResponseCommand("敵を倒さないで")).toBe(false);
    expect(isHostileResponseCommand("敵から逃げるのを助けて")).toBe(true);
    expect(isHostileEvadeIntent("敵から逃げるのを助けて")).toBe(true);
    expect(isHostileEvadeIntent("そいつらを撃滅せよ")).toBe(false);
    expect(isHostileEvadeIntent("逃げないで倒して")).toBe(false);
  });

  it("routes an embedded escape request to evacuation, not combat", async () => {
    const respondToHostiles = vi.fn(async () => ({
      outcome: "completed" as const,
      summary: "距離を取りました。",
    }));
    const coordinator = new ChatCoordinator({
      ownerUsername: "owner",
      game: {
        stopCurrentAction: vi.fn(async () => ({
          outcome: "completed",
          summary: "停止しました。",
        })),
        respondToHostiles,
        say: vi.fn(async () => undefined),
      } as unknown as GameController,
      agent: {} as OpenAIDeliberationAgent,
      contextFactory: {} as ChatContextFactory,
      logger: { warn: vi.fn(), error: vi.fn() } as unknown as Logger,
    });
    await coordinator.handleChat("owner", "敵から逃げるのを助けて");
    expect(respondToHostiles).toHaveBeenCalledWith(
      "evade",
      expect.any(AbortSignal),
    );
  });

  it("preempts the prior task and acts without waiting for an LLM refusal", async () => {
    const events: string[] = [];
    const deliberate = vi.fn();
    const coordinator = new ChatCoordinator({
      ownerUsername: "owner",
      game: {
        stopCurrentAction: vi.fn(async () => {
          events.push("stop");
          return { outcome: "completed", summary: "停止しました。" };
        }),
        respondToHostiles: vi.fn(async () => {
          events.push("respond");
          return {
            before: null,
            after: null,
            outcome: "completed",
            summary: "危険な相手から距離を取りました。",
          };
        }),
        say: vi.fn(async (message: string) => {
          events.push(`say:${message}`);
        }),
      } as unknown as GameController,
      agent: { deliberate } as unknown as OpenAIDeliberationAgent,
      contextFactory: {} as ChatContextFactory,
      logger: { warn: vi.fn(), error: vi.fn() } as unknown as Logger,
    });

    expect(await coordinator.handleChat("visitor", "そいつらを撃滅せよ")).toBe(
      false,
    );
    expect(await coordinator.handleChat("owner", "そいつらを撃滅せよ")).toBe(
      true,
    );
    expect(events).toEqual([
      "stop",
      "respond",
      "say:危険な相手から距離を取りました。",
    ]);
    expect(deliberate).not.toHaveBeenCalled();
  });

  it("lets an immediate stop cancel hostile response before its result is sent", async () => {
    let started!: () => void;
    const actionStarted = new Promise<void>((resolve) => {
      started = resolve;
    });
    const say = vi.fn(async () => undefined);
    const coordinator = new ChatCoordinator({
      ownerUsername: "owner",
      game: {
        stopCurrentAction: vi.fn(async () => ({
          before: null,
          after: null,
          outcome: "completed",
          summary: "停止しました。",
        })),
        respondToHostiles: vi.fn(async (signal: AbortSignal) => {
          started();
          await new Promise<void>((_, reject) => {
            signal.addEventListener(
              "abort",
              () => reject(new Error("cancelled")),
              {
                once: true,
              },
            );
          });
          return {
            before: null,
            after: null,
            outcome: "completed",
            summary: "撃破",
          };
        }),
        say,
      } as unknown as GameController,
      agent: {} as OpenAIDeliberationAgent,
      contextFactory: {} as ChatContextFactory,
      logger: { warn: vi.fn(), error: vi.fn() } as unknown as Logger,
    });

    const active = coordinator.handleChat("owner", "そいつらを撃滅せよ");
    await actionStarted;
    await coordinator.handleChat("owner", "停止");
    await active;
    expect(say).toHaveBeenCalledWith("停止しました。");
    expect(say).not.toHaveBeenCalledWith("撃破");
  });
});

describe("immediate stop command", () => {
  it.each([
    "停止",
    "停止して",
    " 止まって ",
    "止めて",
    "ストップ",
    "ストップして",
    "ストップしてください",
    "やめて",
    "中止",
    "中断",
    "止まれ",
    "止めろ",
    "やめろ",
    "停止しろ",
    "やめなさい",
    "今すぐストップ",
    "やめてくれ",
  ])("accepts the exact safety command %s", (message) =>
    expect(isImmediateStopCommand(message)).toBe(true),
  );

  it.each([
    "採取を止めて",
    "今の作業をやめて",
    "追従を停止して",
    "止めてください",
    "追従を停止",
    "採取を中止",
    "そこで止まってください",
    "採取をやめてほしい",
    "採取をやめてほしいです",
    "採取を止めてほしい今すぐ",
    "採取を止めてね",
    "採取を止めて拠点へ戻って",
    "採取を止めて説明して",
    "採取を止めてもういい",
    "採取を止めてから説明して",
    "採取を止めて今何してる",
    "今すぐやめろ",
    "採取を止めろ",
    "止まれ説明して",
    "追従をやめてくれ",
    "採取をやめなさい",
    "危険だから採取を停止",
    "今から10分間採取を止めて",
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
    "追従を停止しないで",
    "『追従を停止』と表示して",
    "採取を止めてほしくないけど拠点へ戻って",
    "「採取を止めて」拠点へ戻って",
    "なぜ採取を止めてしまった？",
    "採取を止めて拠点へ戻っていい？",
    "採取は止まっていない",
    "採取が止まっていないか確認して",
    "採取を止めてほしいわけではない",
    "採取を止めてしまった",
    "採取を止めてない",
    "採取は止まっていた",
    "採取を止めてくれてありがとう",
    "採取を止めてほしい気持ちはないけど拠点へ戻って",
    "採取を停止していない",
    "採取を中断していません",
    "採取を止めてくださいとは言っていない",
    "採取を止めてほしいわけじゃない",
    "採取を止めてほしい理由を教えて",
    "採取を停止してほしい意味を説明して",
    "採取を止めてほしい場合は言って",
    "追従を止めてほしい時は知らせて",
    "採取を止めてほしいと思ったら相談して",
    "止まれ？",
    "今すぐやめろと言っただけ",
    "「止まれ」と表示して",
    "危険なら採取を停止",
    "危険ならストップして",
    "危険なら、採取を停止",
    "危険になったら採取を止めて",
    "危険な時は採取を停止",
    "あと10分で採取を停止",
    "あと10分で、採取を停止",
    "10分後に止まれ",
    "明日採取をやめて",
  ])(
    "does not stop for a question, negation, quote, condition, or future timing %s",
    (message) => expect(isImmediateStopCommand(message)).toBe(false),
  );

  it("does not treat an ordinary sentence as a stop command", () => {
    expect(isImmediateStopCommand("停止方法を教えて")).toBe(false);
  });

  it("still accepts a later explicit stop after a conditional clause", () => {
    expect(
      isImmediateStopCommand("危険なら、採取を停止、でも今すぐ止まれ"),
    ).toBe(true);
  });

  it.each(["止まれ", "今すぐやめろ", "ストップしてください"])(
    "handles an imperative stop before a running conversation completes: %s",
    async (command) => {
      let releaseAction!: () => void;
      let notifyActionStarted!: () => void;
      const actionStarted = new Promise<void>((resolve) => {
        notifyActionStarted = resolve;
      });
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
        agent: {
          deliberate: vi.fn(async () => {
            notifyActionStarted();
            await new Promise<void>((resolve) => {
              releaseAction = resolve;
            });
            return { text: "作業を開始しました。", toolResults: [] };
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

      const active = coordinator.handleChat("owner", "長時間の作業");
      await actionStarted;
      await coordinator.handleChat("owner", command);
      expect(stopCurrentAction).toHaveBeenCalledTimes(1);
      releaseAction();
      await active;
    },
  );

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

  it.each([
    "採取を止めて、拠点へ戻って",
    "採取を止めて代わりに拠点へ戻って",
    "採取を止めて拠点へ戻って",
  ])(
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

  it("drops a compound follow-up when a newer stop arrives first", async () => {
    let releaseFirstStop!: () => void;
    let notifyFirstStopStarted!: () => void;
    const firstStopStarted = new Promise<void>((resolve) => {
      notifyFirstStopStarted = resolve;
    });
    let stopCount = 0;
    const stopCurrentAction = vi.fn(() => {
      stopCount += 1;
      if (stopCount > 1) {
        return Promise.resolve({
          outcome: "completed",
          summary: "停止しました。",
        });
      }
      notifyFirstStopStarted();
      return new Promise<{ outcome: "completed"; summary: string }>(
        (resolve) => {
          releaseFirstStop = () =>
            resolve({ outcome: "completed", summary: "停止しました。" });
        },
      );
    });
    const deliberate = vi.fn();
    const say = vi.fn(async () => undefined);
    const coordinator = new ChatCoordinator({
      ownerUsername: "owner",
      game: { stopCurrentAction, say } as unknown as GameController,
      agent: { deliberate } as unknown as OpenAIDeliberationAgent,
      contextFactory: {} as ChatContextFactory,
      logger: { warn: vi.fn(), error: vi.fn() } as unknown as Logger,
    });

    const compound = coordinator.handleChat(
      "owner",
      "採取を止めて拠点へ戻って",
    );
    await firstStopStarted;
    const secondStop = coordinator.handleChat("owner", "停止");
    releaseFirstStop();
    await Promise.all([compound, secondStop]);

    expect(stopCurrentAction).toHaveBeenCalledTimes(2);
    expect(say).toHaveBeenCalledTimes(2);
    expect(deliberate).not.toHaveBeenCalled();
  });

  it("drops a compound follow-up after any newer owner instruction", async () => {
    let releaseStop!: () => void;
    let notifyStopStarted!: () => void;
    const stopStarted = new Promise<void>((resolve) => {
      notifyStopStarted = resolve;
    });
    const deliberate = vi.fn(async ({ message }: { message: string }) => ({
      text: `返答:${message}`,
      toolResults: [],
    }));
    const coordinator = new ChatCoordinator({
      ownerUsername: "owner",
      game: {
        stopCurrentAction: vi.fn(() => {
          notifyStopStarted();
          return new Promise<{ outcome: "completed"; summary: string }>(
            (resolve) => {
              releaseStop = () =>
                resolve({ outcome: "completed", summary: "停止しました。" });
            },
          );
        }),
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
      logger: { warn: vi.fn(), error: vi.fn() } as unknown as Logger,
    });

    const compound = coordinator.handleChat(
      "owner",
      "採取を止めて拠点へ戻って",
    );
    await stopStarted;
    const newer = coordinator.handleChat("owner", "帰還しないで");
    releaseStop();
    await Promise.all([compound, newer]);

    expect(deliberate).toHaveBeenCalledTimes(1);
    expect(deliberate).toHaveBeenCalledWith(
      expect.objectContaining({ message: "帰還しないで" }),
    );
  });

  it.each([
    ["採取を止めて説明して", "説明して"],
    ["追従を停止、その理由を教えて", "その理由を教えて"],
    ["採取を止めて要約を作って", "要約を作って"],
    ["採取を止めて、もっと短く", "もっと短く"],
    ["採取を止めて周囲を確認して", "周囲を確認して"],
  ])(
    "dispatches a read-only follow-up after stopping: %s",
    async (message, followUp) => {
      const events: string[] = [];
      const coordinator = new ChatCoordinator({
        ownerUsername: "owner",
        game: {
          stopCurrentAction: vi.fn(async () => {
            events.push("stop");
            return { outcome: "completed", summary: "停止しました。" };
          }),
          say: vi.fn(async (text: string) => {
            events.push(`say:${text}`);
          }),
        } as unknown as GameController,
        agent: {
          deliberate: vi.fn(async ({ message: text }: { message: string }) => {
            events.push(`deliberate:${text}`);
            return { text: "停止理由を説明します。", toolResults: [] };
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
        `deliberate:${followUp}`,
        "say:停止理由を説明します。",
      ]);
    },
  );

  it.each([
    "採取を止めて、もういい",
    "採取を止めて、拠点へ戻っていい？",
    "採取を止めてほしい今すぐ",
  ])(
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
    "なぜ失敗した、再開して",
    "どうして止まった、拠点に戻って",
  ])(
    "keeps a mixed status and action request on the normal path: %s",
    (message) => {
      expect(isReadOnlyStatusQuestion(message)).toBe(false);
    },
  );

  it("notifies pending-runtime cancellation synchronously on owner stop", async () => {
    const calls: string[] = [];
    const clearPendingOwnerGoal = vi.fn();
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
      contextFactory: {
        clearPendingOwnerGoal,
      } as unknown as ChatContextFactory,
      logger: {
        warn: vi.fn(),
      } as unknown as Logger,
    });
    coordinator.onImmediateStop(() => calls.push("pending-cancelled"));

    const handled = coordinator.handleChat("owner", "停止");
    expect(calls).toEqual(["pending-cancelled"]);
    expect(clearPendingOwnerGoal).toHaveBeenCalledOnce();
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

  it("drops an observed status when a newer stop supersedes the question", async () => {
    let releaseObservation!: (status: GameStatus) => void;
    let notifyObservationStarted!: () => void;
    const observationStarted = new Promise<void>((resolve) => {
      notifyObservationStarted = resolve;
    });
    const say = vi.fn(async () => undefined);
    const recordDeliveredOwnerExchange = vi.fn();
    const coordinator = new ChatCoordinator({
      ownerUsername: "owner",
      game: {
        observeStatus: vi.fn(() => {
          notifyObservationStarted();
          return new Promise<GameStatus>((resolve) => {
            releaseObservation = resolve;
          });
        }),
        stopCurrentAction: vi.fn(async () => ({
          outcome: "completed",
          summary: "停止しました。",
        })),
        say,
      } as unknown as GameController,
      agent: {
        recordDeliveredOwnerExchange,
      } as unknown as OpenAIDeliberationAgent,
      contextFactory: {} as ChatContextFactory,
      logger: { error: vi.fn(), warn: vi.fn() } as unknown as Logger,
    });

    const question = coordinator.handleChat("owner", "今どうなってる？");
    await observationStarted;
    await coordinator.handleChat("owner", "停止");
    releaseObservation({
      connected: true,
      activeTaskSummary: "利用者への追従を続けています。",
    } as GameStatus);
    await question;

    expect(say).toHaveBeenCalledTimes(1);
    expect(say).toHaveBeenCalledWith("停止しました。");
    expect(recordDeliveredOwnerExchange).not.toHaveBeenCalled();
  });

  it("sends an already started status reply before the later stop result", async () => {
    let releaseStatusSay!: () => void;
    let notifyStatusSayStarted!: () => void;
    let notifyStopStarted!: () => void;
    const statusSayStarted = new Promise<void>((resolve) => {
      notifyStatusSayStarted = resolve;
    });
    const stopStarted = new Promise<void>((resolve) => {
      notifyStopStarted = resolve;
    });
    const sent: string[] = [];
    const history: string[] = [];
    const coordinator = new ChatCoordinator({
      ownerUsername: "owner",
      game: {
        observeStatus: vi.fn(async () => ({
          connected: true,
          activeTaskSummary: "利用者への追従を続けています。",
        })),
        stopCurrentAction: vi.fn(async () => {
          notifyStopStarted();
          return {
            outcome: "completed",
            summary: "停止しました。",
            before: { activeTaskState: "follow_player:running" },
          };
        }),
        say: vi.fn((message: string) => {
          sent.push(message);
          history.push(
            message === "利用者への追従を続けています。"
              ? "status_send"
              : "stop_send",
          );
          if (message !== "利用者への追従を続けています。") {
            return Promise.resolve();
          }
          notifyStatusSayStarted();
          return new Promise<void>((resolve) => {
            releaseStatusSay = resolve;
          });
        }),
      } as unknown as GameController,
      agent: {
        recordDeliveredOwnerExchange: vi.fn(() =>
          history.push("status_recorded"),
        ),
        recordCancelledRequest: vi.fn(() => history.push("cancel_recorded")),
      } as unknown as OpenAIDeliberationAgent,
      contextFactory: {} as ChatContextFactory,
      logger: { error: vi.fn(), warn: vi.fn() } as unknown as Logger,
    });

    const question = coordinator.handleChat("owner", "今どうなってる？");
    await statusSayStarted;
    const stopping = coordinator.handleChat("owner", "停止");
    await stopStarted;
    expect(sent).toEqual(["利用者への追従を続けています。"]);

    releaseStatusSay();
    await Promise.all([question, stopping]);
    expect(sent).toEqual(["利用者への追従を続けています。", "停止しました。"]);
    expect(history).toEqual([
      "status_send",
      "status_recorded",
      "cancel_recorded",
      "stop_send",
    ]);
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
