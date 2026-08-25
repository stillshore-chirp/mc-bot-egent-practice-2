import type { Logger } from "pino";

import {
  AppError,
  type ErrorCategory as DomainErrorCategory,
} from "../domain/errors.js";
import type { WorldSnapshot } from "../domain/snapshot.js";
import type { TaskRecord } from "../domain/task.js";
import type { MinecraftPort } from "../minecraft/port.js";
import type { MemoryStore } from "../memory/store.js";
import type { ActionArbiter } from "../runtime/action-arbiter.js";
import type { TaskRuntime } from "../runtime/task-service.js";
import type { FollowPlayerSkill } from "../skills/follow-player.js";
import type { GatherLogsSkill } from "../skills/gather-logs/gather-logs-skill.js";
import {
  gatherableLogs,
  type GatherableLog,
} from "../skills/gather-logs/resource-catalog.js";
import type { MoveToSkill } from "../skills/move-to.js";
import type { ReturnToPlayerSkill } from "../skills/return-to-player.js";
import type {
  ActionReport,
  ErrorCategory,
  GameController,
  GameStatus,
  Position,
  Surroundings,
} from "../tools/contracts.js";

interface CompanionGameControllerInput {
  readonly minecraft: MinecraftPort;
  readonly tasks: TaskRuntime;
  readonly arbiter: ActionArbiter;
  readonly followPlayer: FollowPlayerSkill;
  readonly moveTo: MoveToSkill;
  readonly gatherLogs: GatherLogsSkill;
  readonly returnToPlayer: ReturnToPlayerSkill;
  readonly ownerUsername: string;
  readonly taskTimeoutMs: number;
  readonly retryLimit: number;
  readonly logger: Logger;
  readonly memory: MemoryStore;
}

const terminalTaskStatuses = new Set(["completed", "failed", "cancelled"]);

export class CompanionGameController implements GameController {
  readonly #minecraft: MinecraftPort;
  readonly #tasks: TaskRuntime;
  readonly #arbiter: ActionArbiter;
  readonly #followPlayer: FollowPlayerSkill;
  readonly #moveTo: MoveToSkill;
  readonly #gatherLogs: GatherLogsSkill;
  readonly #returnToPlayer: ReturnToPlayerSkill;
  readonly #ownerUsername: string;
  readonly #taskTimeoutMs: number;
  readonly #retryLimit: number;
  readonly #logger: Logger;
  readonly #memory: MemoryStore;

  public constructor(input: CompanionGameControllerInput) {
    this.#minecraft = input.minecraft;
    this.#tasks = input.tasks;
    this.#arbiter = input.arbiter;
    this.#followPlayer = input.followPlayer;
    this.#moveTo = input.moveTo;
    this.#gatherLogs = input.gatherLogs;
    this.#returnToPlayer = input.returnToPlayer;
    this.#ownerUsername = input.ownerUsername;
    this.#taskTimeoutMs = input.taskTimeoutMs;
    this.#retryLimit = input.retryLimit;
    this.#logger = input.logger;
    this.#memory = input.memory;
  }

  public async observeStatus(): Promise<GameStatus> {
    return this.#statusFromSnapshot(await this.#minecraft.observe());
  }

  public async observeSurroundings(
    radius: number,
    includeEntities: boolean,
  ): Promise<Surroundings> {
    const observed = await this.#minecraft.observeSurroundings(
      radius,
      includeEntities,
    );
    return {
      blocks: observed.blocks.map(({ name, distance }) => ({ name, distance })),
      entities: observed.entities.map(({ kind, distance }) => ({
        kind,
        distance,
      })),
      hazards: observed.hazards,
    };
  }

  public async say(message: string): Promise<void> {
    const normalized = message.trim().replace(/\s+/gu, " ");
    if (normalized.length === 0) {
      throw new AppError({
        category: "validation",
        code: "EMPTY_CHAT_MESSAGE",
        message: "A chat message cannot be empty",
        retryable: false,
      });
    }
    for (const chunk of splitMinecraftChat(normalized)) {
      await this.#minecraft.say(chunk);
    }
  }

  public async followOwner(
    safeDistance: number,
    maxDurationSeconds: number,
    signal: AbortSignal,
  ): Promise<ActionReport> {
    return this.#executeTask(
      signal,
      () =>
        this.#followPlayer.run({
          username: this.#ownerUsername,
          range: safeDistance,
          maxDurationMs: maxDurationSeconds * 1_000,
          maxPathAttempts: this.#retryLimit + 1,
        }),
      (_output, after) => {
        const owner = after?.players.find(
          ({ username }) => username === this.#ownerUsername,
        );
        if (owner === undefined || owner.distance > safeDistance + 1) {
          return {
            outcome: "failed",
            failureCategory: "observation",
            failureCode: "FOLLOW_DISTANCE_NOT_VERIFIED",
            summary:
              "追従終了時に指定利用者との安全距離を確認できませんでした。",
          };
        }
        return {
          outcome: "completed",
          summary: `指定利用者を追従し、終了時の距離${owner.distance.toFixed(1)}ブロックを確認しました。`,
        };
      },
    );
  }

  public async stopCurrentAction(reason: string): Promise<ActionReport> {
    const before = await this.#tryObserveStatus();
    const hadActiveTask =
      this.#tasks.current !== undefined &&
      !terminalTaskStatuses.has(this.#tasks.current.status);
    this.#arbiter.stop(reason);
    await this.#tasks.cancel(reason);
    await this.#minecraft.stopCurrentAction();
    const after = await this.#tryObserveStatus();
    return {
      before,
      after,
      outcome: "completed",
      evidenceKind: "task_state",
      summary: hadActiveTask
        ? after === null
          ? "進行中の作業をcancelledとして保存し、操作停止命令を実行しました。Minecraft接続状態は観測できませんでした。"
          : "進行中のMinecraft作業を停止し、cancelled状態を保存しました。"
        : after === null
          ? "操作停止命令を実行しました。Minecraft接続状態は観測できませんでした。"
          : "実行中のMinecraft作業がないことを確認し、操作入力を停止しました。",
    };
  }

  public async moveTo(
    destination: Omit<Position, "dimension">,
    radius: number,
    signal: AbortSignal,
  ): Promise<ActionReport> {
    const current = await this.#minecraft.observe();
    return this.#executeTask(
      signal,
      () =>
        this.#moveTo.run({
          position: destination,
          range: radius,
          timeoutMs: this.#taskTimeoutMs,
        }),
      (output) => ({
        outcome: "completed",
        summary: `目的地へ移動し、座標${formatCoordinates(output.position)}への到達を観測しました。`,
      }),
      current,
    );
  }

  public async gatherResource(
    resource: string,
    count: number,
    signal: AbortSignal,
  ): Promise<ActionReport> {
    if (!isGatherableLog(resource)) {
      throw new AppError({
        category: "validation",
        code: "UNSUPPORTED_GATHER_RESOURCE",
        message: "The requested resource is not in the supported log catalog",
        retryable: false,
      });
    }
    return this.#executeTask(
      signal,
      () =>
        this.#gatherLogs.run({
          resource,
          count,
          requester: this.#ownerUsername,
        }),
      (output) => ({
        outcome: "completed",
        evidenceKind: "inventory_delta",
        confirmedState: {
          resource: output.itemName,
          requestedCount: output.requestedCount,
          collectedCount: output.collectedCount,
          heldCount: output.heldCount,
          playerDistance: output.playerDistance,
        },
        summary: `${output.itemName}を新たに${String(output.collectedCount)}個収集し、所持数${String(output.heldCount)}個と依頼者への帰還を観測しました。`,
      }),
    );
  }

  public async returnToOwner(
    safeDistance: number,
    signal: AbortSignal,
  ): Promise<ActionReport> {
    return this.#executeTask(
      signal,
      () =>
        this.#returnToPlayer.run({
          username: this.#ownerUsername,
          range: safeDistance,
          maxAttempts: this.#retryLimit + 1,
        }),
      (output) => ({
        outcome: "completed",
        summary: `指定利用者の現在位置へ戻り、距離${output.distance.toFixed(1)}ブロックを観測しました。`,
      }),
    );
  }

  public async currentPosition(): Promise<Position> {
    const snapshot = await this.#minecraft.observe();
    return { ...snapshot.position, dimension: snapshot.dimension };
  }

  async #executeTask<Input, Output>(
    externalSignal: AbortSignal,
    run: () => Promise<TaskRecord<Input, Output>>,
    success: (
      output: Output,
      after: WorldSnapshot | null,
    ) => Pick<
      ActionReport,
      | "outcome"
      | "failureCategory"
      | "failureCode"
      | "confirmedState"
      | "evidenceKind"
      | "summary"
    >,
    capturedBefore?: WorldSnapshot,
  ): Promise<ActionReport> {
    const beforeSnapshot = capturedBefore ?? (await this.#tryObserveSnapshot());
    const before =
      beforeSnapshot === null ? null : this.#statusFromSnapshot(beforeSnapshot);
    if (externalSignal.aborted) {
      return {
        before,
        after: before,
        outcome: "cancelled",
        failureCategory: "cancelled",
        failureCode: "ACTION_CANCELLED_BEFORE_START",
        failureRetryable: false,
        failedAt: "precondition",
        nextActions: ["新しい依頼として再度指示する"],
        summary: "停止指示済みのためMinecraft作業を開始しませんでした。",
      };
    }

    const timeoutSignal = AbortSignal.timeout(this.#taskTimeoutMs);
    const cancellationSignal = AbortSignal.any([externalSignal, timeoutSignal]);
    let cancellation: Promise<void> | undefined;
    const cancel = (): void => {
      const reason = timeoutSignal.aborted
        ? "設定された作業時間を超過"
        : "利用者または上位処理による停止";
      cancellation = this.#tasks.cancel(reason).catch((error: unknown) => {
        this.#logger.error(
          { errorType: error instanceof Error ? error.name : "UnknownError" },
          "task cancellation persistence failed",
        );
      });
    };
    cancellationSignal.addEventListener("abort", cancel, { once: true });

    let record: TaskRecord<Input, Output>;
    try {
      record = await run();
      await cancellation;
    } finally {
      cancellationSignal.removeEventListener("abort", cancel);
    }
    const afterSnapshot = await this.#tryObserveSnapshot();
    if (afterSnapshot !== null) this.#syncLifeState(afterSnapshot);
    const after =
      afterSnapshot === null ? null : this.#statusFromSnapshot(afterSnapshot);

    if (record.status === "completed" && record.output !== undefined) {
      return { before, after, ...success(record.output, afterSnapshot) };
    }
    if (record.status === "cancelled") {
      const timedOut = timeoutSignal.aborted;
      return {
        before,
        after,
        outcome: "cancelled",
        failureCategory: timedOut ? "timeout" : "cancelled",
        failureCode: timedOut ? "TASK_TIMEOUT" : "TASK_CANCELLED",
        failureRetryable: timedOut,
        failedAt: record.phase,
        nextActions: timedOut
          ? ["状態を再観測し、範囲または数量を小さくして再依頼する"]
          : ["必要なら新しい依頼として再開する"],
        summary: timedOut
          ? "設定された時間内に完了しなかったため作業を停止しました。"
          : "停止指示によりMinecraft作業を中断しました。",
      };
    }
    if (record.status === "suspended") {
      return {
        before,
        after,
        outcome: "failed",
        failureCategory: "safety",
        failureCode: "TASK_SUSPENDED_FOR_SAFETY",
        failureRetryable: true,
        failedAt: record.phase,
        nextActions: ["安全状態を再観測して再開可否を判断する"],
        summary:
          "安全処理が介入したため作業を中断し、再評価待ちとして保存しました。",
      };
    }
    return {
      before,
      after,
      outcome: "failed",
      failureCategory: mapFailureCategory(record.failure?.category),
      failureCode: record.failure?.code ?? "TASK_NOT_COMPLETED",
      failureRetryable: record.failure?.retryable ?? false,
      failedAt: record.failure?.failedAt ?? record.phase,
      ...(record.failure?.confirmedState === undefined
        ? {}
        : { confirmedState: record.failure.confirmedState }),
      nextActions: failureNextActions(record.failure?.category),
      summary: record.failure?.code
        ? `Minecraft作業の完了を確認できませんでした（${record.failure.code}）。`
        : "Minecraft作業の完了を確認できませんでした。",
    };
  }

  async #tryObserveSnapshot(): Promise<WorldSnapshot | null> {
    try {
      return await this.#minecraft.observe();
    } catch {
      return null;
    }
  }

  async #tryObserveStatus(): Promise<GameStatus | null> {
    const snapshot = await this.#tryObserveSnapshot();
    return snapshot === null ? null : this.#statusFromSnapshot(snapshot);
  }

  #statusFromSnapshot(snapshot: WorldSnapshot): GameStatus {
    const inventory: Record<string, number> = {};
    for (const item of snapshot.inventory) {
      inventory[item.name] = (inventory[item.name] ?? 0) + item.count;
    }
    const task = this.#tasks.current;
    return {
      connected: snapshot.connected,
      spawned: snapshot.spawned,
      health: snapshot.health,
      food: snapshot.food,
      oxygen: snapshot.oxygen,
      position: { ...snapshot.position, dimension: snapshot.dimension },
      inventory,
      activeTaskState:
        task === undefined || terminalTaskStatuses.has(task.status)
          ? null
          : `${task.kind}:${task.phase}:${task.status}`,
    };
  }

  #syncLifeState(snapshot: WorldSnapshot): void {
    try {
      const current = this.#memory.getLifeState();
      this.#memory.saveLifeState({
        currentInterests: current?.currentInterests ?? [],
        longTermGoals: current?.longTermGoals ?? [],
        ...(current?.homeBase === undefined
          ? {}
          : { homeBase: current.homeBase }),
        possessions: snapshot.inventory.map(({ name, count }) => ({
          name,
          quantity: count,
        })),
      });
    } catch (error) {
      this.#logger.error(
        {
          category: "persistence",
          code: "LIFE_STATE_SYNC_FAILED",
          errorType: error instanceof Error ? error.name : "UnknownError",
        },
        "life state synchronization failed",
      );
    }
  }
}

function isGatherableLog(resource: string): resource is GatherableLog {
  return (gatherableLogs as readonly string[]).includes(resource);
}

function mapFailureCategory(
  category: DomainErrorCategory | undefined,
): ErrorCategory {
  return category ?? "internal";
}

function failureNextActions(
  category: DomainErrorCategory | undefined,
): readonly string[] {
  switch (category) {
    case "connection":
      return ["接続設定と再接続状態を確認する"];
    case "observation":
      return ["利用者と対象が観測範囲内にいる状態で再試行する"];
    case "path":
      return ["障害物を確認し、より近い目的地から再試行する"];
    case "resource":
      return ["探索範囲または対象資源を見直す"];
    case "inventory":
      return ["所持品とdropの状態を再観測する"];
    case "timeout":
      return ["作業範囲または数量を小さくして再試行する"];
    case "cancelled":
      return ["必要なら新しい依頼として再開する"];
    case "persistence":
      return ["SQLiteの保存先と整合性を確認する"];
    case "safety":
      return ["安全状態を再観測して再開可否を判断する"];
    case "permission":
    case "validation":
    case "llm":
    case undefined:
      return ["状態と依頼内容を確認してから再試行する"];
  }
}

function formatCoordinates(position: {
  readonly x: number;
  readonly y: number;
  readonly z: number;
}): string {
  return `(${position.x.toFixed(1)}, ${position.y.toFixed(1)}, ${position.z.toFixed(1)})`;
}

function splitMinecraftChat(message: string): string[] {
  const chunks: string[] = [];
  let current = "";
  for (const character of message) {
    if (current.length + character.length > 240) {
      chunks.push(current);
      current = "";
    }
    current += character;
  }
  if (current.length > 0) chunks.push(current);
  return chunks;
}
