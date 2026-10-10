import { randomUUID } from "node:crypto";

import type { Logger } from "pino";

import { sameMinecraftIdentity } from "../domain/minecraft-identity.js";
import type {
  BodyItemStack,
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
  CompanionOutcomeInput,
  CompanionSnapshot,
  CompanionStatePatch,
} from "./contracts.js";
import type {
  CompanionDecision,
  CompanionDecisionInput,
  CompanionAgentStatus,
} from "./agent.js";
import type { CompanionStore } from "./store.js";
import {
  type ChestEquipmentWithdrawalCandidate,
  type EquipmentUpgradeCandidate,
  findChestEquipmentWithdrawal,
  findInventoryEquipmentUpgrade,
  isChestEquipmentWindow,
} from "./equipment-upkeep.js";
import { isImmediateStopCommand } from "./stop-command.js";

const maximumWaitMs = 30 * 60_000;
const minimumWaitMs = 10_000;
const maximumRetryMs = 5 * 60_000;
const defaultRetryMs = 5_000;
const worldChangeCoalesceMs = 1_500;
const messageLimit = 2_000;
const defaultMemoryContextLimit = 12;
const automaticPickupSuppressionLimit = 32;
const equipmentChestReach = 4.5;
const equipmentChestSearchLimit = 4;
const equipmentChestSuppressionLimit = 64;
const equipmentUpkeepStepLimit = 5;

interface PendingWake {
  readonly reason: string;
  readonly mode?:
    "follow_owner" | "damage_reflex" | "equipment_upkeep" | undefined;
  readonly ownerMessage?: string | undefined;
}

interface ActiveBodyRun {
  readonly operationId: string;
  readonly operation: PlayerOperation;
  readonly startedAt: string;
  readonly controller: AbortController;
  readonly promise: Promise<PlayerOperationResult>;
}

interface EquipmentStepResult {
  readonly observation: PlayerBodyObservation | null;
  readonly confirmed: boolean;
}

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
 * Serializes all model judgments and Body operations. Durable stop is written
 * before cancellation; successful multi-step plans continue only after Body
 * confirms the operation and a fresh observation still matches its result.
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
  #unsubscribeBody: (() => void) | undefined;
  #generation = 0;
  #activeDecision: AbortController | undefined;
  #activeBody: ActiveBodyRun | undefined;
  #pendingWake: PendingWake | undefined;
  #drainPromise: Promise<void> | undefined;
  #waitTimer: NodeJS.Timeout | undefined;
  #worldChangeTimer: NodeJS.Timeout | undefined;
  #failureCount = 0;
  #worldChangedDuringDecision = false;
  #ownerFollowRequested = false;
  #damageReflexPending = false;
  #equipmentUpkeepQueued = false;
  #automaticPickupSuppressed = new Map<string, true>();
  #equipmentChestSuppressed = new Set<string>();
  #failedEquipmentCandidateFingerprint: string | undefined;
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
    this.#fireWake({ reason: "startup; re-observe before continuing" });
  }

  /** Only the authenticated owner can affect the companion through chat. */
  public async receiveChat(
    username: string,
    rawMessage: string,
  ): Promise<void> {
    if (!sameMinecraftIdentity(username, this.#ownerUsername)) return;
    if (this.#disposed) return;
    const message = rawMessage.trim().slice(0, messageLimit);
    if (message.length === 0) return;

    if (isImmediateStopCommand(message)) {
      const stopped = await this.stop(username);
      if (stopped) {
        try {
          this.#store.recordMessage("owner", message);
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

    if (!this.#started) this.#activate();
    if (this.#isStopped()) {
      if (isExplicitResumeCommand(message)) {
        this.#store.recordMessage("owner", message);
        await this.resume(username, message);
      }
      return;
    }

    if (isOwnerFollowCommand(message)) {
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

    this.#store.recordMessage("owner", message);
    await this.#requestWake({
      reason: "owner message",
      ownerMessage: message,
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
    this.#ownerFollowRequested = false;
    this.#damageReflexPending = false;
    this.#equipmentUpkeepQueued = false;
    this.#generation += 1;
    this.#pendingWake = undefined;
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
    try {
      await this.#body.stopActiveOperation?.();
    } catch {
      this.#logger?.warn({ errorType: "BodyStopError" }, "Body stop failed");
    }
    await this.#drainPromise;
    return true;
  }

  /** Resume requires a separately authenticated owner identity. */
  public async resume(
    actorUsername: string,
    ownerMessage?: string,
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
    await this.#requestWake({
      reason: "owner explicitly resumed autonomy",
      ...(ownerMessage === undefined
        ? {}
        : { ownerMessage: ownerMessage.slice(0, messageLimit) }),
    });
    return true;
  }

  /** Stop local work while preserving the durable owner stop state as-is. */
  public async shutdown(): Promise<void> {
    if (this.#disposed) return;
    this.#disposed = true;
    this.#ownerFollowRequested = false;
    this.#damageReflexPending = false;
    this.#equipmentUpkeepQueued = false;
    this.#generation += 1;
    this.#pendingWake = undefined;
    this.#clearTimers();
    this.#unsubscribeBody?.();
    this.#unsubscribeBody = undefined;
    this.#activeDecision?.abort(new Error("Companion runtime shutdown"));
    this.#activeBody?.controller.abort(new Error("Companion runtime shutdown"));
    await this.#drainPromise;
  }

  async #requestWake(wake: PendingWake): Promise<void> {
    if (this.#disposed || this.#isStopped()) return;
    if (wake.mode !== "damage_reflex") this.#damageReflexPending = false;
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
    this.#generation += 1;
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
    return true;
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
    const controller = new AbortController();
    this.#activeDecision = controller;
    this.#worldChangedDuringDecision = false;
    try {
      const snapshot = this.#store.snapshot();
      if (this.#isStopped() || !this.#isCurrent(generation)) return;
      const observation = await this.#body.observe({
        ownerPositionException: true,
      });
      if (!this.#isCurrent(generation)) return;
      const nearbyDroppedItems =
        observation.perception.nearbyDroppedItems?.entities ??
        observation.perception.entities.filter(
          (entity) => entity.droppedItem !== undefined,
        );
      const automaticPickupRange =
        observation.perception.nearbyDroppedItems?.maxDistance ??
        observation.perception.maxDistance;
      const observedAutomaticPickupTargets = new Set<string>();
      for (const entity of nearbyDroppedItems) {
        const item = entity.droppedItem;
        if (
          item !== undefined &&
          Number.isFinite(entity.distance) &&
          entity.distance <= automaticPickupRange
        )
          observedAutomaticPickupTargets.add(
            automaticPickupFingerprint(
              observation.dimension,
              entity.id,
              item.name,
              item.count,
            ),
          );
      }
      for (const fingerprint of this.#automaticPickupSuppressed.keys()) {
        if (!observedAutomaticPickupTargets.has(fingerprint))
          this.#automaticPickupSuppressed.delete(fingerprint);
      }
      const automaticEquipmentEligible =
        wake.mode === undefined &&
        wake.ownerMessage === undefined &&
        snapshot.plan === null &&
        snapshot.activeOperation === null &&
        observation.self.health !== null &&
        observation.self.health > 0 &&
        isSafeForEquipmentUpkeep(observation);
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
              Number.isFinite(entity.distance) &&
              entity.distance <= automaticPickupRange,
          )
          .sort((left, right) => left.distance - right.distance)
          .find((entity) => {
            const item = entity.droppedItem;
            return (
              item !== undefined &&
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
          );
          return;
        }
      }
      let repeatedKnowledgeRequest = false;
      let decision: CompanionDecision;
      if (wake.mode === "damage_reflex") {
        decision = this.#damageReflexDecision(snapshot, observation);
      } else {
        const query =
          wake.ownerMessage ??
          snapshot.goal?.title ??
          snapshot.interests[0] ??
          "Minecraftで共有した経験と現在の状況";
        const memories = this.#store.recall(query, this.#memoryContextLimit);
        const messages = this.#store.recentMessages(12);
        const input = {
          snapshot,
          observation,
          wakeReason: wake.reason,
          messages,
          memories,
          ...(wake.ownerMessage === undefined
            ? {}
            : { ownerMessage: wake.ownerMessage }),
          ...(this.#cachedKnowledge === undefined
            ? {}
            : { knowledge: this.#cachedKnowledge }),
        };

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
      if (
        wake.ownerMessage !== undefined &&
        decision.speech !== null &&
        decision.speech.length > 0
      )
        await this.#speakDecision(decision.speech, generation);
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
          ...(wake.ownerMessage === undefined
            ? {}
            : { ownerMessage: wake.ownerMessage }),
        });
        return;
      }
      if (decision.plan === null) {
        this.#setWakeTimer(waitMs, {
          reason: "model-selected companion wait ended",
        });
        return;
      }
      await this.#executePlan(decision, generation);
    } catch (error) {
      if (!controller.signal.aborted && this.#isCurrent(generation)) {
        this.#logError(error, "Companion judgment failed");
        this.#scheduleRetry(wake);
      }
    } finally {
      if (wake.mode === "damage_reflex" && this.#isCurrent(generation))
        this.#damageReflexPending = false;
      if (this.#activeDecision === controller) this.#activeDecision = undefined;
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

  async #runEquipmentUpkeep(
    initialObservation: PlayerBodyObservation,
    generation: number,
    explicit: boolean,
  ): Promise<boolean> {
    let observation = initialObservation;
    let attemptedGearWork = false;
    let uncertain = false;
    let cleanupConfirmed = true;
    let windowMayBeOpen = false;
    let swept = false;
    let equipmentChanges = 0;
    const confirmedItems: string[] = [];

    try {
      if (!this.#isCurrent(generation) || this.#isStopped()) return explicit;
      if (
        !isSafeForEquipmentUpkeep(observation) ||
        observation.window !== null
      ) {
        uncertain = explicit;
      } else {
        while (
          equipmentChanges < equipmentUpkeepStepLimit &&
          this.#isCurrent(generation) &&
          !this.#isStopped() &&
          isSafeForEquipmentUpkeep(observation)
        ) {
          const upgrade = findInventoryEquipmentUpgrade(observation);
          if (upgrade === null) break;
          const candidateFingerprint = equipmentCandidateFingerprint(
            observation,
            upgrade,
          );
          if (
            this.#failedEquipmentCandidateFingerprint === candidateFingerprint
          ) {
            uncertain = true;
            break;
          }
          attemptedGearWork = true;
          const before = observation;
          const step = await this.#executeEquipmentAction(
            {
              kind: "equip",
              item: upgrade.item.name,
              destination: upgrade.destination,
            },
            "Equip a strictly better observed armor or combat weapon item.",
            generation,
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
            break;
          }
          if (!canContinuePlan(before, step.observation, undefined)) {
            this.#failedEquipmentCandidateFingerprint =
              equipmentCandidateFingerprint(step.observation, upgrade);
            uncertain = true;
            break;
          }
          observation = step.observation;
          this.#failedEquipmentCandidateFingerprint = undefined;
          confirmedItems.push(upgrade.item.name);
          equipmentChanges += 1;
        }

        if (
          explicit &&
          equipmentChanges < equipmentUpkeepStepLimit &&
          visibleEquipmentChests(observation).length === 0 &&
          this.#isCurrent(generation) &&
          !this.#isStopped()
        ) {
          swept = true;
          const sweep = await this.#executeEquipmentAction(
            { kind: "look_sweep" },
            "Complete one bounded look sweep before searching the received visible subset for chests.",
            generation,
          );
          if (!sweep.confirmed || sweep.observation === null) {
            uncertain = true;
          } else {
            observation = sweep.observation;
          }
        }

        if (!uncertain && equipmentChanges < equipmentUpkeepStepLimit) {
          const chests = visibleEquipmentChests(observation).filter(
            (block) =>
              !this.#equipmentChestSuppressed.has(
                equipmentChestFingerprint(observation.dimension, block),
              ),
          );
          let inspected = 0;
          for (const block of chests) {
            if (
              inspected >= equipmentChestSearchLimit ||
              !this.#isCurrent(generation) ||
              this.#isStopped() ||
              !isSafeForEquipmentUpkeep(observation) ||
              equipmentChanges >= equipmentUpkeepStepLimit
            )
              break;
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
            // Keep an attempted chest suppressed even if it later leaves the
            // view or the operation is interrupted before its contents settle.
            this.#equipmentChestSuppressed.add(chestKey);
            const withdrawn: ChestEquipmentWithdrawalCandidate[] = [];
            let chestFailed = false;
            attemptedGearWork = true;
            windowMayBeOpen = true;
            try {
              const opened = await this.#executeEquipmentAction(
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
                "Open one currently visible reachable chest to inspect its observed contents.",
                generation,
              );
              if (
                !opened.confirmed ||
                opened.observation === null ||
                !isChestEquipmentWindow(opened.observation.window)
              ) {
                chestFailed = true;
              } else {
                observation = opened.observation;
                let transfers = 0;
                while (
                  transfers < equipmentUpkeepStepLimit &&
                  equipmentChanges + transfers < equipmentUpkeepStepLimit &&
                  this.#isCurrent(generation) &&
                  !this.#isStopped() &&
                  isSafeForEquipmentUpkeep(observation)
                ) {
                  const candidate = findChestEquipmentWithdrawal(observation);
                  if (candidate === null) break;
                  attemptedGearWork = true;
                  const transfer = await this.#executeEquipmentAction(
                    {
                      kind: "window_transfer",
                      item: candidate.item.name,
                      count: 1,
                      direction: "window_to_inventory",
                    },
                    "Withdraw exactly one observed strictly better equipment item.",
                    generation,
                  );
                  if (
                    !transfer.confirmed ||
                    transfer.observation === null ||
                    !sameEquipmentChestWindow(
                      observation.window,
                      transfer.observation.window,
                    ) ||
                    !hasMatchingInventoryItem(
                      transfer.observation,
                      candidate.item,
                    )
                  ) {
                    chestFailed = true;
                    break;
                  }
                  withdrawn.push(candidate);
                  observation = transfer.observation;
                  transfers += 1;
                }
              }
            } catch (error) {
              this.#logError(error, "Equipment chest inspection failed");
              chestFailed = true;
            } finally {
              const closed = await this.#closeEquipmentWindow(generation);
              windowMayBeOpen = false;
              if (!closed.confirmed || closed.observation === null) {
                cleanupConfirmed = false;
                chestFailed = true;
              } else {
                observation = closed.observation;
              }
            }

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
              equipmentChanges < equipmentUpkeepStepLimit &&
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
              const step = await this.#executeEquipmentAction(
                {
                  kind: "equip",
                  item: upgrade.item.name,
                  destination: upgrade.destination,
                },
                "Equip the observed chest item only after the chest is closed and inventory transfer was confirmed.",
                generation,
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
      }
    } catch (error) {
      this.#logError(error, "Equipment upkeep failed");
      uncertain = true;
    } finally {
      if (windowMayBeOpen) {
        const closed = await this.#closeEquipmentWindow(generation);
        if (!closed.confirmed || closed.observation === null)
          cleanupConfirmed = false;
        else observation = closed.observation;
      }
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
    if (handled && this.#isCurrent(generation) && !this.#isStopped())
      this.#setWakeTimer(this.#minWaitMs, {
        reason: "equipment upkeep completed; wait for a fresh observation",
      });
    return handled;
  }

  async #executeEquipmentAction(
    operationInput: PlayerOperation,
    expectedOutcome: string,
    generation: number,
  ): Promise<EquipmentStepResult> {
    if (!this.#isCurrent(generation) || this.#isStopped())
      return { observation: null, confirmed: false };
    const operation = playerOperationSchema.parse(operationInput);
    if (operation.kind === "follow_owner")
      return { observation: null, confirmed: false };
    const snapshot = this.#store.snapshot();
    if (snapshot.activeOperation !== null)
      return { observation: null, confirmed: false };
    const plan = {
      purpose:
        "Perform one deterministic equipment upkeep step from fresh Body observations.",
      steps: [{ operation, expectedOutcome }],
    };
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
    this.#clearTimers();
    const result: { observation: PlayerBodyObservation | null } = {
      observation: null,
    };
    try {
      await this.#executePlan(decision, generation, (fresh) => {
        result.observation = fresh;
      });
    } catch (error) {
      this.#logError(error, "Equipment upkeep step failed");
    } finally {
      this.#clearTimers();
    }
    return {
      observation: result.observation,
      // #executePlan invokes this callback only after a successful Body
      // outcome, same-life check, and fresh observation.
      confirmed:
        result.observation !== null &&
        this.#isCurrent(generation) &&
        !this.#isStopped(),
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
      const closed = await this.#executeEquipmentAction(
        { kind: "window_close" },
        "Close the chest after equipment inspection and verify the window is gone.",
        generation,
      );
      if (closed.confirmed && closed.observation?.window === null)
        return closed;
    }
    return this.#forceCloseEquipmentWindow();
  }

  async #forceCloseEquipmentWindow(): Promise<EquipmentStepResult> {
    let observation: PlayerBodyObservation;
    try {
      observation = await this.#body.observe({
        ownerPositionException: true,
      });
    } catch (error) {
      this.#logError(error, "Equipment cleanup observation failed");
      return { observation: null, confirmed: false };
    }
    if (observation.window === null) return { observation, confirmed: true };

    const operation = playerOperationSchema.parse({ kind: "window_close" });
    const controller = new AbortController();
    const operationId = randomUUID();
    const run: ActiveBodyRun = {
      operationId,
      operation,
      startedAt: new Date().toISOString(),
      controller,
      promise: Promise.resolve().then(() =>
        this.#body.execute(operation, controller.signal),
      ),
    };
    this.#activeBody = run;
    let result: PlayerOperationResult | null = null;
    try {
      result = await run.promise;
    } catch {
      // The fresh observation below decides whether cleanup completed.
    } finally {
      if (this.#activeBody === run) this.#activeBody = undefined;
    }
    try {
      const fresh = await this.#body.observe({ ownerPositionException: true });
      return {
        observation: fresh,
        confirmed:
          result !== null &&
          sameOperation(result.operation, operation) &&
          result.status === "successful" &&
          result.after?.window === null &&
          fresh.window === null,
      };
    } catch (error) {
      this.#logError(error, "Equipment cleanup result could not be observed");
      return { observation: null, confirmed: false };
    }
  }

  async #followOwner(generation: number): Promise<void> {
    const operation = playerOperationSchema.parse({ kind: "follow_owner" });
    const operationId = randomUUID();
    const expectedOutcome =
      "The configured owner remains nearby until following is interrupted.";
    const activeOperation = {
      operationId,
      operation,
      expectedOutcome,
    } as const;

    try {
      this.#store.save({
        goal: {
          title: "オーナーに追従する",
          successCondition: "オーナーの近くを保つ。",
          source: "owner",
        },
        plan: {
          purpose: "明示された指示に従ってオーナーの近くまで移動する。",
          steps: [{ operation, expectedOutcome }],
        },
        waitUntil: null,
        activeOperation,
      });
    } catch (error) {
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
      startedAt: new Date().toISOString(),
      controller,
      promise,
    };
    this.#activeBody = run;

    let result: PlayerOperationResult;
    try {
      result = await promise;
    } catch {
      result = failedBodyResult(operation, operationId);
    } finally {
      if (this.#activeBody === run) this.#activeBody = undefined;
    }

    let updated: CompanionSnapshot;
    try {
      updated = this.#store.recordOutcome(
        outcomeFromResult(result, operation, operationId, expectedOutcome),
      );
    } catch (error) {
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
    onPlanConfirmed?: (observation: PlayerBodyObservation) => void,
  ): Promise<void> {
    const plannedSteps = decision.plan?.steps ?? [];
    for (const plannedStep of plannedSteps) {
      if (!this.#isCurrent(generation) || this.#isStopped()) return;
      const snapshot = this.#store.snapshot();
      const step = snapshot.plan?.steps[0];
      if (
        step === undefined ||
        !sameOperation(step.operation, plannedStep.operation) ||
        step.expectedOutcome !== plannedStep.expectedOutcome
      ) {
        this.#requestReplan(
          "persisted plan no longer matches next action",
          generation,
        );
        return;
      }
      const operation = playerOperationSchema.parse(step.operation);
      if (operation.kind === "follow_owner") {
        this.#requestReplan(
          "Agent cannot issue the internal owner-follow operation",
          generation,
        );
        return;
      }
      const operationId = randomUUID();
      const activeOperation = {
        operationId,
        operation,
        expectedOutcome: step.expectedOutcome,
      } as const;
      this.#store.save({ activeOperation });
      const controller = new AbortController();
      const run: ActiveBodyRun = {
        operationId,
        operation,
        startedAt: new Date().toISOString(),
        controller,
        promise: this.#body.execute(operation, controller.signal),
      };
      this.#activeBody = run;
      let result: PlayerOperationResult;
      try {
        result = await run.promise;
      } catch {
        result = failedBodyResult(operation, operationId);
      } finally {
        if (this.#activeBody === run) this.#activeBody = undefined;
      }
      const outcome = outcomeFromResult(
        result,
        step.operation,
        operationId,
        step.expectedOutcome,
      );
      let updated: CompanionSnapshot;
      try {
        updated = this.#store.recordOutcome(outcome);
      } catch (error) {
        this.#logError(error, "Body outcome could not be persisted");
        this.#scheduleRetry({ reason: "Body outcome persistence failed" });
        return;
      }
      if (
        !this.#isCurrent(generation) ||
        updated.stopped ||
        this.#runtimeStopLatched
      )
        return;
      if (updated.activeOperation !== null) {
        this.#scheduleRetry({
          reason: "Body outcome did not match the persisted active operation",
        });
        return;
      }
      if (result.status !== "successful") {
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
        this.#scheduleRetry({
          reason: "fresh observation after Body action failed",
        });
        return;
      }
      if (!this.#isCurrent(generation) || this.#isStopped()) return;
      if (
        result.after === null ||
        result.sameLife !== true ||
        !canContinuePlan(
          result.after,
          freshObservation,
          updated.plan?.steps[0]?.operation,
        )
      ) {
        this.#store.save({ plan: null });
        this.#scheduleRetry({
          reason: "Body result or next-step prerequisites changed",
        });
        return;
      }
      const next = updated.plan?.steps[0];
      if (next === undefined) {
        this.#setWakeTimer(this.#waitFromSnapshot(updated), {
          reason: "current companion plan completed with observed outcomes",
        });
        onPlanConfirmed?.(freshObservation);
        return;
      }
    }
  }

  #onBodyEvent(event: PlayerBodyEvent): void {
    if (this.#disposed || !this.#started) return;
    if (event.type === "bot_damaged") {
      if (
        this.#activeBody?.operation.kind === "attack" ||
        this.#damageReflexPending ||
        this.#pendingWake?.ownerMessage !== undefined ||
        this.#pendingWake?.mode === "follow_owner" ||
        this.#isStopped()
      )
        return;
      this.#damageReflexPending = true;
      this.#fireWake({
        reason: "damage received; react from a fresh Body observation",
        mode: "damage_reflex",
      });
      return;
    }
    if (
      event.type === "bot_death" ||
      event.type === "bot_death_cause_updated"
    ) {
      this.#fireWake({ reason: `urgent Body event: ${event.type}` });
      return;
    }
    if (event.type === "disconnected") {
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

  #requestReplan(reason: string, generation: number): void {
    if (!this.#isCurrent(generation)) return;
    this.#store.save({ plan: null });
    this.#scheduleRetry({ reason });
  }

  #damageReflexDecision(
    snapshot: CompanionSnapshot,
    observation: PlayerBodyObservation,
  ): CompanionDecision {
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
          entity.distance <= 3.2,
      )
      .sort((left, right) => left.distance - right.distance)[0];
    const operation =
      target === undefined
        ? { kind: "look_sweep" as const }
        : { kind: "attack" as const, entityId: target.id };
    return {
      speech: null,
      goal: snapshot.goal,
      plan: {
        purpose: "React once to damage using fresh Body-visible information.",
        steps: [
          {
            operation,
            expectedOutcome:
              target === undefined
                ? "Complete one bounded look sweep; consider threats on a later wake."
                : "Attempt one nearby hostile attack and rely on Body for confirmation.",
          },
        ],
      },
      memoryUpdates: [],
      relationshipSummary: null,
      waitMs: Math.max(minimumWaitMs, this.#minWaitMs),
      knowledgeQuery: null,
    };
  }

  #scheduleRetry(wake: PendingWake): void {
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

  #isStopped(): boolean {
    return this.#runtimeStopLatched || this.#store.snapshot().stopped;
  }

  async #speakDecision(text: string, generation: number): Promise<void> {
    if (!this.#isCurrent(generation) || this.#isStopped()) return;
    try {
      await this.#say(text);
      if (this.#isCurrent(generation) && !this.#isStopped())
        this.#store.recordMessage("companion", text);
    } catch (error) {
      this.#logError(error, "Companion speech delivery failed");
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

  #clearTimers(): void {
    if (this.#waitTimer !== undefined) clearTimeout(this.#waitTimer);
    if (this.#worldChangeTimer !== undefined)
      clearTimeout(this.#worldChangeTimer);
    this.#waitTimer = undefined;
    this.#worldChangeTimer = undefined;
    this.#wakeAt = null;
    this.#wakeReason = null;
  }
}

function outcomeFromResult(
  result: PlayerOperationResult,
  plannedOperation: PlayerOperation,
  operationId: string,
  expectedOutcome: string,
): CompanionOutcomeInput {
  const operationMatches = sameOperation(result.operation, plannedOperation);
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

function visibleEquipmentChests(
  observation: PlayerBodyObservation,
): BodyVisibleBlock[] {
  return observation.perception.blocks
    .filter(
      (block) =>
        /(?:^|:)(?:trapped_)?chest$/u.test(block.name) &&
        Number.isFinite(block.distance) &&
        block.distance <= equipmentChestReach,
    )
    .sort((left, right) => left.distance - right.distance);
}

function equipmentChestFingerprint(
  dimension: string,
  block: BodyVisibleBlock,
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

function isExplicitResumeCommand(message: string): boolean {
  return /^(?:再開|再開して|自律再開|自律を再開|自律を再開して|続行|続行して|resume|resume autonomy)[。！!]?$/iu.test(
    message.trim(),
  );
}

function isOwnerFollowCommand(message: string): boolean {
  return /^(?:こっち(?:に)?来て|ついてきて|ついて来て)[。！!]*$/u.test(
    message.trim(),
  );
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
