import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import OpenAI from "openai";
import type { Logger } from "pino";

import {
  DashboardHttpServer,
  type DashboardSnapshot,
} from "../dashboard/http-server.js";
import { ConnectionManager } from "../minecraft/connection-manager.js";
import { MineflayerClient } from "../minecraft/mineflayer-client.js";
import { createLogger } from "../observability/logger.js";
import { loadPersona } from "../persona/persona.js";
import { CompanionAgent } from "../player/agent.js";
import { CompanionStore } from "../player/store.js";
import { CompanionRuntime } from "../player/runtime.js";
import type { AppConfig } from "../config/schema.js";

const CHAT_COMMAND_GUARD = "\u200B";

/** Normalize outgoing chat while ensuring no line can become a slash command. */
export function sanitizeMinecraftChatText(text: string): string {
  const protectedLines = text.split(/\r\n|\r|\n/u).map((line) => {
    const leadingWhitespace = /^\s*/u.exec(line)?.[0] ?? "";
    const content = line.slice(leadingWhitespace.length);
    return content.startsWith("/")
      ? `${leadingWhitespace}${CHAT_COMMAND_GUARD}${content}`
      : line;
  });
  return protectedLines.join(" ").replace(/\s+/gu, " ").trim().slice(0, 240);
}

export interface CompanionApplication {
  start(): Promise<void>;
  shutdown(reason?: string): Promise<void>;
}

class PlayerCompanionApplication implements CompanionApplication {
  #unsubscribeChat: (() => void) | undefined;
  #shutdownPromise: Promise<void> | undefined;

  public constructor(
    private readonly connection: ConnectionManager,
    private readonly minecraft: MineflayerClient,
    private readonly runtime: CompanionRuntime,
    private readonly store: CompanionStore,
    private readonly dashboard: DashboardHttpServer | undefined,
    private readonly logger: Logger,
  ) {}

  public async start(): Promise<void> {
    try {
      await this.dashboard?.start();
      await this.connection.connect();
      this.#unsubscribeChat = this.minecraft.onChat((username, message) => {
        void this.runtime
          .receiveChat(username, message)
          .catch((error: unknown) => {
            this.logger.error(
              { code: "OWNER_MESSAGE_FAILED", errorType: errorType(error) },
              "owner message could not be processed",
            );
          });
      });
      await this.runtime.start();
      this.logger.info("Minecraft companion is running");
    } catch (error) {
      await this.shutdown("startup_failed").catch((shutdownError: unknown) => {
        this.logger.error(
          {
            code: "STARTUP_CLEANUP_FAILED",
            errorType: errorType(shutdownError),
          },
          "companion startup cleanup failed",
        );
      });
      throw error;
    }
  }

  public async shutdown(reason = "shutdown"): Promise<void> {
    if (this.#shutdownPromise !== undefined) return this.#shutdownPromise;
    this.#shutdownPromise = (async () => {
      const errors: Error[] = [];
      const capture = async (operation: () => Promise<void> | void) => {
        try {
          await operation();
        } catch (error) {
          errors.push(
            error instanceof Error
              ? error
              : new Error("Companion shutdown operation failed", {
                  cause: error,
                }),
          );
        }
      };

      await capture(() => this.#unsubscribeChat?.());
      this.#unsubscribeChat = undefined;
      await capture(() => this.runtime.shutdown());
      await capture(() => this.connection.shutdown(reason));
      await capture(() => this.dashboard?.close());
      await capture(() => this.store.close());

      const firstError = errors[0];
      if (firstError !== undefined) throw firstError;
    })();
    return this.#shutdownPromise;
  }
}

export function createApplication(config: AppConfig): CompanionApplication {
  const logger = createLogger(config);
  const persona = loadPersona(config.personaPath);
  if (config.databasePath !== ":memory:") {
    mkdirSync(dirname(config.databasePath), { recursive: true });
  }

  const store = CompanionStore.open(config.databasePath, {
    ownerUsername: config.ownerUsername,
  });
  const minecraft = new MineflayerClient(
    {
      bot: {
        host: config.minecraft.host,
        port: config.minecraft.port,
        username: config.minecraft.username,
        auth: config.minecraft.auth,
        version: config.minecraft.version,
      },
      ownerUsername: config.ownerUsername,
    },
    logger,
  );
  const connection = new ConnectionManager(
    minecraft,
    {
      maxAttempts: config.connection.reconnectMaxAttempts + 1,
      initialDelayMs: config.connection.reconnectDelayMs,
      maxDelayMs: config.connection.reconnectDelayMs,
      multiplier: 1,
    },
    config.connection.timeoutMs,
    config.connection.reconnectEnabled,
  );
  const body = minecraft.createPlayerBody();
  const agent = new CompanionAgent({
    client: new OpenAI({ apiKey: config.openai.apiKey }),
    model: config.openai.model,
    persona,
  });
  const runtime = new CompanionRuntime({
    ownerUsername: config.ownerUsername,
    body,
    store,
    agent,
    memoryContextLimit: config.memoryContextLimit,
    say: async (text) => {
      const safeText = sanitizeMinecraftChatText(text);
      if (safeText.length > 0) await minecraft.say(safeText);
    },
    logger,
  });
  const dashboard = config.dashboard.enabled
    ? new DashboardHttpServer({
        host: config.dashboard.host,
        port: config.dashboard.port,
        ...(config.dashboard.authToken === undefined
          ? {}
          : { authToken: config.dashboard.authToken }),
        getSnapshot: (query) =>
          createDashboardSnapshot(connection, runtime, store, query),
      })
    : undefined;

  return new PlayerCompanionApplication(
    connection,
    minecraft,
    runtime,
    store,
    dashboard,
    logger,
  );
}

function createDashboardSnapshot(
  connection: ConnectionManager,
  runtime: CompanionRuntime,
  store: CompanionStore,
  query: string,
): DashboardSnapshot {
  const status = runtime.status();
  const snapshot = store.snapshot();
  const usage = status.usage ?? {
    requests: 0,
    usageResponses: 0,
    missingUsageRequests: 0,
    errors: 0,
    inputTokens: null,
    outputTokens: null,
    cachedInputTokens: null,
    lastErrorCode: null,
  };
  return {
    generatedAt: new Date().toISOString(),
    connectionState: connection.state,
    runtime: {
      running: status.running,
      stopped: status.stopped,
      thinking: status.thinking,
      goal:
        status.goal === null
          ? null
          : {
              title: status.goal.title,
              successCondition: status.goal.successCondition,
            },
      currentOperation: status.currentOperation,
      nextWakeAt: status.nextWakeAt,
      lastOutcome: status.lastOutcome,
      recentErrors: status.recentErrors,
      usage,
    },
    plan:
      snapshot.plan === null
        ? null
        : {
            purpose: snapshot.plan.purpose,
            firstStep:
              snapshot.plan.steps[0] === undefined
                ? null
                : {
                    kind: snapshot.plan.steps[0].operation.kind,
                    expectedOutcome: snapshot.plan.steps[0].expectedOutcome,
                  },
          },
    activeOperation:
      snapshot.activeOperation === null
        ? null
        : {
            kind: snapshot.activeOperation.operation.kind,
            expectedOutcome: snapshot.activeOperation.expectedOutcome,
          },
    memories: store.recall(query, 20).map((memory) => ({
      content: memory.content,
      source: memory.source,
      updatedAt: memory.updatedAt,
    })),
  };
}

function errorType(error: unknown): string {
  return error instanceof Error ? error.name : "UnknownError";
}
