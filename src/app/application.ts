import { mkdirSync } from "node:fs";
import { dirname } from "node:path";

import type { Logger } from "pino";

import { OpenAIDeliberationAgent } from "../agent/openai-agent.js";
import { ChatCoordinator } from "../agent/chat-coordinator.js";
import type { AppConfig } from "../config/schema.js";
import { AppError } from "../domain/errors.js";
import { MemoryStore } from "../memory/store.js";
import type { JsonObject, JsonValue } from "../memory/types.js";
import { ConnectionManager } from "../minecraft/connection-manager.js";
import { MineflayerClient } from "../minecraft/mineflayer-client.js";
import { createLogger } from "../observability/logger.js";
import {
  createCorrelationId,
  runWithCorrelation,
} from "../observability/correlation.js";
import { loadPersona } from "../persona/persona.js";
import { ReflexDetector } from "../reflexes/detectors.js";
import { ReflexCoordinator } from "../reflexes/reflex-coordinator.js";
import { ActionArbiter } from "../runtime/action-arbiter.js";
import { TaskRuntime } from "../runtime/task-service.js";
import { FollowPlayerSkill } from "../skills/follow-player.js";
import { GatherLogsSkill } from "../skills/gather-logs/gather-logs-skill.js";
import { MoveToSkill } from "../skills/move-to.js";
import { ReturnToPlayerSkill } from "../skills/return-to-player.js";
import { ToolExecutor } from "../tools/executor.js";
import type { GameStatus } from "../tools/contracts.js";
import { CompanionContextFactory } from "./context-factory.js";
import { CompanionGameController } from "./game-controller.js";
import { MemoryTaskStore, ToolMemoryAdapter } from "./memory-adapters.js";

const REFLEX_INTERVAL_MS = 250;
const MOVEMENT_PHASES = new Set([
  "move_to",
  "move_to_resource",
  "explore",
  "return_to_requester",
  "return_to_player",
  "following",
]);

export interface CompanionApplication {
  start(): Promise<void>;
  shutdown(reason?: string): Promise<void>;
  collectLiveEvidence(): Promise<LiveEvidence>;
}

export interface LiveEvidence {
  readonly capturedAt: string;
  readonly connectionState: ConnectionManager["state"];
  readonly game:
    | null
    | (Pick<
        GameStatus,
        | "connected"
        | "spawned"
        | "health"
        | "food"
        | "oxygen"
        | "activeTaskState"
      > & { readonly inventoryTotal: number });
  readonly task: null | {
    readonly kind: string;
    readonly status: string;
    readonly phase: string;
    readonly failureCode?: string;
    readonly correlationId?: string;
    readonly gathered?: LiveGatherEvidence;
  };
  readonly reflexState: string;
}

interface LiveGatherEvidence {
  readonly itemName?: string;
  readonly requestedCount?: number;
  readonly collectedCount?: number;
  readonly heldCount?: number;
  readonly playerDistance?: number;
}

class DefaultCompanionApplication implements CompanionApplication {
  readonly #minecraft: MineflayerClient;
  readonly #connection: ConnectionManager;
  readonly #memory: MemoryStore;
  readonly #tasks: TaskRuntime;
  readonly #reflexes: ReflexCoordinator;
  readonly #coordinator: ChatCoordinator;
  readonly #game: CompanionGameController;
  readonly #playerId: string;
  readonly #startupReassessmentRequired: boolean;
  readonly #logger: Logger;
  #unsubscribeChat: (() => void) | undefined;
  #reflexTimer: NodeJS.Timeout | undefined;
  #reflexTickInFlight = false;
  #observationUnavailable = false;
  #lastReflexFailure = "";
  #lastRememberedIncident = "";
  #lastReflexReassessment = "";
  #reconnectFailureLogged = false;
  #started = false;
  #shutdownPromise: Promise<void> | undefined;

  public constructor(input: {
    minecraft: MineflayerClient;
    connection: ConnectionManager;
    memory: MemoryStore;
    tasks: TaskRuntime;
    reflexes: ReflexCoordinator;
    coordinator: ChatCoordinator;
    game: CompanionGameController;
    playerId: string;
    startupReassessmentRequired: boolean;
    logger: Logger;
  }) {
    this.#minecraft = input.minecraft;
    this.#connection = input.connection;
    this.#memory = input.memory;
    this.#tasks = input.tasks;
    this.#reflexes = input.reflexes;
    this.#coordinator = input.coordinator;
    this.#game = input.game;
    this.#playerId = input.playerId;
    this.#startupReassessmentRequired = input.startupReassessmentRequired;
    this.#logger = input.logger;
  }

  public async start(): Promise<void> {
    if (this.#started) return;
    await this.#connection.connect();
    this.#unsubscribeChat = this.#minecraft.onChat((username, message) => {
      void this.#coordinator
        .handleChat(username, message)
        .catch((error: unknown) => {
          this.#logger.error(
            {
              errorType: error instanceof Error ? error.name : "UnknownError",
            },
            "chat coordination failed",
          );
        });
    });
    this.#reflexTimer = setInterval(() => {
      void runWithCorrelation(createCorrelationId(), () =>
        this.#runReflexTick(),
      );
    }, REFLEX_INTERVAL_MS);
    this.#started = true;
    this.#logger.info(
      { minecraftVersion: "configured", reflexIntervalMs: REFLEX_INTERVAL_MS },
      "AI companion started",
    );
    if (this.#startupReassessmentRequired) {
      this.#requestRuntimeReassessment("startup_reassessment");
    }
  }

  public async shutdown(reason = "shutdown"): Promise<void> {
    if (this.#shutdownPromise !== undefined) return this.#shutdownPromise;
    this.#shutdownPromise = this.#performShutdown(reason);
    return this.#shutdownPromise;
  }

  public async collectLiveEvidence(): Promise<LiveEvidence> {
    const status = await this.#game.observeStatus().catch(() => null);
    const recentTask = this.#memory.listRecentTaskRuns(this.#playerId, 1)[0];
    const correlationId =
      typeof recentTask?.input.correlationId === "string"
        ? recentTask.input.correlationId
        : undefined;
    const gathered = gatherEvidence(recentTask?.output);
    return {
      capturedAt: new Date().toISOString(),
      connectionState: this.#connection.state,
      game:
        status === null
          ? null
          : {
              connected: status.connected,
              spawned: status.spawned,
              health: status.health,
              food: status.food,
              oxygen: status.oxygen,
              activeTaskState: status.activeTaskState,
              inventoryTotal: Object.values(status.inventory).reduce(
                (total, count) => total + count,
                0,
              ),
            },
      task:
        recentTask === undefined
          ? null
          : {
              kind: recentTask.kind,
              status: recentTask.status,
              phase: recentTask.phase,
              ...(recentTask.failure?.code === undefined
                ? {}
                : { failureCode: recentTask.failure.code }),
              ...(correlationId === undefined ? {} : { correlationId }),
              ...(gathered === undefined ? {} : { gathered }),
            },
      reflexState: this.#reflexes.state.state,
    };
  }

  async #performShutdown(reason: string): Promise<void> {
    if (this.#reflexTimer !== undefined) {
      clearInterval(this.#reflexTimer);
      this.#reflexTimer = undefined;
    }
    this.#unsubscribeChat?.();
    this.#unsubscribeChat = undefined;
    await this.#coordinator.shutdown();
    await this.#tasks.suspend(reason);
    await this.#connection.shutdown(reason);
    this.#memory.close();
    this.#started = false;
    this.#logger.info({}, "AI companion stopped");
  }

  async #runReflexTick(): Promise<void> {
    if (this.#reflexTickInFlight || this.#shutdownPromise !== undefined) return;
    this.#reflexTickInFlight = true;
    try {
      const snapshot = await this.#minecraft.observe();
      if (this.#connection.state === "connected") {
        this.#reconnectFailureLogged = false;
      }
      if (this.#observationUnavailable) {
        this.#logger.info({}, "Minecraft observation recovered");
        this.#observationUnavailable = false;
        this.#requestRuntimeReassessment("connection_recovered");
      }
      const phase = this.#tasks.current?.phase;
      const state = await this.#reflexes.tick(
        snapshot,
        phase !== undefined && MOVEMENT_PHASES.has(phase),
      );
      if (state.state === "safe") {
        this.#lastRememberedIncident = "";
        this.#lastReflexReassessment = "";
      } else if (state.incident.kind !== "hunger") {
        const incidentKey = [
          state.incident.kind,
          Math.round(snapshot.position.x),
          Math.round(snapshot.position.y),
          Math.round(snapshot.position.z),
          snapshot.dimension,
        ].join(":");
        if (incidentKey !== this.#lastRememberedIncident) {
          try {
            this.#memory.rememberWorldMemory({
              kind: "hazard",
              name: `Observed ${state.incident.kind}`,
              description:
                "A deterministic reflex detected a hazard at this position",
              dimension: snapshot.dimension,
              x: snapshot.position.x,
              y: snapshot.position.y,
              z: snapshot.position.z,
              source: "minecraft_observed",
            });
            this.#lastRememberedIncident = incidentKey;
          } catch (error) {
            this.#logger.error(
              {
                category: "persistence",
                code: "WORLD_MEMORY_SAVE_FAILED",
                errorType: error instanceof Error ? error.name : "UnknownError",
              },
              "world memory persistence failed",
            );
          }
        }
      }
      if (state.state === "stabilizing" || state.state === "failed") {
        const reassessmentKey = `${state.state}:${state.incident.kind}`;
        if (reassessmentKey !== this.#lastReflexReassessment) {
          this.#lastReflexReassessment = reassessmentKey;
          this.#requestRuntimeReassessment(
            state.state === "stabilizing"
              ? "safety_stabilized"
              : "safety_failed",
          );
        }
      }
      if (state.state === "failed") {
        const key = `${state.incident.kind}:${state.failure.code}`;
        if (key !== this.#lastReflexFailure) {
          this.#logger.error(
            {
              incident: state.incident.kind,
              category: state.failure.category,
              code: state.failure.code,
              retryable: state.failure.retryable,
            },
            "reflex intervention failed",
          );
          this.#lastReflexFailure = key;
        }
      } else {
        this.#lastReflexFailure = "";
      }
    } catch (error) {
      if (!this.#observationUnavailable) {
        this.#logger.warn(
          {
            category:
              error instanceof AppError ? error.detail.category : "observation",
            code:
              error instanceof AppError
                ? error.detail.code
                : "OBSERVATION_UNAVAILABLE",
          },
          "Minecraft observation unavailable",
        );
        this.#observationUnavailable = true;
      }
      if (
        this.#connection.state === "failed" &&
        this.#connection.lastReconnectFailure !== undefined &&
        !this.#reconnectFailureLogged
      ) {
        this.#logger.error(
          {
            category: "connection",
            code: "RECONNECT_RETRY_EXHAUSTED",
            retryable: false,
          },
          "Minecraft reconnection entered an explicit failed state",
        );
        this.#reconnectFailureLogged = true;
      }
    } finally {
      this.#reflexTickInFlight = false;
    }
  }

  #requestRuntimeReassessment(
    event: Parameters<ChatCoordinator["handleRuntimeEvent"]>[0],
  ): void {
    void this.#coordinator.handleRuntimeEvent(event).catch((error: unknown) => {
      this.#logger.error(
        {
          category: "llm",
          code: "RUNTIME_REASSESSMENT_FAILED",
          event,
          errorType: error instanceof Error ? error.name : "UnknownError",
        },
        "runtime reassessment failed",
      );
    });
  }
}

export function createApplication(config: AppConfig): CompanionApplication {
  const logger = createLogger(config);
  const persona = loadPersona(config.personaPath);
  prepareDatabaseDirectory(config.databasePath);
  const memory = MemoryStore.open(config.databasePath);
  const player = memory.getOrCreatePlayer(config.ownerUsername);
  const startupReassessmentRequired =
    memory.listActiveCommitments(player.id).length > 0 ||
    memory
      .listRecentTaskRuns(player.id, 8)
      .some(({ status }) => status === "suspended");
  if (memory.getLifeState() === undefined) {
    memory.saveLifeState({
      currentInterests: [],
      longTermGoals: [],
      possessions: [],
    });
  }
  const minecraft = new MineflayerClient(
    {
      bot: {
        host: config.minecraft.host,
        port: config.minecraft.port,
        username: config.minecraft.username,
        auth: config.minecraft.auth,
        version: config.minecraft.version,
      },
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
  );
  const arbiter = new ActionArbiter();
  const tasks = new TaskRuntime(new MemoryTaskStore(memory, player.id), () =>
    minecraft.stopCurrentAction(),
  );
  const followPlayer = new FollowPlayerSkill(minecraft, tasks, arbiter);
  const moveTo = new MoveToSkill(minecraft, tasks, arbiter);
  const returnToPlayer = new ReturnToPlayerSkill(minecraft, tasks, arbiter);
  const gatherLogs = new GatherLogsSkill(minecraft, tasks, arbiter, {
    maxCount: config.limits.maxGatherCount,
    localSearchDistance: Math.min(32, config.limits.maxMoveDistance),
    maxSearchDistance: config.limits.maxMoveDistance,
    searchStep: Math.min(16, config.limits.maxMoveDistance),
    moveRange: 3,
    returnRange: config.limits.followDistance,
    maxPathAttempts: config.limits.skillRetryLimit + 1,
  });
  const game = new CompanionGameController({
    minecraft,
    tasks,
    arbiter,
    followPlayer,
    moveTo,
    gatherLogs,
    returnToPlayer,
    ownerUsername: config.ownerUsername,
    taskTimeoutMs: config.limits.taskTimeoutMs,
    retryLimit: config.limits.skillRetryLimit,
    logger,
    memory,
  });
  const reflexThresholds = {
    lowFood: config.limits.hungerThreshold,
    lowOxygen: 5,
    hostileDistance: 8,
    fallingVelocity: -1.2,
    stuckWindowMs: 3_000,
    stuckDistance: 0.5,
  };
  const reflexes = new ReflexCoordinator(
    new ReflexDetector(reflexThresholds),
    reflexThresholds,
    minecraft,
    tasks,
    arbiter,
    Math.min(config.limits.taskTimeoutMs, 10_000),
    config.limits.skillRetryLimit + 1,
  );
  const toolMemory = new ToolMemoryAdapter(memory);
  const agent = new OpenAIDeliberationAgent({
    apiKey: config.openai.apiKey,
    model: config.openai.model,
    executor: new ToolExecutor(),
    logger,
  });
  const contextFactory = new CompanionContextFactory(
    config,
    player.id,
    memory,
    toolMemory,
    persona,
    game,
    tasks,
  );
  const coordinator = new ChatCoordinator({
    ownerUsername: config.ownerUsername,
    game,
    agent,
    contextFactory,
    logger,
  });
  return new DefaultCompanionApplication({
    minecraft,
    connection,
    memory,
    tasks,
    reflexes,
    coordinator,
    game,
    playerId: player.id,
    startupReassessmentRequired,
    logger,
  });
}

function prepareDatabaseDirectory(databasePath: string): void {
  if (databasePath === ":memory:") return;
  mkdirSync(dirname(databasePath), { recursive: true });
}

function gatherEvidence(
  output: JsonValue | undefined,
): LiveGatherEvidence | undefined {
  if (output === undefined || !isJsonObject(output)) return undefined;
  const gathered: {
    itemName?: string;
    requestedCount?: number;
    collectedCount?: number;
    heldCount?: number;
    playerDistance?: number;
  } = {};
  if (typeof output.itemName === "string") gathered.itemName = output.itemName;
  if (typeof output.requestedCount === "number")
    gathered.requestedCount = output.requestedCount;
  if (typeof output.collectedCount === "number")
    gathered.collectedCount = output.collectedCount;
  if (typeof output.heldCount === "number")
    gathered.heldCount = output.heldCount;
  if (typeof output.playerDistance === "number")
    gathered.playerDistance = output.playerDistance;
  return Object.keys(gathered).length === 0 ? undefined : gathered;
}

function isJsonObject(value: JsonValue): value is JsonObject {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
