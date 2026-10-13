import { randomUUID } from "node:crypto";

import type { Logger } from "pino";

import { sameMinecraftIdentity } from "../domain/minecraft-identity.js";
import type {
  BodyItemStack,
  BodyVisibleEntity,
  BodyVisibleBlock,
  BodyWindowSnapshot,
} from "../minecraft/player-body-observation.js";
import type {
  PlayerBody,
  PlayerBodyEvent,
  PlayerBodyObservation,
  PlayerKnowledge,
  PlayerOperation,
  PlayerOperationResult,
} from "../minecraft/player-body.js";
import { playerOperationSchema } from "../minecraft/player-body-schema.js";
import type {
  CompanionBodyObservationEvidence,
  CompanionOutcomeEvidenceSource,
  CompanionOutcomeInput,
  CompanionOutcomeReasonCode,
  CompanionMessage,
  CompanionReplyLifecycle,
  CompanionReplyLifecycleReasonCode,
  CompanionReplyLifecycleState,
  CompanionSnapshot,
  CompanionStatePatch,
} from "./contracts.js";
import { companionOutcomeReasonCodes } from "./contracts.js";
import type {
  CompanionDecision,
  CompanionDecisionInput,
  CompanionAgentStatus,
} from "./agent.js";
import type { CompanionStore } from "./store.js";
import {
  type EquipmentUpgradeCandidate,
  findChestEquipmentWithdrawal,
  findInventoryEquipmentUpgrade,
  findRetaliationWeaponUpgrade,
  equipmentDestinationForName,
  isChestEquipmentWindow,
} from "./equipment-upkeep.js";
import { isImmediateStopCommand } from "./stop-command.js";

const maximumWaitMs = 30 * 60_000;
const minimumWaitMs = 10_000;
const maximumRetryMs = 5 * 60_000;
const defaultRetryMs = 5_000;
const worldChangeCoalesceMs = 1_500;
const maintenanceCheckIntervalMs = 5_000;
const messageLimit = 2_000;
const defaultMemoryContextLimit = 12;
const automaticPickupSuppressionLimit = 32;
const ownerReplyUnavailable =
  "現在の状況は確認したけれど、返答を確定できなかったよ。詳しい理由はまだ分からないよ。";
const ownerReplyFailed =
  "依頼は受け取ったけれど、現在の状態と返答は確認できていないよ。詳しい原因はまだ分からないよ。";
const ownerPlanAccepted = "依頼を受け取ったよ。結果を確認してから伝えるね。";
const ownerPlanUnconfirmed =
  "行動結果はまだ確認できず、完了とは言えないよ。詳しい原因はまだ分からないよ。";
const ownerPlanConfirmed = "いま実行した操作の結果を確認できたよ。";
const ownerDamageInterruption =
  "ダメージ対応を優先して、元の返答を中断したよ。元の返答はまだ届けられておらず、実行中の操作があれば結果も未確認だよ。";
const ownerDamageObservationFailed =
  "ダメージ対応を優先して元の返答を中断したよ。現在の状態と返答はまだ確認できていないよ。詳しい原因はまだ分からないよ。";
const equipmentChestReach = 4.5;
const equipmentSearchRange = 32;
const equipmentSweepMissCooldownMs = 30_000;
const equipmentChestMoveRange = 2.5;
const equipmentChestSearchLimit = 4;
const equipmentChestSuppressionLimit = 64;
const equipmentUpkeepStepLimit = 5;
const outcomeReasonCodeSet: ReadonlySet<string> = new Set(
  companionOutcomeReasonCodes,
);
const damageReflexAttackRange = 3.2;
const waterRiskObservationCooldownMs = 1_000;
const waterRecoveryDryMinimumIntervalMs = 2_000;
const waterRecoveryDryMaximumAgeMs = 10_000;
const damageReflexPlanPurpose =
  "React once to damage using fresh Body-visible information.";
const waterRecoveryPlanPurpose =
  "Rise toward the surface after damage with low oxygen.";

interface PendingWake {
  readonly reason: string;
  readonly mode?:
    "follow_owner" | "damage_reflex" | "equipment_upkeep" | undefined;
  readonly ownerMessage?: string | undefined;
  readonly ownerMessageSequence?: number | undefined;
}

interface ActiveBodyRun {
  readonly operationId: string;
  readonly operation: PlayerOperation;
  readonly startedAt: string;
  readonly controller: AbortController;
  readonly promise: Promise<PlayerOperationResult>;
}

interface InterleavedOwnerReplyRun {
  readonly generation: number;
  readonly controller: AbortController;
  readonly ownerMessageSequence: number;
}

interface EquipmentStepResult {
  readonly observation: PlayerBodyObservation | null;
  readonly confirmed: boolean;
  readonly lookSweep?: PlayerOperationResult["lookSweep"] | undefined;
}

interface EquipmentSweepChestCandidate {
  readonly name: string;
  readonly position: BodyVisibleBlock["position"];
  readonly distance: number;
}

interface FoodUpkeepResult extends EquipmentStepResult {
  readonly handled: boolean;
}

interface DamageReflexContext {
  readonly goalTitle: string | null;
  readonly goalSuccessCondition: string | null;
  readonly planPurpose: string | null;
}

interface WaterRecoveryTrigger {
  readonly oxygen: number;
  readonly interruptedOperationId?: string | undefined;
}

interface WaterRecoveryTargetBlock {
  readonly entityId: number;
  readonly dimension: string;
}

interface WaterRecoveryDryCandidate {
  readonly observedAtMs: number;
  readonly dimension: string;
  readonly lifeEpoch: number;
  readonly y: number;
}

interface DamagedCollectionCandidate {
  readonly operationId: string;
  readonly entityId: number;
}

type DamageReflexPlanStep = NonNullable<
  CompanionDecision["plan"]
>["steps"][number];

export interface CompanionRuntimeStatus {
  readonly running: boolean;
  readonly stopped: boolean;
  readonly thinking: boolean;
  readonly goal: CompanionSnapshot["goal"];
  readonly relationshipSummary: string;
  readonly interests: readonly string[];
  readonly currentOperation: {
    readonly kind: string;
    readonly startedAt: string;
  } | null;
  readonly nextWakeAt: string | null;
  readonly wakeReason: string | null;
  readonly lastOutcome: {
    readonly status: string;
    readonly operationKind: string;
    readonly summary: string;
    readonly observedAt: string;
  } | null;
  readonly recentErrors: readonly {
    readonly code: string;
    readonly at: string;
  }[];
  readonly usage: CompanionAgentStatus | null;
}

export interface CompanionRuntimeOptions {
  readonly ownerUsername: string;
  readonly body: PlayerBody;
  readonly store: CompanionStore;
  readonly agent: CompanionDecisionPort;
  readonly say: (text: string) => Promise<void>;
  readonly logger?: Pick<Logger, "error" | "warn"> | undefined;
  readonly minWaitMs?: number | undefined;
  readonly memoryContextLimit?: number | undefined;
}

/** Narrow seam for deterministic runtime tests; production uses CompanionAgent. */
export interface CompanionDecisionPort {
  decide(
    input: CompanionDecisionInput,
    signal?: AbortSignal,
  ): Promise<CompanionDecision>;
  status?(): CompanionAgentStatus;
}

/**
 * Serializes all state-writing judgments and Body operations. Read-only owner
 * replies may run alongside one active goal turn. Durable stop is written
 * before cancellation; successful plans continue only after Body confirms the
 * operation and a fresh observation still matches its result.
 */
export class CompanionRuntime {
  readonly #ownerUsername: string;
  readonly #body: PlayerBody;
  readonly #store: CompanionStore;
  readonly #agent: CompanionDecisionPort;
  readonly #say: (text: string) => Promise<void>;
  readonly #logger: Pick<Logger, "error" | "warn"> | undefined;
  readonly #minWaitMs: number;
  readonly #memoryContextLimit: number;

  #started = false;
  #disposed = false;
  #runtimeStopLatched = false;
  #stopPersistenceFailed = false;
  #outcomePersistenceBlocked = false;
  #unsubscribeBody: (() => void) | undefined;
  #generation = 0;
  #activeDecision: AbortController | undefined;
  #activeBody: ActiveBodyRun | undefined;
  #pendingOwnerRequest: string | undefined;
  #pendingOwnerRequestSequence: number | undefined;
  #activeOwnerReplySequence: number | undefined;
  #ownerReplyGeneration = 0;
  #activeInterleavedOwnerReply: InterleavedOwnerReplyRun | undefined;
  #pendingWake: PendingWake | undefined;
  #drainPromise: Promise<void> | undefined;
  #waitTimer: NodeJS.Timeout | undefined;
  #worldChangeTimer: NodeJS.Timeout | undefined;
  #maintenanceTimer: NodeJS.Timeout | undefined;
  #maintenanceObservationInFlight = false;
  #maintenanceActionInFlight = false;
  #maintenanceActionFinished: Promise<void> | undefined;
  #failureCount = 0;
  #worldChangedDuringDecision = false;
  #activeOwnerReplyGeneration: number | undefined;
  #ownerReplyInterruptedByDamage = false;
  #ownerFollowRequested = false;
  #damageReflexPending = false;
  #waterRecoveryActive = false;
  #waterRecoveryAttempted = false;
  #waterRecoveryLifeEpoch = 0;
  #waterRecoveryDryCandidate: WaterRecoveryDryCandidate | undefined;
  #waterRiskObservationInFlight = false;
  #lastWaterRiskObservedAt = 0;
  #waterRecoveryTrigger: WaterRecoveryTrigger | undefined;
  #waterRecoveryTargetBlock: WaterRecoveryTargetBlock | undefined;
  #damagedCollectionCandidate: DamagedCollectionCandidate | undefined;
  #damageReflexContext: DamageReflexContext | undefined;
  #equipmentUpkeepQueued = false;
  #automaticPickupSuppressed = new Map<string, true>();
  #foodPickupSuppressed = new Set<string>();
  #foodPickupSuppressedAtFood: number | undefined;
  #equipmentChestSuppressed = new Set<string>();
  #equipmentSweepCooldown:
    { readonly fingerprint: string; readonly expiresAt: number } | undefined;
  #foodChestSuppressed = new Set<string>();
  #failedEquipmentCandidateFingerprint: string | undefined;
  #failedFoodAttemptFingerprint: string | undefined;
  #foodUseSuppressedFingerprint: string | undefined;
  #cachedKnowledge: PlayerKnowledge | undefined;
  #wakeAt: string | null = null;
  #wakeReason: string | null = null;
  #recentErrors: { code: string; at: string }[] = [];

  public constructor(options: CompanionRuntimeOptions) {
    this.#ownerUsername = options.ownerUsername;
    this.#body = options.body;
    this.#store = options.store;
    this.#agent = options.agent;
    this.#say = options.say;
    this.#logger = options.logger;
    this.#minWaitMs = Math.max(
      1_000,
      Math.min(maximumWaitMs, options.minWaitMs ?? minimumWaitMs),
    );
    this.#memoryContextLimit = Math.max(
      1,
      Math.min(
        50,
        Math.trunc(options.memoryContextLimit ?? defaultMemoryContextLimit),
      ),
    );
  }

  /** Returns a local, read-only status projection without observing or waking Body. */
  public status(): CompanionRuntimeStatus {
    const snapshot = this.#store.snapshot();
    const stopped = snapshot.stopped || this.#runtimeStopLatched;
    const outcome = snapshot.lastOutcome;
    return {
      running: this.#started && !this.#disposed && !stopped,
      stopped,
      thinking: this.#activeDecision !== undefined,
      goal: snapshot.goal,
      relationshipSummary: snapshot.relationshipSummary,
      interests: snapshot.interests,
      currentOperation:
        this.#activeBody === undefined
          ? null
          : {
              kind: this.#activeBody.operation.kind,
              startedAt: this.#activeBody.startedAt,
            },
      nextWakeAt: this.#wakeAt,
      wakeReason: this.#wakeReason,
      lastOutcome:
        outcome === null
          ? null
          : {
              status: outcome.status,
              operationKind: outcome.operation.kind,
              summary: safeSummary(outcome.summary),
              observedAt: outcome.observedAt,
            },
      recentErrors: this.#recentErrors.map((error) => ({ ...error })),
      usage: this.#agent.status?.() ?? null,
    };
  }

  /** Starts one fresh judgment; persisted plans are context, never replay instructions. */
  public async start(): Promise<void> {
    if (!this.#activate()) return;
    if (this.#isStopped()) return;
    this.#armMaintenanceTimer();
    const recoveredReply = this.#recoverableReplyAfterRestart();
    if (recoveredReply !== null) {
      this.#pendingOwnerRequest = recoveredReply.message.text;
      this.#pendingOwnerRequestSequence = recoveredReply.message.sequence;
      this.#fireWake({
        reason: "resume an owner request without a completed send",
        ownerMessage: recoveredReply.message.text,
        ownerMessageSequence: recoveredReply.message.sequence,
      });
      return;
    }
    this.#fireWake({ reason: "startup; re-observe before continuing" });
  }

  /** Only the authenticated owner can affect the companion through chat. */
  public async receiveChat(
    username: string,
    rawMessage: string,
  ): Promise<void> {
    if (!sameMinecraftIdentity(username, this.#ownerUsername)) return;
    if (this.#disposed) return;

    if (isImmediateStopCommand(rawMessage)) {
      const stopped = await this.stop(username);
      if (stopped) {
        try {
          this.#store.recordMessage("owner", rawMessage);
        } catch (error) {
          this.#logError(error, "Owner stop message could not be recorded");
        }
        await this.#speakControlMessage(
          this.#stopPersistenceFailed
            ? "自律行動をこの実行中は停止しました。停止状態の永続保存に失敗したため、Botを再起動しないでください。"
            : "自律行動を停止しました。再開の明示的な指示があるまで、操作を実行しません。",
        );
      }
      return;
    }

    if (this.#outcomePersistenceBlocked) {
      await this.#speakControlMessage(
        "操作結果の記録状態を確認できないため、自律行動を保留中だよ。停止してからBotを再起動してね。",
      );
      return;
    }

    const message = rawMessage.trim().slice(0, messageLimit);
    if (message.length === 0) return;

    if (!this.#started) this.#activate();
    if (!this.#isStopped()) this.#armMaintenanceTimer();
    if (this.#isStopped()) {
      const ownerMessageSequence = this.#store.recordMessage("owner", message);
      if (isExplicitResumeCommand(message)) {
        await this.resume(username, message, ownerMessageSequence);
      }
      return;
    }

    if (
      isOwnerFollowCommand(message) ||
      (this.#ownerFollowRequested && isOwnerFollowReminder(message))
    ) {
      if (this.#ownerFollowRequested) return;
      this.#store.recordMessage("owner", message);
      this.#ownerFollowRequested = true;
      await this.#requestWake({
        reason: "authenticated owner requested following",
        mode: "follow_owner",
      });
      if (this.#isStopped()) {
        this.#ownerFollowRequested = false;
        return;
      }
      await this.#speakControlMessage("わかった。近くまでついていくね。");
      return;
    }

    if (isOwnerEquipmentCommand(message)) {
      this.#store.recordMessage("owner", message);
      this.#equipmentUpkeepQueued = true;
      if (
        this.#damageReflexPending ||
        this.#pendingWake?.mode === "damage_reflex"
      )
        return;
      await this.#requestWake({
        reason: "authenticated owner requested equipment upkeep",
        mode: "equipment_upkeep",
      });
      return;
    }

    const ownerMessageSequence = this.#store.recordMessage("owner", message);
    if (isReplyStatusQuestion(message)) {
      const target = this.#latestMeaningfulReplyStatusTarget();
      await this.#speakReplyStatus(
        replyStatusAnswer(
          target?.lifecycle ?? null,
          target?.originalMessage ?? null,
        ),
        this.#generation,
      );
      return;
    }
    if (!this.#tryRecordReplyLifecycleEvent(ownerMessageSequence, "received"))
      return;
    if (this.#hasActiveOwnerTurnContext()) {
      await this.#replyDuringGoalTurn(message, ownerMessageSequence);
      return;
    }
    await this.#requestWake({
      reason: "owner message",
      ownerMessage: message,
      ownerMessageSequence,
    });
  }

  /** Latch and cancel local work before attempting durable owner stop. */
  public async stop(actorUsername: string): Promise<boolean> {
    if (!sameMinecraftIdentity(actorUsername, this.#ownerUsername))
      return false;
    if (this.#disposed) return false;
    let alreadyPersistedStopped = false;
    try {
      alreadyPersistedStopped = this.#store.snapshot().stopped;
    } catch (error) {
      this.#stopPersistenceFailed = true;
      this.#logError(error, "Owner stop state could not be read");
    }
    this.#runtimeStopLatched = true;
    this.#cancelInterleavedOwnerReply("Owner stopped companion");
    this.#pendingOwnerRequest = undefined;
    this.#pendingOwnerRequestSequence = undefined;
    this.#activeOwnerReplySequence = undefined;
    this.#activeOwnerReplyGeneration = undefined;
    this.#ownerReplyInterruptedByDamage = false;
    this.#ownerFollowRequested = false;
    this.#damageReflexPending = false;
    this.#waterRecoveryActive = false;
    this.#waterRecoveryAttempted = false;
    this.#waterRecoveryDryCandidate = undefined;
    this.#waterRecoveryTrigger = undefined;
    this.#waterRecoveryTargetBlock = undefined;
    this.#damagedCollectionCandidate = undefined;
    this.#damageReflexContext = undefined;
    this.#equipmentUpkeepQueued = false;
    this.#equipmentSweepCooldown = undefined;
    this.#generation += 1;
    this.#pendingWake = undefined;
    this.#clearMaintenanceTimer();
    this.#clearTimers();
    this.#activeDecision?.abort(new Error("Owner stopped companion"));
    this.#activeBody?.controller.abort(new Error("Owner stopped companion"));
    if (!alreadyPersistedStopped) {
      try {
        this.#store.stop();
        this.#stopPersistenceFailed = false;
      } catch (error) {
        this.#stopPersistenceFailed = true;
        this.#logError(error, "Owner stop persistence failed");
      }
    } else {
      this.#stopPersistenceFailed = false;
    }
    if (!this.#stopPersistenceFailed) this.#outcomePersistenceBlocked = false;
    try {
      await this.#body.stopActiveOperation?.();
    } catch {
      this.#logger?.warn({ errorType: "BodyStopError" }, "Body stop failed");
    }
    await this.#maintenanceActionFinished;
    await this.#drainPromise;
    return true;
  }

  /** Resume requires a separately authenticated owner identity. */
  public async resume(
    actorUsername: string,
    ownerMessage?: string,
    ownerMessageSequence?: number,
  ): Promise<boolean> {
    if (!sameMinecraftIdentity(actorUsername, this.#ownerUsername))
      return false;
    if (this.#disposed) return false;
    if (!this.#started) this.#activate();
    const snapshot = this.#store.snapshot();
    if (!snapshot.stopped) return false;
    this.#store.resume(snapshot.stopGeneration);
    this.#runtimeStopLatched = false;
    this.#stopPersistenceFailed = false;
    this.#equipmentSweepCooldown = undefined;
    this.#armMaintenanceTimer();
    if (
      ownerMessageSequence !== undefined &&
      !this.#tryRecordReplyLifecycleEvent(ownerMessageSequence, "received")
    )
      return true;
    await this.#requestWake({
      reason: "owner explicitly resumed autonomy",
      ...(ownerMessage === undefined
        ? {}
        : { ownerMessage: ownerMessage.slice(0, messageLimit) }),
      ...(ownerMessageSequence === undefined ? {} : { ownerMessageSequence }),
    });
    return true;
  }

  #latestMeaningfulReplyStatusTarget(): {
    readonly lifecycle: CompanionReplyLifecycle;
    readonly originalMessage: CompanionMessage | null;
  } | null {
    const records = [...this.#store.snapshot().replyLifecycle].sort(
      (left, right) => right.ownerMessageSequence - left.ownerMessageSequence,
    );
    for (const lifecycle of records) {
      const originalMessage = this.#store.messageBySequence(
        lifecycle.ownerMessageSequence,
      );
      if (
        originalMessage !== null &&
        (isImmediateStopCommand(originalMessage.text) ||
          isExplicitResumeCommand(originalMessage.text) ||
          isReplyStatusQuestion(originalMessage.text))
      )
        continue;
      return { lifecycle, originalMessage };
    }
    return null;
  }

  #hasActiveOwnerTurnContext(): boolean {
    const snapshot = this.#store.snapshot();
    return (
      this.#runnablePendingOwnerRequest() !== undefined ||
      this.#activeInterleavedOwnerReply !== undefined ||
      this.#activeDecision !== undefined ||
      this.#activeBody !== undefined ||
      this.#drainPromise !== undefined ||
      snapshot.activeOperation !== null
    );
  }

  #runnablePendingOwnerRequest(): string | undefined {
    if (this.#pendingOwnerRequest === undefined) return undefined;
    if (this.#pendingOwnerRequestSequence === undefined)
      return this.#pendingOwnerRequest;
    const latest = this.#store
      .replyLifecycleFor(this.#pendingOwnerRequestSequence)
      ?.events.at(-1)?.state;
    return latest === "received" ||
      latest === "generation_started" ||
      latest === "generated"
      ? this.#pendingOwnerRequest
      : undefined;
  }

  #recoverableReplyAfterRestart(): {
    readonly message: CompanionMessage;
  } | null {
    const record = this.#store.latestReplyLifecycle();
    const latest = record?.events.at(-1);
    if (
      record === null ||
      (latest?.state !== "received" &&
        !(
          latest?.state === "interrupted" &&
          latest.reasonCode === "process_restart_with_generation_unresolved"
        ))
    )
      return null;
    const message = this.#store.messageBySequence(record.ownerMessageSequence);
    if (message?.role === "owner") return { message };
    this.#tryRecordReplyLifecycleEvent(
      record.ownerMessageSequence,
      "interrupted",
      "owner_message_unavailable",
    );
    return null;
  }

  #tryRecordReplyLifecycleEvent(
    ownerMessageSequence: number,
    state: CompanionReplyLifecycleState,
    reasonCode?: CompanionReplyLifecycleReasonCode,
  ): boolean {
    try {
      this.#store.recordReplyLifecycleEvent(
        ownerMessageSequence,
        state,
        reasonCode,
      );
      return true;
    } catch (error) {
      this.#logError(error, "Reply lifecycle could not be persisted");
      return false;
    }
  }

  #recordReplyInterruption(
    ownerMessageSequence: number,
    reasonCode: CompanionReplyLifecycleReasonCode,
  ): void {
    const latest = this.#store
      .replyLifecycleFor(ownerMessageSequence)
      ?.events.at(-1)?.state;
    if (
      latest === "send_unknown" ||
      latest === "send_call_resolved" ||
      latest === "durable_stop"
    )
      return;
    this.#tryRecordReplyLifecycleEvent(
      ownerMessageSequence,
      latest === "send_started" ? "send_unknown" : "interrupted",
      reasonCode,
    );
  }

  async #replyDuringGoalTurn(
    ownerMessage: string,
    ownerMessageSequence: number,
  ): Promise<void> {
    this.#cancelInterleavedOwnerReply(
      "A newer owner message superseded reply",
      "newer_owner_input",
    );
    const run: InterleavedOwnerReplyRun = {
      generation: ++this.#ownerReplyGeneration,
      controller: new AbortController(),
      ownerMessageSequence,
    };
    this.#activeInterleavedOwnerReply = run;
    try {
      if (this.#isStopped() || !this.#isCurrentInterleavedOwnerReply(run))
        return;
      const observation = await this.#body.observe({
        ownerPositionException: true,
      });
      if (this.#isStopped() || !this.#isCurrentInterleavedOwnerReply(run))
        return;
      const snapshot = this.#store.snapshot();
      if (snapshot.stopped || this.#isStopped()) return;
      const input = this.#createDecisionInput(
        snapshot,
        observation,
        "owner asked a separate question during an active goal turn",
        ownerMessage,
        this.#runnablePendingOwnerRequest(),
        {
          pendingOwnerRequest: this.#runnablePendingOwnerRequest() ?? null,
        },
        ownerMessageSequence,
      );
      if (
        !this.#tryRecordReplyLifecycleEvent(
          ownerMessageSequence,
          "generation_started",
        )
      )
        return;
      const decision = await this.#agent.decide(input, run.controller.signal);
      if (this.#isStopped() || !this.#isCurrentInterleavedOwnerReply(run))
        return;
      if (
        !this.#tryRecordReplyLifecycleEvent(ownerMessageSequence, "generated")
      )
        return;
      if (decision.ownerMessageDisposition === "update_goal") {
        await this.#requestWake({
          reason: "owner explicitly changed the active goal",
          ownerMessage,
          ownerMessageSequence,
        });
        return;
      }
      if (decision.ownerMessageDisposition !== "answer_only") {
        await this.#speakInterleavedOwnerReply(
          ownerReplyFailed,
          run,
          ownerMessageSequence,
        );
        return;
      }
      const reply = decision.speech?.trim();
      await this.#speakInterleavedOwnerReply(
        reply === undefined || reply.length === 0
          ? ownerReplyUnavailable
          : reply,
        run,
        ownerMessageSequence,
      );
    } catch (error) {
      if (
        !run.controller.signal.aborted &&
        this.#isCurrentInterleavedOwnerReply(run) &&
        !this.#isStopped()
      ) {
        this.#logError(error, "Interleaved owner reply failed");
        this.#tryRecordReplyLifecycleEvent(
          ownerMessageSequence,
          "generation_failed",
          "judgment_failed",
        );
        await this.#speakInterleavedOwnerReply(
          ownerReplyFailed,
          run,
          ownerMessageSequence,
        );
      }
    } finally {
      if (this.#activeInterleavedOwnerReply === run)
        this.#activeInterleavedOwnerReply = undefined;
    }
  }

  #createDecisionInput(
    snapshot: CompanionSnapshot,
    observation: PlayerBodyObservation,
    wakeReason: string,
    ownerMessage?: string,
    pendingOwnerRequest?: string,
    ownerReplyContext?: CompanionDecisionInput["ownerReplyContext"],
    ownerMessageSequence?: number,
  ): CompanionDecisionInput {
    const query =
      ownerMessage ??
      pendingOwnerRequest ??
      ownerReplyContext?.pendingOwnerRequest ??
      snapshot.goal?.title ??
      snapshot.interests[0] ??
      "Minecraftで共有した経験と現在の状況";
    const recalledMemories = this.#store.recall(
      query,
      this.#memoryContextLimit,
    );
    const latestChestLocation = this.#store.latestObservedChestLocation();
    const latestBedLocation = this.#store.latestObservedBedLocation();
    const latestLocations = [latestChestLocation, latestBedLocation].filter(
      (memory): memory is NonNullable<typeof memory> => memory !== null,
    );
    const latestLocationIds = new Set(
      latestLocations.map((memory) => memory.id),
    );
    const memories =
      latestLocations.length === 0
        ? recalledMemories
        : [
            ...latestLocations,
            ...recalledMemories.filter(
              (memory) => !latestLocationIds.has(memory.id),
            ),
          ].slice(0, this.#memoryContextLimit);
    return {
      snapshot,
      observation,
      wakeReason,
      messages: this.#store.recentMessages(24),
      memories,
      recentOutcomes: this.#store.readRecentOutcomes(),
      ...(ownerMessage === undefined ? {} : { ownerMessage }),
      ...(pendingOwnerRequest === undefined ? {} : { pendingOwnerRequest }),
      ...(ownerReplyContext === undefined ? {} : { ownerReplyContext }),
      ...(ownerMessageSequence === undefined ? {} : { ownerMessageSequence }),
      ...(this.#cachedKnowledge === undefined
        ? {}
        : { knowledge: this.#cachedKnowledge }),
    };
  }

  #isCurrentInterleavedOwnerReply(run: InterleavedOwnerReplyRun): boolean {
    return (
      this.#activeInterleavedOwnerReply === run &&
      run.generation === this.#ownerReplyGeneration &&
      !run.controller.signal.aborted
    );
  }

  #cancelInterleavedOwnerReply(
    reason: string,
    lifecycleReasonCode?: CompanionReplyLifecycleReasonCode,
  ): void {
    this.#ownerReplyGeneration += 1;
    const active = this.#activeInterleavedOwnerReply;
    this.#activeInterleavedOwnerReply = undefined;
    if (active !== undefined && lifecycleReasonCode !== undefined)
      this.#recordReplyInterruption(
        active.ownerMessageSequence,
        lifecycleReasonCode,
      );
    active?.controller.abort(new Error(reason));
  }

  async #speakInterleavedOwnerReply(
    text: string,
    run: InterleavedOwnerReplyRun,
    ownerMessageSequence: number,
  ): Promise<void> {
    await this.#speakOwnerReply(text, ownerMessageSequence, () =>
      this.#isCurrentInterleavedOwnerReply(run),
    );
  }

  /** Stop local work while preserving the durable owner stop state as-is. */
  public async shutdown(): Promise<void> {
    if (this.#disposed) return;
    this.#disposed = true;
    this.#cancelInterleavedOwnerReply("Companion runtime shutdown");
    this.#pendingOwnerRequest = undefined;
    this.#pendingOwnerRequestSequence = undefined;
    this.#activeOwnerReplySequence = undefined;
    this.#activeOwnerReplyGeneration = undefined;
    this.#ownerReplyInterruptedByDamage = false;
    this.#ownerFollowRequested = false;
    this.#damageReflexPending = false;
    this.#waterRecoveryActive = false;
    this.#waterRecoveryAttempted = false;
    this.#waterRecoveryDryCandidate = undefined;
    this.#waterRecoveryTrigger = undefined;
    this.#waterRecoveryTargetBlock = undefined;
    this.#damagedCollectionCandidate = undefined;
    this.#equipmentUpkeepQueued = false;
    this.#equipmentSweepCooldown = undefined;
    this.#generation += 1;
    this.#pendingWake = undefined;
    this.#clearMaintenanceTimer();
    this.#clearTimers();
    this.#unsubscribeBody?.();
    this.#unsubscribeBody = undefined;
    this.#activeDecision?.abort(new Error("Companion runtime shutdown"));
    this.#activeBody?.controller.abort(new Error("Companion runtime shutdown"));
    await this.#maintenanceActionFinished;
    await this.#drainPromise;
  }

  async #requestWake(wake: PendingWake): Promise<void> {
    if (wake.mode !== undefined || wake.ownerMessage !== undefined)
      this.#cancelInterleavedOwnerReply(
        "A newer owner action superseded reply",
        "newer_owner_input",
      );
    const ownerActionWake =
      wake.ownerMessage !== undefined ||
      wake.mode === "follow_owner" ||
      wake.mode === "equipment_upkeep";
    if (
      ownerActionWake &&
      this.#activeOwnerReplySequence !== undefined &&
      this.#activeOwnerReplySequence !== wake.ownerMessageSequence
    )
      this.#recordReplyInterruption(
        this.#activeOwnerReplySequence,
        "newer_owner_input",
      );
    if (wake.mode === "follow_owner" || wake.mode === "equipment_upkeep") {
      this.#pendingOwnerRequest = undefined;
      this.#pendingOwnerRequestSequence = undefined;
    } else if (wake.ownerMessage !== undefined) {
      this.#pendingOwnerRequest = wake.ownerMessage;
      this.#pendingOwnerRequestSequence = wake.ownerMessageSequence;
    }
    const maintenanceAction = this.#maintenanceActionFinished;
    const activeBody = this.#activeBody;
    const ownerWake =
      wake.mode === "follow_owner" ||
      wake.mode === "equipment_upkeep" ||
      wake.ownerMessage !== undefined;
    const collectionDamageInterrupt =
      wake.mode === "damage_reflex" &&
      activeBody?.operation.kind === "collect_item" &&
      (this.#waterRecoveryTrigger?.interruptedOperationId ===
        activeBody.operationId ||
        this.#damagedCollectionCandidate?.operationId ===
          activeBody.operationId);
    const ownerMaintenanceInterrupt =
      ownerWake &&
      (activeBody?.operation.kind === "look_sweep" ||
        activeBody?.operation.kind === "collect_item");
    let maintenanceInterruptGeneration: number | undefined;
    if (
      activeBody !== undefined &&
      maintenanceAction !== undefined &&
      this.#maintenanceActionInFlight &&
      (ownerMaintenanceInterrupt || collectionDamageInterrupt)
    ) {
      // These operations have no open window to clean up; let the newer wake
      // stop them before maintenance can continue to another candidate.
      this.#generation += 1;
      maintenanceInterruptGeneration = this.#generation;
      this.#pendingWake = wake;
      activeBody.controller.abort(
        new Error(
          collectionDamageInterrupt
            ? "Damage response interrupted automatic item collection"
            : activeBody.operation.kind === "collect_item"
              ? "Owner action superseded automatic item collection"
              : "Owner action superseded the automatic equipment sweep",
        ),
      );
    }
    if (maintenanceAction !== undefined) await maintenanceAction;
    if (this.#disposed || this.#isStopped()) return;
    if (
      maintenanceInterruptGeneration !== undefined &&
      !this.#isCurrent(maintenanceInterruptGeneration)
    )
      return;
    if (wake.mode !== "damage_reflex") {
      this.#activeOwnerReplyGeneration = undefined;
      this.#ownerReplyInterruptedByDamage = false;
      this.#damageReflexPending = false;
      this.#waterRecoveryActive = false;
      this.#damagedCollectionCandidate = undefined;
      this.#damageReflexContext = undefined;
    }
    if (wake.mode !== "damage_reflex" && wake.mode !== "equipment_upkeep")
      this.#equipmentUpkeepQueued = false;
    if (wake.mode !== "follow_owner") this.#ownerFollowRequested = false;
    if (this.#waitTimer !== undefined) clearTimeout(this.#waitTimer);
    if (this.#worldChangeTimer !== undefined)
      clearTimeout(this.#worldChangeTimer);
    this.#waitTimer = undefined;
    this.#worldChangeTimer = undefined;
    this.#wakeAt = null;
    this.#wakeReason = wake.reason;
    if (maintenanceInterruptGeneration === undefined) this.#generation += 1;
    this.#activeDecision?.abort(new Error("Companion judgment superseded"));
    this.#pendingWake = wake;
    if (this.#activeBody !== undefined) {
      this.#activeBody.controller.abort(new Error("Companion intent changed"));
    }
    const drain = this.#ensureDrain();
    if (wake.mode === "follow_owner") {
      void drain.catch((error: unknown) =>
        this.#logError(error, "Companion wake failed"),
      );
      return;
    }
    await drain;
  }

  #activate(): boolean {
    if (this.#disposed || this.#started) return false;
    this.#started = true;
    this.#unsubscribeBody = this.#body.onEvent((event) =>
      this.#onBodyEvent(event),
    );
    if (!this.#isStopped()) this.#armMaintenanceTimer();
    return true;
  }

  #armMaintenanceTimer(): void {
    if (
      this.#maintenanceTimer !== undefined ||
      !this.#started ||
      this.#disposed ||
      this.#isStopped()
    )
      return;
    this.#maintenanceTimer = setInterval(() => {
      void this.#checkMaintenance();
    }, maintenanceCheckIntervalMs);
    this.#maintenanceTimer.unref();
  }

  #clearMaintenanceTimer(): void {
    if (this.#maintenanceTimer !== undefined)
      clearInterval(this.#maintenanceTimer);
    this.#maintenanceTimer = undefined;
  }

  #refreshAutomaticPickupSuppressions(
    observation: PlayerBodyObservation,
  ): void {
    const automaticPickupRange =
      observation.perception.nearbyDroppedItems?.maxDistance ??
      observation.perception.maxDistance;
    const observedTargets = new Set<string>();
    for (const entity of visibleDroppedItems(observation)) {
      const item = entity.droppedItem;
      if (
        item !== undefined &&
        Number.isFinite(entity.distance) &&
        entity.distance <= automaticPickupRange
      )
        observedTargets.add(
          automaticPickupFingerprint(
            observation.dimension,
            entity.id,
            item.name,
            item.count,
          ),
        );
    }
    for (const fingerprint of this.#automaticPickupSuppressed.keys()) {
      if (!observedTargets.has(fingerprint))
        this.#automaticPickupSuppressed.delete(fingerprint);
    }
  }

  #refreshWaterRecoveryLatch(observation: PlayerBodyObservation): void {
    const { self } = observation;
    if (self.inWater === false) this.#damagedCollectionCandidate = undefined;

    const observedAtMs = Date.parse(observation.observedAt);
    const now = Date.now();
    const y = self.position.y;
    if (
      self.inWater !== false ||
      self.health === null ||
      !Number.isFinite(self.health) ||
      self.health <= 0 ||
      self.oxygen === null ||
      !Number.isFinite(self.oxygen) ||
      self.oxygen <= 5 ||
      !Number.isFinite(self.velocity.y) ||
      Math.abs(self.velocity.y) > 0.05 ||
      !Number.isFinite(y) ||
      !Number.isFinite(observedAtMs) ||
      observedAtMs > now ||
      now - observedAtMs > waterRecoveryDryMaximumAgeMs
    ) {
      this.#waterRecoveryDryCandidate = undefined;
      return;
    }

    const candidate = this.#waterRecoveryDryCandidate;
    if (candidate === undefined) {
      this.#waterRecoveryDryCandidate = {
        observedAtMs,
        dimension: observation.dimension,
        lifeEpoch: this.#waterRecoveryLifeEpoch,
        y,
      };
      return;
    }

    const intervalMs = observedAtMs - candidate.observedAtMs;
    if (
      candidate.dimension !== observation.dimension ||
      candidate.lifeEpoch !== this.#waterRecoveryLifeEpoch ||
      now - candidate.observedAtMs < 0 ||
      now - candidate.observedAtMs > waterRecoveryDryMaximumAgeMs ||
      intervalMs <= 0 ||
      intervalMs > waterRecoveryDryMaximumAgeMs ||
      Math.abs(y - candidate.y) > 0.1
    ) {
      this.#waterRecoveryDryCandidate = {
        observedAtMs,
        dimension: observation.dimension,
        lifeEpoch: this.#waterRecoveryLifeEpoch,
        y,
      };
      return;
    }
    if (intervalMs < waterRecoveryDryMinimumIntervalMs) return;

    this.#waterRecoveryAttempted = false;
    this.#waterRecoveryTrigger = undefined;
    this.#waterRecoveryDryCandidate = undefined;
  }

  #isWaterRecoveryTargetBlocked(
    entityId: number,
    dimension: string,
    ownerAuthorized = false,
  ): boolean {
    const block = this.#waterRecoveryTargetBlock;
    if (
      block === undefined ||
      ownerAuthorized ||
      this.#pendingOwnerRequest !== undefined ||
      this.#ownerFollowRequested
    )
      return false;
    return block.dimension === dimension && block.entityId === entityId;
  }

  async #checkMaintenance(): Promise<void> {
    if (
      this.#outcomePersistenceBlocked ||
      this.#maintenanceObservationInFlight ||
      !this.#started ||
      this.#disposed ||
      this.#isStopped()
    )
      return;
    this.#maintenanceObservationInFlight = true;
    const generation = this.#generation;
    let observation: PlayerBodyObservation;
    try {
      observation = await this.#body.observe({
        ownerPositionException: true,
      });
    } catch (error) {
      if (this.#isCurrent(generation) && !this.#isStopped())
        this.#logError(error, "Periodic upkeep observation failed");
      return;
    } finally {
      this.#maintenanceObservationInFlight = false;
    }
    if (!this.#isCurrent(generation) || this.#isStopped()) return;
    try {
      this.#rememberVisibleChests(observation);
      this.#rememberVisibleBeds(observation);
      this.#refreshAutomaticPickupSuppressions(observation);

      const snapshot = this.#store.snapshot();
      this.#refreshWaterRecoveryLatch(observation);
      if (
        !isSafeForEquipmentUpkeep(observation) ||
        observation.window !== null ||
        this.#maintenanceActionInFlight ||
        this.#activeDecision !== undefined ||
        this.#activeBody !== undefined ||
        this.#drainPromise !== undefined ||
        this.#pendingWake !== undefined ||
        this.#worldChangeTimer !== undefined ||
        snapshot.plan !== null ||
        snapshot.activeOperation !== null
      )
        return;

      this.#maintenanceActionInFlight = true;
      let finishMaintenanceAction!: () => void;
      this.#maintenanceActionFinished = new Promise<void>((resolve) => {
        finishMaintenanceAction = resolve;
      });
      try {
        const food = await this.#runFoodUpkeep(observation, generation);
        if (!this.#isCurrent(generation) || this.#isStopped()) return;
        observation = food.observation ?? observation;
        if (this.#hasActiveBodyRun() || this.#store.snapshot().plan !== null)
          return;
        await this.#runEquipmentUpkeep(observation, generation, false, false);
      } finally {
        this.#maintenanceActionInFlight = false;
        this.#maintenanceActionFinished = undefined;
        finishMaintenanceAction();
      }
    } catch (error) {
      if (this.#isCurrent(generation) && !this.#isStopped())
        this.#logError(error, "Periodic upkeep check failed");
    }
  }

  #fireWake(wake: PendingWake): void {
    void this.#requestWake(wake).catch((error: unknown) =>
      this.#logError(error, "Companion wake failed"),
    );
  }

  #ensureDrain(): Promise<void> {
    if (this.#drainPromise !== undefined) return this.#drainPromise;
    const drain = this.#drain().finally(() => {
      if (this.#drainPromise === drain) this.#drainPromise = undefined;
      if (this.#pendingWake !== undefined && !this.#disposed)
        void this.#ensureDrain();
    });
    this.#drainPromise = drain;
    return drain;
  }

  async #drain(): Promise<void> {
    while (this.#pendingWake !== undefined && !this.#disposed) {
      const wake = this.#pendingWake;
      this.#pendingWake = undefined;
      if (this.#isStopped()) return;
      const generation = this.#generation;
      if (wake.mode === "follow_owner") await this.#followOwner(generation);
      else if (wake.mode === "equipment_upkeep")
        await this.#runEquipmentUpkeepFromWake(generation);
      else await this.#think(wake, generation);
      if (
        wake.mode === "damage_reflex" &&
        this.#equipmentUpkeepQueued &&
        this.#isCurrent(generation) &&
        !this.#isStopped()
      ) {
        this.#pendingWake = {
          reason:
            "authenticated equipment request queued behind damage response",
          mode: "equipment_upkeep",
        };
      }
    }
  }

  async #think(wake: PendingWake, generation: number): Promise<void> {
    if (this.#outcomePersistenceBlocked) return;
    const controller = new AbortController();
    this.#activeDecision = controller;
    if (wake.ownerMessage !== undefined) {
      this.#activeOwnerReplyGeneration = generation;
      this.#activeOwnerReplySequence = wake.ownerMessageSequence;
    }
    const ownerReplyInterruptedByDamage =
      wake.mode === "damage_reflex" && this.#ownerReplyInterruptedByDamage;
    const ownerReplyGeneration = this.#ownerReplyGeneration;
    if (ownerReplyInterruptedByDamage)
      this.#ownerReplyInterruptedByDamage = false;
    this.#worldChangedDuringDecision = false;
    try {
      const snapshot = this.#store.snapshot();
      if (this.#isStopped() || !this.#isCurrent(generation)) return;
      const observation = await this.#body.observe({
        ownerPositionException: true,
      });
      if (!this.#isCurrent(generation)) return;
      if (
        ownerReplyInterruptedByDamage &&
        ownerReplyGeneration === this.#ownerReplyGeneration
      )
        void this.#speakDecision(ownerDamageInterruption, generation);
      this.#rememberVisibleChests(observation);
      this.#rememberVisibleBeds(observation);
      this.#refreshAutomaticPickupSuppressions(observation);
      this.#refreshWaterRecoveryLatch(observation);
      const nearbyDroppedItems = visibleDroppedItems(observation);
      const automaticPickupRange =
        observation.perception.nearbyDroppedItems?.maxDistance ??
        observation.perception.maxDistance;
      const automaticEquipmentEligible =
        wake.mode === undefined &&
        wake.ownerMessage === undefined &&
        snapshot.plan === null &&
        snapshot.activeOperation === null &&
        !this.#maintenanceActionInFlight &&
        observation.self.health !== null &&
        observation.self.health > 0 &&
        isSafeForEquipmentUpkeep(observation);
      if (
        wake.mode === undefined &&
        wake.ownerMessage === undefined &&
        snapshot.plan === null &&
        snapshot.activeOperation === null &&
        !this.#maintenanceActionInFlight &&
        isSafeForEquipmentUpkeep(observation)
      ) {
        const food = await this.#runFoodUpkeep(observation, generation);
        if (food.handled) {
          this.#setWakeTimer(this.#minWaitMs, {
            reason: "food upkeep completed; continue after a fresh observation",
          });
          return;
        }
      }
      if (
        automaticEquipmentEligible &&
        (await this.#runEquipmentUpkeep(observation, generation, false))
      )
        return;
      if (
        wake.mode === undefined &&
        wake.ownerMessage === undefined &&
        snapshot.plan === null &&
        snapshot.activeOperation === null &&
        this.#automaticPickupSuppressed.size <
          automaticPickupSuppressionLimit &&
        observation.self.health !== null &&
        observation.self.health > 0
      ) {
        const target = nearbyDroppedItems
          .filter(
            (entity) =>
              entity.droppedItem !== undefined &&
              entity.droppedItem.name !== "rotten_flesh" &&
              Number.isFinite(entity.distance) &&
              entity.distance <= automaticPickupRange,
          )
          .sort((left, right) => left.distance - right.distance)
          .find((entity) => {
            const item = entity.droppedItem;
            return (
              item !== undefined &&
              !this.#isWaterRecoveryTargetBlocked(
                entity.id,
                observation.dimension,
              ) &&
              !this.#automaticPickupSuppressed.has(
                automaticPickupFingerprint(
                  observation.dimension,
                  entity.id,
                  item.name,
                  item.count,
                ),
              )
            );
          });
        if (target?.droppedItem !== undefined) {
          const item = target.droppedItem;
          const targetKey = automaticPickupFingerprint(
            observation.dimension,
            target.id,
            item.name,
            item.count,
          );
          const operation = {
            kind: "collect_item" as const,
            entityId: target.id,
          };
          const automaticPlan = {
            purpose: "Collect one nearby visible dropped item autonomously.",
            steps: [
              {
                operation,
                expectedOutcome:
                  "PlayerBody confirms the pickup from the observed inventory change and item entity result.",
              },
            ],
          };
          this.#store.save({ plan: automaticPlan });
          this.#automaticPickupSuppressed.set(targetKey, true);
          await this.#executePlan(
            {
              speech: null,
              goal: snapshot.goal,
              plan: automaticPlan,
              memoryUpdates: [],
              relationshipSummary: null,
              waitMs: this.#minWaitMs,
              knowledgeQuery: null,
            },
            generation,
            undefined,
            false,
            undefined,
            observation,
          );
          return;
        }
      }
      let repeatedKnowledgeRequest = false;
      let decision: CompanionDecision;
      if (wake.mode === "damage_reflex") {
        decision = this.#damageReflexDecision(snapshot, observation);
      } else {
        const pendingOwnerRequest =
          this.#pendingOwnerRequest === wake.ownerMessage
            ? undefined
            : this.#runnablePendingOwnerRequest();
        const input = this.#createDecisionInput(
          snapshot,
          observation,
          wake.reason,
          wake.ownerMessage,
          pendingOwnerRequest,
          undefined,
          wake.ownerMessageSequence ??
            (pendingOwnerRequest === undefined
              ? undefined
              : this.#pendingOwnerRequestSequence),
        );

        if (
          wake.ownerMessageSequence !== undefined &&
          !this.#tryRecordReplyLifecycleEvent(
            wake.ownerMessageSequence,
            "generation_started",
          )
        )
          return;
        decision = await this.#agent.decide(input, controller.signal);
        if (!this.#isCurrent(generation)) return;
        if (decision.knowledgeQuery !== null) {
          if (
            this.#cachedKnowledge !== undefined &&
            normalizeKnowledgeQuery(decision.knowledgeQuery) ===
              normalizeKnowledgeQuery(this.#cachedKnowledge.query)
          ) {
            // The prior answer is already in this judgment's input. Do not query
            // the registry or spend another model call asking the same question.
            repeatedKnowledgeRequest = true;
            decision = { ...decision, plan: null, knowledgeQuery: null };
          } else {
            const knowledge = this.#body.knowledge(decision.knowledgeQuery);
            this.#cachedKnowledge = knowledge;
            if (!this.#isCurrent(generation)) return;
            decision = await this.#agent.decide(
              {
                ...input,
                wakeReason: `${wake.reason}; registry answer available`,
                knowledge,
              },
              controller.signal,
            );
            if (!this.#isCurrent(generation)) return;
            // Only one registry inspection is allowed per wake. A different
            // follow-up query waits for the next meaningful wake.
            if (decision.knowledgeQuery !== null)
              decision = { ...decision, plan: null };
          }
        }
      }

      if (
        wake.ownerMessageSequence !== undefined &&
        !this.#tryRecordReplyLifecycleEvent(
          wake.ownerMessageSequence,
          "generated",
        )
      )
        return;

      let refreshAfterDecision = false;
      if (
        wake.mode !== "damage_reflex" &&
        this.#didWorldChangeDuringDecision() &&
        decision.plan !== null
      ) {
        let freshObservation: PlayerBodyObservation;
        try {
          freshObservation = await this.#body.observe({
            ownerPositionException: true,
          });
        } catch {
          decision = { ...decision, plan: null };
          refreshAfterDecision = true;
          freshObservation = observation;
        }
        if (
          !canContinuePlan(
            observation,
            freshObservation,
            decision.plan?.steps[0]?.operation,
          )
        ) {
          decision = { ...decision, plan: null };
          refreshAfterDecision = true;
        }
      }

      if (
        wake.ownerMessage === undefined &&
        decision.plan?.steps.some(
          (step) =>
            step.operation.kind === "collect_item" &&
            this.#isWaterRecoveryTargetBlocked(
              step.operation.entityId,
              observation.dimension,
            ),
        )
      )
        decision = { ...decision, plan: null };

      const currentSnapshot = this.#store.snapshot();
      if (
        currentSnapshot.stopped ||
        this.#runtimeStopLatched ||
        !this.#isCurrent(generation)
      )
        return;
      this.#failureCount = 0;
      if (decision.memoryUpdates.length > 0) {
        this.#store.remember(decision.memoryUpdates, {
          ...(wake.ownerMessage === undefined
            ? {}
            : { ownerMessage: wake.ownerMessage }),
        });
      }
      const waitMs = this.#clampWaitMs(decision.waitMs);
      const waitUntil = new Date(Date.now() + waitMs).toISOString();
      const patch: CompanionStatePatch = {
        goal: decision.goal,
        plan: decision.knowledgeQuery === null ? decision.plan : null,
        waitUntil,
        activeOperation: null,
        ...(decision.relationshipSummary === null
          ? {}
          : { relationshipSummary: decision.relationshipSummary }),
      };
      this.#store.save(patch);
      if (!this.#isCurrent(generation) || this.#isStopped()) return;

      // The model request is complete; later world events are handled after
      // the Body result rather than invalidating an already validated action.
      if (this.#activeDecision === controller) this.#activeDecision = undefined;
      if (wake.ownerMessage !== undefined) {
        if (refreshAfterDecision) {
          this.#finishOwnerReply(generation);
          await this.#speakDecision(
            ownerPlanUnconfirmed,
            generation,
            wake.ownerMessageSequence,
          );
        } else if (decision.plan === null) {
          this.#finishOwnerReply(generation);
          const reply = decision.speech?.trim();
          await this.#speakDecision(
            reply === undefined || reply.length === 0
              ? ownerReplyUnavailable
              : reply,
            generation,
            wake.ownerMessageSequence,
          );
        } else {
          await this.#speakDecision(
            ownerPlanAccepted,
            generation,
            wake.ownerMessageSequence,
          );
        }
      }
      if (!this.#isCurrent(generation) || this.#isStopped()) return;

      if (refreshAfterDecision) {
        this.#setWakeTimer(worldChangeCoalesceMs, {
          reason: "world changed during judgment; re-observe before acting",
        });
        return;
      }
      if (repeatedKnowledgeRequest) {
        this.#setWakeTimer(waitMs, {
          reason:
            "registry answer was already available; wait for a meaningful wake",
        });
        return;
      }
      if (decision.knowledgeQuery !== null) {
        this.#setWakeTimer(waitMs, {
          reason:
            "registry knowledge request was repeated; wait for a new wake",
        });
        return;
      }
      if (decision.plan === null) {
        this.#setWakeTimer(waitMs, {
          reason: "model-selected companion wait ended",
        });
        return;
      }
      await this.#executePlan(
        decision,
        generation,
        wake.ownerMessage === undefined
          ? undefined
          : async () => {
              this.#finishOwnerReply(generation);
              const reply = decision.speech?.trim();
              await this.#speakDecision(
                reply === undefined || reply.length === 0
                  ? ownerPlanConfirmed
                  : reply,
                generation,
                wake.ownerMessageSequence,
                true,
              );
            },
        wake.mode === "damage_reflex",
        wake.ownerMessage === undefined
          ? undefined
          : async () => {
              this.#finishOwnerReply(generation);
              await this.#speakDecision(
                ownerPlanUnconfirmed,
                generation,
                wake.ownerMessageSequence,
                true,
              );
            },
        observation,
      );
    } catch (error) {
      if (!controller.signal.aborted && this.#isCurrent(generation)) {
        this.#logError(error, "Companion judgment failed");
        if (wake.ownerMessageSequence !== undefined)
          this.#tryRecordReplyLifecycleEvent(
            wake.ownerMessageSequence,
            "generation_failed",
            "judgment_failed",
          );
        if (ownerReplyInterruptedByDamage)
          void this.#speakDecision(ownerDamageObservationFailed, generation);
        if (wake.ownerMessage !== undefined) this.#finishOwnerReply(generation);
        if (wake.ownerMessage !== undefined)
          await this.#speakDecision(
            ownerReplyFailed,
            generation,
            wake.ownerMessageSequence,
          );
        this.#scheduleRetry({ reason: "Companion judgment failed" });
      }
    } finally {
      if (wake.mode === "damage_reflex" && this.#isCurrent(generation)) {
        this.#damageReflexPending = false;
        this.#waterRecoveryActive = false;
        this.#damageReflexContext = undefined;
      }
      if (this.#activeDecision === controller) this.#activeDecision = undefined;
      this.#finishOwnerReply(generation);
      if (this.#activeOwnerReplySequence === wake.ownerMessageSequence)
        this.#activeOwnerReplySequence = undefined;
    }
  }

  async #runEquipmentUpkeepFromWake(generation: number): Promise<void> {
    if (!this.#isCurrent(generation) || this.#isStopped()) return;
    let observation: PlayerBodyObservation;
    try {
      observation = await this.#body.observe({
        ownerPositionException: true,
      });
    } catch (error) {
      this.#logError(error, "Equipment upkeep observation failed");
      if (this.#isCurrent(generation) && !this.#isStopped())
        await this.#speakControlMessage(
          "装備を確認できなかったので、変更したとは言えないよ。",
        );
      if (this.#isCurrent(generation)) this.#equipmentUpkeepQueued = false;
      return;
    }
    if (!this.#isCurrent(generation) || this.#isStopped()) return;
    this.#rememberVisibleChests(observation);
    this.#rememberVisibleBeds(observation);
    if (!isSafeForEquipmentUpkeep(observation)) {
      this.#equipmentUpkeepQueued = false;
      await this.#speakControlMessage(
        "体力や周囲の状態を確認できないため、装備確認は始めなかったよ。",
      );
      return;
    }

    // A new explicit request is a deliberate retry of previously inspected chests.
    this.#equipmentChestSuppressed.clear();
    this.#failedEquipmentCandidateFingerprint = undefined;
    try {
      await this.#runEquipmentUpkeep(observation, generation, true);
    } finally {
      if (this.#isCurrent(generation)) this.#equipmentUpkeepQueued = false;
    }
  }

  async #runFoodUpkeep(
    initialObservation: PlayerBodyObservation,
    generation: number,
  ): Promise<FoodUpkeepResult> {
    let observation = initialObservation;
    const food = observation.self.food;
    if (
      !this.#isCurrent(generation) ||
      this.#isStopped() ||
      !isSafeForEquipmentUpkeep(observation) ||
      observation.window !== null ||
      food === null ||
      food >= 20
    )
      return {
        observation,
        confirmed: false,
        handled: false,
      };

    if (
      this.#foodPickupSuppressedAtFood !== undefined &&
      this.#foodPickupSuppressedAtFood !== food
    ) {
      this.#foodPickupSuppressed.clear();
      this.#foodChestSuppressed.clear();
    }
    this.#foodPickupSuppressedAtFood = food;

    const knownFoodInventory = (
      current: PlayerBodyObservation,
    ): BodyItemStack[] =>
      current.self.inventory.filter(
        (item) =>
          item.slot >= 9 &&
          item.slot < 45 &&
          item.count > 0 &&
          this.#isKnownFood(item.name),
      );
    const ordinaryFoodInventory = (
      current: PlayerBodyObservation,
    ): BodyItemStack[] =>
      knownFoodInventory(current).filter((item) =>
        this.#isRoutineFood(item.name),
      );
    let edibleItems = ordinaryFoodInventory(observation);
    let foodInventory = knownFoodInventory(observation);
    let fingerprint = foodAttemptFingerprint(observation, foodInventory);
    if (this.#foodUseSuppressedFingerprint === fingerprint) {
      return {
        observation,
        confirmed: false,
        handled: false,
      };
    }
    if (this.#foodUseSuppressedFingerprint !== undefined)
      this.#foodUseSuppressedFingerprint = undefined;
    if (this.#failedFoodAttemptFingerprint === fingerprint)
      return {
        observation,
        confirmed: false,
        handled: false,
      };

    if (edibleItems.length === 0) {
      const maxDistance =
        observation.perception.nearbyDroppedItems?.maxDistance ??
        observation.perception.maxDistance;
      const eligibleFoodDrop = (entity: BodyVisibleEntity): boolean =>
        entity.droppedItem !== undefined &&
        entity.droppedItem.count > 0 &&
        this.#isRoutineFood(entity.droppedItem.name) &&
        Number.isFinite(entity.distance) &&
        entity.distance <= maxDistance;
      const foodDropKey = (entity: BodyVisibleEntity): string | undefined => {
        const item = entity.droppedItem;
        if (item === undefined) return undefined;
        return JSON.stringify([
          food,
          automaticPickupFingerprint(
            observation.dimension,
            entity.id,
            item.name,
            item.count,
          ),
        ]);
      };
      const foodDrops = (nearby: boolean): BodyVisibleEntity[] =>
        visibleDroppedItems(observation)
          .filter(
            (entity) =>
              eligibleFoodDrop(entity) &&
              !this.#foodPickupSuppressed.has(foodDropKey(entity) ?? "") &&
              (nearby
                ? entity.distance <= equipmentSearchRange
                : entity.distance > equipmentSearchRange),
          )
          .sort((left, right) => left.distance - right.distance)
          .slice(0, equipmentUpkeepStepLimit);
      const collectFoodDrop = async (nearby: boolean): Promise<void> => {
        for (const candidate of foodDrops(nearby)) {
          const collected = await this.#collectObservedDrop(
            observation,
            candidate,
            generation,
            food,
          );
          if (collected.observation !== null)
            observation = collected.observation;
          if (collected.confirmed) return;
        }
      };
      await collectFoodDrop(true);
      if (ordinaryFoodInventory(observation).length === 0) {
        for (const block of visibleEquipmentChests(observation)) {
          const chestKey = JSON.stringify([
            food,
            equipmentChestFingerprint(observation.dimension, block),
          ]);
          if (
            this.#foodChestSuppressed.has(chestKey) ||
            this.#foodChestSuppressed.size >= equipmentChestSuppressionLimit
          )
            continue;
          this.#foodChestSuppressed.add(chestKey);
          const chest = await this.#withdrawFromVisibleChest(
            observation,
            block,
            generation,
            1,
            (fresh) => {
              if (!isChestEquipmentWindow(fresh.window)) return null;
              const item = fresh.window.slots
                .slice(0, fresh.window.inventoryStart)
                .find(
                  (candidate) =>
                    candidate !== null &&
                    candidate.count > 0 &&
                    this.#isRoutineFood(candidate.name),
                );
              return item === undefined || item === null ? null : { item };
            },
            (before, after, candidate) =>
              inventoryCount(after, candidate.item.name) >
              inventoryCount(before, candidate.item.name),
          );
          observation = chest.observation;
          if (!chest.cleanupConfirmed || observation.window !== null) {
            this.#failedFoodAttemptFingerprint = undefined;
            return { observation, confirmed: false, handled: true };
          }
          if (!chest.confirmed) break;
          if (chest.withdrawn.length > 0) break;
        }
      }
      if (ordinaryFoodInventory(observation).length === 0)
        await collectFoodDrop(false);
      edibleItems = ordinaryFoodInventory(observation);
      foodInventory = knownFoodInventory(observation);
      fingerprint = foodAttemptFingerprint(observation, foodInventory);
      if (edibleItems.length === 0) {
        const hasUntriedFoodDrop = visibleDroppedItems(observation).some(
          (entity) =>
            eligibleFoodDrop(entity) &&
            !this.#foodPickupSuppressed.has(foodDropKey(entity) ?? ""),
        );
        const hasUntriedFoodChest = visibleEquipmentChests(observation).some(
          (block) =>
            !this.#foodChestSuppressed.has(
              JSON.stringify([
                food,
                equipmentChestFingerprint(observation.dimension, block),
              ]),
            ),
        );
        if (
          (hasUntriedFoodDrop &&
            this.#foodPickupSuppressed.size <
              automaticPickupSuppressionLimit) ||
          (hasUntriedFoodChest &&
            this.#foodChestSuppressed.size < equipmentChestSuppressionLimit)
        ) {
          this.#failedFoodAttemptFingerprint = undefined;
          return { observation, confirmed: false, handled: false };
        }
        if (hasUntriedFoodDrop || hasUntriedFoodChest) {
          this.#failedFoodAttemptFingerprint = fingerprint;
          return { observation, confirmed: false, handled: false };
        }

        const heldRottenFlesh = foodInventory.filter(
          (item) => item.name === "rotten_flesh",
        );
        if (
          heldRottenFlesh.length === 0 ||
          !canUseRottenFleshLastResort(observation) ||
          !this.#isCurrent(generation) ||
          this.#isStopped()
        ) {
          this.#failedFoodAttemptFingerprint = fingerprint;
          return { observation, confirmed: false, handled: false };
        }
        edibleItems = heldRottenFlesh;
      }
    }

    const useRottenFleshLastResort =
      edibleItems.length > 0 &&
      edibleItems.every((item) => item.name === "rotten_flesh");
    const operation: PlayerOperation = useRottenFleshLastResort
      ? { kind: "consume", item: "rotten_flesh" }
      : { kind: "consume" };
    const expectedOutcome = useRottenFleshLastResort
      ? rottenFleshLastResortReason(
          observation,
          visibleDroppedItems(observation).filter((entity) => {
            const item = entity.droppedItem;
            const maxDistance =
              observation.perception.nearbyDroppedItems?.maxDistance ??
              observation.perception.maxDistance;
            return (
              item !== undefined &&
              item.count > 0 &&
              this.#isRoutineFood(item.name) &&
              Number.isFinite(entity.distance) &&
              entity.distance <= maxDistance
            );
          }).length,
          visibleEquipmentChests(observation).length,
          this.#foodPickupSuppressed.size,
          this.#foodChestSuppressed.size,
        )
      : "Consume one ordinary known food item while hunger is below full, then verify the Body result and fresh observation.";
    const step = await this.#executeUpkeepAction(
      operation,
      expectedOutcome,
      generation,
      undefined,
      observation,
    );
    let after = step.observation;
    if (after === null) {
      try {
        after = await this.#body.observe({ ownerPositionException: true });
      } catch (error) {
        this.#logError(error, "Food result could not be observed");
        this.#failedFoodAttemptFingerprint = fingerprint;
        return {
          observation,
          confirmed: false,
          handled: false,
        };
      }
    }
    const inventoryChanged = edibleItems.some(
      (item) =>
        inventoryCount(after, item.name) <
        inventoryCount(observation, item.name),
    );
    const foodIncreased = after.self.food !== null && after.self.food > food;
    if (
      !step.confirmed ||
      !inventoryChanged ||
      !foodIncreased ||
      !this.#isCurrent(generation) ||
      this.#isStopped()
    ) {
      if (
        step.confirmed &&
        inventoryChanged &&
        !foodIncreased &&
        after.self.food !== null
      )
        this.#foodUseSuppressedFingerprint = foodAttemptFingerprint(
          after,
          knownFoodInventory(after),
        );
      this.#failedFoodAttemptFingerprint = foodAttemptFingerprint(
        after,
        knownFoodInventory(after),
      );
      return { observation: after, confirmed: false, handled: false };
    }
    this.#failedFoodAttemptFingerprint = undefined;
    this.#foodUseSuppressedFingerprint = undefined;
    return { observation: after, confirmed: true, handled: true };
  }

  #isKnownFood(name: string): boolean {
    return this.#body
      .knowledge(name)
      .facts.some(
        (fact) =>
          fact.kind === "item" &&
          fact.name === name &&
          fact.food !== null &&
          fact.food.foodPoints > 0,
      );
  }

  #isRoutineFood(name: string): boolean {
    return name !== "rotten_flesh" && this.#isKnownFood(name);
  }

  async #collectObservedDrop(
    observation: PlayerBodyObservation,
    candidate: BodyVisibleEntity,
    generation: number,
    foodState?: number,
    ownerAuthorized = false,
  ): Promise<EquipmentStepResult> {
    const item = candidate.droppedItem;
    if (item === undefined) return { observation: null, confirmed: false };
    if (
      this.#isWaterRecoveryTargetBlocked(
        candidate.id,
        observation.dimension,
        ownerAuthorized,
      )
    )
      return { observation: null, confirmed: false };
    const targetKey = automaticPickupFingerprint(
      observation.dimension,
      candidate.id,
      item.name,
      item.count,
    );
    const key =
      foodState === undefined
        ? targetKey
        : JSON.stringify([foodState, targetKey]);
    const suppressed =
      foodState === undefined
        ? this.#automaticPickupSuppressed.has(key)
        : this.#foodPickupSuppressed.has(key);
    const suppressionCount =
      foodState === undefined
        ? this.#automaticPickupSuppressed.size
        : this.#foodPickupSuppressed.size;
    if (suppressed || suppressionCount >= automaticPickupSuppressionLimit)
      return { observation: null, confirmed: false };
    const current = visibleDroppedItems(observation).find(
      (entity) =>
        entity.id === candidate.id &&
        entity.droppedItem?.name === item.name &&
        entity.droppedItem.count === item.count &&
        Number.isFinite(entity.distance) &&
        entity.distance <=
          (observation.perception.nearbyDroppedItems?.maxDistance ??
            observation.perception.maxDistance),
    );
    if (current === undefined) return { observation: null, confirmed: false };
    if (foodState === undefined) this.#automaticPickupSuppressed.set(key, true);
    else this.#foodPickupSuppressed.add(key);
    const beforeCount = inventoryCount(observation, item.name);
    const step = await this.#executeUpkeepAction(
      { kind: "collect_item", entityId: current.id },
      "Collect one observed item and confirm its inventory count increased.",
      generation,
      undefined,
      observation,
    );
    if (
      !step.confirmed ||
      step.observation === null ||
      inventoryCount(step.observation, item.name) <= beforeCount ||
      !canContinuePlan(observation, step.observation, undefined)
    )
      return { observation: step.observation, confirmed: false };
    return step;
  }

  async #withdrawFromVisibleChest<T extends { readonly item: BodyItemStack }>(
    initialObservation: PlayerBodyObservation,
    block: BodyVisibleBlock,
    generation: number,
    limit: number,
    findCandidate: (observation: PlayerBodyObservation) => T | null,
    verifyTransfer: (
      before: PlayerBodyObservation,
      after: PlayerBodyObservation,
      candidate: T,
    ) => boolean,
  ): Promise<{
    readonly observation: PlayerBodyObservation;
    readonly withdrawn: readonly T[];
    readonly confirmed: boolean;
    readonly cleanupConfirmed: boolean;
  }> {
    let observation = initialObservation;
    const withdrawn: T[] = [];
    let confirmed = true;
    let cleanupConfirmed = true;
    const targetBlock = block;

    if (block.distance > equipmentChestReach) {
      const moved = await this.#executeUpkeepAction(
        {
          kind: "move_to",
          position: {
            x: block.position.x,
            y: block.position.y,
            z: block.position.z,
          },
          range: equipmentChestMoveRange,
        },
        "Move within reach of the observed chest, then verify the same chest before opening it.",
        generation,
        undefined,
        observation,
      );
      if (
        !moved.confirmed ||
        moved.observation === null ||
        !canContinuePlan(observation, moved.observation, undefined) ||
        !isSafeForEquipmentUpkeep(moved.observation)
      )
        return {
          observation,
          withdrawn,
          confirmed: false,
          cleanupConfirmed,
        };
      observation = moved.observation;
      const reachable = visibleEquipmentChests(observation).find(
        (candidate) =>
          sameBlockPosition(candidate, targetBlock) &&
          candidate.distance <= equipmentChestReach,
      );
      if (reachable === undefined)
        return {
          observation,
          withdrawn,
          confirmed: false,
          cleanupConfirmed,
        };
      block = reachable;
    }

    if (
      !this.#isCurrent(generation) ||
      this.#isStopped() ||
      !isSafeForEquipmentUpkeep(observation)
    )
      return {
        observation,
        withdrawn,
        confirmed: false,
        cleanupConfirmed,
      };

    try {
      const opened = await this.#executeUpkeepAction(
        {
          kind: "open_window",
          target: {
            kind: "block",
            position: {
              x: block.position.x,
              y: block.position.y,
              z: block.position.z,
            },
          },
        },
        "Open the freshly observed reachable chest to inspect its contents.",
        generation,
        undefined,
        observation,
      );
      if (
        !opened.confirmed ||
        opened.observation === null ||
        !isChestEquipmentWindow(opened.observation.window)
      ) {
        confirmed = false;
      } else {
        observation = opened.observation;
        while (
          withdrawn.length < limit &&
          this.#isCurrent(generation) &&
          !this.#isStopped() &&
          isSafeForEquipmentUpkeep(observation)
        ) {
          const candidate = findCandidate(observation);
          if (candidate === null) break;
          const before = observation;
          const transfer = await this.#executeUpkeepAction(
            {
              kind: "window_transfer",
              item: candidate.item.name,
              count: 1,
              direction: "window_to_inventory",
            },
            "Withdraw exactly one freshly observed item from the open chest.",
            generation,
            undefined,
            before,
          );
          if (
            !transfer.confirmed ||
            transfer.observation === null ||
            !sameEquipmentChestWindow(
              before.window,
              transfer.observation.window,
            ) ||
            !verifyTransfer(before, transfer.observation, candidate)
          ) {
            confirmed = false;
            break;
          }
          withdrawn.push(candidate);
          observation = transfer.observation;
        }
      }
    } catch (error) {
      this.#logError(error, "Chest inspection failed");
      confirmed = false;
    } finally {
      const closed = await this.#closeEquipmentWindow(generation);
      if (!closed.confirmed || closed.observation === null) {
        confirmed = false;
        cleanupConfirmed = false;
      } else {
        observation = closed.observation;
      }
    }
    return { observation, withdrawn, confirmed, cleanupConfirmed };
  }

  async #runEquipmentUpkeep(
    initialObservation: PlayerBodyObservation,
    generation: number,
    explicit: boolean,
    scheduleWake = true,
  ): Promise<boolean> {
    let observation = initialObservation;
    let attemptedGearWork = false;
    let uncertain = false;
    let cleanupConfirmed = true;
    let swept = false;
    let sweepAttempted = false;
    let sweepChestCandidates: EquipmentSweepChestCandidate[] = [];
    let automaticSweepFingerprint: string | undefined;
    const attemptedSweepChestCandidates = new Set<string>();
    let sweepChestCandidateChecks = 0;
    let equipmentChanges = 0;
    let equipmentDropsCollected = 0;
    const confirmedItems: string[] = [];

    try {
      if (!this.#isCurrent(generation) || this.#isStopped()) return explicit;
      if (
        !isSafeForEquipmentUpkeep(observation) ||
        observation.window !== null
      ) {
        uncertain = explicit;
      } else {
        const equipInventoryUpgrades = async (): Promise<boolean> => {
          while (
            equipmentChanges + equipmentDropsCollected <
              equipmentUpkeepStepLimit &&
            this.#isCurrent(generation) &&
            !this.#isStopped() &&
            isSafeForEquipmentUpkeep(observation)
          ) {
            const upgrade = findInventoryEquipmentUpgrade(observation);
            if (upgrade === null) return true;
            const candidateFingerprint = equipmentCandidateFingerprint(
              observation,
              upgrade,
            );
            if (
              this.#failedEquipmentCandidateFingerprint === candidateFingerprint
            ) {
              uncertain = true;
              return false;
            }
            attemptedGearWork = true;
            const before = observation;
            const step = await this.#executeUpkeepAction(
              {
                kind: "equip",
                item: upgrade.item.name,
                destination: upgrade.destination,
              },
              "Equip a strictly better observed armor or combat weapon item.",
              generation,
              undefined,
              before,
            );
            if (
              !step.confirmed ||
              step.observation === null ||
              !sameItemQuality(
                step.observation.self.equipment[upgrade.destination] ?? null,
                upgrade.item,
              )
            ) {
              this.#failedEquipmentCandidateFingerprint =
                equipmentCandidateFingerprint(
                  step.observation ?? before,
                  upgrade,
                );
              uncertain = true;
              return false;
            }
            if (!canContinuePlan(before, step.observation, undefined)) {
              this.#failedEquipmentCandidateFingerprint =
                equipmentCandidateFingerprint(step.observation, upgrade);
              uncertain = true;
              return false;
            }
            observation = step.observation;
            this.#failedEquipmentCandidateFingerprint = undefined;
            confirmedItems.push(upgrade.item.name);
            equipmentChanges += 1;
          }
          return this.#isCurrent(generation) && !this.#isStopped();
        };

        const collectEquipmentDrop = async (
          candidates: readonly BodyVisibleEntity[],
        ): Promise<boolean> => {
          if (
            equipmentChanges + equipmentDropsCollected >=
              equipmentUpkeepStepLimit ||
            !this.#isCurrent(generation) ||
            this.#isStopped() ||
            !isSafeForEquipmentUpkeep(observation) ||
            this.#automaticPickupSuppressed.size >=
              automaticPickupSuppressionLimit
          )
            return false;
          for (const candidate of candidates) {
            const item = candidate.droppedItem;
            if (item === undefined) continue;
            const targetKey = automaticPickupFingerprint(
              observation.dimension,
              candidate.id,
              item.name,
              item.count,
            );
            if (this.#automaticPickupSuppressed.has(targetKey)) continue;
            attemptedGearWork = true;
            const step = await this.#collectObservedDrop(
              observation,
              candidate,
              generation,
              undefined,
              explicit,
            );
            if (!step.confirmed || step.observation === null) {
              uncertain = true;
              return false;
            }
            observation = step.observation;
            equipmentDropsCollected += 1;
            return true;
          }
          return false;
        };

        let equipmentUpgradesConfirmed = await equipInventoryUpgrades();
        while (
          equipmentUpgradesConfirmed &&
          equipmentChanges + equipmentDropsCollected < equipmentUpkeepStepLimit
        ) {
          const nearbyEquipmentDrops = equipmentDropCandidates(
            observation,
          ).filter((entity) => entity.distance <= equipmentSearchRange);
          if (!(await collectEquipmentDrop(nearbyEquipmentDrops))) break;
          equipmentUpgradesConfirmed = await equipInventoryUpgrades();
        }

        if (
          explicit &&
          equipmentChanges + equipmentDropsCollected <
            equipmentUpkeepStepLimit &&
          visibleEquipmentChests(observation).length === 0 &&
          this.#isCurrent(generation) &&
          !this.#isStopped()
        ) {
          swept = true;
          sweepAttempted = true;
          const sweep = await this.#executeUpkeepAction(
            { kind: "look_sweep" },
            "Complete one bounded look sweep before searching its received views for nearby chests.",
            generation,
            undefined,
            observation,
          );
          if (!sweep.confirmed || sweep.observation === null) {
            uncertain = true;
          } else {
            observation = sweep.observation;
            sweepChestCandidates = equipmentSweepChestCandidates(
              sweep.lookSweep,
              observation.dimension,
            );
          }
        }

        if (
          !uncertain &&
          equipmentChanges + equipmentDropsCollected < equipmentUpkeepStepLimit
        ) {
          let inspected = 0;
          while (
            inspected < equipmentChestSearchLimit &&
            this.#isCurrent(generation) &&
            !this.#isStopped() &&
            isSafeForEquipmentUpkeep(observation) &&
            equipmentChanges + equipmentDropsCollected <
              equipmentUpkeepStepLimit
          ) {
            const nearbyEquipmentDrops = equipmentDropCandidates(
              observation,
            ).filter((entity) => entity.distance <= equipmentSearchRange);
            if (
              nearbyEquipmentDrops.length > 0 &&
              (await collectEquipmentDrop(nearbyEquipmentDrops))
            ) {
              if (!(await equipInventoryUpgrades())) break;
              continue;
            }
            const block = visibleEquipmentChests(observation).find(
              (candidate) =>
                !this.#equipmentChestSuppressed.has(
                  equipmentChestFingerprint(observation.dimension, candidate),
                ),
            );
            if (block === undefined) {
              if (!explicit && !sweepAttempted) {
                const fingerprint = equipmentSearchGapFingerprint(observation);
                const cooldown = this.#equipmentSweepCooldown;
                if (
                  fingerprint !== null &&
                  (cooldown?.fingerprint !== fingerprint ||
                    cooldown.expiresAt <= Date.now())
                ) {
                  sweepAttempted = true;
                  swept = true;
                  const sweep = await this.#executeUpkeepAction(
                    { kind: "look_sweep" },
                    "Complete one bounded look sweep for nearby gear while equipment is missing.",
                    generation,
                    undefined,
                    observation,
                  );
                  if (!sweep.confirmed || sweep.observation === null) {
                    attemptedGearWork = true;
                    uncertain = true;
                    break;
                  }
                  observation = sweep.observation;
                  sweepChestCandidates = equipmentSweepChestCandidates(
                    sweep.lookSweep,
                    observation.dimension,
                  );
                  if (sweep.lookSweep?.complete === true)
                    automaticSweepFingerprint = fingerprint;
                  continue;
                }
              }

              const candidate = sweepChestCandidates.find((sweepCandidate) => {
                if (sweepCandidate.position.dimension !== observation.dimension)
                  return false;
                const key = equipmentChestFingerprint(
                  observation.dimension,
                  sweepCandidate,
                );
                return (
                  !attemptedSweepChestCandidates.has(key) &&
                  !this.#equipmentChestSuppressed.has(key)
                );
              });
              if (
                candidate === undefined ||
                sweepChestCandidateChecks >= equipmentChestSearchLimit
              )
                break;

              const candidateKey = equipmentChestFingerprint(
                observation.dimension,
                candidate,
              );
              attemptedSweepChestCandidates.add(candidateKey);
              sweepChestCandidateChecks += 1;
              const looked = await this.#executeUpkeepAction(
                {
                  kind: "look",
                  target: {
                    x: candidate.position.x + 0.5,
                    y: candidate.position.y + 0.5,
                    z: candidate.position.z + 0.5,
                  },
                },
                "Face a chest candidate from the current bounded sweep, then confirm it in a fresh Body view.",
                generation,
                undefined,
                observation,
              );
              if (!looked.confirmed || looked.observation === null) {
                uncertain = true;
                break;
              }
              observation = looked.observation;
              continue;
            }
            inspected += 1;
            const chestKey = equipmentChestFingerprint(
              observation.dimension,
              block,
            );
            if (
              this.#equipmentChestSuppressed.size >=
              equipmentChestSuppressionLimit
            )
              break;
            // Suppress before travel so a failed or interrupted approach is bounded.
            this.#equipmentChestSuppressed.add(chestKey);
            attemptedGearWork = true;
            const chest = await this.#withdrawFromVisibleChest(
              observation,
              block,
              generation,
              equipmentUpkeepStepLimit -
                equipmentChanges -
                equipmentDropsCollected,
              (fresh) => findChestEquipmentWithdrawal(fresh),
              (_before, after, candidate) =>
                hasMatchingInventoryItem(after, candidate.item),
            );
            observation = chest.observation;
            const withdrawn = chest.withdrawn;
            if (!chest.cleanupConfirmed) cleanupConfirmed = false;
            const chestFailed = !chest.confirmed;

            if (!cleanupConfirmed || !this.#isCurrent(generation)) break;
            if (chestFailed) {
              this.#equipmentChestSuppressed.add(chestKey);
              uncertain = true;
              break;
            }
            if (withdrawn.length === 0) {
              this.#equipmentChestSuppressed.add(chestKey);
              continue;
            }

            this.#equipmentChestSuppressed.add(chestKey);
            while (
              equipmentChanges + equipmentDropsCollected <
                equipmentUpkeepStepLimit &&
              this.#isCurrent(generation) &&
              !this.#isStopped() &&
              isSafeForEquipmentUpkeep(observation)
            ) {
              const upgrade = findInventoryEquipmentUpgrade(observation);
              if (upgrade === null) break;
              if (
                !withdrawn.some(
                  (candidate) =>
                    candidate.destination === upgrade.destination &&
                    sameItemQuality(candidate.item, upgrade.item),
                )
              ) {
                uncertain = true;
                break;
              }
              const candidateFingerprint = equipmentCandidateFingerprint(
                observation,
                upgrade,
              );
              if (
                this.#failedEquipmentCandidateFingerprint ===
                candidateFingerprint
              ) {
                uncertain = true;
                break;
              }
              const before = observation;
              const step = await this.#executeUpkeepAction(
                {
                  kind: "equip",
                  item: upgrade.item.name,
                  destination: upgrade.destination,
                },
                "Equip the observed chest item only after the chest is closed and inventory transfer was confirmed.",
                generation,
                undefined,
                before,
              );
              if (
                !step.confirmed ||
                step.observation === null ||
                !sameItemQuality(
                  step.observation.self.equipment[upgrade.destination] ?? null,
                  upgrade.item,
                ) ||
                !canContinuePlan(before, step.observation, undefined)
              ) {
                this.#failedEquipmentCandidateFingerprint =
                  equipmentCandidateFingerprint(
                    step.observation ?? before,
                    upgrade,
                  );
                uncertain = true;
                break;
              }
              observation = step.observation;
              this.#failedEquipmentCandidateFingerprint = undefined;
              confirmedItems.push(upgrade.item.name);
              equipmentChanges += 1;
            }
            if (uncertain) break;
          }
        }

        if (
          !uncertain &&
          equipmentChanges + equipmentDropsCollected <
            equipmentUpkeepStepLimit &&
          !visibleEquipmentChests(observation).some(
            (block) =>
              !this.#equipmentChestSuppressed.has(
                equipmentChestFingerprint(observation.dimension, block),
              ),
          )
        ) {
          const distantEquipmentDrops = equipmentDropCandidates(
            observation,
          ).filter((entity) => entity.distance > equipmentSearchRange);
          if (await collectEquipmentDrop(distantEquipmentDrops))
            await equipInventoryUpgrades();
        }

        if (
          automaticSweepFingerprint !== undefined &&
          equipmentSearchGapFingerprint(observation) ===
            automaticSweepFingerprint
        )
          this.#equipmentSweepCooldown = {
            fingerprint: automaticSweepFingerprint,
            expiresAt: Date.now() + equipmentSweepMissCooldownMs,
          };
      }
    } catch (error) {
      this.#logError(error, "Equipment upkeep failed");
      uncertain = true;
    }

    if (explicit && this.#isCurrent(generation) && !this.#isStopped()) {
      if (!cleanupConfirmed) {
        await this.#speakControlMessage(
          "画面を閉じたことを観測で確認できなかったので、装備更新の成功は報告できないよ。",
        );
      } else if (uncertain) {
        await this.#speakControlMessage(
          "装備の変更を最後まで観測で確認できなかったので、成功とは言えないよ。",
        );
      } else if (confirmedItems.length > 0) {
        await this.#speakControlMessage(
          `装備を更新したよ: ${confirmedItems.join(", ")}`,
        );
      } else {
        await this.#speakControlMessage(
          "今回受け取った可視範囲では、今の装備を改善する品を確認できなかったよ。",
        );
      }
    }

    if (swept && confirmedItems.length === 0 && !uncertain)
      attemptedGearWork = false;
    const handled = explicit || attemptedGearWork || confirmedItems.length > 0;
    if (
      scheduleWake &&
      handled &&
      this.#isCurrent(generation) &&
      !this.#isStopped()
    )
      this.#setWakeTimer(this.#minWaitMs, {
        reason: "equipment upkeep completed; wait for a fresh observation",
      });
    return handled;
  }

  async #executeUpkeepAction(
    operationInput: PlayerOperation,
    expectedOutcome: string,
    generation: number,
    purpose = "Perform one deterministic food or equipment upkeep step from fresh Body observations.",
    beforeObservation?: PlayerBodyObservation,
  ): Promise<EquipmentStepResult> {
    if (!this.#isBodyDispatchAllowed(generation))
      return { observation: null, confirmed: false };
    const operation = playerOperationSchema.parse(operationInput);
    if (operation.kind === "follow_owner")
      return { observation: null, confirmed: false };
    const snapshot = this.#store.snapshot();
    if (snapshot.activeOperation !== null)
      return { observation: null, confirmed: false };
    const plan = { purpose, steps: [{ operation, expectedOutcome }] };
    try {
      this.#store.save({ plan });
    } catch (error) {
      this.#logError(error, "Equipment upkeep plan could not be saved");
      return { observation: null, confirmed: false };
    }
    const decision: CompanionDecision = {
      speech: null,
      goal: snapshot.goal,
      plan,
      memoryUpdates: [],
      relationshipSummary: null,
      waitMs: this.#minWaitMs,
      knowledgeQuery: null,
    };
    const preserveWakeTimer = this.#maintenanceActionInFlight;
    this.#clearTimers(preserveWakeTimer);
    const result: {
      observation: PlayerBodyObservation | null;
      bodyResult?: PlayerOperationResult | undefined;
    } = {
      observation: null,
    };
    try {
      await this.#executePlan(
        decision,
        generation,
        (fresh, bodyResult) => {
          result.observation = fresh;
          result.bodyResult = bodyResult;
        },
        false,
        undefined,
        beforeObservation,
      );
    } catch (error) {
      this.#logError(error, "Equipment upkeep step failed");
    } finally {
      this.#clearTimers(preserveWakeTimer);
    }
    return {
      observation: result.observation,
      // #executePlan invokes this callback only after a successful Body
      // outcome, same-life check, and fresh observation.
      confirmed:
        result.observation !== null &&
        this.#isCurrent(generation) &&
        !this.#isStopped(),
      ...(result.bodyResult?.lookSweep === undefined
        ? {}
        : { lookSweep: result.bodyResult.lookSweep }),
    };
  }

  async #closeEquipmentWindow(
    generation: number,
  ): Promise<EquipmentStepResult> {
    let observation: PlayerBodyObservation;
    try {
      observation = await this.#body.observe({
        ownerPositionException: true,
      });
    } catch (error) {
      this.#logError(error, "Equipment window state could not be observed");
      return { observation: null, confirmed: false };
    }
    if (observation.window === null) return { observation, confirmed: true };
    if (this.#isCurrent(generation) && !this.#isStopped()) {
      const closed = await this.#executeUpkeepAction(
        { kind: "window_close" },
        "Close the chest after equipment inspection and verify the window is gone.",
        generation,
        undefined,
        observation,
      );
      if (closed.confirmed && closed.observation?.window === null)
        return closed;
    }
    return this.#forceCloseEquipmentWindow(generation);
  }

  async #forceCloseEquipmentWindow(
    generation: number,
  ): Promise<EquipmentStepResult> {
    if (!this.#isBodyDispatchAllowed(generation))
      return { observation: null, confirmed: false };

    let observation: PlayerBodyObservation;
    try {
      observation = await this.#body.observe({
        ownerPositionException: true,
      });
    } catch (error) {
      if (this.#isBodyDispatchAllowed(generation))
        this.#logError(error, "Equipment cleanup observation failed");
      return { observation: null, confirmed: false };
    }
    if (!this.#isBodyDispatchAllowed(generation))
      return { observation: null, confirmed: false };
    if (observation.window === null) return { observation, confirmed: true };
    return this.#executeUpkeepAction(
      { kind: "window_close" },
      "Close the equipment window after inspection and verify it is gone.",
      generation,
      "Close the equipment window after inspection and record the cleanup Body result.",
      observation,
    );
  }

  async #followOwner(generation: number): Promise<void> {
    if (this.#outcomePersistenceBlocked) return;
    const existing = this.#store.snapshot();
    if (existing.activeOperation !== null) return;
    let preActionObservation: PlayerBodyObservation;
    try {
      preActionObservation = await this.#body.observe({
        ownerPositionException: true,
      });
    } catch (error) {
      if (this.#isCurrent(generation) && !this.#isStopped())
        this.#logError(error, "Owner-follow pre-action observation failed");
      return;
    }
    if (!this.#isCurrent(generation) || this.#isStopped()) return;
    const operation = playerOperationSchema.parse({ kind: "follow_owner" });
    const operationId = randomUUID();
    const expectedOutcome =
      "The configured owner remains nearby until following is interrupted.";
    const purpose = "明示された指示に従ってオーナーの近くまで移動する。";
    const startedAt = new Date().toISOString();
    const activeOperation = {
      operationId,
      operation,
      expectedOutcome,
      purpose,
      preActionObservation: bodyObservationEvidence(preActionObservation),
      bodyStartedAt: startedAt,
    } as const;

    try {
      this.#store.save({
        goal: {
          title: "オーナーに追従する",
          successCondition: "オーナーの近くを保つ。",
          source: "owner",
        },
        plan: {
          purpose,
          steps: [{ operation, expectedOutcome }],
        },
        waitUntil: null,
        activeOperation,
      });
    } catch (error) {
      this.#outcomePersistenceBlocked = true;
      this.#ownerFollowRequested = false;
      if (!this.#isStopped())
        this.#logError(error, "Owner-follow state could not be saved");
      return;
    }
    if (!this.#isCurrent(generation) || this.#isStopped()) return;

    const controller = new AbortController();
    const promise = Promise.resolve().then(() =>
      this.#body.execute(operation, controller.signal),
    );
    const run: ActiveBodyRun = {
      operationId,
      operation,
      startedAt,
      controller,
      promise,
    };
    this.#activeBody = run;

    let result: PlayerOperationResult;
    let evidenceSource: CompanionOutcomeEvidenceSource = "body_result";
    try {
      result = await promise;
    } catch {
      result = failedBodyResult(operation, operationId);
      evidenceSource = "runtime_exception";
    } finally {
      if (this.#activeBody === run) this.#activeBody = undefined;
    }

    let updated: CompanionSnapshot;
    try {
      updated = this.#store.recordOutcome(
        outcomeFromResult(
          result,
          operation,
          operationId,
          expectedOutcome,
          purpose,
          evidenceSource,
          activeOperation.preActionObservation,
        ),
      );
    } catch (error) {
      this.#outcomePersistenceBlocked = true;
      if (this.#isCurrent(generation)) this.#ownerFollowRequested = false;
      this.#logError(error, "Body outcome could not be persisted");
      return;
    }
    if (this.#isCurrent(generation)) this.#ownerFollowRequested = false;
    if (
      !this.#isCurrent(generation) ||
      updated.stopped ||
      this.#runtimeStopLatched
    )
      return;
    this.#store.save({ goal: null });
  }

  async #executePlan(
    decision: CompanionDecision,
    generation: number,
    onPlanConfirmed?: (
      observation: PlayerBodyObservation,
      result: PlayerOperationResult,
    ) => void | Promise<void>,
    damageReflex = false,
    onPlanNotConfirmed?: () => void | Promise<void>,
    initialObservation?: PlayerBodyObservation,
  ): Promise<void> {
    if (this.#outcomePersistenceBlocked) return;
    const plannedSteps = decision.plan?.steps ?? [];
    const reportPlanNotConfirmed = async (): Promise<void> => {
      if (this.#isCurrent(generation) && !this.#isStopped())
        await onPlanNotConfirmed?.();
    };
    let beforeObservation = initialObservation;
    for (const plannedStep of plannedSteps) {
      if (!this.#isCurrent(generation) || this.#isStopped()) return;
      const snapshot = this.#store.snapshot();
      if (snapshot.activeOperation !== null) return;
      const step = snapshot.plan?.steps[0];
      if (
        step === undefined ||
        !sameOperation(step.operation, plannedStep.operation) ||
        step.expectedOutcome !== plannedStep.expectedOutcome
      ) {
        await reportPlanNotConfirmed();
        this.#requestReplan(
          "persisted plan no longer matches next action",
          generation,
        );
        return;
      }
      const operation = playerOperationSchema.parse(step.operation);
      if (operation.kind === "follow_owner") {
        await reportPlanNotConfirmed();
        this.#requestReplan(
          "Agent cannot issue the internal owner-follow operation",
          generation,
        );
        return;
      }
      if (beforeObservation === undefined) {
        try {
          beforeObservation = await this.#body.observe({
            ownerPositionException: true,
          });
        } catch (error) {
          this.#logError(error, "Pre-action Body observation failed");
          await reportPlanNotConfirmed();
          this.#scheduleRetry({ reason: "pre-action observation failed" });
          return;
        }
      }
      if (!this.#isCurrent(generation) || this.#isStopped()) return;
      const latest = this.#store.snapshot();
      const latestStep = latest.plan?.steps[0];
      if (
        latest.activeOperation !== null ||
        latestStep === undefined ||
        !sameOperation(latestStep.operation, operation) ||
        latestStep.expectedOutcome !== step.expectedOutcome
      ) {
        await reportPlanNotConfirmed();
        this.#requestReplan(
          "persisted plan changed before operation dispatch",
          generation,
        );
        return;
      }
      const startedAt = new Date().toISOString();
      const operationId = randomUUID();
      const activeOperation = {
        operationId,
        operation,
        expectedOutcome: step.expectedOutcome,
        purpose: latest.plan?.purpose ?? null,
        preActionObservation: bodyObservationEvidence(beforeObservation),
        bodyStartedAt: startedAt,
      } as const;
      try {
        this.#store.save({ activeOperation });
      } catch (error) {
        // A save may throw after committing. Never dispatch or retry until
        // reopen/stop resolves the durable active marker.
        this.#outcomePersistenceBlocked = true;
        this.#logError(error, "Body operation marker could not be persisted");
        await reportPlanNotConfirmed();
        return;
      }
      const controller = new AbortController();
      const run: ActiveBodyRun = {
        operationId,
        operation,
        startedAt,
        controller,
        promise: this.#body.execute(operation, controller.signal),
      };
      this.#activeBody = run;
      let result: PlayerOperationResult;
      let evidenceSource: CompanionOutcomeEvidenceSource = "body_result";
      try {
        result = await run.promise;
      } catch {
        result = failedBodyResult(operation, operationId);
        evidenceSource = "runtime_exception";
      } finally {
        if (this.#activeBody === run) this.#activeBody = undefined;
      }
      let outcome = outcomeFromResult(
        result,
        step.operation,
        operationId,
        step.expectedOutcome,
        activeOperation.purpose,
        evidenceSource,
        activeOperation.preActionObservation,
      );
      const waterTrigger = this.#waterRecoveryTrigger;
      const interruptedCollection =
        operation.kind === "collect_item" &&
        waterTrigger?.interruptedOperationId === operationId;
      const waterRecoveryControl =
        damageReflex &&
        this.#waterRecoveryAttempted &&
        operation.kind === "control" &&
        operation.controls.jump === true &&
        sameOperation(result.operation, operation);
      if (interruptedCollection) {
        outcome = {
          ...outcome,
          summary: `water_recovery:acquisition_interrupted; trigger=inWater:true,oxygen:${waterTrigger.oxygen}; requested collection remains unmet.`,
        };
      } else if (waterRecoveryControl && waterTrigger !== undefined) {
        const category = classifyWaterRecoveryResult(result);
        outcome = {
          ...outcome,
          status:
            result.status === "interrupted" ? result.status : "unverified",
          summary: waterRecoverySummary(category, waterTrigger.oxygen),
        };
      }
      let updated: CompanionSnapshot;
      try {
        updated = this.#store.recordOutcome(outcome);
      } catch (error) {
        // recordOutcome may report failure after its transaction committed.
        // Do not retry the current plan until stop/restart resolves that state.
        this.#outcomePersistenceBlocked = true;
        this.#logError(error, "Body outcome could not be persisted");
        await reportPlanNotConfirmed();
        return;
      }
      if (waterRecoveryControl && this.#waterRecoveryTrigger === waterTrigger)
        this.#waterRecoveryTrigger = undefined;
      if (
        !this.#isCurrent(generation) ||
        updated.stopped ||
        this.#runtimeStopLatched
      )
        return;
      this.#rememberChestObservations(result);
      this.#rememberChestContents(operation, result);
      this.#rememberBedObservations(result);
      if (updated.activeOperation !== null) {
        await reportPlanNotConfirmed();
        this.#scheduleRetry({
          reason: "Body outcome did not match the persisted active operation",
        });
        return;
      }
      if (outcome.status !== "successful") {
        await reportPlanNotConfirmed();
        this.#scheduleRetry({ reason: "Body outcome was not confirmed" });
        return;
      }

      let freshObservation: PlayerBodyObservation;
      try {
        freshObservation = await this.#body.observe({
          ownerPositionException: true,
        });
      } catch (error) {
        this.#logError(error, "Fresh Body observation failed");
        await reportPlanNotConfirmed();
        this.#scheduleRetry({
          reason: "fresh observation after Body action failed",
        });
        return;
      }
      if (!this.#isCurrent(generation) || this.#isStopped()) return;
      this.#refreshWaterRecoveryLatch(freshObservation);
      this.#rememberVisibleBeds(freshObservation);
      const nextStep = updated.plan?.steps[0];
      const damageReflexAttackTargetId =
        damageReflex &&
        updated.plan?.purpose === damageReflexPlanPurpose &&
        operation.kind === "equip" &&
        operation.destination === "hand" &&
        updated.plan.steps.length === 1 &&
        nextStep?.operation.kind === "attack"
          ? nextStep.operation.entityId
          : undefined;
      const canContinue =
        result.after !== null &&
        (damageReflexAttackTargetId !== undefined
          ? canContinueDamageReflexRetaliation(
              result.after,
              freshObservation,
              damageReflexAttackTargetId,
              this.#ownerUsername,
            )
          : canContinuePlan(
              result.after,
              freshObservation,
              nextStep?.operation,
            ));
      if (result.after === null || result.sameLife !== true || !canContinue) {
        this.#store.save({ plan: null });
        await reportPlanNotConfirmed();
        this.#scheduleRetry({
          reason: "Body result or next-step prerequisites changed",
        });
        return;
      }
      const next = updated.plan?.steps[0];
      if (next === undefined) {
        if (!this.#maintenanceActionInFlight)
          this.#setWakeTimer(this.#waitFromSnapshot(updated), {
            reason: "current companion plan completed with observed outcomes",
          });
        await onPlanConfirmed?.(freshObservation, result);
        return;
      }
      beforeObservation = freshObservation;
    }
  }

  #onBodyEvent(event: PlayerBodyEvent): void {
    if (this.#disposed || !this.#started) return;
    if (event.type === "bot_damaged") {
      if (
        this.#waterRecoveryActive ||
        this.#activeBody?.operation.kind === "attack" ||
        this.#damageReflexPending ||
        this.#pendingWake?.ownerMessage !== undefined ||
        this.#pendingWake?.mode === "follow_owner" ||
        this.#isStopped()
      )
        return;
      this.#damagedCollectionCandidate = undefined;
      if (this.#activeOwnerReplyGeneration === this.#generation) {
        this.#ownerReplyInterruptedByDamage = true;
        if (this.#activeOwnerReplySequence !== undefined)
          this.#recordReplyInterruption(
            this.#activeOwnerReplySequence,
            "damage_response",
          );
      }
      try {
        const snapshot = this.#store.snapshot();
        const activeBody = this.#activeBody;
        if (activeBody?.operation.kind === "collect_item")
          this.#damagedCollectionCandidate = {
            operationId: activeBody.operationId,
            entityId: activeBody.operation.entityId,
          };
        this.#damageReflexContext = {
          goalTitle: snapshot.goal?.title ?? null,
          goalSuccessCondition: snapshot.goal?.successCondition ?? null,
          planPurpose: snapshot.plan?.purpose ?? null,
        };
      } catch {
        this.#damageReflexContext = undefined;
      }
      this.#damageReflexPending = true;
      this.#fireWake({
        reason: "damage received; react from a fresh Body observation",
        mode: "damage_reflex",
      });
      return;
    }
    if (
      event.type === "state_changed" &&
      event.reason === "vitals" &&
      this.#activeBody?.operation.kind === "collect_item"
    ) {
      void this.#inspectWaterRecoveryDuringCollection(this.#activeBody);
      return;
    }
    if (event.type === "bot_death") {
      this.#waterRecoveryLifeEpoch += 1;
      this.#waterRecoveryDryCandidate = undefined;
    }
    if (
      event.type === "bot_death" ||
      event.type === "bot_death_cause_updated"
    ) {
      this.#equipmentSweepCooldown = undefined;
      this.#fireWake({ reason: `urgent Body event: ${event.type}` });
      return;
    }
    if (event.type === "disconnected") {
      this.#waterRecoveryDryCandidate = undefined;
      this.#equipmentSweepCooldown = undefined;
      if (this.#activeBody?.operation.kind === "follow_owner") {
        this.#ownerFollowRequested = false;
        this.#activeBody.controller.abort(
          new Error("Minecraft disconnected during owner follow"),
        );
        return;
      }
      this.#fireWake({ reason: "Body disconnected; recheck after reconnect" });
      return;
    }
    if (event.type === "reconnected") {
      this.#equipmentSweepCooldown = undefined;
      this.#fireWake({ reason: "Body reconnected; observe before acting" });
      return;
    }
    if (
      event.type !== "state_changed" ||
      event.reason === "time" ||
      this.#activeBody !== undefined ||
      this.#worldChangeTimer !== undefined
    )
      return;
    if (this.#activeDecision !== undefined) {
      this.#worldChangedDuringDecision = true;
      return;
    }
    this.#worldChangeTimer = setTimeout(() => {
      this.#worldChangeTimer = undefined;
      this.#fireWake({ reason: `world changed: ${event.reason}` });
    }, worldChangeCoalesceMs);
    this.#worldChangeTimer.unref();
  }

  async #inspectWaterRecoveryDuringCollection(
    run: ActiveBodyRun,
  ): Promise<void> {
    const now = Date.now();
    const ownerWakePending = (): boolean =>
      this.#pendingOwnerRequest !== undefined ||
      this.#pendingWake?.ownerMessage !== undefined ||
      this.#pendingWake?.mode === "follow_owner" ||
      this.#pendingWake?.mode === "equipment_upkeep" ||
      this.#ownerFollowRequested;
    if (
      run.operation.kind !== "collect_item" ||
      this.#waterRiskObservationInFlight ||
      now - this.#lastWaterRiskObservedAt < waterRiskObservationCooldownMs ||
      this.#waterRecoveryActive ||
      this.#waterRecoveryAttempted ||
      this.#damageReflexPending ||
      ownerWakePending() ||
      this.#isStopped()
    )
      return;

    this.#lastWaterRiskObservedAt = now;
    this.#waterRiskObservationInFlight = true;
    const generation = this.#generation;
    try {
      const observation = await this.#body.observe({
        ownerPositionException: true,
      });
      if (
        !this.#isCurrent(generation) ||
        this.#activeBody !== run ||
        this.#isStopped()
      )
        return;
      if (ownerWakePending()) return;
      const snapshot = this.#store.snapshot();
      this.#refreshWaterRecoveryLatch(observation);
      const oxygen = observation.self.oxygen;
      if (observation.self.inWater !== true || oxygen === null || oxygen > 5)
        return;

      this.#waterRecoveryTrigger = {
        oxygen,
        interruptedOperationId: run.operationId,
      };
      this.#waterRecoveryTargetBlock = {
        entityId: run.operation.entityId,
        dimension: observation.dimension,
      };
      this.#damageReflexContext = {
        goalTitle: snapshot.goal?.title ?? null,
        goalSuccessCondition: snapshot.goal?.successCondition ?? null,
        planPurpose: snapshot.plan?.purpose ?? null,
      };
      this.#damagedCollectionCandidate = undefined;
      if (this.#activeOwnerReplyGeneration === generation) {
        this.#ownerReplyInterruptedByDamage = true;
        if (this.#activeOwnerReplySequence !== undefined)
          this.#recordReplyInterruption(
            this.#activeOwnerReplySequence,
            "damage_response",
          );
      }
      this.#damageReflexPending = true;
      this.#fireWake({
        reason:
          "known low oxygen in water interrupted item collection; recover from fresh Body observation",
        mode: "damage_reflex",
      });
    } catch {
      // Unknown observations never interrupt an active collection.
    } finally {
      this.#waterRiskObservationInFlight = false;
    }
  }

  #requestReplan(reason: string, generation: number): void {
    if (!this.#isCurrent(generation)) return;
    this.#store.save({ plan: null });
    this.#scheduleRetry({ reason });
  }

  #damageReflexDecision(
    snapshot: CompanionSnapshot,
    observation: PlayerBodyObservation,
  ): CompanionDecision {
    const oxygen = observation.self.oxygen;
    const lowOxygenWater =
      observation.self.inWater === true && oxygen !== null && oxygen <= 5;
    if (lowOxygenWater) {
      if (this.#waterRecoveryAttempted) {
        this.#damagedCollectionCandidate = undefined;
        return {
          speech: null,
          goal: snapshot.goal,
          plan: null,
          memoryUpdates: [],
          relationshipSummary: null,
          waitMs: Math.max(minimumWaitMs, this.#minWaitMs),
          knowledgeQuery: null,
        };
      }
      this.#waterRecoveryActive = true;
      this.#waterRecoveryAttempted = true;
      const damagedCollection = this.#damagedCollectionCandidate;
      this.#damagedCollectionCandidate = undefined;
      if (damagedCollection !== undefined) {
        this.#waterRecoveryTrigger = {
          oxygen,
          interruptedOperationId: damagedCollection.operationId,
        };
        this.#waterRecoveryTargetBlock = {
          entityId: damagedCollection.entityId,
          dimension: observation.dimension,
        };
      } else if (this.#waterRecoveryTrigger === undefined) {
        this.#waterRecoveryTrigger = { oxygen };
      }
      const context = this.#damageReflexContext;
      const memoryContent = context
        ? waterRecoveryMemoryContent(context)
        : null;
      return {
        speech: null,
        goal: snapshot.goal,
        plan: {
          purpose: waterRecoveryPlanPurpose,
          steps: [
            {
              operation: {
                kind: "control",
                controls: { jump: true },
                ticks: 40,
              },
              expectedOutcome:
                "Finish a bounded 40 physics-tick jump input only; this does not establish surfacing. Use fresh observation and treat continued water or low oxygen as unresolved.",
            },
          ],
        },
        memoryUpdates:
          memoryContent === null
            ? []
            : [
                {
                  kind: "episode",
                  content: memoryContent,
                  importance: 4,
                  ownerQuote: null,
                },
              ],
        relationshipSummary: null,
        waitMs: Math.max(minimumWaitMs, this.#minWaitMs),
        knowledgeQuery: null,
      };
    }
    this.#damagedCollectionCandidate = undefined;
    if (
      !this.#waterRecoveryAttempted &&
      this.#waterRecoveryTrigger?.interruptedOperationId !== undefined
    )
      this.#waterRecoveryTrigger = undefined;
    const target = (observation.perception.nearbyHostiles?.entities ?? [])
      .filter(
        (entity) =>
          !entity.isPlayer &&
          entity.kind !== "player" &&
          !sameMinecraftIdentity(
            entity.username ?? entity.name,
            this.#ownerUsername,
          ) &&
          Number.isFinite(entity.distance) &&
          entity.distance <= damageReflexAttackRange,
      )
      .sort((left, right) => left.distance - right.distance)[0];
    const weaponUpgrade =
      target === undefined ? null : findRetaliationWeaponUpgrade(observation);
    const steps: DamageReflexPlanStep[] = [];
    if (weaponUpgrade !== null) {
      steps.push({
        operation: {
          kind: "equip",
          item: weaponUpgrade.item.name,
          destination: "hand",
        },
        expectedOutcome:
          "Equip and observe the best available owned melee weapon before retaliation.",
      });
    }
    const operation: DamageReflexPlanStep["operation"] =
      target === undefined
        ? { kind: "look_sweep" }
        : { kind: "attack", entityId: target.id };
    steps.push({
      operation,
      expectedOutcome:
        target === undefined
          ? "Complete one bounded look sweep; consider threats on a later wake."
          : "Attempt one nearby hostile attack and rely on Body for confirmation.",
    });
    return {
      speech: null,
      goal: snapshot.goal,
      plan: {
        purpose: damageReflexPlanPurpose,
        steps,
      },
      memoryUpdates: [],
      relationshipSummary: null,
      waitMs: Math.max(minimumWaitMs, this.#minWaitMs),
      knowledgeQuery: null,
    };
  }

  #scheduleRetry(wake: PendingWake): void {
    if (this.#maintenanceActionInFlight) return;
    this.#failureCount += 1;
    const delay = Math.min(
      maximumRetryMs,
      defaultRetryMs * 2 ** Math.min(this.#failureCount - 1, 6),
    );
    this.#setWakeTimer(delay, wake);
  }

  #setWakeTimer(delayMs: number, wake: PendingWake): void {
    if (this.#disposed || this.#isStopped()) return;
    if (this.#waitTimer !== undefined) clearTimeout(this.#waitTimer);
    const delay = Math.max(this.#minWaitMs, Math.min(maximumWaitMs, delayMs));
    this.#wakeAt = new Date(Date.now() + delay).toISOString();
    this.#wakeReason = wake.reason;
    this.#waitTimer = setTimeout(() => {
      this.#waitTimer = undefined;
      this.#wakeAt = null;
      this.#wakeReason = null;
      this.#fireWake(wake);
    }, delay);
    this.#waitTimer.unref();
  }

  #waitFromSnapshot(snapshot: CompanionSnapshot): number {
    if (snapshot.waitUntil === null) return this.#minWaitMs;
    const remaining = Date.parse(snapshot.waitUntil) - Date.now();
    return Number.isFinite(remaining)
      ? Math.max(this.#minWaitMs, remaining)
      : this.#minWaitMs;
  }

  #didWorldChangeDuringDecision(): boolean {
    return this.#worldChangedDuringDecision;
  }

  #clampWaitMs(waitMs: number): number {
    return Math.max(
      this.#minWaitMs,
      Math.min(maximumWaitMs, Math.trunc(waitMs)),
    );
  }

  #isCurrent(generation: number): boolean {
    return !this.#disposed && generation === this.#generation;
  }

  #isBodyDispatchAllowed(generation: number): boolean {
    return (
      !this.#outcomePersistenceBlocked &&
      this.#isCurrent(generation) &&
      !this.#isStopped()
    );
  }

  #finishOwnerReply(generation: number): void {
    if (this.#activeOwnerReplyGeneration === generation)
      this.#activeOwnerReplyGeneration = undefined;
  }

  #hasActiveBodyRun(): boolean {
    return this.#activeBody !== undefined;
  }

  #isStopped(): boolean {
    return this.#runtimeStopLatched || this.#store.snapshot().stopped;
  }

  async #speakDecision(
    text: string,
    generation: number,
    ownerMessageSequence?: number,
    allowAfterResolved = false,
  ): Promise<void> {
    if (ownerMessageSequence !== undefined) {
      await this.#speakOwnerReply(
        text,
        ownerMessageSequence,
        () => this.#isCurrent(generation),
        allowAfterResolved,
      );
      return;
    }
    if (!this.#isCurrent(generation) || this.#isStopped()) return;
    try {
      await this.#say(text);
      if (this.#isCurrent(generation) && !this.#isStopped())
        this.#store.recordMessage("companion", text);
    } catch (error) {
      this.#logError(error, "Companion speech delivery failed");
    }
  }

  async #speakOwnerReply(
    text: string,
    ownerMessageSequence: number,
    isCurrent: () => boolean,
    allowAfterResolved = false,
  ): Promise<void> {
    if (!isCurrent() || this.#isStopped()) return;
    const latest = this.#store
      .replyLifecycleFor(ownerMessageSequence)
      ?.events.at(-1)?.state;
    if (
      latest === "send_started" ||
      latest === "send_unknown" ||
      latest === "durable_stop" ||
      (latest === "send_call_resolved" && !allowAfterResolved)
    )
      return;
    if (
      !this.#tryRecordReplyLifecycleEvent(ownerMessageSequence, "send_started")
    )
      return;
    try {
      await this.#say(text);
    } catch (error) {
      this.#logError(error, "Companion speech delivery failed");
      if (!this.#isStopped())
        this.#tryRecordReplyLifecycleEvent(
          ownerMessageSequence,
          "send_unknown",
          "say_call_rejected",
        );
      return;
    }
    // say resolving confirms only that the call returned. It does not prove
    // that the owner saw the message in the Minecraft client.
    if (this.#isStopped()) return;
    if (
      !this.#tryRecordReplyLifecycleEvent(
        ownerMessageSequence,
        "send_call_resolved",
      )
    )
      return;
    try {
      this.#store.recordMessage("companion", text);
    } catch (error) {
      this.#logError(error, "Companion reply could not be journaled");
    }
  }

  async #speakReplyStatus(text: string, generation: number): Promise<void> {
    if (!this.#isCurrent(generation) || this.#isStopped()) return;
    try {
      await this.#say(text);
      if (this.#isCurrent(generation) && !this.#isStopped())
        this.#store.recordMessage("companion", text);
    } catch (error) {
      this.#logError(error, "Reply status speech delivery failed");
    }
  }

  async #speakControlMessage(text: string): Promise<void> {
    try {
      await this.#say(text);
      this.#store.recordMessage("companion", text);
    } catch (error) {
      this.#logError(error, "Control message delivery failed");
    }
  }

  #logError(error: unknown, message: string): void {
    const code = runtimeErrorCode(message);
    this.#recentErrors.unshift({ code, at: new Date().toISOString() });
    this.#recentErrors = this.#recentErrors.slice(0, 5);
    this.#logger?.error(
      {
        errorType: error instanceof Error ? error.name : "UnknownError",
      },
      message,
    );
  }

  #rememberVisibleChests(
    observation: PlayerBodyObservation | null | undefined,
  ): void {
    if (!observation) return;
    const recorded = new Set<string>();
    for (const block of observation.perception.blocks) {
      if (!isChestBlockName(block.name)) continue;
      const position = {
        x: Math.floor(block.position.x),
        y: Math.floor(block.position.y),
        z: Math.floor(block.position.z),
      };
      const key = JSON.stringify([
        observation.dimension,
        ...Object.values(position),
      ]);
      if (recorded.has(key)) continue;
      recorded.add(key);
      this.#rememberChest({
        dimension: observation.dimension,
        position,
        observedAt: observation.observedAt,
      });
    }
  }

  #rememberVisibleBeds(
    observation: PlayerBodyObservation | null | undefined,
  ): void {
    if (!observation) return;
    const recorded = new Set<string>();
    for (const block of observation.perception.blocks) {
      if (!isBedBlockName(block.name)) continue;
      const position = {
        x: Math.floor(block.position.x),
        y: Math.floor(block.position.y),
        z: Math.floor(block.position.z),
      };
      const key = JSON.stringify([
        observation.dimension,
        position.x,
        position.y,
        position.z,
      ]);
      if (recorded.has(key)) continue;
      recorded.add(key);
      this.#rememberBed({
        dimension: observation.dimension,
        position,
        observedAt: observation.observedAt,
      });
    }
  }

  #rememberChestObservations(result: PlayerOperationResult): void {
    this.#rememberVisibleChests(result.before);
    this.#rememberVisibleChests(result.after);
    const sweep = result.lookSweep;
    if (sweep === undefined) return;
    for (const view of [sweep.current, ...sweep.directions]) {
      for (const block of view.visibleBlocks) {
        if (!isChestBlockName(block.name)) continue;
        this.#rememberChest({
          dimension: view.dimension,
          position: {
            x: Math.floor(block.position.x),
            y: Math.floor(block.position.y),
            z: Math.floor(block.position.z),
          },
          observedAt: result.completedAt,
        });
      }
    }
  }

  #rememberBedObservations(result: PlayerOperationResult): void {
    this.#rememberVisibleBeds(result.before);
    this.#rememberVisibleBeds(result.after);
    const sweep = result.lookSweep;
    if (sweep === undefined) return;
    for (const view of [sweep.current, ...sweep.directions]) {
      for (const block of view.visibleBlocks) {
        if (!isBedBlockName(block.name)) continue;
        this.#rememberBed({
          dimension: view.dimension,
          position: {
            x: Math.floor(block.position.x),
            y: Math.floor(block.position.y),
            z: Math.floor(block.position.z),
          },
          observedAt: result.completedAt,
        });
      }
    }
  }

  #rememberChestContents(
    operation: PlayerOperation,
    result: PlayerOperationResult,
  ): void {
    const before = result.before;
    const after = result.after;
    if (
      operation.kind !== "open_window" ||
      operation.target.kind !== "block" ||
      !sameOperation(operation, result.operation) ||
      result.status !== "successful" ||
      result.sameLife !== true ||
      !before ||
      !after
    )
      return;
    if (before.dimension !== after.dimension) return;
    const targetPosition = operation.target.position;
    const targetBlock = before.perception.blocks.find(
      (block) =>
        isChestBlockName(block.name) &&
        sameBlockAtPosition(block, targetPosition),
    );
    const window = after.window;
    if (
      targetBlock === undefined ||
      !isChestEquipmentWindow(window) ||
      !Number.isSafeInteger(window.inventoryStart) ||
      window.inventoryStart < 0 ||
      window.inventoryStart > window.slots.length
    )
      return;
    const contents = window.slots
      .slice(0, window.inventoryStart)
      .flatMap((item, slot) =>
        item === null ? [] : [{ slot, name: item.name, count: item.count }],
      );
    this.#rememberChest({
      dimension: before.dimension,
      position: {
        x: Math.floor(targetPosition.x),
        y: Math.floor(targetPosition.y),
        z: Math.floor(targetPosition.z),
      },
      observedAt: after.observedAt,
      contents,
    });
  }

  #rememberChest(input: {
    readonly dimension: string;
    readonly position: {
      readonly x: number;
      readonly y: number;
      readonly z: number;
    };
    readonly observedAt: string;
    readonly contents?: readonly {
      readonly slot: number;
      readonly name: string;
      readonly count: number;
    }[];
  }): void {
    try {
      this.#store.rememberObservedChest(input);
    } catch (error) {
      this.#logError(error, "Observed chest memory could not be saved");
    }
  }

  #rememberBed(input: {
    readonly dimension: string;
    readonly position: {
      readonly x: number;
      readonly y: number;
      readonly z: number;
    };
    readonly observedAt: string;
  }): void {
    try {
      this.#store.rememberObservedBedLocation(input);
    } catch (error) {
      this.#logError(error, "Observed bed location could not be saved");
    }
  }

  #clearTimers(preserveWaitTimer = false): void {
    if (!preserveWaitTimer && this.#waitTimer !== undefined)
      clearTimeout(this.#waitTimer);
    if (this.#worldChangeTimer !== undefined)
      clearTimeout(this.#worldChangeTimer);
    if (!preserveWaitTimer) this.#waitTimer = undefined;
    this.#worldChangeTimer = undefined;
    if (!preserveWaitTimer) {
      this.#wakeAt = null;
      this.#wakeReason = null;
    }
  }
}

function waterRecoveryMemoryContent(
  context: DamageReflexContext,
): string | null {
  const bounded = (value: string | null, maximum: number): string => {
    if (value === null) return "未記録";
    return value.trim().slice(0, maximum) || "未記録";
  };
  const content = `Body観測で水中・酸素5以下を確認し、40tickのjump入力を試行。surface達成は再観測まで未確認。中断直前の保存goal title=${bounded(context.goalTitle, 56)}; success=${bounded(context.goalSuccessCondition, 44)}; plan.purpose=${bounded(context.planPurpose, 92)}。水に入った当初の理由は未記録。`;
  return content.length <= 320 ? content : content.slice(0, 320);
}

function outcomeFromResult(
  result: PlayerOperationResult,
  plannedOperation: PlayerOperation,
  operationId: string,
  expectedOutcome: string,
  purpose: string | null,
  evidenceSource: CompanionOutcomeEvidenceSource,
  preActionObservation: CompanionBodyObservationEvidence | null,
): CompanionOutcomeInput {
  const operationMatches = sameOperation(result.operation, plannedOperation);
  const candidateReason =
    result.failureReason?.code ??
    result.itemCollectionPathFailureReason ??
    result.itemCollectionOutcome ??
    result.status;
  const reasonCode: CompanionOutcomeReasonCode | null = !operationMatches
    ? "operation_mismatch"
    : result.recoveryRequired
      ? "recovery_required"
      : outcomeReasonCodeSet.has(candidateReason)
        ? (candidateReason as CompanionOutcomeReasonCode)
        : null;
  return {
    // Body has an internal UUID; the runtime marker is the durable correlation ID.
    operationId,
    operation: plannedOperation,
    status: operationMatches ? result.status : "failed",
    summary:
      operationMatches && result.status === "successful"
        ? "Body observed the requested world effect."
        : operationMatches
          ? `Body did not confirm the requested world effect (${result.status}).`
          : "Body returned a result for a different operation.",
    expectedOutcome,
    observedAt: result.completedAt,
    purpose,
    preActionObservation:
      preActionObservation ?? unknownBodyObservationEvidence(),
    bodyEvidence: {
      source: evidenceSource,
      startedAt: result.startedAt,
      completedAt: result.completedAt,
      sameLife: result.sameLife ?? null,
      recoveryRequired: result.recoveryRequired,
      reasonCode,
      before: bodyObservationEvidence(result.before),
      after: bodyObservationEvidence(result.after),
    },
  };
}

function bodyObservationEvidence(
  observation: PlayerBodyObservation | null,
): CompanionBodyObservationEvidence {
  if (observation === null) return unknownBodyObservationEvidence();
  const boundedNumber = (value: number): number | null =>
    Number.isFinite(value) ? value : null;
  const x = boundedNumber(observation.self.position.x);
  const y = boundedNumber(observation.self.position.y);
  const z = boundedNumber(observation.self.position.z);
  const dimension = observation.dimension.trim();
  return {
    source: observation.source,
    observedAt: observation.observedAt,
    dimension:
      dimension.length > 0 && dimension.length <= 128 ? dimension : null,
    position: x === null || y === null || z === null ? null : { x, y, z },
    yaw: boundedNumber(observation.self.yaw),
    pitch: boundedNumber(observation.self.pitch),
    health:
      observation.self.health === null
        ? null
        : boundedNumber(observation.self.health),
    food:
      observation.self.food === null
        ? null
        : boundedNumber(observation.self.food),
    oxygen:
      observation.self.oxygen === null
        ? null
        : boundedNumber(observation.self.oxygen),
    inWater: observation.self.inWater,
    inLava: observation.self.inLava,
    onFire: observation.self.onFire,
    suffocating: observation.self.suffocating,
    sleeping: observation.self.sleeping,
  };
}

function unknownBodyObservationEvidence(): CompanionBodyObservationEvidence {
  return {
    source: "unknown",
    observedAt: null,
    dimension: null,
    position: null,
    yaw: null,
    pitch: null,
    health: null,
    food: null,
    oxygen: null,
    inWater: null,
    inLava: null,
    onFire: null,
    suffocating: null,
    sleeping: null,
  };
}

function automaticPickupFingerprint(
  dimension: string,
  entityId: number,
  itemName: string,
  count: number,
): string {
  return JSON.stringify([dimension, entityId, itemName, count]);
}

function isOwnerEquipmentCommand(message: string): boolean {
  return /^(?:(?:自分で)?装備を(?:探して|整えて|見直して|確認して)|装備を自分で(?:探して|整えて|見直して)|(?:防具|武器)を(?:探して|整えて)|装備して|gear up|find gear|equip yourself)[。！!]*$/iu.test(
    message.trim(),
  );
}

function isSafeForEquipmentUpkeep(observation: PlayerBodyObservation): boolean {
  return (
    observation.self.health !== null &&
    observation.self.health > 0 &&
    observation.self.inLava !== true &&
    observation.self.onFire !== true &&
    observation.self.suffocating !== true &&
    !observation.self.sleeping
  );
}

function canUseRottenFleshLastResort(
  observation: PlayerBodyObservation,
): boolean {
  return (
    observation.self.food !== null &&
    observation.self.food <= 6 &&
    isSafeForEquipmentUpkeep(observation) &&
    observation.window === null &&
    observation.self.inWater !== true &&
    !(observation.self.oxygen !== null && observation.self.oxygen <= 5)
  );
}

function rottenFleshLastResortReason(
  observation: PlayerBodyObservation,
  ordinaryDropCandidates: number,
  visibleChestCandidates: number,
  attemptedDropCandidates: number,
  attemptedChestCandidates: number,
): string {
  const truncated =
    observation.perception.candidateSearchMayBeTruncated ||
    observation.perception.nearbyDroppedItems?.candidateSearchMayBeTruncated ===
      true;
  return [
    "Use only held rotten_flesh as a bounded ordinary-food search last resort",
    `food=${observation.self.food}; health=${observation.self.health}`,
    `inWater=${observation.self.inWater}; oxygen=${observation.self.oxygen}; inLava=${observation.self.inLava}; onFire=${observation.self.onFire}; suffocating=${observation.self.suffocating}`,
    `visibleOrdinaryDrops=${ordinaryDropCandidates}; visibleChests=${visibleChestCandidates}; attemptedDrops=${attemptedDropCandidates}; attemptedChests=${attemptedChestCandidates}; truncated=${truncated}`,
    "This bounded visible observation does not establish world-wide ordinary-food absence.",
  ].join("; ");
}

function visibleEquipmentChests(
  observation: PlayerBodyObservation,
): BodyVisibleBlock[] {
  return observation.perception.blocks
    .filter(
      (block) =>
        /(?:^|:)(?:trapped_)?chest$/u.test(block.name) &&
        Number.isFinite(block.distance) &&
        block.distance <= equipmentSearchRange,
    )
    .sort((left, right) => left.distance - right.distance);
}

function equipmentSweepChestCandidates(
  sweep: PlayerOperationResult["lookSweep"],
  dimension: string,
): EquipmentSweepChestCandidate[] {
  if (sweep?.complete !== true) return [];
  const candidates = new Map<string, EquipmentSweepChestCandidate>();
  for (const view of [sweep.current, ...sweep.directions]) {
    if (view.dimension !== dimension) continue;
    for (const block of view.visibleBlocks) {
      if (
        !isChestBlockName(block.name) ||
        !Number.isFinite(block.distance) ||
        block.distance > equipmentSearchRange
      )
        continue;
      const candidate: EquipmentSweepChestCandidate = {
        name: block.name,
        position: { ...block.position, dimension: view.dimension },
        distance: block.distance,
      };
      const key = equipmentChestFingerprint(dimension, candidate);
      const previous = candidates.get(key);
      if (previous === undefined || candidate.distance < previous.distance)
        candidates.set(key, candidate);
    }
  }
  return [...candidates.values()].sort(
    (left, right) => left.distance - right.distance,
  );
}

function equipmentSearchGapFingerprint(
  observation: PlayerBodyObservation,
): string | null {
  const armorGaps = (["head", "torso", "legs", "feet"] as const).filter(
    (destination) => {
      const item = observation.self.equipment[destination];
      return item === null || item?.durability === 0;
    },
  );
  const hand = observation.self.equipment.hand;
  const handNeedsWeapon =
    (hand === null ||
      hand === undefined ||
      (hand.durability === 0 &&
        equipmentDestinationForName(hand.name) === "hand")) &&
    findRetaliationWeaponUpgrade(observation) === null;
  const gaps = [...armorGaps, ...(handNeedsWeapon ? ["hand"] : [])];
  if (gaps.length === 0) return null;
  const position = observation.self.position;
  return JSON.stringify([
    observation.dimension,
    Math.floor(position.x),
    Math.floor(position.y),
    Math.floor(position.z),
    gaps,
  ]);
}

function isChestBlockName(name: string): boolean {
  return /(?:^|:)(?:trapped_)?chest$/u.test(name);
}

function isBedBlockName(name: string): boolean {
  return /(?:^|:)[a-z0-9_]+_bed$/iu.test(name);
}

function sameBlockAtPosition(
  block: BodyVisibleBlock,
  position: { readonly x: number; readonly y: number; readonly z: number },
): boolean {
  return (
    Math.floor(block.position.x) === Math.floor(position.x) &&
    Math.floor(block.position.y) === Math.floor(position.y) &&
    Math.floor(block.position.z) === Math.floor(position.z)
  );
}

function visibleDroppedItems(
  observation: PlayerBodyObservation,
): readonly BodyVisibleEntity[] {
  return (
    observation.perception.nearbyDroppedItems?.entities ??
    observation.perception.entities.filter(
      (entity) => entity.droppedItem !== undefined,
    )
  );
}

function equipmentDropCandidates(
  observation: PlayerBodyObservation,
): BodyVisibleEntity[] {
  const maxDistance =
    observation.perception.nearbyDroppedItems?.maxDistance ??
    observation.perception.maxDistance;
  return visibleDroppedItems(observation)
    .filter(
      (entity) =>
        entity.droppedItem?.count === 1 &&
        equipmentDestinationForName(entity.droppedItem.name) !== undefined &&
        Number.isFinite(entity.distance) &&
        entity.distance <= maxDistance,
    )
    .sort((left, right) => left.distance - right.distance);
}

function sameBlockPosition(
  left: Pick<BodyVisibleBlock, "position">,
  right: Pick<BodyVisibleBlock, "position">,
): boolean {
  return (
    Math.floor(left.position.x) === Math.floor(right.position.x) &&
    Math.floor(left.position.y) === Math.floor(right.position.y) &&
    Math.floor(left.position.z) === Math.floor(right.position.z)
  );
}

function inventoryCount(
  observation: PlayerBodyObservation,
  name: string,
): number {
  return observation.self.inventory
    .filter((item) => item.slot >= 9 && item.slot < 45 && item.name === name)
    .reduce((total, item) => total + item.count, 0);
}

function foodAttemptFingerprint(
  observation: PlayerBodyObservation,
  items: readonly BodyItemStack[],
): string {
  const visibleFoods = visibleDroppedItems(observation)
    .flatMap((entity) =>
      entity.droppedItem === undefined
        ? []
        : [[entity.id, entity.droppedItem.name, entity.droppedItem.count]],
    )
    .sort(([leftId], [rightId]) => Number(leftId) - Number(rightId));
  const visibleChests = visibleEquipmentChests(observation).map((block) =>
    equipmentChestFingerprint(observation.dimension, block),
  );
  return JSON.stringify([
    observation.self.food,
    items
      .map((item) => [item.name, inventoryCount(observation, item.name)])
      .sort(([left], [right]) => String(left).localeCompare(String(right))),
    visibleFoods,
    visibleChests,
  ]);
}

function equipmentChestFingerprint(
  dimension: string,
  block: Pick<BodyVisibleBlock, "position">,
): string {
  return JSON.stringify([
    dimension,
    Math.floor(block.position.x),
    Math.floor(block.position.y),
    Math.floor(block.position.z),
  ]);
}

function equipmentCandidateFingerprint(
  observation: PlayerBodyObservation,
  candidate: EquipmentUpgradeCandidate,
): string {
  return JSON.stringify([
    candidate.destination,
    candidate.item,
    observation.self.equipment[candidate.destination] ?? null,
  ]);
}

function sameItemQuality(
  left: BodyItemStack | null,
  right: BodyItemStack,
): boolean {
  if (left === null) return false;
  const leftEnchantments = [...left.enchantments]
    .map(({ name, level }) => [name, level] as const)
    .sort(
      ([leftName, leftLevel], [rightName, rightLevel]) =>
        leftName.localeCompare(rightName) || leftLevel - rightLevel,
    );
  const rightEnchantments = [...right.enchantments]
    .map(({ name, level }) => [name, level] as const)
    .sort(
      ([leftName, leftLevel], [rightName, rightLevel]) =>
        leftName.localeCompare(rightName) || leftLevel - rightLevel,
    );
  return (
    left.itemId === right.itemId &&
    left.name === right.name &&
    left.count === right.count &&
    left.metadata === right.metadata &&
    left.durability === right.durability &&
    left.maxDurability === right.maxDurability &&
    left.customName === right.customName &&
    JSON.stringify(leftEnchantments) === JSON.stringify(rightEnchantments)
  );
}

function sameEquipmentChestWindow(
  before: BodyWindowSnapshot | null,
  after: BodyWindowSnapshot | null,
): boolean {
  return (
    isChestEquipmentWindow(before) &&
    after !== null &&
    before.id === after.id &&
    before.type === after.type &&
    before.inventoryStart === after.inventoryStart &&
    before.inventoryEnd === after.inventoryEnd
  );
}

function hasMatchingInventoryItem(
  observation: PlayerBodyObservation,
  candidate: BodyItemStack,
): boolean {
  return observation.self.inventory.some(
    (item) =>
      item.slot >= 9 &&
      item.slot < 45 &&
      item.name === candidate.name &&
      sameItemQuality(item, candidate),
  );
}

function failedBodyResult(
  operation: PlayerOperation,
  operationId: string,
): PlayerOperationResult {
  const now = new Date().toISOString();
  return {
    operationId,
    operation,
    status: "failed",
    startedAt: now,
    completedAt: now,
    before: null,
    after: null,
    recoveryRequired: false,
    detail: "Body execution failed before an observed result was returned.",
  };
}

function sameOperation(left: PlayerOperation, right: PlayerOperation): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

type WaterRecoveryCategory =
  "dry_observed" | "progress_observed" | "unresolved";

function classifyWaterRecoveryResult(
  result: PlayerOperationResult,
): WaterRecoveryCategory {
  if (result.sameLife !== true) return "unresolved";
  const before = result.before;
  const after = result.after;
  if (after?.self.inWater === false) return "dry_observed";
  if (before?.self.inWater !== true || after?.self.inWater !== true)
    return "unresolved";
  const beforeY = before.self.position.y;
  const afterY = after.self.position.y;
  const verticalProgress =
    Number.isFinite(beforeY) &&
    Number.isFinite(afterY) &&
    afterY > beforeY + 0.15;
  const oxygenProgress =
    before.self.oxygen !== null &&
    after.self.oxygen !== null &&
    after.self.oxygen > before.self.oxygen;
  return verticalProgress || oxygenProgress
    ? "progress_observed"
    : "unresolved";
}

function waterRecoverySummary(
  category: WaterRecoveryCategory,
  triggerOxygen: number,
): string {
  const detail =
    category === "dry_observed"
      ? "Body observed one dry frame; stable escape remains unconfirmed."
      : category === "progress_observed"
        ? "Body observed partial progress while still in water; surfacing remains unconfirmed."
        : "Body did not confirm surfacing or partial progress; recovery remains unresolved.";
  return `water_recovery:${category}; trigger=inWater:true,oxygen:${triggerOxygen}; ${detail}`;
}

function canContinuePlan(
  after: PlayerBodyObservation,
  fresh: PlayerBodyObservation,
  nextOperation: PlayerOperation | undefined,
): boolean {
  if (after.dimension !== fresh.dimension) return false;
  if (
    after.self.health !== null &&
    fresh.self.health !== null &&
    fresh.self.health < after.self.health
  )
    return false;
  if (
    after.self.oxygen !== null &&
    fresh.self.oxygen !== null &&
    fresh.self.oxygen < after.self.oxygen
  )
    return false;
  if (
    (fresh.self.inLava === true && after.self.inLava !== true) ||
    (fresh.self.onFire === true && after.self.onFire !== true) ||
    (fresh.self.suffocating === true && after.self.suffocating !== true)
  )
    return false;
  return (
    nextOperation === undefined ||
    nextOperationTargetIsAvailable(nextOperation, fresh)
  );
}

function canContinueDamageReflexRetaliation(
  after: PlayerBodyObservation,
  fresh: PlayerBodyObservation,
  targetEntityId: number,
  ownerUsername: string,
): boolean {
  if (!canContinuePlan(after, fresh, undefined)) return false;
  const nearbyHostiles = fresh.perception.nearbyHostiles;
  return (
    nearbyHostiles?.source === "client_received_unoccluded_nearby_hostiles" &&
    nearbyHostiles.entities.some(
      (entity) =>
        entity.id === targetEntityId &&
        !entity.isPlayer &&
        entity.kind !== "player" &&
        !sameMinecraftIdentity(entity.username ?? entity.name, ownerUsername) &&
        Number.isFinite(entity.distance) &&
        entity.distance >= 0 &&
        entity.distance <= damageReflexAttackRange,
    )
  );
}

function nextOperationTargetIsAvailable(
  operation: PlayerOperation,
  observation: PlayerBodyObservation,
): boolean {
  const visibleBlockAt = (position: { x: number; y: number; z: number }) =>
    observation.perception.blocks.some(
      (block) =>
        Math.floor(block.position.x) === Math.floor(position.x) &&
        Math.floor(block.position.y) === Math.floor(position.y) &&
        Math.floor(block.position.z) === Math.floor(position.z),
    );
  const visibleEntity = (entityId: number) =>
    observation.perception.entities.some((entity) => entity.id === entityId);
  const nearbyDroppedItem = (entityId: number) => {
    const maxDistance =
      observation.perception.nearbyDroppedItems?.maxDistance ??
      observation.perception.maxDistance;
    const candidates =
      observation.perception.nearbyDroppedItems?.entities ??
      observation.perception.entities;
    return candidates.some(
      (entity) =>
        entity.id === entityId &&
        entity.droppedItem !== undefined &&
        Number.isFinite(entity.distance) &&
        entity.distance <= maxDistance,
    );
  };
  const visibleNamedBlock = (
    position: { x: number; y: number; z: number },
    name: RegExp,
  ) =>
    observation.perception.blocks.some(
      (block) =>
        name.test(block.name) &&
        Math.floor(block.position.x) === Math.floor(position.x) &&
        Math.floor(block.position.y) === Math.floor(position.y) &&
        Math.floor(block.position.z) === Math.floor(position.z),
    );

  switch (operation.kind) {
    case "attack":
    case "mount":
    case "trade":
      return visibleEntity(operation.entityId);
    case "collect_item":
      return (
        nearbyDroppedItem(operation.entityId) ||
        visibleEntity(operation.entityId)
      );
    case "dig":
      return visibleBlockAt(operation.position);
    case "place":
      return observation.perception.placementCandidates.some(
        ({ position }) =>
          Math.floor(position.x) === Math.floor(operation.position.x) &&
          Math.floor(position.y) === Math.floor(operation.position.y) &&
          Math.floor(position.z) === Math.floor(operation.position.z),
      );
    case "use":
    case "open_window": {
      const target = operation.target;
      return target.kind === "entity"
        ? visibleEntity(target.entityId)
        : target.kind === "block"
          ? visibleBlockAt(target.position)
          : true;
    }
    case "sleep":
      return visibleNamedBlock(operation.position, /bed/u);
    case "enchant":
      return visibleNamedBlock(operation.position, /enchanting_table/u);
    case "anvil":
      return visibleNamedBlock(operation.position, /anvil/u);
    case "update_sign":
      return visibleNamedBlock(operation.position, /sign/u);
    case "window_click":
    case "window_transfer":
    case "window_close":
      return observation.window !== null;
    case "move_vehicle":
      return observation.self.mountedEntityId !== null;
    case "dismount":
      return observation.self.mountedEntityId !== null;
    case "wake":
      return observation.self.sleeping;
    default:
      return true;
  }
}

function isReplyStatusQuestion(message: string): boolean {
  const hasReplyTopic = /返事|返答|返信|回答|メッセージ|返して/u.test(message);
  const asksAboutAbsence =
    /(?:来な|こな|届かな|届いていな|返ってこな|返ってきていな|途切れ|未返信|なかった|返事がない|返答がない|返信がない|回答がない|もらえない|くれない)/u.test(
      message,
    );
  const asksAboutDelay = /遅(?:い|かった|れて|れた|れています|れました)/u.test(
    message,
  );
  const asksForReason =
    /[?？]|なぜ|どうして|なんで|理由|原因|教えて|説明して|分かる|わかる/u.test(
      message,
    );
  return hasReplyTopic && (asksAboutAbsence || asksAboutDelay) && asksForReason;
}

function replyStatusAnswer(
  lifecycle: CompanionReplyLifecycle | null,
  originalMessage: CompanionMessage | null,
): string {
  if (lifecycle === null)
    return "返答の記録が見つからず、元の質問の扱いも確認できないよ。理由はまだ分からないよ。返答が必要ならもう一度依頼してね。";
  const questionStatus =
    originalMessage?.role === "owner"
      ? "元の質問は履歴に残っているよ。"
      : "元の質問本文は履歴から見つからず、内容は確認できないよ。";
  const latest = lifecycle.events.at(-1);
  if (latest === undefined)
    return `${questionStatus} 返答処理の記録がなく、理由はまだ分からないよ。`;

  switch (latest.state) {
    case "received":
      return `${questionStatus} 受け取った記録だけがあり、生成開始と送信は確認できないよ。返答が必要ならもう一度依頼してね。`;
    case "generation_started":
      return `${questionStatus} 生成開始の記録はあるけれど、結果と送信は確認できないよ。返答が必要ならもう一度依頼してね。`;
    case "generated":
      return `${questionStatus} 返答生成の完了は記録されているよ。送信開始は確認できず、自動送信はしないよ。返答が必要ならもう一度依頼してね。`;
    case "generation_failed":
      return `${questionStatus} 返答生成の失敗が記録されているよ。詳しい例外は保存しておらず、送信も確認できないよ。自動再生成はせず、返答が必要ならもう一度依頼してね。`;
    case "interrupted":
      switch (latest.reasonCode) {
        case "damage_response":
          return `${questionStatus} ダメージ対応を優先して元の返答を中断した記録があるよ。送信は確認できず、自動再開もしないよ。返答が必要ならもう一度依頼してね。`;
        case "newer_owner_input":
          return `${questionStatus} あなたの新しい呼びかけで元の返答を中断した記録があるよ。送信は確認できず、古い返答を自動再開しないよ。必要ならもう一度依頼してね。`;
        case "process_restart_with_generation_unresolved":
          if (lifecycle.events.at(-2)?.state === "generated")
            return `${questionStatus} 再起動前に返答生成の完了を記録しているよ。送信開始とゲーム内表示は未確認で、再起動の原因も分からないよ。再起動後の状態を確認して、元の質問を考え直すよ。`;
          return `${questionStatus} 生成完了を記録した証跡は残っていないよ。再起動前に完了していたかは未確認で、送信開始とゲーム内表示も確認できないよ。再起動の原因は分からないよ。再起動後の状態を確認して、元の質問を考え直すよ。`;
        default:
          return `${questionStatus} 返答処理を中断した記録があるよ。理由の詳細と送信は確認できず、自動再開もしないよ。必要ならもう一度依頼してね。`;
      }
    case "send_started":
      return `${questionStatus} 送信呼び出しを始めた記録はあるけれど、結果とゲーム内表示は不明だよ。自動再送はしないので、返答が必要ならもう一度依頼してね。`;
    case "send_unknown":
      if (latest.reasonCode === "say_call_rejected")
        return `${questionStatus} say呼び出しの失敗が記録されているよ。ゲーム内表示は確認できず、自動再送もしないよ。返答が必要ならもう一度依頼してね。`;
      if (latest.reasonCode === "process_restart_during_send")
        return `${questionStatus} 再起動時に送信結果が不明だった記録があるよ。ゲーム内表示は確認できず、自動再送もしないよ。返答が必要ならもう一度依頼してね。`;
      return `${questionStatus} 送信結果が不明だよ。ゲーム内表示は確認できず、自動再送もしないよ。返答が必要ならもう一度依頼してね。`;
    case "send_call_resolved":
      return `${questionStatus} say呼び出しが戻った記録はあるよ。ただし、ゲーム内画面に表示されたことは確認できないよ。重複を避けて自動再送しないので、見えていなければもう一度依頼してね。`;
    case "durable_stop":
      return `${questionStatus} 永続停止で元の返答処理を止めた記録があるよ。明示再開でも停止前の質問は自動再生しないので、必要なら再開後にもう一度依頼してね。`;
  }
}

function isExplicitResumeCommand(message: string): boolean {
  return /^(?:再開|再開して|再開しろ|自律再開|自律を再開|自律を再開して|続行|続行して|resume|resume autonomy)[。！!]?$/iu.test(
    message.trim(),
  );
}

function isOwnerFollowCommand(message: string): boolean {
  return /^(?:こっち(?:に)?(?:きて|来て)|ついてきて|ついて来て)$/u.test(
    normalizeOwnerFollowMessage(message),
  );
}

function isOwnerFollowReminder(message: string): boolean {
  return /^(?:早く(?:来て)?|はやくきて|急いで)$/u.test(
    normalizeOwnerFollowMessage(message),
  );
}

function normalizeOwnerFollowMessage(message: string): string {
  return message.trim().replace(/[。.!！?？、，,]+$/u, "");
}

function normalizeKnowledgeQuery(query: string): string {
  return query.trim().replace(/\s+/gu, " ").toLocaleLowerCase("en-US");
}

function safeSummary(summary: string): string {
  return summary
    .replace(
      /\b(?:sk-(?:proj-)?|gh[pousr]_)[A-Za-z0-9_-]{12,}\b/gu,
      "[redacted]",
    )
    .replace(/[\r\n\t]+/gu, " ")
    .slice(0, 240);
}

function runtimeErrorCode(message: string): string {
  switch (message) {
    case "Companion wake failed":
      return "runtime_wake_failed";
    case "Body stop failed":
      return "body_stop_failed";
    case "Companion judgment failed":
      return "judgment_failed";
    case "Body outcome could not be persisted":
      return "body_outcome_persist_failed";
    case "Fresh Body observation failed":
      return "body_observation_failed";
    case "Companion speech delivery failed":
      return "speech_delivery_failed";
    case "Control message delivery failed":
      return "control_message_delivery_failed";
    case "Owner stop state could not be read":
      return "owner_stop_state_read_failed";
    case "Owner stop persistence failed":
      return "owner_stop_persistence_failed";
    case "Owner stop message could not be recorded":
      return "owner_stop_message_persist_failed";
    default:
      return "runtime_error";
  }
}
