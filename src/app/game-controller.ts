import { DeliverLogsSkill } from "../skills/deliver-logs.js";
import type { DepositResult } from "../minecraft/port.js";
import { DeliveryController } from "./delivery-controller.js";
import type { Logger } from "pino";

import {
  AppError,
  type ErrorCategory as DomainErrorCategory,
} from "../domain/errors.js";
import type { WorldSnapshot } from "../domain/snapshot.js";
import type { TaskRecord } from "../domain/task.js";
import type { MinecraftPort } from "../minecraft/port.js";
import type { MemoryStore } from "../memory/store.js";
import type { TaskRunRecord } from "../memory/types.js";
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
  readonly playerId?: string;
  readonly taskTimeoutMs: number;
  readonly retryLimit: number;
  readonly maxMoveDistance?: number;
  readonly logger: Logger;
  readonly memory: MemoryStore;
}

const terminalTaskStatuses = new Set(["completed", "failed", "cancelled"]);

interface TaskStateForSummary {
  readonly kind: string;
  readonly status: TaskRecord["status"];
  readonly phase: string;
  readonly updatedAt: string;
  readonly failureCategory?: string;
  readonly failureCode?: string;
  readonly checkpoint?: Readonly<Record<string, unknown>>;
}

export class CompanionGameController implements GameController {
  public readonly delivery: DeliveryController;
  readonly #deliverySkill: DeliverLogsSkill;
  readonly #minecraft: MinecraftPort;
  readonly #tasks: TaskRuntime;
  readonly #arbiter: ActionArbiter;
  readonly #followPlayer: FollowPlayerSkill;
  readonly #moveTo: MoveToSkill;
  readonly #gatherLogs: GatherLogsSkill;
  readonly #returnToPlayer: ReturnToPlayerSkill;
  readonly #ownerUsername: string;
  readonly #playerId: string | undefined;
  readonly #taskTimeoutMs: number;
  readonly #retryLimit: number;
  readonly #logger: Logger;
  readonly #memory: MemoryStore;

  public constructor(input: CompanionGameControllerInput) {
    this.delivery = new DeliveryController(
      input.minecraft,
      input.memory,
      input.ownerUsername,
      input.arbiter,
      (resource, count, gather, signal) =>
        this.#deliverLogs(resource, count, gather, signal),
    );
    this.#deliverySkill = new DeliverLogsSkill(
      input.minecraft,
      input.tasks,
      input.arbiter,
      input.gatherLogs,
      input.maxMoveDistance ?? 128,
    );
    this.#minecraft = input.minecraft;
    this.#tasks = input.tasks;
    this.#arbiter = input.arbiter;
    this.#followPlayer = input.followPlayer;
    this.#moveTo = input.moveTo;
    this.#gatherLogs = input.gatherLogs;
    this.#returnToPlayer = input.returnToPlayer;
    this.#ownerUsername = input.ownerUsername;
    this.#playerId = input.playerId;
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
      observedAt: observed.observedAt,
      subject: observed.subject,
      source: observed.source,
      requesterVitals: "unobserved",
      oxygen: observed.oxygen,
      oxygenState: observed.oxygenState,
      inWater: observed.inWater,
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
    const report = await this.#executeTask(
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
    if (
      report.outcome !== "completed" &&
      (report.failureCode?.startsWith("TREE_") ||
        report.failureCode === "RESOURCE_NOT_FOUND")
    ) {
      const held =
        report.after === null
          ? undefined
          : (report.after.inventory[resource] ?? 0);
      const before =
        report.before === null
          ? undefined
          : (report.before.inventory[resource] ?? 0);
      const acquired =
        held === undefined || before === undefined
          ? undefined
          : Math.max(0, held - before);
      return {
        ...report,
        nextActions: [
          "建築保護の補助が有効か確認し、その稼働中に建築から離れた苗木を育ててください。",
        ],
        summary: `安全に採取できる原木を確認できず、収集を停止しました。${acquired === undefined ? "取得数は未確認です。" : `今回の取得は${String(acquired)}個、現在の所持数は${String(held)}個です。`}履歴不足・建築保護・照会失敗の対象は採取しません。`,
      };
    }
    if (report.outcome !== "completed") {
      const held =
        report.after?.inventory[resource] ?? (report.after ? 0 : undefined);
      const before =
        report.before?.inventory[resource] ?? (report.before ? 0 : undefined);
      const acquired =
        held === undefined || before === undefined
          ? undefined
          : Math.max(0, held - before);
      return {
        ...report,
        confirmedState: {
          ...report.confirmedState,
          collectedCount: acquired ?? null,
          heldCount: held ?? null,
        },
        summary: `${report.summary}${acquired === undefined ? "取得数は未確認です。" : `今回の取得は${String(acquired)}個、現在の所持数は${String(held)}個です。`}`,
      };
    }
    return report;
  }

  async #deliverLogs(
    resource: string,
    count: number,
    gather: boolean,
    signal: AbortSignal,
  ): Promise<ActionReport> {
    if (!isGatherableLog(resource))
      throw new AppError({
        category: "validation",
        code: "UNSUPPORTED_GATHER_RESOURCE",
        message: "対象外の資源です。",
        retryable: false,
      });
    const targets = this.delivery.list();
    const home = targets.find((target) => target.kind === "home"),
      chest = targets.find((target) => target.kind === "chest");
    if (!home || !chest)
      throw new AppError({
        category: "validation",
        code: "DELIVERY_TARGET_NOT_REGISTERED",
        message:
          "帰還拠点と指定チェストを先に登録してください。収納先は推測しません。",
        retryable: false,
      });
    let receipt: DepositResult | undefined;
    const report = await this.#executeTask(
      signal,
      () =>
        this.#deliverySkill.run(
          {
            resource,
            count,
            gather,
            requester: this.#ownerUsername,
            home,
            chest,
          },
          (result) => {
            receipt = result;
          },
        ),
      (output) => ({
        outcome: "completed",
        evidenceKind: "inventory_delta",
        confirmedState: { ...output },
        summary: `登録拠点への帰還と指定チェストへの${String(output.deposited)}個の収納を観測しました。${resource}の残り所持数は${String(output.heldCount)}個です。`,
      }),
    );
    if (report.outcome === "completed") return report;
    return {
      ...report,
      confirmedState: { ...report.confirmedState, ...receipt },
      summary: receipt?.verified
        ? `収納は途中で終了しました。確認できた収納数は${String(receipt.deposited)}個、未収納は${String(receipt.remaining)}個、${resource}の残り所持数は${String(receipt.heldCount)}個です。`
        : `帰還・収納を完了できませんでした（${report.failureCode ?? "UNVERIFIED"}）。収納数は未確認です。`,
      nextActions: [
        "登録先と現在の所持品を確認し、残りの数量を新しい依頼として指示してください。過去の収納数は加算しません。",
      ],
    };
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
      cancellation = this.#tasks
        .cancel(reason, timeoutSignal.aborted ? "TASK_TIMEOUT" : undefined)
        .catch((error: unknown) => {
          this.#logger.error(
            {
              errorType: error instanceof Error ? error.name : "UnknownError",
            },
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
      const recovery = suspendedTaskRecovery(record);
      return {
        before,
        after,
        outcome: "failed",
        failureCategory: "safety",
        failureCode: "TASK_SUSPENDED_FOR_SAFETY",
        failureRetryable: true,
        failedAt: record.phase,
        nextActions: recovery.nextActions,
        summary: recovery.summary,
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
    const task = this.#latestTaskForStatus();
    return {
      observedAt: snapshot.observedAt,
      subject: snapshot.subject,
      source: snapshot.source,
      requesterVitals: "unobserved",
      connected: snapshot.connected,
      spawned: snapshot.spawned,
      health: snapshot.health,
      food: snapshot.food,
      oxygen: snapshot.oxygen,
      oxygenState: snapshot.oxygenState,
      inWater: snapshot.inWater,
      inLava: snapshot.inLava,
      suffocating: snapshot.suffocating,
      position: { ...snapshot.position, dimension: snapshot.dimension },
      inventory,
      activeTaskState: activeTaskState(task),
      activeTaskSummary: activeTaskSummary(task),
      latestTaskState: latestTaskState(task),
    };
  }

  #latestTaskForStatus(): TaskStateForSummary | undefined {
    const active = this.#tasks.current;
    const activeSummary =
      active === undefined
        ? undefined
        : {
            kind: active.kind,
            status: active.status,
            phase: active.phase,
            updatedAt: active.updatedAt,
            ...(active.failure === undefined
              ? {}
              : { failureCategory: active.failure.category }),
            ...(active.failure === undefined
              ? {}
              : { failureCode: active.failure.code }),
            ...(active.checkpoint === undefined
              ? {}
              : { checkpoint: active.checkpoint }),
          };
    let persisted: TaskStateForSummary | undefined;
    if (this.#playerId !== undefined) {
      try {
        const latest = this.#memory.listRecentTaskRuns(this.#playerId, 1)[0];
        if (latest !== undefined) persisted = persistedTaskState(latest);
      } catch {
        // A status question remains useful when the durable task read is
        // temporarily unavailable; the live task state is still authoritative.
      }
    }
    if (activeSummary === undefined) return persisted;
    if (persisted === undefined) return activeSummary;
    return activeSummary.updatedAt >= persisted.updatedAt
      ? activeSummary
      : persisted;
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

interface SuspendedTaskRecovery {
  readonly summary: string;
  readonly nextActions: readonly string[];
}

function suspendedTaskRecovery(
  task: TaskStateForSummary,
): SuspendedTaskRecovery {
  const reason = task.checkpoint?.suspendReason;
  const actionLabel = task.kind === "follow_player" ? "追従" : "作業";
  if (reason === "reflex:stuck") {
    const nextInstruction =
      task.kind === "follow_player"
        ? "もう一度「こっちおいで」と指示する"
        : "もう一度作業を指示する";
    return {
      summary: `移動が進まなかったため、${actionLabel}を安全に一時停止しました。周囲の障害物を避けてから、${nextInstruction}。`,
      nextActions: ["周囲の障害物を避ける", nextInstruction],
    };
  }
  if (reason === "reflex:hazard") {
    return {
      summary:
        "危険を確認したため、安全のため作業を一時停止しました。現在も危険があるかは再確認が必要です。周囲の安全を確かめてから、もう一度指示してください。",
      nextActions: [
        "周囲が安全か再確認する",
        "安全を確かめてからもう一度指示する",
      ],
    };
  }
  if (reason === "reflex:hostile") {
    return {
      summary:
        "危険な相手を確認したため、安全のため作業を一時停止しました。現在も相手が近くにいるかは再確認が必要です。相手から離れて安全を確かめてから、もう一度指示してください。",
      nextActions: [
        "危険な相手から離れる",
        "周囲の安全を再確認してからもう一度指示する",
      ],
    };
  }
  if (reason === "reflex:damage") {
    return {
      summary:
        "被害を確認したため、安全のため作業を一時停止しました。現在も危険があるかは再確認が必要です。周囲の安全と被害の原因を確かめてから、もう一度指示してください。",
      nextActions: [
        "周囲の安全と被害の原因を再確認する",
        "安全を確かめてからもう一度指示する",
      ],
    };
  }
  if (reason === "reflex:hunger") {
    return {
      summary:
        "空腹を確認したため、安全のため作業を一時停止しました。現在の空腹状態と食料を再確認し、必要なら食料を確保してから、もう一度指示してください。",
      nextActions: [
        "現在の空腹状態と食料を再確認する",
        "必要なら食料を確保してからもう一度指示する",
      ],
    };
  }
  return {
    summary:
      "安全確認のため作業を一時停止しました。現在の状態を確認してから、もう一度指示してください。",
    nextActions: ["現在の安全状態を確認する", "確認後にもう一度指示する"],
  };
}

function activeTaskState(task: TaskStateForSummary | undefined): string | null {
  if (task === undefined || terminalTaskStatuses.has(task.status)) return null;
  if (task.status === "suspended") {
    const recovery = suspendedTaskRecovery(task);
    return `作業を一時停止中。${recovery.summary} 次の操作: ${recovery.nextActions.join("、")}。`;
  }
  return `${task.kind}:${task.phase}:${task.status}`;
}

function activeTaskSummary(
  task: TaskStateForSummary | undefined,
): string | null {
  if (task === undefined || terminalTaskStatuses.has(task.status)) return null;
  if (task.status === "suspended") {
    const recovery = suspendedTaskRecovery(task);
    return `${recovery.summary} 次の操作: ${recovery.nextActions.join("、")}。`;
  }
  switch (task.kind) {
    case "follow_player":
      return "利用者への追従を続けています。";
    case "gather_resource":
      return "資源の収集を続けています。";
    case "move_to":
      return "指定場所への移動を続けています。";
    case "return_to_player":
      return "利用者の場所への帰還を続けています。";
    default:
      return "Minecraft作業を続けています。";
  }
}

function latestTaskState(task: TaskStateForSummary | undefined): string | null {
  if (task === undefined) return null;
  if (task.status === "completed") return "直前のMinecraft作業は完了しました。";
  if (task.status === "failed") {
    const reason = taskFailureReason(task.failureCategory, task.failureCode);
    return reason === undefined
      ? "直前のMinecraft作業は完了を確認できませんでした。"
      : "直前のMinecraft作業は完了を確認できませんでした。" + reason;
  }
  if (task.status === "cancelled") {
    const reason = taskFailureReason(task.failureCategory, task.failureCode);
    return reason === undefined
      ? "直前のMinecraft作業は停止しました。"
      : "直前のMinecraft作業は停止しました。" + reason;
  }
  if (task.status === "suspended") return suspendedTaskRecovery(task).summary;
  if (task.status === "queued") return "Minecraft作業の開始を待っています。";
  return activeTaskSummary(task);
}

function persistedTaskState(task: TaskRunRecord): TaskStateForSummary {
  const suspendReason = task.checkpoint?.data.suspendReason;
  return {
    kind: task.kind,
    status: task.status,
    phase: task.phase,
    updatedAt: task.updatedAt,
    ...(task.failure === undefined
      ? {}
      : { failureCategory: task.failure.category }),
    ...(task.failure === undefined ? {} : { failureCode: task.failure.code }),
    ...(typeof suspendReason === "string"
      ? { checkpoint: { suspendReason } }
      : {}),
  };
}

function taskFailureReason(
  category: string | undefined,
  code: string | undefined,
): string | undefined {
  switch (category) {
    case "connection":
      return "Minecraftへの接続を確認できませんでした。";
    case "observation":
      return "Minecraftの状態を確認できませんでした。";
    case "path":
      return "経路を確認できませんでした。";
    case "resource":
      return "必要な資源を確認できませんでした。";
    case "inventory":
      return "所持品の状態を確認できませんでした。";
    case "timeout":
      return "設定時間内に完了しませんでした。";
    case "cancelled":
      if (code === "TASK_TIMEOUT") {
        return "設定時間内に完了しませんでした。";
      }
      if (code === "TASK_REPLACED_AFTER_SUSPENSION") {
        return "安全待機中に別の依頼へ切り替えました。";
      }
      return "停止指示で中断しました。";
    case "safety":
      return "安全確認のため停止しました。";
    case "permission":
    case "validation":
    case "llm":
    case "persistence":
    case undefined:
      return undefined;
    default:
      return undefined;
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
