import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import OpenAI from "openai";
import type { Logger } from "pino";

import type { AppConfig } from "../config/schema.js";
import { DashboardHttpServer } from "../dashboard/http-server.js";
import { MemoryStore } from "../memory/store.js";
import { McSkillRepository } from "../mc-skills/index.js";
import { ConnectionManager } from "../minecraft/connection-manager.js";
import { MineflayerClient } from "../minecraft/mineflayer-client.js";
import { playerOperationNames } from "../minecraft/player-body-schema.js";
import { createLogger } from "../observability/logger.js";
import { loadPersona } from "../persona/persona.js";
import {
  PlayerConversationAgent,
  PlayerPurposeAgent,
} from "../player/agents.js";
import type { PlayerMemoryPort } from "../player/contracts.js";
import { PlayerMindStore } from "../player/mind-store.js";
import { toObservationEvidence } from "../player/observation-evidence.js";
import type { PlayerResponsesClient } from "../player/responses.js";
import { PlayerRuntime } from "../player/runtime.js";
import { TraceService } from "../trace/service.js";
import { TraceStore } from "../trace/store.js";
import type { CompanionApplication, LiveEvidence } from "./application.js";

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

export class PlayerCompanionApplication implements CompanionApplication {
  readonly #connection: ConnectionManager;
  readonly #minecraft: MineflayerClient;
  readonly #memory: MemoryStore;
  readonly #mind: PlayerMindStore;
  readonly #skills: McSkillRepository;
  readonly #runtime: PlayerRuntime;
  readonly #logger: Logger;
  readonly #trace: TraceService | undefined;
  readonly #temporarySkillDirectory: string | undefined;
  readonly #dashboard?: DashboardHttpServer;
  #unsubscribeChat: (() => void) | undefined;
  #shutdownPromise: Promise<void> | undefined;

  public constructor(input: {
    config: AppConfig;
    logger: Logger;
    memory: MemoryStore;
    mind: PlayerMindStore;
    skills: McSkillRepository;
    minecraft: MineflayerClient;
    connection: ConnectionManager;
    runtime: PlayerRuntime;
    trace?: TraceService;
    temporarySkillDirectory?: string;
  }) {
    this.#connection = input.connection;
    this.#minecraft = input.minecraft;
    this.#memory = input.memory;
    this.#mind = input.mind;
    this.#skills = input.skills;
    this.#runtime = input.runtime;
    this.#logger = input.logger;
    this.#trace = input.trace;
    this.#temporarySkillDirectory = input.temporarySkillDirectory;
    if (input.trace !== undefined) {
      try {
        this.#dashboard = new DashboardHttpServer(
          input.trace,
          {
            ...input.config.dashboard,
            getBotHealth: async () => {
              const evidence = await this.collectLiveEvidence();
              const state = evidence.player;
              return {
                botState:
                  evidence.game?.connected && evidence.game.spawned
                    ? "active"
                    : this.#connection.state === "connected"
                      ? "active"
                      : "unavailable",
                connectionState: this.#connection.state,
                aiState: this.#runtime.busy ? "active" : "idle",
                memoryState: "available",
                reflexState: state?.stopped ? "stopped" : "running",
                positionState:
                  evidence.game === null ? "unavailable" : "available_redacted",
                ...(evidence.game === null
                  ? {}
                  : { health: evidence.game.health, food: evidence.game.food }),
                taskStatus: evidence.task?.status ?? "idle",
                taskPhase: evidence.task?.phase,
              };
            },
          },
          input.logger,
        );
      } catch (error) {
        input.logger.warn(
          {
            code: "DASHBOARD_CONFIGURATION_FAILED",
            errorType: error instanceof Error ? error.name : "UnknownError",
          },
          "trace dashboard unavailable",
        );
      }
    }
  }

  public async start(): Promise<void> {
    try {
      try {
        await this.#dashboard?.start();
      } catch (error) {
        this.#logger.warn(
          {
            code: "DASHBOARD_START_FAILED",
            errorType: error instanceof Error ? error.name : "UnknownError",
          },
          "trace dashboard unavailable",
        );
      }
      await this.#connection.connect();
      this.#unsubscribeChat = this.#minecraft.onChat((username, message) =>
        this.#runtime.receiveChat(username, message),
      );
      await this.#runtime.start();
    } catch (error) {
      try {
        await this.shutdown("startup_failed");
      } catch (shutdownError) {
        this.#logger.error(
          {
            code: "STARTUP_CLEANUP_FAILED",
            errorType:
              shutdownError instanceof Error
                ? shutdownError.name
                : "UnknownError",
          },
          "player application startup cleanup failed",
        );
      }
      if (error instanceof Error) throw error;
      throw new Error("Player application startup failed", { cause: error });
    }
  }

  public async shutdown(reason = "shutdown"): Promise<void> {
    if (this.#shutdownPromise !== undefined) return this.#shutdownPromise;
    this.#shutdownPromise = (async () => {
      const shutdownErrors: Error[] = [];
      const capture = async (
        operation: () => Promise<void> | void,
      ): Promise<void> => {
        try {
          await operation();
        } catch (error) {
          shutdownErrors.push(
            error instanceof Error
              ? error
              : new Error("Player application shutdown operation failed", {
                  cause: error,
                }),
          );
        }
      };
      await capture(() => this.#unsubscribeChat?.());
      this.#unsubscribeChat = undefined;
      await capture(() => this.#runtime.shutdown(reason));
      await capture(() => this.#connection.shutdown(reason));
      await capture(() => this.#dashboard?.stop());
      await capture(() => this.#trace?.store.close());
      await capture(() => this.#skills.close());
      await capture(() => this.#mind.close());
      await capture(() => this.#memory.close());
      const temporarySkillDirectory = this.#temporarySkillDirectory;
      if (temporarySkillDirectory !== undefined) {
        await capture(() =>
          rmSync(temporarySkillDirectory, {
            recursive: true,
            force: true,
          }),
        );
      }
      const firstError = shutdownErrors[0];
      if (firstError !== undefined) throw firstError;
    })();
    return this.#shutdownPromise;
  }

  public async collectLiveEvidence(): Promise<LiveEvidence> {
    const player = this.#runtime.evidence();
    const observation = await this.#minecraft.observe().catch(() => null);
    return {
      capturedAt: new Date().toISOString(),
      connectionState: this.#connection.state,
      game:
        observation === null
          ? null
          : {
              connected: observation.connected,
              spawned: observation.spawned,
              health: observation.health,
              food: observation.food,
              oxygen: observation.oxygen,
              oxygenState: observation.oxygenState,
              inWater: observation.inWater,
              observedAt: observation.observedAt,
              activeTaskState: player.activeOperation?.kind ?? null,
              inventoryTotal: observation.inventory.reduce(
                (total, item) => total + item.count,
                0,
              ),
            },
      task:
        player.activeOperation === undefined
          ? null
          : {
              kind: player.activeOperation.kind,
              status: "running",
              phase: player.activeOperation.kind,
            },
      reflexState: "not_applicable",
      player,
    };
  }
}

export function createPlayerApplication(
  config: AppConfig,
): CompanionApplication {
  const logger = createLogger(config);
  const persona = loadPersona(config.personaPath);
  if (config.databasePath !== ":memory:") {
    mkdirSync(dirname(config.databasePath), { recursive: true });
  }
  const memory = MemoryStore.open(config.databasePath);
  const owner = memory.getOrCreatePlayer(config.ownerUsername);
  const existingLife = memory.getLifeState();
  if (existingLife === undefined)
    memory.saveLifeState({
      currentInterests: [],
      longTermGoals: [],
      possessions: [],
    });
  const trace = openTraceService(config.databasePath, logger);
  const mind = PlayerMindStore.open(config.databasePath);
  const temporarySkillDirectory =
    config.databasePath === ":memory:"
      ? mkdtempSync(join(tmpdir(), "mc-player-skills-"))
      : undefined;
  const skills = McSkillRepository.open({
    databasePath: config.databasePath,
    exchangeDirectory:
      temporarySkillDirectory ??
      resolve(dirname(config.databasePath), "mc-skills"),
    allowedOperationNames: playerOperationNames,
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
      pathfinderThinkTimeoutMs: 5_000,
      pathfinderTickTimeoutMs: 40,
      collectTimeoutMs: 10_000,
    },
    logger,
  );
  const connection = new ConnectionManager(
    minecraft,
    {
      maxAttempts: config.reconnect.maxAttempts + 1,
      initialDelayMs: config.reconnect.delayMs,
      maxDelayMs: config.reconnect.delayMs,
      multiplier: 1,
    },
    Math.min(config.limits.taskTimeoutMs, 60_000),
    config.reconnect.enabled,
    trace,
  );
  const body = minecraft.createPlayerBody();
  const client: PlayerResponsesClient = new OpenAI({
    apiKey: config.openai.apiKey,
  });
  if (
    mind.snapshot().goals.length === 0 &&
    existingLife?.longTermGoals.length
  ) {
    let revision = mind.snapshot().revision;
    for (const title of existingLife.longTermGoals) {
      const restored = mind.commitGoalState({
        expectedRevision: revision,
        goal: {
          title,
          status: "active",
          priority: 3,
          changeReason: "既存の長期目標を復元",
          source: "persona",
        },
      });
      if (restored.accepted) revision = restored.snapshot.revision;
    }
  }
  const playerMemory: PlayerMemoryPort = {
    context: () => {
      const lifeState = memory.getLifeState();
      return {
        persona: JSON.stringify({
          ...persona,
          currentInterests: lifeState?.currentInterests ?? [],
          goals: mind.snapshot().goals,
        }),
        ownerUsername: config.ownerUsername,
        relationship: memory.getRelationship(owner.id),
        lifeState,
        recalled: memory.recall({
          playerId: owner.id,
          query: "",
          limit: config.limits.memoryContextLimit,
        }),
      };
    },
    recall: (query) => memory.recall({ playerId: owner.id, query, limit: 8 }),
    persistGoals: (saved) => {
      const lifeState = memory.getLifeState();
      memory.saveLifeState({
        currentInterests: lifeState?.currentInterests ?? [],
        longTermGoals: saved
          .filter(
            (goal) => goal.status === "active" || goal.status === "paused",
          )
          .map(({ title }) => title)
          .slice(0, 24),
        ...(lifeState?.homeBase === undefined
          ? {}
          : { homeBase: lifeState.homeBase }),
        possessions: lifeState?.possessions ?? [],
      });
    },
    recordEpisode: (episode) =>
      memory.recordEpisode({
        playerId: owner.id,
        summary: episode.summary,
        importance: episode.status === "successful" ? 3 : 4,
        source: "minecraft_observed",
        details: {
          status: episode.status,
          ...(episode.operationKind === undefined
            ? {}
            : { operationKind: episode.operationKind }),
        },
      }),
  };
  const runtimeRef: { current?: PlayerRuntime } = {};
  const say = async (text: string): Promise<void> => {
    const safeText = sanitizeMinecraftChatText(text);
    if (safeText.length > 0) await minecraft.say(safeText);
  };
  const conversation = new PlayerConversationAgent({
    client,
    apiKey: config.openai.apiKey,
    model: config.openai.model,
    ownerUsername: config.ownerUsername,
    mind,
    memory: playerMemory,
    logger,
    ...(trace === undefined ? {} : { trace }),
    onCall: (metrics) =>
      mind.recordCall({
        inputTokens: metrics.inputTokens,
        outputTokens: metrics.outputTokens,
        latencyMs: metrics.latencyMs,
      }),
    onRoundActivity: (activity) => mind.recordAgentActivity(activity),
    say,
    onProposal: () => runtimeRef.current?.onOwnerProposal(),
    onStop: async () => {
      await runtimeRef.current?.stopNow();
    },
    onResume: () => runtimeRef.current?.onResume(),
  });
  const purpose = new PlayerPurposeAgent({
    client,
    apiKey: config.openai.apiKey,
    model: config.openai.model,
    body,
    skills,
    mind,
    memory: playerMemory,
    ownerPlayerId: owner.id,
    logger,
    ...(trace === undefined ? {} : { trace }),
    onCall: (metrics) =>
      mind.recordCall({
        inputTokens: metrics.inputTokens,
        outputTokens: metrics.outputTokens,
        latencyMs: metrics.latencyMs,
      }),
    onRoundActivity: (activity) => mind.recordAgentActivity(activity),
    onObservation: (observation) =>
      mind.recordObservation(toObservationEvidence(observation)),
    onCommitted: (snapshot, decision) =>
      runtimeRef.current?.handleCommittedDecision(snapshot, decision),
  });
  const runtime = new PlayerRuntime({
    ownerUsername: config.ownerUsername,
    playerId: owner.id,
    body,
    mind,
    memory: playerMemory,
    skills,
    conversation,
    purpose,
    logger,
    ...(trace === undefined ? {} : { trace }),
    say,
    requestReconnect: (reason) => minecraft.disconnect(reason),
  });
  runtimeRef.current = runtime;
  return new PlayerCompanionApplication({
    config,
    logger,
    memory,
    mind,
    skills,
    minecraft,
    connection,
    runtime,
    ...(temporarySkillDirectory === undefined
      ? {}
      : { temporarySkillDirectory }),
    ...(trace === undefined ? {} : { trace }),
  });
}

function openTraceService(
  databasePath: string,
  logger: Logger,
): TraceService | undefined {
  try {
    return new TraceService(TraceStore.open(databasePath), logger);
  } catch (error) {
    logger.warn(
      {
        code: "TRACE_STORE_OPEN_FAILED",
        errorType: error instanceof Error ? error.name : "UnknownError",
      },
      "trace observability unavailable",
    );
    return undefined;
  }
}
