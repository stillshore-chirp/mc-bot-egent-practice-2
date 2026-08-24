import type { AppConfig } from "../config/schema.js";
import type { MemoryStore } from "../memory/store.js";
import type { PersonaCore } from "../persona/persona.js";
import { buildPersonaContext } from "../persona/persona.js";
import type { TaskRuntime } from "../runtime/task-service.js";
import type {
  GameController,
  MemoryPort,
  ToolContext,
} from "../tools/contracts.js";
import type { ChatContextFactory } from "../agent/chat-coordinator.js";

export class CompanionContextFactory implements ChatContextFactory {
  public constructor(
    private readonly config: AppConfig,
    private readonly playerId: string,
    private readonly memoryStore: MemoryStore,
    private readonly toolMemory: MemoryPort,
    private readonly persona: PersonaCore,
    private readonly game: GameController,
    private readonly tasks: TaskRuntime,
  ) {}

  public async create(
    requesterUsername: string,
    message: string,
    signal: AbortSignal,
    correlationId: string,
    requestKind: ToolContext["requestKind"],
  ) {
    const relationship = this.memoryStore.getRelationship(this.playerId);
    const contextLines: string[] = [];
    const lifeState = this.memoryStore.getLifeState();
    if (lifeState !== undefined) {
      contextLines.push(`[life_state] ${JSON.stringify(lifeState)}`);
    }
    let worldMemories = this.memoryStore.searchWorldMemories({
      query: message,
      limit: Math.min(2, this.config.limits.memoryContextLimit),
    });
    if (worldMemories.length === 0) {
      worldMemories = this.memoryStore.searchWorldMemories({
        query: "",
        limit: 1,
      });
    }
    for (const memory of worldMemories) {
      contextLines.push(
        `[world_memory:${memory.source}] ${memory.kind} ${memory.name}: ${memory.description} (${memory.dimension} ${String(memory.x)}, ${String(memory.y)}, ${String(memory.z)}; ${memory.updatedAt})`,
      );
    }
    const recentTasks = this.memoryStore.listRecentTaskRuns(
      this.playerId,
      Math.min(2, this.config.limits.memoryContextLimit),
    );
    for (const task of recentTasks) {
      contextLines.push(
        `[task] ${task.kind} ${task.status}/${task.phase}${task.failure === undefined ? "" : ` failure=${task.failure.code}`} (${task.updatedAt})`,
      );
    }
    const remaining = Math.max(
      0,
      this.config.limits.memoryContextLimit - contextLines.length,
    );
    let memories =
      remaining === 0
        ? []
        : this.memoryStore.recall({
            playerId: this.playerId,
            query: message,
            limit: remaining,
          });
    if (memories.length === 0 && remaining > 0) {
      memories = this.memoryStore.recall({
        playerId: this.playerId,
        query: "",
        limit: remaining,
      });
    }
    contextLines.push(
      ...memories.map(
        (memory) => `[${memory.kind}] ${memory.summary} (${memory.recordedAt})`,
      ),
    );
    const currentTask = this.tasks.current;
    const status = await this.game.observeStatus();
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
      worldContext: JSON.stringify(status),
      toolContext: {
        correlationId,
        requesterUsername,
        authorizedOwnerUsername: this.config.ownerUsername,
        playerId: this.playerId,
        signal,
        requestKind,
        executionEvidence: { verifiedActionReceipts: [] },
        game: this.game,
        memory: this.toolMemory,
        limits: {
          maxMoveDistance: this.config.limits.maxMoveDistance,
          maxGatherCount: this.config.limits.maxGatherCount,
          followDistance: this.config.limits.followDistance,
          memoryContextLimit: this.config.limits.memoryContextLimit,
        },
      },
    };
  }
}
