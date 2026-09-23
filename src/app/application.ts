import { mkdirSync } from "node:fs";
import { dirname } from "node:path";

import type { Logger } from "pino";

import { OpenAIDeliberationAgent } from "../agent/openai-agent.js";
import {
  ChatCoordinator,
  type RuntimeReassessmentEvent,
} from "../agent/chat-coordinator.js";
import type { AppConfig } from "../config/schema.js";
import {
  DashboardHttpServer,
  type DashboardBotHealth,
} from "../dashboard/http-server.js";
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
import {
  ReflexCoordinator,
  type ReflexState,
} from "../reflexes/reflex-coordinator.js";
import { ActionArbiter } from "../runtime/action-arbiter.js";
import { TaskRuntime } from "../runtime/task-service.js";
import { FollowPlayerSkill } from "../skills/follow-player.js";
import { GatherLogsSkill } from "../skills/gather-logs/gather-logs-skill.js";
import { MoveToSkill } from "../skills/move-to.js";
import { ReturnToPlayerSkill } from "../skills/return-to-player.js";
import { ToolExecutor } from "../tools/executor.js";
import type { GameStatus } from "../tools/contracts.js";
import { TraceService, type TraceSession } from "../trace/service.js";
import { TraceStore } from "../trace/store.js";
import { CompanionContextFactory } from "./context-factory.js";
import { CompanionGameController } from "./game-controller.js";
import {
  MemoryTaskStore,
  ToolBehaviorMemoryAdapter,
  ToolMemoryAdapter,
} from "./memory-adapters.js";
import {
  RuntimeReassessmentGate,
  type RuntimeReassessmentRequest,
} from "./runtime-reassessment-gate.js";

const REFLEX_INTERVAL_MS = 250;
const RUNTIME_REASSESSMENT_COOLDOWN_MS = 30_000;
const SAFETY_REASSESSMENT_QUIET_MS = 60_000;
const MOVEMENT_PHASES = new Set([
  "move_to",
  "move_to_resource",
  "explore",
  "return_to_requester",
  "return_to_player",
  "following",
]);

const runtimeReassessmentPriority = (event: RuntimeReassessmentEvent): number =>
  ({
    safety_failed: 4,
    connection_recovered: 3,
    startup_reassessment: 2,
    safety_stabilized: 1,
  })[event];

export function taskExpectsMovement(
  task:
    | {
        readonly kind?: string;
        readonly status: string;
        readonly phase: string;
        readonly input?: unknown;
      }
    | undefined,
  ownerDistance?: number,
  followDistance = 0,
): boolean {
  if (task?.status !== "running" || !MOVEMENT_PHASES.has(task.phase))
    return false;
  return task.phase !== "following"
    ? true
    : ownerDistance !== undefined &&
        ownerDistance > activeFollowDistance(task, followDistance) + 0.75;
}

function activeFollowDistance(
  task: { readonly kind?: string; readonly input?: unknown },
  fallback: number,
): number {
  if (
    task.kind !== "follow_player" ||
    task.input === null ||
    typeof task.input !== "object" ||
    Array.isArray(task.input)
  ) {
    return fallback;
  }
  const range = (task.input as { readonly range?: unknown }).range;
  return typeof range === "number" && Number.isFinite(range) && range >= 0
    ? range
    : fallback;
}

export function reflexReassessmentForTransition(
  previous: ReflexState,
  current: ReflexState,
): RuntimeReassessmentEvent | undefined {
  if (current.state === "failed") {
    return previous.state === "failed" &&
      previous.incident.kind === current.incident.kind &&
      previous.failure.code === current.failure.code
      ? undefined
      : "safety_failed";
  }
  return previous.state !== "safe" && current.state === "safe"
    ? "safety_stabilized"
    : undefined;
}

function safeRuntimeKey(value: string): string {
  return value.replace(/[^a-zA-Z0-9:_-]/g, "_").slice(0, 96);
}

export function runtimeReassessmentState(
  event: RuntimeReassessmentEvent,
  previous: ReflexState,
  current: ReflexState,
  connectionRecoveryEpisode?: number,
): { readonly stateKey: string; readonly causeKey: string } {
  if (event === "safety_failed" && current.state === "failed") {
    const attemptSuffix =
      previous.state === "stabilizing"
        ? `:attempt:${safeRuntimeKey(current.startedAt ?? current.endedAt ?? "unknown")}`
        : "";
    return {
      stateKey: `safety:failed:${current.incident.kind}:${safeRuntimeKey(current.failure.code)}${attemptSuffix}`,
      causeKey: `reflex:${current.incident.kind}`,
    };
  }
  if (event === "safety_stabilized") {
    const kind = previous.state === "safe" ? "unknown" : previous.incident.kind;
    return {
      stateKey: `safety:stabilized:${kind}`,
      causeKey: `reflex:${kind}`,
    };
  }
  if (event === "connection_recovered") {
    const suffix =
      connectionRecoveryEpisode === undefined
        ? ""
        : `:${Math.max(1, Math.floor(connectionRecoveryEpisode))}`;
    return {
      stateKey: `connection:recovered${suffix}`,
      causeKey: "connection",
    };
  }
  return { stateKey: "startup:reassessment", causeKey: "startup" };
}

/** Repeated short recoveries from one hazard are one user-visible episode. */
export class SafetyReassessmentEpisodes {
  readonly #recent = new Map<string, { episode: number; lastSeenAt: number }>();
  #nextEpisode = 0;

  public constructor(private readonly quietMs = SAFETY_REASSESSMENT_QUIET_MS) {}

  public state(
    event: RuntimeReassessmentEvent,
    state: { readonly stateKey: string; readonly causeKey: string },
    nowMs = Date.now(),
  ): { readonly stateKey: string; readonly causeKey: string } {
    if (event === "safety_failed") {
      this.#recent.delete(state.causeKey);
      return state;
    }
    if (event !== "safety_stabilized") return state;
    const previous = this.#recent.get(state.causeKey);
    const episode =
      previous !== undefined &&
      nowMs - previous.lastSeenAt < this.quietMs &&
      nowMs >= previous.lastSeenAt
        ? previous.episode
        : ++this.#nextEpisode;
    this.#recent.set(state.causeKey, { episode, lastSeenAt: nowMs });
    return { ...state, stateKey: `${state.stateKey}:episode:${episode}` };
  }
}

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
        | "oxygenState"
        | "inWater"
        | "observedAt"
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
  readonly #runtimeReassessments: RuntimeReassessmentGate<RuntimeReassessmentEvent>;
  readonly #safetyReassessmentEpisodes = new SafetyReassessmentEpisodes();
  readonly #game: CompanionGameController;
  readonly #playerId: string;
  readonly #ownerUsername: string;
  readonly #followDistance: number;
  readonly #startupReassessmentRequired: boolean;
  readonly #logger: Logger;
  readonly #traceService: TraceService | undefined;
  readonly #dashboard: DashboardHttpServer | undefined;
  #unsubscribeChat: (() => void) | undefined;
  #unsubscribeDeath: (() => void) | undefined;
  #unsubscribeImmediateStop: (() => void) | undefined;
  #unsubscribeOwnerMessage: (() => void) | undefined;
  #reflexTimer: NodeJS.Timeout | undefined;
  #reflexTickPromise: Promise<void> | undefined;
  #observationUnavailable = false;
  #connectionRecoveryEpisode = 0;
  #lastReflexFailure = "";
  #lastRememberedIncident = "";
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
    ownerUsername: string;
    followDistance: number;
    startupReassessmentRequired: boolean;
    logger: Logger;
    traceService?: TraceService | undefined;
    dashboard: AppConfig["dashboard"];
  }) {
    this.#minecraft = input.minecraft;
    this.#connection = input.connection;
    this.#memory = input.memory;
    this.#tasks = input.tasks;
    this.#reflexes = input.reflexes;
    this.#coordinator = input.coordinator;
    this.#game = input.game;
    this.#playerId = input.playerId;
    this.#ownerUsername = input.ownerUsername;
    this.#followDistance = input.followDistance;
    this.#startupReassessmentRequired = input.startupReassessmentRequired;
    this.#logger = input.logger;
    this.#traceService = input.traceService;
    this.#dashboard = this.#createDashboard(input.dashboard);
    this.#runtimeReassessments = new RuntimeReassessmentGate({
      run: (event, request) =>
        this.#coordinator.handleRuntimeEvent(event, {
          stateKey: request.stateKey,
          ...(request.causeKey === undefined
            ? {}
            : { causeKey: request.causeKey }),
        }),
      priority: runtimeReassessmentPriority,
      cooldownMs: RUNTIME_REASSESSMENT_COOLDOWN_MS,
      onError: (error, event, request) => {
        this.#logger.error(
          {
            category: "llm",
            code: "RUNTIME_REASSESSMENT_FAILED",
            event,
            cause: request.causeKey ?? "unspecified",
            errorType: error instanceof Error ? error.name : "UnknownError",
          },
          "runtime reassessment failed",
        );
      },
      onDecision: (decision) => {
        this.#logger.info(
          {
            category: "llm",
            code: "RUNTIME_REASSESSMENT_GATE_DECISION",
            event: decision.event,
            cause: decision.causeKey ?? "unspecified",
            outcome: decision.outcome,
            reason: decision.reason ?? "none",
            requested: decision.stats.requested,
            started: decision.stats.started,
            completed: decision.stats.completed,
            failed: decision.stats.failed,
            cancelled: decision.stats.cancelled,
            suppressed: decision.stats.suppressed,
          },
          "runtime reassessment gate decision",
        );
      },
    });
    this.#unsubscribeImmediateStop = this.#coordinator.onImmediateStop(() =>
      this.#runtimeReassessments.cancelPending("stopped"),
    );
    this.#unsubscribeOwnerMessage = this.#coordinator.onOwnerMessage(() =>
      this.#runtimeReassessments.cancelPending("owner_message"),
    );
  }

  public async start(): Promise<void> {
    if (this.#started) return;
    await this.#startDashboard();
    this.#unsubscribeDeath ??= this.#minecraft.onDeath((observedAt) => {
      try {
        this.#memory.recordEpisode({
          playerId: this.#playerId,
          summary:
            "Bot自身が死亡した。復帰状態は現在のMinecraft観測で確認する。",
          importance: 5,
          source: "minecraft_observed",
          details: { event: "bot_death" },
          observedAt,
        });
      } catch (error) {
        this.#logger.error(
          {
            code: "BOT_DEATH_MEMORY_SAVE_FAILED",
            errorType: error instanceof Error ? error.name : "UnknownError",
          },
          "bot death memory persistence failed",
        );
      }
    });
    await this.#connectMinecraft();
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
      this.#scheduleReflexTick();
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
              oxygenState: status.oxygenState,
              inWater: status.inWater,
              observedAt: status.observedAt,
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
    this.#unsubscribeDeath?.();
    this.#unsubscribeDeath = undefined;
    const runtimeReassessmentsStopped = this.#runtimeReassessments.stop();
    const coordinatorStopped = this.#coordinator.shutdown();
    await Promise.all([
      this.#reflexTickPromise,
      coordinatorStopped,
      runtimeReassessmentsStopped,
    ]);
    this.#unsubscribeImmediateStop?.();
    this.#unsubscribeImmediateStop = undefined;
    this.#unsubscribeOwnerMessage?.();
    this.#unsubscribeOwnerMessage = undefined;
    await this.#tasks.suspend(reason);
    await this.#connection.shutdown(reason);
    await this.#stopDashboard();
    this.#memory.close();
    try {
      this.#traceService?.store.close();
    } catch (error) {
      this.#logger.warn(
        {
          category: "observability",
          code: "TRACE_STORE_CLOSE_FAILED",
          errorType: error instanceof Error ? error.name : "UnknownError",
        },
        "trace store close failed",
      );
    }
    this.#started = false;
    this.#logger.info({}, "AI companion stopped");
  }

  #scheduleReflexTick(): void {
    if (
      this.#reflexTickPromise !== undefined ||
      this.#shutdownPromise !== undefined
    ) {
      return;
    }
    const tick = runWithCorrelation(createCorrelationId(), () =>
      this.#runReflexTick(),
    ).finally(() => {
      if (this.#reflexTickPromise === tick) this.#reflexTickPromise = undefined;
    });
    this.#reflexTickPromise = tick;
  }

  async #runReflexTick(): Promise<void> {
    if (this.#shutdownPromise !== undefined) return;
    try {
      const snapshot = await this.#minecraft.observe();
      if (this.#connection.state === "connected") {
        this.#reconnectFailureLogged = false;
      }
      if (this.#observationUnavailable) {
        this.#logger.info({}, "Minecraft observation recovered");
        this.#observationUnavailable = false;
        this.#requestRuntimeReassessment(
          "connection_recovered",
          runtimeReassessmentState(
            "connection_recovered",
            { state: "safe" },
            { state: "safe" },
            this.#connectionRecoveryEpisode,
          ),
        );
      }
      const previousReflexState = this.#reflexes.state;
      const ownerDistance = snapshot.players.find(
        ({ username }) => username === this.#ownerUsername,
      )?.distance;
      const state = await this.#reflexes.tick(
        snapshot,
        taskExpectsMovement(
          this.#tasks.current,
          ownerDistance,
          this.#followDistance,
        ),
      );
      await this.#recordReflexTransition(previousReflexState, state);
      if (state.state === "safe") {
        this.#lastRememberedIncident = "";
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
      const reassessment = reflexReassessmentForTransition(
        previousReflexState,
        state,
      );
      if (reassessment !== undefined) {
        this.#requestRuntimeReassessment(
          reassessment,
          this.#safetyReassessmentEpisodes.state(
            reassessment,
            runtimeReassessmentState(reassessment, previousReflexState, state),
          ),
        );
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
        this.#connectionRecoveryEpisode += 1;
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
    }
  }

  #requestRuntimeReassessment(
    event: RuntimeReassessmentEvent,
    context: { readonly stateKey: string; readonly causeKey?: string } = {
      stateKey: event,
    },
  ): void {
    const request: RuntimeReassessmentRequest<RuntimeReassessmentEvent> = {
      event,
      ...context,
    };
    this.#runtimeReassessments.request(request);
  }

  #createDashboard(
    config: AppConfig["dashboard"],
  ): DashboardHttpServer | undefined {
    if (this.#traceService === undefined) return undefined;
    try {
      return new DashboardHttpServer(
        this.#traceService,
        {
          ...config,
          getBotHealth: () => this.#collectDashboardHealth(),
        },
        this.#logger,
      );
    } catch (error) {
      this.#logger.error(
        {
          category: "observability",
          code: "DASHBOARD_CONFIGURATION_FAILED",
          errorType: error instanceof Error ? error.name : "UnknownError",
        },
        "trace dashboard unavailable",
      );
      return undefined;
    }
  }

  async #startDashboard(): Promise<void> {
    try {
      await this.#dashboard?.start();
    } catch (error) {
      this.#logger.error(
        {
          category: "observability",
          code: "DASHBOARD_START_FAILED",
          errorType: error instanceof Error ? error.name : "UnknownError",
        },
        "trace dashboard unavailable",
      );
    }
  }

  async #connectMinecraft(): Promise<void> {
    const traceService = this.#traceService;
    if (traceService === undefined) {
      await this.#connection.connect();
      return;
    }
    const operation: { promise?: Promise<void> } = {};
    const connect = (): Promise<void> => {
      operation.promise = this.#connection.connect();
      return operation.promise;
    };
    let session: TraceSession | undefined;
    try {
      session = await traceService.startTrace("Minecraft接続状態を更新", {
        attributes: { requestKind: "system_startup" },
      });
      await traceService.withTrace(session, () =>
        traceService.withSpan(
          "system",
          "Minecraftへ接続",
          {
            summary: "設定済みMinecraft serverへ接続",
            summarizeResult: () => "Minecraft接続を確立",
          },
          connect,
        ),
      );
      await session.complete("succeeded", { summary: "Minecraft接続を確立" });
    } catch (error) {
      if (operation.promise !== undefined) {
        try {
          await operation.promise;
        } catch {
          try {
            await session?.complete("failed", {
              summary: "Minecraft接続を確立できず",
            });
          } catch {
            // The original connection failure remains authoritative.
          }
          throw error;
        }
        return;
      }
      await connect();
    }
  }

  async #stopDashboard(): Promise<void> {
    try {
      await this.#dashboard?.stop();
    } catch (error) {
      this.#logger.warn(
        {
          category: "observability",
          code: "DASHBOARD_STOP_FAILED",
          errorType: error instanceof Error ? error.name : "UnknownError",
        },
        "trace dashboard stop failed",
      );
    }
  }

  async #collectDashboardHealth(): Promise<DashboardBotHealth> {
    const evidence = await this.collectLiveEvidence();
    return {
      botState:
        evidence.game === null
          ? "unknown"
          : evidence.game.connected && evidence.game.spawned
            ? "active"
            : "unavailable",
      connectionState: evidence.connectionState,
      aiState: this.#traceService?.health.active === true ? "active" : "idle",
      memoryState: "available",
      reflexState: evidence.reflexState,
      ...(evidence.game === null
        ? { positionState: "unavailable" as const }
        : {
            health: evidence.game.health,
            food: evidence.game.food,
            positionState: evidence.game.spawned
              ? ("available_redacted" as const)
              : ("unavailable" as const),
          }),
      ...(evidence.task === null
        ? {}
        : {
            taskStatus: evidence.task.status,
            taskPhase: evidence.task.phase,
          }),
    };
  }

  async #recordReflexTransition(
    previous: ReflexState,
    current: ReflexState,
  ): Promise<void> {
    const traceService = this.#traceService;
    if (
      traceService === undefined ||
      reflexTraceKey(previous) === reflexTraceKey(current)
    ) {
      return;
    }
    const record = () =>
      traceService.withSpan(
        "reflex",
        "安全介入状態を更新",
        {
          summary: "Minecraft観測に基づく安全状態の変化",
          resultKind: "skill_result",
          attributes: {
            previousState: previous.state,
            currentState: current.state,
            ...(current.state === "safe"
              ? {}
              : {
                  incidentKind: current.incident.kind,
                  incidentReason: current.incident.reason,
                  observationSubject: current.incident.observation.subject,
                  observationSource: current.incident.observation.source,
                  observationAt: current.incident.observation.observedAt,
                  observationDimension: current.incident.observation.dimension,
                  observationX: current.incident.observation.position.x,
                  observationY: current.incident.observation.position.y,
                  observationZ: current.incident.observation.position.z,
                  observationInWater: current.incident.observation.inWater,
                  observationOxygen: current.incident.observation.oxygen,
                  observationOxygenState:
                    current.incident.observation.oxygenState,
                  ...(current.state === "failed" &&
                  current.failure.code === "REFLEX_NOT_STABLE"
                    ? { failureCode: current.failure.code }
                    : {}),
                  ...(current.after === undefined
                    ? {}
                    : {
                        afterObservationAt: current.after.observedAt,
                        afterObservationInWater: current.after.inWater,
                        afterObservationOxygen: current.after.oxygen,
                        afterObservationOxygenState: current.after.oxygenState,
                        afterObservationX: current.after.position.x,
                        afterObservationY: current.after.position.y,
                        afterObservationZ: current.after.position.z,
                      }),
                  ...(current.startedAt === undefined
                    ? {}
                    : { interventionStartedAt: current.startedAt }),
                  ...(current.endedAt === undefined
                    ? {}
                    : { interventionEndedAt: current.endedAt }),
                }),
          },
          summarizeResult: () => "安全状態の変化を記録",
        },
        async () => current.state,
      );
    try {
      if (traceService.health.active) {
        await traceService.withActiveTrace(record);
        return;
      }
      const session = await traceService.startTrace("安全状態の変化", {
        attributes: { requestKind: "runtime_reflex" },
      });
      await traceService.withTrace(session, record);
      await session.complete(
        current.state === "failed" ? "failed" : "succeeded",
        {
          summary:
            current.state === "failed"
              ? "安全介入を完了できず"
              : "安全状態を更新",
        },
      );
    } catch (error) {
      this.#logger.warn(
        {
          category: "observability",
          code: "REFLEX_TRACE_FAILED",
          errorType: error instanceof Error ? error.name : "UnknownError",
        },
        "reflex trace unavailable",
      );
    }
  }
}

export function createApplication(config: AppConfig): CompanionApplication {
  const logger = createLogger(config);
  const persona = loadPersona(config.personaPath);
  prepareDatabaseDirectory(config.databasePath);
  const memory = MemoryStore.open(config.databasePath);
  const traceService = createTraceService(config.databasePath, logger);
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
    traceService,
  );
  const arbiter = new ActionArbiter();
  const tasks = new TaskRuntime(
    new MemoryTaskStore(memory, player.id),
    () => minecraft.stopCurrentAction(),
    traceService,
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
    playerId: player.id,
    taskTimeoutMs: config.limits.taskTimeoutMs,
    hungerThreshold: config.limits.hungerThreshold,
    retryLimit: config.limits.skillRetryLimit,
    maxMoveDistance: config.limits.maxMoveDistance,
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
  const toolBehaviorMemory = new ToolBehaviorMemoryAdapter(memory);
  const executor = new ToolExecutor(traceService);
  const agent = new OpenAIDeliberationAgent({
    apiKey: config.openai.apiKey,
    model: config.openai.model,
    executor,
    logger,
    ...(traceService === undefined ? {} : { traceService }),
  });
  const contextFactory = new CompanionContextFactory(
    config,
    player.id,
    memory,
    toolMemory,
    persona,
    game,
    tasks,
    traceService,
    toolBehaviorMemory,
  );
  const coordinator = new ChatCoordinator({
    ownerUsername: config.ownerUsername,
    game,
    agent,
    contextFactory,
    logger,
    ...(traceService === undefined ? {} : { traceService }),
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
    ownerUsername: config.ownerUsername,
    followDistance: config.limits.followDistance,
    startupReassessmentRequired,
    logger,
    ...(traceService === undefined ? {} : { traceService }),
    dashboard: config.dashboard,
  });
}

function createTraceService(
  databasePath: string,
  logger: Logger,
): TraceService | undefined {
  try {
    return new TraceService(TraceStore.open(databasePath), logger);
  } catch (error) {
    logger.error(
      {
        category: "observability",
        code: "TRACE_STORE_OPEN_FAILED",
        errorType: error instanceof Error ? error.name : "UnknownError",
      },
      "trace observability unavailable",
    );
    return undefined;
  }
}

function reflexTraceKey(state: ReflexState): string {
  return state.state === "safe"
    ? "safe"
    : `${state.state}:${state.incident.kind}${
        state.state === "failed" ? `:${state.failure.code}` : ""
      }`;
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
