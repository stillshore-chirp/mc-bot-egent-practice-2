import type { Logger } from "pino";

import {
  createCorrelationId,
  runWithCorrelation,
} from "../observability/correlation.js";
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

export class ChatCoordinator {
  readonly #ownerUsername: string;
  readonly #game: GameController;
  readonly #agent: OpenAIDeliberationAgent;
  readonly #contextFactory: ChatContextFactory;
  readonly #logger: Logger;
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
  }) {
    this.#ownerUsername = input.ownerUsername;
    this.#game = input.game;
    this.#agent = input.agent;
    this.#contextFactory = input.contextFactory;
    this.#logger = input.logger;
  }

  public async handleChat(username: string, message: string): Promise<boolean> {
    if (username !== this.#ownerUsername) return false;

    const normalized = message.trim();
    if (STOP_COMMANDS.has(normalized)) {
      this.#generation += 1;
      this.#notifyImmediateStop();
      this.#activeController?.abort(new Error("OWNER_STOP_REQUESTED"));
      const report = await this.#game.stopCurrentAction("利用者の即時停止指示");
      await this.#game.say(report.summary);
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
    try {
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
        await this.#game.say(reply.text);
      });
    } catch (error) {
      if (controller.signal.aborted) return;
      this.#logger.error(
        {
          errorType: error instanceof Error ? error.name : "UnknownError",
        },
        "deliberation failed",
      );
      await this.#game.say(
        "会話処理に失敗しました。直前のMinecraft状態と作業結果を再確認してください。",
      );
    } finally {
      if (this.#activeController === controller)
        this.#activeController = undefined;
    }
  }
}

export function isImmediateStopCommand(message: string): boolean {
  return STOP_COMMANDS.has(message.trim());
}
