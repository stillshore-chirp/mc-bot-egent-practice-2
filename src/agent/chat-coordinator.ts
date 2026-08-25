import type { Logger } from "pino";

import {
  createCorrelationId,
  runWithCorrelation,
} from "../observability/correlation.js";
import type { CognitiveStage } from "../trace/contracts.js";
import type {
  TraceService,
  TraceSession,
  WithSpanOptions,
} from "../trace/service.js";
import type { GameController, ToolContext } from "../tools/contracts.js";
import type { OpenAIDeliberationAgent } from "./openai-agent.js";

const STOP_COMMANDS = new Set([
  "停止",
  "停止して",
  "止まって",
  "止めて",
  "ストップ",
  "やめて",
  "中止",
  "中断",
]);

export interface ChatContextFactory {
  create(
    requesterUsername: string,
    message: string,
    signal: AbortSignal,
    correlationId: string,
    requestKind: ToolContext["requestKind"],
  ): Promise<{
    personaContext: string;
    memoryContext: string;
    worldContext: string;
    toolContext: ToolContext;
  }>;
}

export type RuntimeReassessmentEvent =
  | "startup_reassessment"
  | "safety_stabilized"
  | "safety_failed"
  | "connection_recovered";

async function safeWithTraceSpan<T>(
  traceService: TraceService | undefined,
  stage: CognitiveStage,
  name: string,
  options: WithSpanOptions<T>,
  operation: () => Promise<T>,
): Promise<T> {
  if (traceService === undefined) return operation();

  let operationPromise: Promise<T> | undefined;
  const invoke = (): Promise<T> => {
    operationPromise = Promise.resolve().then(operation);
    return operationPromise;
  };

  try {
    return await traceService.withSpan(stage, name, options, invoke);
  } catch {
    // Trace failures must not execute the primary operation twice. If the
    // operation already started, return its original result/error instead.
    if (operationPromise !== undefined) {
      return operationPromise;
    }
    return operation();
  }
}

async function safeWithTrace<T>(
  traceService: TraceService | undefined,
  session: TraceSession,
  operation: () => Promise<T>,
): Promise<T> {
  if (traceService === undefined) return operation();

  let operationPromise: Promise<T> | undefined;
  const invoke = (): Promise<T> => {
    operationPromise = Promise.resolve().then(operation);
    return operationPromise;
  };

  try {
    return await traceService.withTrace(session, invoke);
  } catch {
    if (operationPromise !== undefined) {
      return operationPromise;
    }
    return operation();
  }
}

async function safeStartTrace(
  traceService: TraceService | undefined,
  requestSummary: string,
  requestKind: ToolContext["requestKind"],
): Promise<TraceSession | undefined> {
  if (traceService === undefined) return undefined;
  try {
    return await traceService.startTrace(requestSummary, {
      attributes: { requestKind },
    });
  } catch {
    return undefined;
  }
}

async function safeCompleteTrace(
  session: TraceSession | undefined,
  status: "succeeded" | "failed" | "cancelled",
  summary: string,
): Promise<void> {
  if (session === undefined) return;
  try {
    await session.complete(status, { summary });
  } catch {
    // Trace completion is best effort; the companion response path remains
    // authoritative when observability is degraded.
  }
}

export class ChatCoordinator {
  readonly #ownerUsername: string;
  readonly #game: GameController;
  readonly #agent: OpenAIDeliberationAgent;
  readonly #contextFactory: ChatContextFactory;
  readonly #logger: Logger;
  readonly #traceService: TraceService | undefined;
  readonly #immediateStopListeners = new Set<() => void>();
  #activeController: AbortController | undefined;
  #conversationTail: Promise<void> = Promise.resolve();
  #generation = 0;

  public constructor(input: {
    ownerUsername: string;
    game: GameController;
    agent: OpenAIDeliberationAgent;
    contextFactory: ChatContextFactory;
    logger: Logger;
    traceService?: TraceService;
  }) {
    this.#ownerUsername = input.ownerUsername;
    this.#game = input.game;
    this.#agent = input.agent;
    this.#contextFactory = input.contextFactory;
    this.#logger = input.logger;
    this.#traceService = input.traceService;
  }

  public async handleChat(username: string, message: string): Promise<boolean> {
    if (username !== this.#ownerUsername) return false;

    const normalized = message.trim();
    if (STOP_COMMANDS.has(normalized)) {
      this.#generation += 1;
      this.#notifyImmediateStop();
      this.#activeController?.abort(new Error("OWNER_STOP_REQUESTED"));
      const session = await safeStartTrace(
        this.#traceService,
        "停止指示を受信",
        "owner_message",
      );
      const stop = async (): Promise<void> => {
        const report = await safeWithTraceSpan(
          this.#traceService,
          "cancellation",
          "Minecraft作業を停止",
          {
            summary: "停止指示を処理",
            summarizeResult: () => "停止処理を実行",
          },
          () => this.#game.stopCurrentAction("利用者の即時停止指示"),
        );
        await safeWithTraceSpan(
          this.#traceService,
          "response",
          "停止結果を応答",
          {
            summary: "停止結果を送信",
            resultKind: "final_response",
            summarizeResult: () => "停止結果を送信",
          },
          () => this.#game.say(report.summary),
        );
      };
      try {
        if (session === undefined) await stop();
        else await safeWithTrace(this.#traceService, session, stop);
        await safeCompleteTrace(session, "succeeded", "停止結果を送信");
      } catch (error) {
        await safeCompleteTrace(session, "failed", "停止処理に失敗");
        throw error;
      }
      return true;
    }

    const generation = this.#generation;
    this.#conversationTail = this.#conversationTail
      .catch(() => undefined)
      .then(() =>
        generation === this.#generation
          ? this.#deliberate(username, normalized, "owner_message")
          : undefined,
      );
    await this.#conversationTail;
    return true;
  }

  public onImmediateStop(listener: () => void): () => void {
    this.#immediateStopListeners.add(listener);
    return () => this.#immediateStopListeners.delete(listener);
  }

  public async handleRuntimeEvent(
    event: RuntimeReassessmentEvent,
  ): Promise<void> {
    const messages = {
      startup_reassessment:
        "再起動後の未完了の約束またはsuspended作業を再評価し、新規行動を開始せず現在状態を短く報告してください。",
      safety_stabilized:
        "安全介入後の状態とsuspended作業を再評価し、新規行動を開始せず現在状態を短く報告してください。",
      safety_failed:
        "安全介入が安定状態を確認できなかったため、現在状態とsuspended作業を観測し、新規行動を開始せず利用者に判断を求めてください。",
      connection_recovered:
        "Minecraft接続復旧後の状態を再評価し、新規行動を開始せず現在状態を短く報告してください。",
    } as const;
    const generation = this.#generation;
    this.#conversationTail = this.#conversationTail
      .catch(() => undefined)
      .then(() =>
        generation === this.#generation
          ? this.#deliberate(
              this.#ownerUsername,
              messages[event],
              "runtime_reassessment",
            )
          : undefined,
      );
    await this.#conversationTail;
  }

  public async shutdown(): Promise<void> {
    this.#generation += 1;
    this.#activeController?.abort(new Error("APPLICATION_SHUTDOWN"));
    await this.#conversationTail;
  }

  #notifyImmediateStop(): void {
    for (const listener of this.#immediateStopListeners) {
      try {
        listener();
      } catch (error) {
        this.#logger.warn(
          {
            code: "IMMEDIATE_STOP_LISTENER_FAILED",
            errorType: error instanceof Error ? error.name : "UnknownError",
          },
          "immediate stop listener failed",
        );
      }
    }
  }

  async #deliberate(
    username: string,
    message: string,
    requestKind: ToolContext["requestKind"],
  ): Promise<void> {
    const controller = new AbortController();
    this.#activeController = controller;
    const session = await safeStartTrace(
      this.#traceService,
      requestKind === "runtime_reassessment"
        ? "runtime再評価を受信"
        : "利用者依頼を受信",
      requestKind,
    );
    const withinSession = <T>(operation: () => Promise<T>): Promise<T> =>
      session === undefined
        ? operation()
        : safeWithTrace(this.#traceService, session, operation);
    const process = async (): Promise<void> => {
      const correlationId = createCorrelationId();
      await runWithCorrelation(correlationId, async () => {
        const context = await this.#contextFactory.create(
          username,
          message,
          controller.signal,
          correlationId,
          requestKind,
        );
        const reply = await this.#agent.deliberate({ message, ...context });
        await safeWithTraceSpan(
          this.#traceService,
          "response",
          "利用者向け応答",
          {
            summary: "最終応答を送信",
            resultKind: "final_response",
            summarizeResult: () => "最終応答を送信",
          },
          () => this.#game.say(reply.text),
        );
      });
    };
    try {
      const tracedProcess =
        requestKind === "runtime_reassessment"
          ? () =>
              safeWithTraceSpan(
                this.#traceService,
                "recovery",
                "runtime状態を再評価",
                {
                  summary: "接続・安全状態を再評価",
                },
                process,
              )
          : process;
      await withinSession(tracedProcess);
      await safeCompleteTrace(session, "succeeded", "応答を送信");
    } catch (error) {
      if (controller.signal.aborted) {
        await withinSession(() =>
          safeWithTraceSpan(
            this.#traceService,
            "cancellation",
            "会話処理を中断",
            {
              summary: "停止または終了指示を処理",
            },
            async () => undefined,
          ),
        );
        await safeCompleteTrace(session, "cancelled", "処理を中断");
        return;
      }
      this.#logger.error(
        {
          errorType: error instanceof Error ? error.name : "UnknownError",
        },
        "deliberation failed",
      );
      try {
        await withinSession(() =>
          safeWithTraceSpan(
            this.#traceService,
            "response",
            "エラー応答",
            {
              summary: "処理失敗を通知",
              resultKind: "final_response",
              summarizeResult: () => "処理失敗を通知",
            },
            () =>
              this.#game.say(
                "会話処理に失敗しました。直前のMinecraft状態と作業結果を再確認してください。",
              ),
          ),
        );
      } finally {
        await safeCompleteTrace(session, "failed", "処理に失敗");
      }
    } finally {
      if (this.#activeController === controller)
        this.#activeController = undefined;
    }
  }
}

export function isImmediateStopCommand(message: string): boolean {
  return STOP_COMMANDS.has(message.trim());
}
