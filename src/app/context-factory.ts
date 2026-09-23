import type { AppConfig } from "../config/schema.js";
import { behaviorMemoryDescription } from "../memory/behavior-memory.js";
import type { MemoryStore } from "../memory/store.js";
import type { PersonaCore } from "../persona/persona.js";
import { buildPersonaContext } from "../persona/persona.js";
import type { TaskRuntime } from "../runtime/task-service.js";
import type { CognitiveStage } from "../trace/contracts.js";
import type { TraceService, WithSpanOptions } from "../trace/service.js";
import { OwnerBehaviorMemoryLearner } from "../agent/behavior-memory-learning.js";
import type {
  BehaviorMemoryPort,
  GameController,
  MemoryPort,
  ToolContext,
} from "../tools/contracts.js";
import type { ChatContextFactory } from "../agent/chat-coordinator.js";
import {
  deriveOwnerGoalAuthorization,
  type PendingOwnerGoal,
} from "../decision/owner-goal-authorization.js";

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
    if (operationPromise !== undefined) {
      return operationPromise;
    }
    return operation();
  }
}

export class CompanionContextFactory implements ChatContextFactory {
  #pendingOwnerGoal: PendingOwnerGoal | undefined;
  readonly #behaviorLearner: OwnerBehaviorMemoryLearner;

  public constructor(
    private readonly config: AppConfig,
    private readonly playerId: string,
    private readonly memoryStore: MemoryStore,
    private readonly toolMemory: MemoryPort,
    private readonly persona: PersonaCore,
    private readonly game: GameController,
    private readonly tasks: TaskRuntime,
    private readonly traceService?: TraceService,
    private readonly toolBehaviorMemory?: BehaviorMemoryPort,
  ) {
    this.#behaviorLearner = new OwnerBehaviorMemoryLearner(memoryStore);
  }

  public clearPendingOwnerGoal(): void {
    this.#pendingOwnerGoal = undefined;
  }

  public acceptOwnerMessage(
    requesterUsername: string,
    message: string,
    eventId: string,
  ): void {
    if (requesterUsername !== this.config.ownerUsername) return;
    this.#behaviorLearner.learn({
      ownerUsername: this.config.ownerUsername,
      requesterUsername,
      playerId: this.playerId,
      message,
      requestKind: "owner_message",
      eventId,
    });
  }

  public async create(
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
  }> {
    return safeWithTraceSpan(
      this.traceService,
      "context",
      "コンテキスト構築",
      {
        summary: "構造化コンテキストを構築",
        attributes: { requestKind },
      },
      async () => {
        const learned =
          requestKind === "owner_message" &&
          requesterUsername === this.config.ownerUsername
            ? await safeWithTraceSpan(
                this.traceService,
                "memory_write",
                "行動記憶を更新",
                { summary: "ownerの継続希望を構造化して保存" },
                async () =>
                  this.#behaviorLearner.learn({
                    ownerUsername: this.config.ownerUsername,
                    requesterUsername,
                    playerId: this.playerId,
                    message,
                    requestKind,
                    eventId: correlationId,
                  }),
              )
            : {
                candidates: [],
                savedCount: 0,
                failedCount: 0,
              };
        const relationship = await safeWithTraceSpan(
          this.traceService,
          "memory_read",
          "関係情報を参照",
          { summary: "関係情報を参照" },
          async () => this.memoryStore.getRelationship(this.playerId),
        );
        const contextLines: string[] = [];
        const lifeState = await safeWithTraceSpan(
          this.traceService,
          "memory_read",
          "生活状態を参照",
          { summary: "生活状態を参照" },
          async () => this.memoryStore.getLifeState(),
        );
        if (lifeState !== undefined) {
          contextLines.push(`[life_state] ${JSON.stringify(lifeState)}`);
        }
        let worldMemories = await safeWithTraceSpan(
          this.traceService,
          "memory_read",
          "WorldMemoryを検索",
          { summary: "WorldMemoryを検索" },
          async () =>
            this.memoryStore.searchWorldMemories({
              query: message,
              limit: Math.min(2, this.config.limits.memoryContextLimit),
            }),
        );
        if (worldMemories.length === 0) {
          worldMemories = await safeWithTraceSpan(
            this.traceService,
            "memory_read",
            "WorldMemoryを再検索",
            { summary: "WorldMemoryを再検索" },
            async () =>
              this.memoryStore.searchWorldMemories({
                query: "",
                limit: 1,
              }),
          );
        }
        for (const memory of worldMemories) {
          contextLines.push(
            `[world_memory:${memory.source}] ${memory.kind} ${memory.name}: ${memory.description} (${memory.dimension} ${String(memory.x)}, ${String(memory.y)}, ${String(memory.z)}; ${memory.updatedAt})`,
          );
        }
        const recentTasks = (
          await safeWithTraceSpan(
            this.traceService,
            "memory_read",
            "task履歴を参照",
            { summary: "task履歴を参照" },
            async () =>
              this.memoryStore.listRecentTaskRuns(
                this.playerId,
                // The newest task is the authoritative result for a current
                // question. Older failures are retained in storage but are not
                // placed beside it where the model could mistake them for the
                // current state.
                Math.min(1, this.config.limits.memoryContextLimit),
              ),
          )
        ).slice(0, 1);
        for (const task of recentTasks) {
          contextLines.push(
            `[latest_task] 最新の作業結果: ${task.kind} ${task.status}/${task.phase}${task.failure === undefined ? "" : ` failure=${task.failure.code}`} (${task.updatedAt})`,
          );
        }
        const behaviorMemories =
          typeof this.memoryStore.listBehaviorMemories === "function"
            ? await safeWithTraceSpan(
                this.traceService,
                "memory_read",
                "行動記憶を参照",
                { summary: "適用可能な行動記憶を参照" },
                async () =>
                  this.memoryStore.listBehaviorMemories(this.playerId, {
                    limit: this.config.limits.memoryContextLimit,
                  }),
              )
            : [];
        contextLines.push(
          ...behaviorMemories
            .filter((record) =>
              this.memoryStore.behaviorMemoryIsApplicable(record),
            )
            .map(
              (record) =>
                `[behavior_preference:${record.confidence}] ${behaviorMemoryDescription(record)}`,
            ),
        );
        const remaining = Math.max(
          0,
          this.config.limits.memoryContextLimit - contextLines.length,
        );
        let memories =
          remaining === 0
            ? []
            : await safeWithTraceSpan(
                this.traceService,
                "memory_read",
                "構造化記憶を検索",
                { summary: "構造化記憶を検索" },
                async () =>
                  this.memoryStore.recall({
                    playerId: this.playerId,
                    query: message,
                    limit: remaining,
                  }),
              );
        if (memories.length === 0 && remaining > 0) {
          memories = await safeWithTraceSpan(
            this.traceService,
            "memory_read",
            "構造化記憶を再検索",
            { summary: "構造化記憶を再検索" },
            async () =>
              this.memoryStore.recall({
                playerId: this.playerId,
                query: "",
                limit: remaining,
              }),
          );
        }
        contextLines.push(
          ...memories.map(
            (memory) =>
              `[${memory.kind}] ${memory.summary} (${memory.recordedAt})`,
          ),
        );
        const currentTask = this.tasks.current;
        const status = await safeWithTraceSpan(
          this.traceService,
          "perception",
          "Minecraft状態を観測",
          { summary: "Minecraft状態を観測" },
          () => this.game.observeStatus(),
        );
        const ownerGoal = deriveOwnerGoalAuthorization({
          message,
          requesterUsername,
          authorizedOwnerUsername: this.config.ownerUsername,
          requestKind,
          maxCount: this.config.limits.maxGatherCount,
          ...(this.#pendingOwnerGoal === undefined
            ? {}
            : { pendingGoal: this.#pendingOwnerGoal }),
        });
        if (
          requestKind !== "runtime_reassessment" &&
          requesterUsername === this.config.ownerUsername
        ) {
          this.#pendingOwnerGoal =
            ownerGoal.outcome === "clarify" &&
            ownerGoal.pendingGoal !== undefined
              ? ownerGoal.pendingGoal
              : undefined;
        }
        const ownerGoalFields =
          ownerGoal.outcome === "authorized"
            ? {
                safeActionAuthorization: ownerGoal.authorization,
                safeActionAuthorizationUsage: {
                  remainingCount: ownerGoal.authorization.targetCount,
                  consumed: false,
                },
              }
            : ownerGoal.outcome === "clarify"
              ? { safeActionClarification: ownerGoal.question }
              : {};
        return {
          personaContext: buildPersonaContext(this.persona, {
            playerName: requesterUsername,
            relationshipSummary: `trust=${String(relationship.trust)}, intimacy=${String(relationship.intimacy)}`,
            ...(currentTask === undefined
              ? {}
              : {
                  currentTask: {
                    kind: currentTask.kind,
                    phase: currentTask.phase,
                    status: currentTask.status,
                  },
                }),
          }),
          memoryContext:
            contextLines.length === 0
              ? "関連する保存済み記憶はありません。"
              : contextLines.map((line) => `- ${line}`).join("\n"),
          worldContext:
            "Bot自身のMinecraft観測（利用者の体力・空腹・酸素・水中状態は未観測）:\n" +
            JSON.stringify(status),
          toolContext: {
            correlationId,
            requesterUsername,
            authorizedOwnerUsername: this.config.ownerUsername,
            playerId: this.playerId,
            signal,
            requestKind,
            ...ownerGoalFields,
            executionEvidence: { verifiedActionReceipts: [] },
            game: this.game,
            memory: this.toolMemory,
            ...(this.toolBehaviorMemory === undefined
              ? {}
              : { behaviorMemory: this.toolBehaviorMemory }),
            ...(requestKind === "owner_message" &&
            requesterUsername === this.config.ownerUsername
              ? {
                  behaviorMemoryCandidates: learned.candidates,
                  behaviorMemoryEventId: correlationId,
                }
              : {}),
            limits: {
              maxMoveDistance: this.config.limits.maxMoveDistance,
              maxGatherCount: this.config.limits.maxGatherCount,
              maxSafeActionDurationMs: this.config.limits.taskTimeoutMs,
              followDistance: this.config.limits.followDistance,
              memoryContextLimit: this.config.limits.memoryContextLimit,
            },
          },
        };
      },
    );
  }
}
