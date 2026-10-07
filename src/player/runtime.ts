import { randomUUID } from "node:crypto";

import type { Logger } from "pino";

import { sameMinecraftIdentity } from "../domain/minecraft-identity.js";
import { oxygenObservationState } from "../domain/snapshot.js";
import type {
  McSkillRepository,
  McSkillOutcomeStatus,
} from "../mc-skills/index.js";
import type {
  PlayerBody,
  PlayerBodyDamageSource,
  PlayerBodyDeathCause,
  PlayerBodyEvent,
  PlayerBodyObservation,
  PlayerOperation,
  PlayerOperationResult,
} from "../minecraft/player-body.js";
import type { BodyNearbyHostileDirection } from "../minecraft/player-body-observation.js";
import { isImmediateStopCommand } from "../agent/chat-coordinator.js";
import type { TraceService, TraceSession } from "../trace/service.js";
import type {
  PlayerMemoryPort,
  PlayerObservationEvidence,
  PlayerObservedDisplacement,
  PlayerRuntimeInspection,
  PlayerRuntimeEvent,
  PlayerRuntimeSnapshot,
  PlayerThoughtDecision,
  PlayerWakeKind,
} from "./contracts.js";
import type { PlayerMindStore } from "./mind-store.js";
import {
  toObservationEvidence,
  trustedConditions,
} from "./observation-evidence.js";

// Keep owner changes responsive while giving an accepted HTTP one
// bounded drain window.
const ownerProposalSettlementTimeoutMs = 30_000;
const damageObservationCoalesceMs = 3_000;

function enabledControlCount(operation: PlayerOperation): number | null {
  if (operation.kind !== "control") return null;
  return Object.values(operation.controls).filter((enabled) => enabled).length;
}

function isUrgentPerceptionWake(kind: PlayerWakeKind): boolean {
  return (
    kind === "bot_damaged" ||
    kind === "bot_death" ||
    kind === "bot_death_cause_updated"
  );
}

interface ActiveBodyRun {
  readonly operationId: string;
  readonly actionRevision: number;
  readonly operation: PlayerOperation;
  readonly skillId?: string;
  readonly skillVersion?: number;
  readonly controller: AbortController;
  promise: Promise<void>;
}

type RuntimeBodyOperationPhase = NonNullable<
  PlayerRuntimeInspection["body"]["latestOperationPhase"]
>;

interface LatestBodyOperationPhase {
  readonly runtimeOperationId: string;
  readonly actionRevision: number;
  readonly bodyOperationId?: string;
  readonly operation: PlayerOperation["kind"];
  readonly phase: RuntimeBodyOperationPhase["phase"];
  readonly at: string;
  readonly admissionObserved: boolean;
  readonly status?: McSkillOutcomeStatus;
  readonly reason?: RuntimeBodyOperationPhase["reason"];
  readonly firstPathStatus?: RuntimeBodyOperationPhase["firstPathStatus"];
  readonly controlEnabledCount: number | null;
}

type DamageReflexCompletedEvent = Extract<
  PlayerBodyEvent,
  { readonly type: "damage_reflex_completed" }
>;

interface PendingDamageReflexOutcome {
  readonly latest: DamageReflexCompletedEvent;
  readonly confirmed?: DamageReflexCompletedEvent;
  readonly count: number;
}

export interface PlayerConversationPort {
  nextTurn(): number;
  handleOwnerMessage(input: {
    readonly username: string;
    readonly message: string;
    readonly turn: number;
    readonly signal?: AbortSignal;
  }): Promise<void>;
  finishTurn?(turn: number): void;
}

export interface PlayerPurposePort {
  think(input: {
    readonly snapshot: PlayerRuntimeSnapshot;
    readonly events: readonly PlayerRuntimeEvent[];
    readonly urgentPerceptionWake?: boolean;
    readonly signal?: AbortSignal;
    readonly shouldStopAfterResponse?: () => boolean;
    readonly onResponsesRequestState?: (active: boolean) => void;
  }): Promise<{
    readonly accepted: boolean;
    readonly decision?: PlayerThoughtDecision;
  }>;
}

export interface PlayerRuntimeOptions {
  readonly ownerUsername: string;
  readonly playerId: string;
  readonly body: PlayerBody;
  readonly mind: PlayerMindStore;
  readonly memory: PlayerMemoryPort;
  readonly skills: McSkillRepository;
  readonly conversation: PlayerConversationPort;
  readonly purpose: PlayerPurposePort;
  readonly logger: Logger;
  readonly trace?: TraceService;
  readonly say: (text: string) => Promise<void>;
  readonly requestReconnect?: (reason: string) => Promise<void> | void;
}

interface PendingThoughtWake {
  readonly kind: PlayerWakeKind;
  readonly reason: string;
  readonly damageAware: boolean;
  readonly deathAware: boolean;
}

interface EquipmentOutcomeNotificationState {
  readonly failedSignatures: Set<string>;
  lastSuccessfulSignature: string | undefined;
}

/** Event-driven coordinator. Only this class owns calls into PlayerBody.execute. */
export class PlayerRuntime {
  readonly #eventTimes = new Map<string, number>();
  readonly #semanticSignatures = new Map<string, string>();
  readonly #pendingSemanticChanges = new Set<string>();
  readonly #equipmentOutcomeNotifications = new Map<
    Extract<PlayerOperation, { kind: "equip" }>["destination"],
    EquipmentOutcomeNotificationState
  >();
  readonly #lifetime = new AbortController();
  #unsubscribeBody: (() => void) | undefined;
  #activeBody: ActiveBodyRun | undefined;
  #activeThought: AbortController | undefined;
  #activeThoughtStartedAtMs: number | undefined;
  #activeThoughtCommitted = false;
  #activeThoughtDamageAware = false;
  #activeThoughtDamageInvalidated = false;
  #activeThoughtDeathAware = false;
  #activeThoughtDeathInvalidated = false;
  #activeResponsesRequest = false;
  #activeResponsesRequestStartedAtMs: number | undefined;
  #ownerProposalSettlementTimer: NodeJS.Timeout | undefined;
  #ownerProposalSettlementThought: AbortController | undefined;
  #pendingThoughtWake: PendingThoughtWake | undefined;
  #replacementTail: Promise<void> = Promise.resolve();
  #retryTimer: NodeJS.Timeout | undefined;
  #revisionRetryUsed = false;
  #deadlineTimer: NodeJS.Timeout | undefined;
  #sampleTimer: NodeJS.Timeout | undefined;
  #semanticWakeTimer: NodeJS.Timeout | undefined;
  #vitalsWakeTimer: NodeJS.Timeout | undefined;
  #samplePromise: Promise<void> | undefined;
  #retryDelayMs = 5_000;
  #bodyNeedsRecovery = false;
  #recoveryRequestedOperationIds = new Set<string>();
  #ownerProposalsAwaitingResolution = new Set<string>();
  #ownerConsumeOperations = new Set<string>();
  #pendingDamageReflexOutcome: PendingDamageReflexOutcome | undefined;
  #latestBodyOperationPhase: LatestBodyOperationPhase | undefined;
  #bodyConnected = true;
  #lastDamageEventAtMs = Number.NEGATIVE_INFINITY;
  #started = false;
  #shuttingDown = false;
  #handledPurposeCompletionWakeSequence = 0;

  public constructor(private readonly options: PlayerRuntimeOptions) {}

  public get snapshot(): PlayerRuntimeSnapshot {
    return this.options.mind.snapshot();
  }

  public get busy(): boolean {
    return this.#activeThought !== undefined || this.#activeBody !== undefined;
  }

  /** Safe, bounded current-process diagnostics for an authenticated owner question. */
  public inspectRuntime(): PlayerRuntimeInspection {
    const now = Date.now();
    const snapshot = this.options.mind.snapshot();
    const recentDecisionFailures = snapshot.recentAgentActivity
      .slice(-8)
      .flatMap((activity) => {
        const rejectionCodes = activity.toolCalls
          .filter((call) => call.resultClass !== "ok")
          .flatMap((call) =>
            call.resultCode === undefined ? [] : [call.resultCode],
          );
        if (
          rejectionCodes.length === 0 &&
          activity.responseStatus !== "failed" &&
          activity.responseStatus !== "request_error" &&
          activity.responseStatus !== "incomplete"
        )
          return [];
        return [
          {
            role: activity.role,
            responseStatus: activity.responseStatus,
            ...(activity.requestErrorCause === undefined
              ? {}
              : { requestErrorCause: activity.requestErrorCause }),
            rejectionCodes,
            ageKnown: false as const,
          },
        ];
      })
      .slice(-4);
    return {
      sampledAt: new Date(now).toISOString(),
      process: { started: this.#started, shuttingDown: this.#shuttingDown },
      purpose: {
        active: this.#activeThought !== undefined,
        activeForMs:
          this.#activeThoughtStartedAtMs === undefined
            ? null
            : Math.max(0, now - this.#activeThoughtStartedAtMs),
        awaitingResponse: this.#activeResponsesRequest,
        responseWaitForMs:
          !this.#activeResponsesRequest ||
          this.#activeResponsesRequestStartedAtMs === undefined
            ? null
            : Math.max(0, now - this.#activeResponsesRequestStartedAtMs),
        retryScheduled: this.#retryTimer !== undefined,
      },
      body: {
        connectionState: !this.#started
          ? "not_started"
          : this.#bodyConnected
            ? "connected"
            : "disconnected",
        activeOperation:
          snapshot.activeOperation === undefined
            ? null
            : {
                operation: snapshot.activeOperation.kind,
                startedAt:
                  snapshot.activeOperation.bodyStartedAt ??
                  snapshot.activeOperation.startedAt,
              },
        latestOperationPhase:
          this.#latestBodyOperationPhase === undefined
            ? null
            : {
                operation: this.#latestBodyOperationPhase.operation,
                phase: this.#latestBodyOperationPhase.phase,
                at: this.#latestBodyOperationPhase.at,
                ageMs: Math.max(
                  0,
                  now - Date.parse(this.#latestBodyOperationPhase.at),
                ),
                inFlight:
                  this.#activeBody?.operationId ===
                    this.#latestBodyOperationPhase.runtimeOperationId &&
                  this.#latestBodyOperationPhase.phase !== "result" &&
                  this.#latestBodyOperationPhase.phase !== "guard_rejected",
                admissionObserved:
                  this.#latestBodyOperationPhase.admissionObserved,
                status: this.#latestBodyOperationPhase.status ?? null,
                reason: this.#latestBodyOperationPhase.reason ?? null,
                firstPathStatus:
                  this.#latestBodyOperationPhase.firstPathStatus ?? null,
                controlEnabledCount:
                  this.#latestBodyOperationPhase.controlEnabledCount,
              },
        latestObservation:
          snapshot.lastObservation === undefined
            ? null
            : {
                observedAt: snapshot.lastObservation.observedAt,
                ageMs: Math.max(
                  0,
                  now - Date.parse(snapshot.lastObservation.observedAt),
                ),
                health: snapshot.lastObservation.health,
              },
        lastResult:
          snapshot.lastOutcome === undefined
            ? null
            : {
                operation: snapshot.lastOutcome.kind,
                status: snapshot.lastOutcome.status,
                observedAt: snapshot.lastOutcome.observedAt,
              },
      },
      pendingOwnerProposalCount: snapshot.proposals.filter(
        ({ status }) => status === "pending",
      ).length,
      recentDecisionFailures,
    };
  }

  public async start(): Promise<void> {
    if (this.#started) return;
    this.#started = true;
    this.#unsubscribeBody = this.options.body.onEvent((event) =>
      this.onBodyEvent(event),
    );
    const activeBeforeRecovery = this.options.mind.snapshot().activeOperation;
    const priorReceipt =
      activeBeforeRecovery === undefined
        ? undefined
        : this.options.skills.getEvidence(activeBeforeRecovery.operationId);
    const trustedRecovery =
      priorReceipt === undefined || activeBeforeRecovery === undefined
        ? undefined
        : priorReceipt.operationName === activeBeforeRecovery.kind &&
            priorReceipt.skillIdAtUse === activeBeforeRecovery.skillId &&
            priorReceipt.skillVersionAtUse === activeBeforeRecovery.skillVersion
          ? {
              status: priorReceipt.observedOutcome,
              summary: priorReceipt.observationSummary,
              observedAt: priorReceipt.observedAt,
            }
          : undefined;
    const recovered =
      this.options.mind.recoverInterruptedOperation(trustedRecovery);
    if (recovered !== undefined) {
      this.#recordRecoveryEvidence(recovered);
      this.options.memory.recordEpisode({
        summary: `再起動をまたいだ${recovered.kind}の観測結果を${recovered.status}として保存`,
        status: recovered.status,
        operationKind: recovered.kind,
      });
    }
    const snapshot = this.options.mind.snapshot();
    this.#rememberPendingOwnerProposals(snapshot);
    this.#handledPurposeCompletionWakeSequence =
      this.options.mind.purposeCompletionWakeState().sequence;
    this.#scheduleDeadline(snapshot.wait?.wakeAt);
    if (!snapshot.stopped) {
      this.#setDamageReflexEnabled(true);
      await this.#sampleSemanticState();
      this.#startSampler();
      const completionWake = this.options.mind.purposeCompletionWakeState();
      this.#handledPurposeCompletionWakeSequence = completionWake.sequence;
      if (completionWake.pendingEvent !== undefined) {
        this.#requestThought(
          completionWake.pendingEvent.kind,
          completionWake.pendingEvent.summary,
          true,
        );
      } else {
        const kind: PlayerWakeKind =
          snapshot.wait?.wakeOn.includes("reconnected") === true
            ? "reconnected"
            : "startup";
        const summary =
          kind === "reconnected"
            ? "接続済みの新しいMinecraft sessionでランタイムを起動"
            : "接続後に自律目的と現在状態を評価";
        const event = this.options.mind.enqueueEvent(kind, summary);
        this.#requestThought(event.kind, event.summary);
      }
    }
  }

  /** Mineflayer entry point; identity is checked before either agent sees chat. */
  public receiveChat(username: string, message: string): void {
    if (
      this.#shuttingDown ||
      !sameMinecraftIdentity(username, this.options.ownerUsername)
    )
      return;
    const normalized = message.trim();
    if (normalized.length === 0 || normalized.length > 1_000) return;
    const turn = this.options.conversation.nextTurn();
    if (isImmediateStopCommand(normalized)) {
      this.options.mind.stop();
      this.#stopSampler();
      this.#cancelThought("owner_stop");
      void this.#stopBody("owner_stop")
        .then(async () => {
          if (!this.#shuttingDown)
            await this.#safeSay(
              "自律行動を停止しました。再開の指示があるまで停止を続けます。",
            );
        })
        .catch((error: unknown) =>
          this.#logFailure("PLAYER_STOP_FAILED", error),
        );
      return;
    }
    void this.#traceCall("owner conversation turn", () =>
      this.options.conversation.handleOwnerMessage({
        username,
        message: normalized,
        turn,
        signal: this.#lifetime.signal,
      }),
    )
      .catch((error: unknown) =>
        this.#logFailure("PLAYER_CONVERSATION_FAILED", error),
      )
      .finally(() => this.options.conversation.finishTurn?.(turn));
  }

  /** Called after a durable owner proposal was recorded; this leaves the body running. */
  public onOwnerProposal(): void {
    this.#rememberPendingOwnerProposals(this.options.mind.snapshot());
    const event = this.options.mind
      .pendingEvents(12)
      .findLast(({ kind }) => kind === "owner_proposal");
    this.#requestThought(
      "owner_proposal",
      event?.summary ?? "所有者の目的提案を評価",
    );
  }

  /** Wake Purpose to reconsider an existing plan using its next fresh observation. */
  public onOwnerFeedbackNeedsReassessment(reason: string): boolean {
    if (
      this.#shuttingDown ||
      this.#lifetime.signal.aborted ||
      this.options.mind.snapshot().stopped
    )
      return false;
    const detail = sanitizeDetail(reason);
    if (detail.length === 0) return false;
    const event = this.options.mind.enqueueEvent(
      "manual",
      `Owner feedback asks me to reconsider the current purpose: ${detail}`,
    );
    this.#requestThought(event.kind, event.summary, true);
    return true;
  }

  /** Called only after the stop latch has been persisted. */
  public async stopNow(): Promise<void> {
    this.#stopSampler();
    this.#cancelThought("autonomy_stopped");
    await this.#stopBody("autonomy_stopped");
  }

  /** A fresh, owner-authenticated resume wakes the purpose agent. */
  public onResume(): void {
    if (this.#shuttingDown || this.options.mind.snapshot().stopped) return;
    this.#setDamageReflexEnabled(true);
    void this.#sampleSemanticState();
    this.#startSampler();
    const completionWake = this.options.mind.purposeCompletionWakeState();
    this.#handledPurposeCompletionWakeSequence = completionWake.sequence;
    if (completionWake.pendingEvent !== undefined) {
      this.#requestThought(
        completionWake.pendingEvent.kind,
        completionWake.pendingEvent.summary,
        true,
      );
    } else {
      this.#requestThought("manual", "所有者が自律行動を再開");
    }
  }

  public async shutdown(reason = "shutdown"): Promise<void> {
    if (this.#shuttingDown) return;
    this.#shuttingDown = true;
    this.#lifetime.abort(new Error("player runtime shutdown"));
    this.#cancelThought(reason);
    if (this.#retryTimer !== undefined) clearTimeout(this.#retryTimer);
    if (this.#deadlineTimer !== undefined) clearTimeout(this.#deadlineTimer);
    this.#stopSampler();
    this.#unsubscribeBody?.();
    this.#unsubscribeBody = undefined;
    await this.#stopBody(reason);
  }

  public evidence(): PlayerRuntimeSnapshot {
    const snapshot = this.options.mind.snapshot();
    return {
      ...snapshot,
      ...(snapshot.lastObservation === undefined
        ? {}
        : {
            lastObservation: withoutPrivateObservationDetails(
              snapshot.lastObservation,
            ),
          }),
      ...(snapshot.latestDeath === undefined
        ? {}
        : {
            latestDeath: {
              observedAt: snapshot.latestDeath.observedAt,
              ...(snapshot.latestDeath.cause === undefined
                ? {}
                : { cause: snapshot.latestDeath.cause }),
              ...(snapshot.latestDeath.beforeObservation === undefined
                ? {}
                : {
                    beforeObservation: withoutPrivateObservationDetails(
                      snapshot.latestDeath.beforeObservation,
                    ),
                  }),
              ...(snapshot.latestDeath.firstPostDeathObservation === undefined
                ? {}
                : {
                    firstPostDeathObservation: withoutPrivateObservationDetails(
                      snapshot.latestDeath.firstPostDeathObservation,
                    ),
                  }),
            },
          }),
    };
  }

  public handleCommittedDecision(
    snapshot: PlayerRuntimeSnapshot,
    decision: PlayerThoughtDecision,
  ): void {
    if (this.#activeThought !== undefined) this.#activeThoughtCommitted = true;
    this.#retryDelayMs = 5_000;
    this.#revisionRetryUsed = false;
    if (this.#retryTimer !== undefined) clearTimeout(this.#retryTimer);
    this.#retryTimer = undefined;
    this.#scheduleDeadline(snapshot.wait?.wakeAt);
    this.#handleOwnerProposalResolution(snapshot, decision);
    if (decision.kind === "complete") this.#dispatchNewPurposeCompletionWake();
    if (decision.kind === "act") {
      this.#abortActiveBody("action_revision_changed");
      this.#replacementTail = this.#replacementTail
        .catch(() => undefined)
        .then(() => this.#replaceBodyOperation(snapshot, decision));
      return;
    }
    if (decision.kind === "wait" || decision.kind === "complete") {
      this.#abortActiveBody("action_revision_changed");
      this.#replacementTail = this.#replacementTail
        .catch(() => undefined)
        .then(() => this.#stopPrimaryOperation("action_revision_changed"));
    }
  }

  #dispatchNewPurposeCompletionWake(): void {
    const state = this.options.mind.purposeCompletionWakeState();
    if (state.sequence <= this.#handledPurposeCompletionWakeSequence) return;
    this.#handledPurposeCompletionWakeSequence = state.sequence;
    if (state.pendingEvent === undefined) return;
    this.#requestThought(
      state.pendingEvent.kind,
      state.pendingEvent.summary,
      true,
    );
  }

  #rememberPendingOwnerProposals(snapshot: PlayerRuntimeSnapshot): void {
    for (const proposal of snapshot.proposals) {
      if (proposal.status === "pending")
        this.#ownerProposalsAwaitingResolution.add(proposal.id);
    }
    while (this.#ownerProposalsAwaitingResolution.size > 16) {
      const oldest = this.#ownerProposalsAwaitingResolution
        .values()
        .next().value;
      if (oldest === undefined) break;
      this.#ownerProposalsAwaitingResolution.delete(oldest);
    }
  }

  #handleOwnerProposalResolution(
    snapshot: PlayerRuntimeSnapshot,
    decision: PlayerThoughtDecision,
  ): void {
    if (
      this.#shuttingDown ||
      snapshot.stopped ||
      this.options.mind.snapshot().stopped
    )
      return;
    const latestJudgment = snapshot.recentJudgments.at(-1);
    const directlyResolvedId =
      latestJudgment?.kind === decision.kind
        ? latestJudgment.proposalId
        : undefined;
    const resolved = snapshot.proposals.filter(
      ({ id, status, resolution }) =>
        status !== "pending" &&
        resolution !== undefined &&
        (this.#ownerProposalsAwaitingResolution.has(id) ||
          id === directlyResolvedId),
    );
    const proposal =
      resolved.find(({ id }) => id === directlyResolvedId) ??
      (resolved.length === 1 ? resolved[0] : undefined);
    if (proposal === undefined) return;
    this.#ownerProposalsAwaitingResolution.delete(proposal.id);

    if (decision.kind === "act" && decision.operation.kind === "consume") {
      this.#ownerConsumeOperations.add(decision.operationId);
      while (this.#ownerConsumeOperations.size > 16) {
        const oldest = this.#ownerConsumeOperations.values().next().value;
        if (oldest === undefined) break;
        this.#ownerConsumeOperations.delete(oldest);
      }
    }

    const resolution = sanitizeDetail(proposal.resolution ?? "");
    if (resolution.length === 0) return;
    void this.#sayWhileActive(resolution);
  }

  async #sayWhileActive(message: string): Promise<void> {
    if (this.#shuttingDown || this.options.mind.snapshot().stopped) return;
    await this.#safeSay(message);
  }

  private onBodyEvent(event: PlayerBodyEvent): void {
    if (this.#shuttingDown) return;
    const bodyEvent = event as unknown as Record<string, unknown>;
    const type =
      typeof bodyEvent.type === "string" ? bodyEvent.type : "unknown";
    const at =
      typeof bodyEvent.at === "string"
        ? bodyEvent.at
        : new Date().toISOString();
    if (event.type === "damage_reflex_started") return;
    if (event.type === "damage_reflex_completed") {
      this.#queueDamageReflexOutcome(event);
      return;
    }
    if (event.type === "bot_damaged") {
      const damageAt = Date.parse(event.at);
      this.#lastDamageEventAtMs = Number.isFinite(damageAt)
        ? damageAt
        : Date.now();
      const invalidateDecision =
        this.#activeThought !== undefined &&
        !this.#activeThoughtCommitted &&
        !this.#activeThoughtDamageAware &&
        !this.#activeThoughtDeathAware &&
        !this.#activeThoughtDamageInvalidated;
      if (invalidateDecision) this.#activeThoughtDamageInvalidated = true;
      this.enqueueAndWake(
        "bot_damaged",
        damageEventSummary(event.source, event.confidence),
        event.at,
        "bot_damaged",
        damageObservationCoalesceMs,
        { invalidateDecision, damageAware: true },
      );
      return;
    }
    if (event.type === "bot_death_cause_updated") {
      const updated = this.options.mind.recordDeathCauseUpdate(
        event.deathAt,
        event.cause,
        deathCauseUpdateSummary(event.cause),
        event.at,
      );
      if (updated !== undefined)
        this.#requestThought(updated.kind, updated.summary, false, false, true);
      return;
    }
    if (type === "operation_started") {
      const active = this.#activeBody;
      if (
        active !== undefined &&
        bodyEvent.operation === active.operation.kind
      ) {
        const bodyOperationId =
          typeof bodyEvent.operationId === "string"
            ? bodyEvent.operationId
            : undefined;
        this.#advanceBodyOperationPhase(active, {
          phase: "admitted",
          at,
          admissionObserved: true,
          ...(bodyOperationId === undefined ? {} : { bodyOperationId }),
        });
        // The adapter generates its own operationId; the runtime's durable ID is the action identity.
        this.options.mind.markOperationStarted(active.operationId, at);
      }
      return;
    }
    if (type === "operation_admission_waiting") {
      const active = this.#activeBody;
      if (active !== undefined && bodyEvent.operation === active.operation.kind)
        this.#advanceBodyOperationPhase(active, {
          phase: "admission_waiting",
          at,
        });
      return;
    }
    if (type === "operation_dispatched") {
      const active = this.#activeBody;
      if (
        active !== undefined &&
        bodyEvent.operation === active.operation.kind &&
        bodyEvent.operationId ===
          this.#latestBodyOperationPhase?.bodyOperationId
      )
        this.#advanceBodyOperationPhase(active, {
          phase: "dispatch_entered",
          at,
        });
      return;
    }
    if (type === "operation_path_updated") {
      const active = this.#activeBody;
      const latest = this.#latestBodyOperationPhase;
      if (
        active !== undefined &&
        latest?.firstPathStatus === undefined &&
        bodyEvent.operation === active.operation.kind &&
        bodyEvent.operationId === latest?.bodyOperationId &&
        (bodyEvent.status === "noPath" ||
          bodyEvent.status === "timeout" ||
          bodyEvent.status === "success" ||
          bodyEvent.status === "partial")
      )
        this.#advanceBodyOperationPhase(active, {
          phase: "path_progress",
          at,
          firstPathStatus: bodyEvent.status,
        });
      return;
    }
    if (type === "operation_completed" || type === "operation_failed") {
      // The execute promise carries before/after observations and creates the trusted receipt.
      return;
    }
    if (type === "operation_stalled") {
      const operation =
        typeof bodyEvent.operation === "string"
          ? bodyEvent.operation
          : "operation";
      const elapsed =
        typeof bodyEvent.elapsedMs === "number"
          ? Math.max(0, Math.floor(bodyEvent.elapsedMs))
          : 0;
      this.enqueueAndWake(
        "operation_stalled",
        `${operation} が ${elapsed}ms 以上続き、進捗を再評価`,
        at,
      );
      return;
    }
    if (type === "bot_death") {
      if (event.type !== "bot_death") return;
      const deathWakeAlreadyAware =
        this.#activeThoughtDeathAware ||
        this.#activeThoughtDeathInvalidated ||
        this.#pendingThoughtWake?.deathAware === true;
      const invalidateDecision = !deathWakeAlreadyAware;
      if (invalidateDecision && this.#activeThought !== undefined)
        this.#activeThoughtDeathInvalidated = true;
      this.options.memory.recordEpisode({
        summary: "Bot自身がMinecraft内で死亡したことを観測",
        status: "observed",
        operationKind: "bot_death",
      });
      this.enqueueAndWake(
        "bot_death",
        deathEventSummary(event.cause),
        at,
        "bot_death",
        0,
        {
          invalidateDecision,
          deathAware: true,
          ...(event.cause === undefined ? {} : { deathCause: event.cause }),
        },
      );
      return;
    }
    if (type === "reconnected") {
      this.#bodyConnected = true;
      this.#bodyNeedsRecovery = false;
      void this.#sampleSemanticState();
      this.#startSampler();
      this.enqueueAndWake("reconnected", "Minecraftへの再接続を観測", at);
      return;
    }
    if (type === "operation_recovery_required") {
      const operation =
        typeof bodyEvent.operation === "string"
          ? bodyEvent.operation
          : "operation";
      const operationId =
        typeof bodyEvent.operationId === "string"
          ? bodyEvent.operationId
          : "unknown-operation";
      this.#requestBodyRecovery(operationId, operation);
      this.options.logger.warn(
        {
          category: "player_runtime",
          code: "BODY_RECOVERY_REQUIRED",
          operation,
        },
        "body operation awaits Minecraft reconnect",
      );
      return;
    }
    if (type === "disconnected") {
      this.#bodyConnected = false;
      this.#stopSampler();
      this.options.mind.enqueueEvent(
        "state_changed",
        "Minecraft接続が切断され、再接続を待機",
      );
      return;
    }
    if (type === "state_changed") {
      void this.#sampleSemanticState();
    }
  }

  private enqueueAndWake(
    kind: PlayerWakeKind,
    summary: string,
    at: string,
    key: string = kind,
    minimumGapMs = 3_000,
    options: {
      readonly invalidateDecision?: boolean;
      readonly deathCause?: PlayerBodyDeathCause;
      readonly damageAware?: boolean;
      readonly deathAware?: boolean;
    } = {},
  ): boolean {
    const now = Date.parse(at);
    const previous = this.#eventTimes.get(key) ?? 0;
    if (Number.isFinite(now) && now - previous < minimumGapMs) {
      if (kind === "bot_damaged" && options.invalidateDecision === true) {
        const event = this.options.mind.enqueueEvent(kind, summary, {
          invalidateDecision: true,
        });
        this.#requestThought(kind, event.summary, false, true);
        return true;
      }
      if (kind === "state_changed" && summary.includes("vitals")) {
        this.options.mind.enqueueEvent(kind, summary);
        this.#scheduleVitalsWake(Math.max(1, minimumGapMs - (now - previous)));
        return true;
      }
      return false;
    }
    this.#eventTimes.set(key, Number.isFinite(now) ? now : Date.now());
    const deferObservation =
      kind === "state_changed" &&
      !summary.includes("vitals") &&
      this.#activeThought !== undefined;
    const invalidateDecision = options.invalidateDecision ?? !deferObservation;
    const event =
      kind === "bot_death"
        ? this.options.mind.recordDeathEvent(at, summary, options.deathCause, {
            invalidateDecision,
          })
        : this.options.mind.enqueueEvent(kind, summary, { invalidateDecision });
    this.#requestThought(
      kind,
      event.summary,
      false,
      options.damageAware ?? false,
      options.deathAware ?? false,
    );
    return true;
  }

  #requestThought(
    kind: PlayerWakeKind,
    reason: string,
    acceptedPendingWake = false,
    damageAwareWake = false,
    deathAwareWake = false,
  ): void {
    if (this.#shuttingDown || this.options.mind.snapshot().stopped) return;
    if (isUrgentPerceptionWake(kind) && this.#retryTimer !== undefined) {
      this.#queueThoughtWake(kind, reason, damageAwareWake, deathAwareWake);
      return;
    }
    const current = this.options.mind.snapshot();
    if (
      !acceptedPendingWake &&
      current.wait !== undefined &&
      !current.wait.wakeOn.includes(kind) &&
      kind !== "deadline" &&
      kind !== "owner_proposal" &&
      !isUrgentPerceptionWake(kind)
    )
      return;
    if (
      !acceptedPendingWake &&
      current.wait?.wakeAt !== undefined &&
      Date.parse(current.wait.wakeAt) > Date.now() &&
      kind !== "owner_proposal" &&
      kind !== "manual" &&
      !isUrgentPerceptionWake(kind)
    )
      return;
    const activeThought = this.#activeThought;
    if (activeThought !== undefined) {
      this.#queueThoughtWake(kind, reason, damageAwareWake, deathAwareWake);
      if (kind === "owner_proposal") {
        if (this.#activeResponsesRequest) {
          this.#boundOwnerProposalSettlement(activeThought);
        } else {
          this.#clearOwnerProposalSettlement(activeThought);
          activeThought.abort(new Error("owner_proposal_preempted_thought"));
        }
      } else if (
        !this.#activeThoughtCommitted &&
        kind !== "body_outcome" &&
        !isUrgentPerceptionWake(kind) &&
        (kind !== "state_changed" || reason.includes("vitals"))
      ) {
        // Body outcomes advance CAS but let the in-flight request settle; its
        // stale commit will be rejected before the queued outcome is retried.
        activeThought.abort(new Error(`new_event_preempted_thought:${kind}`));
      }
      return;
    }
    const controller = new AbortController();
    this.#activeThought = controller;
    this.#activeThoughtStartedAtMs = Date.now();
    this.#activeThoughtCommitted = false;
    this.#activeThoughtDamageAware = kind === "bot_damaged" || damageAwareWake;
    this.#activeThoughtDamageInvalidated = false;
    this.#activeThoughtDeathAware =
      kind === "bot_death" ||
      kind === "bot_death_cause_updated" ||
      deathAwareWake;
    this.#activeThoughtDeathInvalidated = false;
    this.#activeResponsesRequest = false;
    this.#activeResponsesRequestStartedAtMs = undefined;
    const events = this.options.mind.pendingEvents(32);
    let retry = false;
    let immediateRevisionRetry = false;
    void this.#traceCall("autonomous purpose thought", async () => {
      try {
        const result = await this.options.purpose.think({
          snapshot: current,
          events:
            events.length === 0
              ? [
                  {
                    id: randomUUID(),
                    kind,
                    summary: reason,
                    createdAt: new Date().toISOString(),
                  },
                ]
              : events,
          urgentPerceptionWake:
            isUrgentPerceptionWake(kind) || damageAwareWake || deathAwareWake,
          signal: AbortSignal.any([controller.signal, this.#lifetime.signal]),
          shouldStopAfterResponse: () =>
            this.#pendingThoughtWake?.kind === "body_outcome" ||
            this.#pendingThoughtWake?.kind === "owner_proposal" ||
            this.#activeThoughtDamageInvalidated ||
            this.#activeThoughtDeathInvalidated,
          onResponsesRequestState: (active) => {
            if (this.#activeThought === controller) {
              this.#activeResponsesRequest = active;
              this.#activeResponsesRequestStartedAtMs = active
                ? Date.now()
                : undefined;
            }
          },
        });
        if (
          !result.accepted &&
          !controller.signal.aborted &&
          !this.options.mind.snapshot().stopped
        ) {
          retry = true;
          if (
            this.options.mind.snapshot().revision !== current.revision &&
            !this.#revisionRetryUsed
          ) {
            this.#revisionRetryUsed = true;
            immediateRevisionRetry = true;
          }
        }
      } catch (error) {
        if (
          !controller.signal.aborted &&
          !this.#lifetime.signal.aborted &&
          !this.options.mind.snapshot().stopped
        ) {
          this.#logFailure("PLAYER_PURPOSE_THOUGHT_FAILED", error);
          retry = true;
        }
      }
    })
      .catch((error: unknown) => {
        this.#logFailure("PLAYER_THOUGHT_TRACE_FAILED", error);
        retry =
          !controller.signal.aborted && !this.options.mind.snapshot().stopped;
      })
      .finally(() =>
        this.#finishThought(controller, retry, immediateRevisionRetry),
      );
  }

  #queueThoughtWake(
    kind: PlayerWakeKind,
    reason: string,
    damageAware = false,
    deathAware = false,
  ): void {
    const pending = this.#pendingThoughtWake;
    const priority = (wake: PlayerWakeKind): number =>
      wake === "owner_proposal"
        ? 5
        : wake === "body_outcome"
          ? 4
          : isUrgentPerceptionWake(wake)
            ? 3
            : wake === "operation_stalled"
              ? 2
              : 1;
    const mergedAwareness = {
      damageAware: damageAware || pending?.damageAware === true,
      deathAware: deathAware || pending?.deathAware === true,
    };
    if (pending !== undefined && priority(pending.kind) > priority(kind)) {
      this.#pendingThoughtWake = { ...pending, ...mergedAwareness };
      return;
    }
    this.#pendingThoughtWake = {
      kind,
      reason,
      ...mergedAwareness,
    };
  }

  #finishThought(
    controller: AbortController,
    retry: boolean,
    immediateRevisionRetry = false,
  ): void {
    if (this.#activeThought !== controller) return;
    this.#clearOwnerProposalSettlement(controller);
    this.#activeThought = undefined;
    this.#activeThoughtStartedAtMs = undefined;
    this.#activeThoughtCommitted = false;
    this.#activeThoughtDamageAware = false;
    this.#activeThoughtDamageInvalidated = false;
    this.#activeThoughtDeathAware = false;
    this.#activeThoughtDeathInvalidated = false;
    this.#activeResponsesRequest = false;
    this.#activeResponsesRequestStartedAtMs = undefined;
    const reflexWake = this.#persistPendingDamageReflexOutcome();
    if (reflexWake !== undefined)
      this.#queueThoughtWake("body_outcome", reflexWake, true, true);
    if (this.#shuttingDown || this.options.mind.snapshot().stopped) {
      this.#pendingThoughtWake = undefined;
      return;
    }
    if (
      this.#pendingThoughtWake?.kind === "body_outcome" ||
      this.#pendingThoughtWake?.kind === "owner_proposal"
    ) {
      this.#dispatchPendingThought();
      return;
    }
    if (retry) {
      this.#retryThought(immediateRevisionRetry);
      return;
    }
    this.#dispatchPendingThought();
  }

  #dispatchPendingThought(): void {
    const pending = this.#pendingThoughtWake;
    if (pending === undefined) return;
    this.#pendingThoughtWake = undefined;
    // The event already passed its wait/deadline gate when queued. A newer
    // thought may have committed a different wait since then; honor this
    // accepted wake once against the latest snapshot without widening gates.
    this.#requestThought(
      pending.kind,
      pending.reason,
      true,
      pending.damageAware,
      pending.deathAware,
    );
  }

  #queueDamageReflexOutcome(event: DamageReflexCompletedEvent): void {
    const pending = this.#pendingDamageReflexOutcome;
    const confirmed =
      event.status === "successful" &&
      event.sameLife === true &&
      event.serverConfirmedAt !== null
        ? event
        : pending?.confirmed;
    this.#pendingDamageReflexOutcome = {
      latest: event,
      ...(confirmed === undefined ? {} : { confirmed }),
      count: (pending?.count ?? 0) + 1,
    };
    if (this.#activeThought !== undefined) return;
    const summary = this.#persistPendingDamageReflexOutcome();
    if (summary !== undefined)
      this.#requestThought("body_outcome", summary, true, true);
  }

  #persistPendingDamageReflexOutcome(): string | undefined {
    const pending = this.#pendingDamageReflexOutcome;
    if (pending === undefined) return undefined;
    const results = [pending.confirmed, pending.latest].filter(
      (event, index, all): event is DamageReflexCompletedEvent =>
        event !== undefined && all.indexOf(event) === index,
    );
    const summary = `damage-reflex events=${pending.count}; ${results
      .map(damageReflexEvidenceSummary)
      .join("; ")}`;
    for (const [index, event] of results.entries()) {
      const evidenceSummary = `damage-reflex ${damageReflexEvidenceSummary(event)}`;
      if (event.operationKind !== null) {
        this.options.mind.recordOutcome({
          evidence: {
            operationId: `damage-reflex:${event.startedAt}:${index}`,
            kind: event.operationKind,
            status: event.status,
            summary: evidenceSummary,
            observedAt: event.at,
          },
        });
      }
      this.options.memory.recordEpisode({
        summary: `身体反射の結果: ${evidenceSummary}`,
        status: event.status,
        operationKind: event.operationKind ?? "damage_reflex",
      });
    }
    this.options.mind.enqueueEvent("body_outcome", summary, {
      invalidateDecision: false,
    });
    this.#pendingDamageReflexOutcome = undefined;
    return summary;
  }

  async #replaceBodyOperation(
    snapshot: PlayerRuntimeSnapshot,
    decision: Extract<PlayerThoughtDecision, { kind: "act" }>,
  ): Promise<void> {
    const running = this.#activeBody;
    if (running !== undefined)
      await this.#settleBody(running, "body_operation_replaced");
    const latest = this.options.mind.snapshot();
    const guardReason = this.#bodyOperationGuardReason(
      latest,
      snapshot.actionRevision,
      decision.operationId,
    );
    if (guardReason !== undefined) {
      this.#recordBodyOperationGuardRejection(
        decision,
        snapshot.actionRevision,
        guardReason,
      );
      return;
    }
    if (this.#bodyNeedsRecovery || !this.#bodyConnected) {
      this.#recordBodyOperationGuardRejection(
        decision,
        snapshot.actionRevision,
        this.#bodyNeedsRecovery
          ? "body_recovery_required"
          : "body_disconnected",
      );
      this.options.mind.deferOperationUntilReconnect(decision.operationId);
      return;
    }
    const controller = new AbortController();
    const run: ActiveBodyRun = {
      operationId: decision.operationId,
      actionRevision: snapshot.actionRevision,
      operation: decision.operation,
      ...(decision.skillId === undefined ? {} : { skillId: decision.skillId }),
      ...(decision.skillVersion === undefined
        ? {}
        : { skillVersion: decision.skillVersion }),
      controller,
      promise: Promise.resolve(),
    };
    this.#recordBodyOperationPhase({
      runtimeOperationId: run.operationId,
      actionRevision: run.actionRevision,
      operation: run.operation.kind,
      phase: "execute_requested",
      at: new Date().toISOString(),
      admissionObserved: false,
      controlEnabledCount: enabledControlCount(run.operation),
    });
    this.#activeBody = run;
    run.promise = this.#executeBody(
      run,
      decision.operation,
      decision.expectedOutcome,
    );
    await run.promise;
  }

  #bodyOperationGuardReason(
    latest: PlayerRuntimeSnapshot,
    expectedActionRevision: number,
    operationId: string,
  ):
    | Exclude<
        RuntimeBodyOperationPhase["reason"],
        null | "execution_returned_without_admission"
      >
    | undefined {
    if (this.#shuttingDown) return "runtime_shutting_down";
    if (latest.stopped) return "owner_stopped";
    if (latest.actionRevision !== expectedActionRevision)
      return "action_revision_changed";
    if (latest.activeOperation?.operationId !== operationId)
      return "operation_replaced";
    return undefined;
  }

  #recordBodyOperationGuardRejection(
    decision: Extract<PlayerThoughtDecision, { kind: "act" }>,
    actionRevision: number,
    reason: Exclude<
      RuntimeBodyOperationPhase["reason"],
      null | "execution_returned_without_admission"
    >,
  ): void {
    this.#recordBodyOperationPhase({
      runtimeOperationId: decision.operationId,
      actionRevision,
      operation: decision.operation.kind,
      phase: "guard_rejected",
      at: new Date().toISOString(),
      admissionObserved: false,
      reason,
      firstPathStatus: null,
      controlEnabledCount: enabledControlCount(decision.operation),
    });
  }

  #recordBodyOperationPhase(phase: LatestBodyOperationPhase): void {
    this.#latestBodyOperationPhase = phase;
    this.options.logger.info(
      {
        category: "player_runtime",
        code: "BODY_OPERATION_PHASE",
        operationId: phase.runtimeOperationId,
        actionRevision: phase.actionRevision,
        operation: phase.operation,
        phase: phase.phase,
        at: phase.at,
        admissionObserved: phase.admissionObserved,
        status: phase.status ?? null,
        reason: phase.reason ?? null,
        firstPathStatus: phase.firstPathStatus ?? null,
        controlEnabledCount: phase.controlEnabledCount,
      },
      "player body operation phase",
    );
  }

  #advanceBodyOperationPhase(
    run: ActiveBodyRun,
    update: Pick<LatestBodyOperationPhase, "phase" | "at"> &
      Partial<
        Pick<
          LatestBodyOperationPhase,
          | "bodyOperationId"
          | "admissionObserved"
          | "status"
          | "reason"
          | "firstPathStatus"
        >
      >,
  ): void {
    const latest = this.#latestBodyOperationPhase;
    if (
      latest?.runtimeOperationId !== run.operationId ||
      latest.actionRevision !== run.actionRevision
    )
      return;
    this.#recordBodyOperationPhase({ ...latest, ...update });
  }

  async #executeBody(
    run: ActiveBodyRun,
    operation: Parameters<PlayerBody["execute"]>[0],
    expectedOutcome: string,
  ): Promise<void> {
    const reportOwnerConsume = this.#ownerConsumeOperations.delete(
      run.operationId,
    );
    const reportEquip = operation.kind === "equip" ? operation : undefined;
    let result: PlayerOperationResult | undefined;
    try {
      result = await this.options.body.execute(
        operation,
        run.controller.signal,
      );
    } catch (error) {
      this.#logFailure("PLAYER_BODY_OPERATION_FAILED", error);
    }
    if (result?.recoveryRequired)
      this.#requestBodyRecovery(result.operationId, operation.kind);
    const outcome: McSkillOutcomeStatus =
      result?.status ??
      (run.controller.signal.aborted ? "interrupted" : "unverified");
    const summary =
      result === undefined
        ? run.controller.signal.aborted
          ? "操作を中断し、実行終了を確認"
          : "操作toolが結果を返さず、ゲーム内結果は未検証"
        : groundedOperationSummary(result, expectedOutcome);
    const observedAt = result?.completedAt ?? new Date().toISOString();
    const movementDelta =
      result === undefined ? undefined : observedMovementDelta(result);
    if (result?.after != null)
      this.options.mind.recordObservation(toObservationEvidence(result.after));
    const evidenceInput = {
      runId: run.operationId,
      operationName: operation.kind,
      inputSummary: `operation=${operation.kind}`,
      conditions: trustedConditions(result?.before ?? null),
      expectedOutcome: expectedOutcome.trim() || "目的に沿うゲーム内変化を観測",
      observedOutcome: outcome,
      observationSummary: summary,
      observedAt,
      ...(run.skillId === undefined ? {} : { skillIdAtUse: run.skillId }),
      ...(run.skillVersion === undefined
        ? {}
        : { skillVersionAtUse: run.skillVersion }),
    };
    let skillId = run.skillId;
    let skillVersion = run.skillVersion;
    try {
      const receipt = this.options.skills.recordTrustedEvidence(evidenceInput);
      skillId = receipt.skillIdAtUse;
      skillVersion = receipt.skillVersionAtUse;
      if (skillId !== undefined) {
        this.options.skills.recordOutcome({
          skillId,
          runId: run.operationId,
          proposedOutcome: outcome,
          summary,
        });
      }
    } catch (error) {
      this.#logFailure("PLAYER_SKILL_EVIDENCE_FAILED", error);
    }
    this.options.memory.recordEpisode({
      summary: `${operation.kind} の観測結果: ${outcome}`,
      status: outcome,
      operationKind: operation.kind,
    });
    const recoveryRequired = result?.recoveryRequired === true;
    const saved = this.options.mind.recordOutcome({
      evidence: {
        operationId: run.operationId,
        kind: operation.kind,
        status: outcome,
        summary,
        observedAt,
        ...(movementDelta === undefined ? {} : { movementDelta }),
        ...(result?.lookSweep === undefined
          ? {}
          : { lookSweep: result.lookSweep }),
        expectedOutcome,
        ...(skillId === undefined ? {} : { skillId }),
        ...(skillVersion === undefined ? {} : { skillVersion }),
      },
      recoveryRequired,
    });
    this.#advanceBodyOperationPhase(run, {
      phase: "result",
      at: observedAt,
      status: outcome,
      reason:
        this.#latestBodyOperationPhase?.runtimeOperationId ===
          run.operationId && !this.#latestBodyOperationPhase.admissionObserved
          ? "execution_returned_without_admission"
          : null,
    });
    if (this.#activeBody === run) this.#activeBody = undefined;
    if (reportOwnerConsume && !saved.stopped && !this.#shuttingDown)
      await this.#sayWhileActive(ownerConsumeOutcomeMessage(result, outcome));
    if (
      reportEquip !== undefined &&
      !saved.stopped &&
      !this.#shuttingDown &&
      this.#shouldReportEquipmentOutcome(reportEquip, result, outcome)
    )
      await this.#sayWhileActive(
        equipmentOutcomeMessage(reportEquip, result, outcome),
      );
    if (
      !recoveryRequired &&
      !saved.stopped &&
      saved.activeOperation === undefined &&
      saved.lastOutcome?.operationId === run.operationId
    ) {
      // recordOutcome has already inserted the body_outcome event and revision.
      this.#requestThought("body_outcome", summary);
    } else if (recoveryRequired && this.#bodyConnected && !saved.stopped) {
      // A very fast reconnect may precede the bounded execute result; wake after its durable wait is recorded.
      const event = this.options.mind.enqueueEvent(
        "reconnected",
        "Minecraftの新しい接続で中断操作の復旧を確認",
      );
      this.#requestThought(event.kind, event.summary);
    }
  }

  #shouldReportEquipmentOutcome(
    operation: Extract<PlayerOperation, { kind: "equip" }>,
    result: PlayerOperationResult | undefined,
    outcome: McSkillOutcomeStatus,
  ): boolean {
    const resultMatches =
      result?.operation.kind === "equip" &&
      result.operation.item === operation.item &&
      result.operation.destination === operation.destination;
    const before = equipmentSlotObservation(
      resultMatches ? result.before : null,
      operation.destination,
    );
    const after = equipmentSlotObservation(
      resultMatches ? result.after : null,
      operation.destination,
    );
    const equipmentChanged =
      before.state !== "unobserved" &&
      after.state !== "unobserved" &&
      JSON.stringify(before) !== JSON.stringify(after);
    const successful =
      outcome === "successful" &&
      after.state === "item" &&
      after.itemName === operation.item;
    const signature = JSON.stringify({
      item: operation.item,
      destination: operation.destination,
      outcome,
      detail:
        result?.detail === undefined ? null : sanitizeDetail(result.detail),
      failureReason: result?.failureReason ?? null,
      sameLife: result?.sameLife ?? null,
      recoveryRequired: result?.recoveryRequired ?? false,
      before,
      after,
    });
    const state = this.#equipmentOutcomeNotifications.get(
      operation.destination,
    ) ?? {
      failedSignatures: new Set<string>(),
      lastSuccessfulSignature: undefined,
    };

    if (equipmentChanged) {
      state.failedSignatures.clear();
      state.lastSuccessfulSignature = undefined;
    }
    if (successful) {
      if (state.lastSuccessfulSignature === signature) return false;
      state.failedSignatures.clear();
      state.lastSuccessfulSignature = signature;
      this.#equipmentOutcomeNotifications.set(operation.destination, state);
      return true;
    }

    state.lastSuccessfulSignature = undefined;
    if (state.failedSignatures.has(signature)) return false;
    state.failedSignatures.add(signature);
    while (state.failedSignatures.size > 12) {
      const oldest = state.failedSignatures.values().next().value;
      if (oldest === undefined) break;
      state.failedSignatures.delete(oldest);
    }
    this.#equipmentOutcomeNotifications.set(operation.destination, state);
    return true;
  }

  async #stopBody(reason: string): Promise<void> {
    this.#setDamageReflexEnabled(false);
    const running = this.#activeBody;
    if (running !== undefined) await this.#settleBody(running, reason);
    try {
      await this.options.body.stop();
    } catch (error) {
      this.#logFailure("PLAYER_BODY_STOP_FAILED", error);
    }
  }

  async #stopPrimaryOperation(reason: string): Promise<void> {
    const running = this.#activeBody;
    if (running !== undefined) await this.#settleBody(running, reason);
  }

  async #settleBody(run: ActiveBodyRun, reason: string): Promise<void> {
    run.controller.abort(new Error(reason));
    try {
      if (this.options.body.stopActiveOperation !== undefined)
        await this.options.body.stopActiveOperation();
      else await this.options.body.stop();
    } catch (error) {
      this.#logFailure("PLAYER_BODY_CANCEL_FAILED", error);
    }
    try {
      await run.promise;
    } catch {
      /* Operation result persistence is handled inside the body owner. */
    }
    if (this.#activeBody === run) this.#activeBody = undefined;
  }

  #setDamageReflexEnabled(enabled: boolean): void {
    try {
      this.options.body.setDamageReflexEnabled?.(enabled);
    } catch (error) {
      this.#logFailure(
        enabled
          ? "PLAYER_DAMAGE_REFLEX_ENABLE_FAILED"
          : "PLAYER_DAMAGE_REFLEX_DISABLE_FAILED",
        error,
      );
    }
  }

  #abortActiveBody(reason: string): void {
    const active = this.#activeBody;
    if (active !== undefined) active.controller.abort(new Error(reason));
  }

  #requestBodyRecovery(operationId: string, operation: string): void {
    if (this.#recoveryRequestedOperationIds.has(operationId)) return;
    this.#recoveryRequestedOperationIds.add(operationId);
    if (this.#recoveryRequestedOperationIds.size > 16) {
      const oldest = this.#recoveryRequestedOperationIds.values().next().value;
      if (oldest !== undefined)
        this.#recoveryRequestedOperationIds.delete(oldest);
    }
    this.#bodyNeedsRecovery = true;
    if (this.options.requestReconnect === undefined) return;
    try {
      void Promise.resolve(
        this.options.requestReconnect("player-operation-recovery"),
      ).catch((error: unknown) =>
        this.#logFailure("PLAYER_RECONNECT_REQUEST_FAILED", error),
      );
    } catch (error) {
      this.#logFailure("PLAYER_RECONNECT_REQUEST_FAILED", error);
    }
    this.options.logger.info(
      {
        category: "player_runtime",
        code: "BODY_RECONNECT_REQUESTED",
        operation,
      },
      "requesting recovery through the connection manager",
    );
  }

  #cancelThought(reason: string): void {
    const thought = this.#activeThought;
    this.#clearOwnerProposalSettlement(thought);
    this.#activeResponsesRequest = false;
    this.#activeResponsesRequestStartedAtMs = undefined;
    this.#pendingThoughtWake = undefined;
    this.#activeThoughtCommitted = false;
    this.#activeThoughtDamageAware = false;
    this.#activeThoughtDamageInvalidated = false;
    thought?.abort(new Error(reason));
  }

  #boundOwnerProposalSettlement(controller: AbortController): void {
    if (
      controller.signal.aborted ||
      this.#ownerProposalSettlementTimer !== undefined
    )
      return;
    this.#ownerProposalSettlementThought = controller;
    this.#ownerProposalSettlementTimer = setTimeout(() => {
      this.#ownerProposalSettlementTimer = undefined;
      this.#ownerProposalSettlementThought = undefined;
      if (
        this.#activeThought === controller &&
        this.#pendingThoughtWake?.kind === "owner_proposal" &&
        !controller.signal.aborted
      )
        controller.abort(new Error("owner_proposal_settlement_timeout"));
    }, ownerProposalSettlementTimeoutMs);
    this.#ownerProposalSettlementTimer.unref();
  }

  #clearOwnerProposalSettlement(controller?: AbortController): void {
    if (
      controller !== undefined &&
      this.#ownerProposalSettlementThought !== controller
    )
      return;
    if (this.#ownerProposalSettlementTimer !== undefined)
      clearTimeout(this.#ownerProposalSettlementTimer);
    this.#ownerProposalSettlementTimer = undefined;
    this.#ownerProposalSettlementThought = undefined;
  }

  async #sampleSemanticState(): Promise<void> {
    if (
      this.options.mind.snapshot().stopped ||
      this.#shuttingDown ||
      !this.#bodyConnected
    )
      return;
    if (this.#samplePromise !== undefined) return this.#samplePromise;
    const sampling = (async () => {
      try {
        const observation = await this.options.body.observe();
        if (this.options.mind.snapshot().stopped || this.#shuttingDown) return;
        this.options.mind.recordObservation(toObservationEvidence(observation));
        const next = semanticSignatures(observation);
        const changed: string[] = [];
        for (const [kind, signature] of Object.entries(next)) {
          const previous = this.#semanticSignatures.get(kind);
          this.#semanticSignatures.set(kind, signature);
          if (previous !== undefined && previous !== signature)
            changed.push(kind);
        }
        if (changed.length > 0) {
          const active = this.options.mind.snapshot().activeOperation;
          const meaningful = changed.filter(
            (kind) => kind !== "position" || active === undefined,
          );
          if (meaningful.length > 0) {
            const criticalVitals = meaningful.includes("vitals");
            const damageAlreadyReported =
              criticalVitals &&
              Date.now() - this.#lastDamageEventAtMs <
                damageObservationCoalesceMs;
            if (damageAlreadyReported)
              this.#pendingSemanticChanges.delete("vitals");
            for (const kind of meaningful) {
              if (!(kind === "vitals" && damageAlreadyReported))
                this.#pendingSemanticChanges.add(kind);
            }
          }
        }
        this.#scheduleSemanticOpportunity();
      } catch (error) {
        // Disconnects and transient observation errors are handled by body/reconnect events.
        this.#logFailure("PLAYER_OBSERVATION_FAILED", error);
      }
    })();
    this.#samplePromise = sampling;
    try {
      await sampling;
    } finally {
      if (this.#samplePromise === sampling) this.#samplePromise = undefined;
    }
  }

  #startSampler(): void {
    if (
      this.#sampleTimer !== undefined ||
      this.#shuttingDown ||
      this.options.mind.snapshot().stopped ||
      !this.#bodyConnected
    )
      return;
    // Native events provide the fast path; this bounded cadence detects missed day/entity/world deltas.
    this.#sampleTimer = setInterval(() => {
      void this.#sampleSemanticState();
    }, 15_000);
    this.#sampleTimer.unref();
  }

  #stopSampler(): void {
    if (this.#sampleTimer !== undefined) clearInterval(this.#sampleTimer);
    this.#sampleTimer = undefined;
    if (this.#semanticWakeTimer !== undefined)
      clearTimeout(this.#semanticWakeTimer);
    this.#semanticWakeTimer = undefined;
    if (this.#vitalsWakeTimer !== undefined)
      clearTimeout(this.#vitalsWakeTimer);
    this.#vitalsWakeTimer = undefined;
  }

  #scheduleSemanticOpportunity(): void {
    if (this.#semanticWakeTimer !== undefined)
      clearTimeout(this.#semanticWakeTimer);
    this.#semanticWakeTimer = undefined;
    if (this.#pendingSemanticChanges.size === 0) return;
    if (
      this.#shuttingDown ||
      !this.#bodyConnected ||
      this.options.mind.snapshot().stopped
    )
      return;

    const now = Date.now();
    const kinds = [...this.#pendingSemanticChanges].sort();
    const eligible: string[] = [];
    let nextDelayMs = Number.POSITIVE_INFINITY;
    for (const kind of kinds) {
      const minimumGapMs =
        kind === "vitals" ? 3_000 : kind === "time" ? 60_000 : 12_000;
      const previous = this.#eventTimes.get(`semantic-kind:${kind}`) ?? 0;
      const delayMs = previous + minimumGapMs - now;
      if (delayMs <= 0) eligible.push(kind);
      else nextDelayMs = Math.min(nextDelayMs, delayMs);
    }
    if (eligible.length > 0) {
      const at = new Date(now).toISOString();
      const queued = this.enqueueAndWake(
        "state_changed",
        `観測上の意味のある変化: ${eligible.join(", ")}`,
        at,
        "semantic-opportunity",
        0,
      );
      if (queued) {
        const deliveredAt = Date.now();
        for (const kind of eligible) {
          this.#pendingSemanticChanges.delete(kind);
          this.#eventTimes.set(`semantic-kind:${kind}`, deliveredAt);
        }
      }
      if (this.#pendingSemanticChanges.size === 0) return;
      nextDelayMs = Math.min(
        nextDelayMs,
        queued ? Number.POSITIVE_INFINITY : 1,
      );
    }
    this.#semanticWakeTimer = setTimeout(
      () => {
        this.#semanticWakeTimer = undefined;
        this.#scheduleSemanticOpportunity();
      },
      Math.max(1, nextDelayMs),
    );
    this.#semanticWakeTimer.unref();
  }

  #scheduleVitalsWake(delayMs: number): void {
    if (this.#vitalsWakeTimer !== undefined || this.#shuttingDown) return;
    this.#vitalsWakeTimer = setTimeout(() => {
      this.#vitalsWakeTimer = undefined;
      if (this.options.mind.snapshot().stopped || !this.#bodyConnected) return;
      const event = this.options.mind
        .pendingEvents(64)
        .findLast(
          ({ kind, summary }) =>
            kind === "state_changed" && summary.includes("vitals"),
        );
      if (event !== undefined) this.#requestThought(event.kind, event.summary);
    }, delayMs);
    this.#vitalsWakeTimer.unref();
  }

  #retryThought(immediateRevisionRetry = false): void {
    if (
      this.#retryTimer !== undefined ||
      this.#shuttingDown ||
      this.options.mind.snapshot().stopped
    )
      return;
    const delay = immediateRevisionRetry ? 0 : this.#retryDelayMs;
    if (!immediateRevisionRetry)
      this.#retryDelayMs = Math.min(60_000, Math.round(this.#retryDelayMs * 2));
    this.#retryTimer = setTimeout(() => {
      this.#retryTimer = undefined;
      if (!immediateRevisionRetry) this.#revisionRetryUsed = false;
      if (this.#pendingThoughtWake !== undefined) {
        this.#dispatchPendingThought();
        return;
      }
      const event = this.options.mind.enqueueEvent(
        "manual",
        "自律判断の一時失敗をbackoff後に再試行",
      );
      this.#requestThought(event.kind, event.summary);
    }, delay);
    this.#retryTimer.unref();
  }

  #scheduleDeadline(wakeAt: string | undefined): void {
    if (this.#deadlineTimer !== undefined) clearTimeout(this.#deadlineTimer);
    this.#deadlineTimer = undefined;
    if (
      wakeAt === undefined ||
      this.#shuttingDown ||
      this.options.mind.snapshot().stopped
    )
      return;
    const deadline = Date.parse(wakeAt);
    if (!Number.isFinite(deadline)) return;
    const delay = Math.max(0, Math.min(2_147_000_000, deadline - Date.now()));
    this.#deadlineTimer = setTimeout(() => {
      this.#deadlineTimer = undefined;
      const current = this.options.mind.snapshot();
      if (current.wait?.wakeAt !== wakeAt || current.stopped) return;
      const event = this.options.mind.enqueueEvent(
        "deadline",
        "目的判断で指定した待機期限に到達",
      );
      this.#requestThought(event.kind, event.summary);
    }, delay);
    this.#deadlineTimer.unref();
  }

  async #traceCall<T>(label: string, operation: () => Promise<T>): Promise<T> {
    const trace = this.options.trace;
    if (trace === undefined) return operation();
    let session: TraceSession | undefined;
    try {
      session = await trace.startTrace(label, {
        attributes: { lane: "player_runtime" },
      });
      const result = await trace.withTrace(session, () =>
        trace.withSpan(
          "deliberation",
          label,
          { summary: label, sensitivity: "sensitive" },
          operation,
        ),
      );
      await session.complete("succeeded", { summary: label });
      return result;
    } catch (error) {
      try {
        await session?.complete("failed", { summary: `${label} failed` });
      } catch {
        /* tracing is best effort */
      }
      throw error;
    }
  }

  async #safeSay(message: string): Promise<void> {
    try {
      await this.options.say(message.slice(0, 240));
    } catch (error) {
      this.#logFailure("PLAYER_CHAT_DELIVERY_FAILED", error);
    }
  }

  #recordRecoveryEvidence(input: {
    operationId: string;
    kind: string;
    expectedOutcome?: string;
    skillId?: string;
    skillVersion?: number;
  }): void {
    try {
      const receipt =
        this.options.skills.getEvidence(input.operationId) ??
        this.options.skills.recordTrustedEvidence({
          runId: input.operationId,
          operationName: input.kind,
          inputSummary: `operation=${input.kind}`,
          conditions: [],
          expectedOutcome: input.expectedOutcome ?? "再起動後に操作結果を確認",
          observedOutcome: "unverified",
          observationSummary: "再起動後に実行継続を確認できず、未検証",
          ...(input.skillId === undefined
            ? {}
            : { skillIdAtUse: input.skillId }),
          ...(input.skillVersion === undefined
            ? {}
            : { skillVersionAtUse: input.skillVersion }),
        });
      if (receipt.skillIdAtUse !== undefined) {
        this.options.skills.recordOutcome({
          skillId: receipt.skillIdAtUse,
          runId: input.operationId,
          proposedOutcome: receipt.observedOutcome,
          summary: receipt.observationSummary,
        });
      }
    } catch (error) {
      this.#logFailure("PLAYER_RECOVERY_EVIDENCE_FAILED", error);
    }
  }

  #logFailure(code: string, error: unknown): void {
    this.options.logger.warn(
      {
        category: "player_runtime",
        code,
        errorType: error instanceof Error ? error.name : "UnknownError",
      },
      "player runtime operation failed",
    );
  }
}

function withoutPrivateObservationDetails(
  observation: PlayerObservationEvidence,
): PlayerObservationEvidence {
  const {
    position: _position,
    inventoryItems: _inventoryItems,
    ...visibleEvidence
  } = observation;
  return visibleEvidence;
}

function groundedOperationSummary(
  result: PlayerOperationResult,
  expectedOutcome: string,
): string {
  const before = compactHostileProjection("pre", result.before);
  const after = compactHostileProjection("post", result.after);
  const sameLife =
    result.sameLife === false
      ? "sameLife=false/no-cross-life-delta"
      : result.sameLife === true
        ? "sameLife=true"
        : "sameLife=unknown";
  const parts = [
    ...(result.failureReason === undefined
      ? []
      : [groundedFailureReasonSummary(result.failureReason)]),
    before.core,
    after.core,
    sameLife,
    "client-table only; not a world census; zero or unavailable is not absence; dirs are Minecraft cardinal",
    before.directions,
    after.directions,
    before.occlusion,
    after.occlusion,
    `${result.operation.kind}=${result.status}`,
    ...(result.observedEffect === undefined
      ? []
      : [`effect=${result.observedEffect.type}`]),
    ...(result.detail === undefined
      ? []
      : [`detail=${sanitizeDetail(result.detail).slice(0, 40)}`]),
    observedMovementSummary(result),
    `expected=${sanitizeDetail(expectedOutcome).slice(0, 60)}`,
    "次の判断は実観測で見直す。",
  ];
  let summary = "";
  for (const part of parts) {
    if (part.length === 0) continue;
    const next = summary.length === 0 ? part : `${summary}; ${part}`;
    if (next.length > 680) break;
    summary = next;
  }
  return summary;
}

function groundedFailureReasonSummary(
  failureReason: NonNullable<PlayerOperationResult["failureReason"]>,
): string {
  const itemName = safeDamageToken(failureReason.itemName, 80);
  switch (failureReason.code) {
    case "unknown_registry_item":
      return `failure=unknown_registry_item; registryに${itemName}がありません`;
    case "item_not_in_inventory":
      return `failure=item_not_in_inventory; 所持品に${itemName}がありません`;
    case "no_recipe_for_current_inventory_and_surface":
      return `failure=no_recipe_for_current_inventory_and_surface; 現在の所持品と利用可能な作業面で${itemName}のrecipeなし`;
  }
}

interface CompactHostileProjection {
  readonly core: string;
  readonly directions: string;
  readonly occlusion: string;
}

function compactHostileProjection(
  phase: "pre" | "post",
  observation: PlayerBodyObservation | null,
): CompactHostileProjection {
  if (observation === null)
    return {
      core: `${phase}=unavailable,hp=unknown`,
      directions: `${phase}Dirs=unknown`,
      occlusion: `${phase}Ray=unknown`,
    };
  const health = compactObservedNumber(observation.self.health);
  const nearbyHostiles = observation.perception.nearbyHostiles;
  if (nearbyHostiles === undefined)
    return {
      core: `${phase}=unavailable,hp=${health}`,
      directions: `${phase}Dirs=unknown`,
      occlusion: `${phase}Ray=unknown`,
    };
  const aggregate = nearbyHostiles.aggregate;
  if (aggregate === undefined) {
    const nearestVisible = nearbyHostiles.entities.reduce<number | undefined>(
      (nearest, entity) =>
        nearest === undefined || entity.distance < nearest
          ? entity.distance
          : nearest,
      undefined,
    );
    return {
      core: `${phase}=visible:${compactObservedCount(nearbyHostiles.entities.length)},min=${nearestVisible === undefined ? "unknown" : formatObservedDistance(nearestVisible)},hp=${health}`,
      directions: `${phase}Dirs=unknown`,
      occlusion: `${phase}Ray=unknown`,
    };
  }
  const occupied = aggregate.byDirection
    .filter(({ count }) => count > 0)
    .sort(
      (left, right) =>
        right.count - left.count ||
        left.direction.localeCompare(right.direction),
    );
  const topDirections = occupied
    .slice(0, 2)
    .map(
      ({ direction, count, nearestDistance }) =>
        `${hostileDirectionLabel(direction)}:${compactObservedCount(count)}${nearestDistance === null ? "" : `@${formatObservedDistance(nearestDistance)}`}`,
    )
    .join(",");
  const nearestDistance = occupied.reduce<number | undefined>(
    (nearest, { nearestDistance: candidate }) =>
      candidate === null
        ? nearest
        : nearest === undefined || candidate < nearest
          ? candidate
          : nearest,
    undefined,
  );
  const check = aggregate.occlusionCheck;
  return {
    core: `${phase}=client:${compactObservedCount(aggregate.clientReceivedHostileCount)}/${formatObservedDistance(aggregate.maxDistance)},min=${nearestDistance === undefined ? "unknown" : formatObservedDistance(nearestDistance)},hp=${health}`,
    directions: `${phase}Dirs=${topDirections || "none"}${occupied.length > 2 ? `+${occupied.length - 2}` : ""}`,
    occlusion: `${phase}Ray=check${compactObservedCount(check.candidatesChecked)}/${compactObservedCount(check.candidateLimit)},unocc${compactObservedCount(check.unoccludedCandidates)},occ${compactObservedCount(check.occludedCandidates)},skip${compactObservedCount(check.uncheckedCandidates)},visible${compactObservedCount(nearbyHostiles.entities.length)}`,
  };
}

function hostileDirectionLabel(direction: BodyNearbyHostileDirection): string {
  const labels = {
    north: "N",
    northeast: "NE",
    east: "E",
    southeast: "SE",
    south: "S",
    southwest: "SW",
    west: "W",
    northwest: "NW",
    coincident: "C",
  } as const;
  return labels[direction];
}

function formatObservedDistance(distance: number): string {
  return `${compactObservedNumber(Math.max(0, distance))}m`;
}

function compactObservedNumber(value: number | null | undefined): string {
  if (value === null || value === undefined || !Number.isFinite(value))
    return "unknown";
  const formatted = String(Number(value.toFixed(1)));
  return formatted.length <= 8 ? formatted : "large";
}

function compactObservedCount(value: number): string {
  if (!Number.isFinite(value) || value < 0) return "unknown";
  const formatted = String(Math.trunc(value));
  return formatted.length <= 4 ? formatted : "many";
}

function damageReflexEvidenceSummary(
  event: DamageReflexCompletedEvent,
): string {
  const trigger =
    "trigger" in event && event.trigger === "hostile_approach"
      ? "hostile_approach"
      : "damage";
  return `${event.summary}; operation=${event.operationKind ?? "none"}; status=${event.status}; startedAt=${event.startedAt}; serverConfirmedAt=${event.serverConfirmedAt ?? "unknown"}; trigger=${trigger}; sameLife=${event.sameLife ?? "unknown"}`;
}

function ownerConsumeOutcomeMessage(
  result: PlayerOperationResult | undefined,
  outcome: McSkillOutcomeStatus,
): string {
  const beforeFood = result?.before?.self.food;
  const afterFood = result?.after?.self.food;
  const foodChange =
    beforeFood == null || afterFood == null
      ? ""
      : `実行前food=${beforeFood}、実行後food=${afterFood}。`;
  if (
    result?.operation.kind === "consume" &&
    result.status === "successful" &&
    beforeFood != null &&
    afterFood != null &&
    afterFood > beforeFood &&
    consumeItemCountDecreased(result)
  )
    return `食事操作が成功し、food値が${beforeFood}から${afterFood}へ増えたことを観測しました。体力回復は確認していません。`;

  const statusMessage: Record<McSkillOutcomeStatus, string> = {
    successful:
      "PlayerBodyは成功扱いでしたが、食料アイテムの所持数減少とfood値上昇を揃って確認できませんでした。",
    failed: "食事操作は失敗し、食べられたことを確認できませんでした。",
    interrupted: "食事操作は中断され、成功を確認できませんでした。",
    cancelled: "食事操作は取り消され、成功を確認できませんでした。",
    unverified: "食事操作の結果を検証できず、成功を確認できませんでした。",
  };
  return `${statusMessage[outcome]}${foodChange}原因は観測から特定できていません。`;
}

function equipmentOutcomeMessage(
  operation: Extract<PlayerOperation, { kind: "equip" }>,
  result: PlayerOperationResult | undefined,
  outcome: McSkillOutcomeStatus,
): string {
  const operationMatches =
    result?.operation.kind === "equip" &&
    result.operation.item === operation.item &&
    result.operation.destination === operation.destination;
  const observedEquipment =
    operationMatches && result.after != null
      ? result.after.self.equipment
      : undefined;
  const slotObserved =
    observedEquipment !== undefined &&
    Object.prototype.hasOwnProperty.call(
      observedEquipment,
      operation.destination,
    );
  const equipment = slotObserved
    ? observedEquipment[operation.destination]
    : undefined;
  const equipmentArea = `${equipmentDestinationLabel[operation.destination]}の装備欄`;
  const statusMessage: Record<McSkillOutcomeStatus, string> = {
    successful: "装備操作は成功と判定されました。",
    failed: "装備操作は失敗しました。",
    interrupted: "装備操作は中断されました。",
    cancelled: "装備操作は取り消されました。",
    unverified: "装備操作の結果を確認できていません。",
  };
  const observedMessage = !slotObserved
    ? `実行後の${equipmentArea}は観測できませんでした。`
    : equipment === null
      ? `実行後の${equipmentArea}は空で、${operation.item}は確認できませんでした。`
      : equipment?.name === operation.item
        ? `実行後、${equipmentArea}に${operation.item}があることを観測しました。`
        : equipment === undefined
          ? `実行後の${equipmentArea}は観測できませんでした。`
          : `実行後、${equipmentArea}には${equipment.name}があり、${operation.item}は確認できませんでした。`;
  if (outcome === "successful" && equipment?.name === operation.item)
    return `${statusMessage[outcome]}${observedMessage}`;
  const failureReason = operationMatches ? result.failureReason : undefined;
  const itemMissingFromInventory =
    failureReason?.code === "item_not_in_inventory" &&
    failureReason.itemName === operation.item;
  const reasonMessage = itemMissingFromInventory
    ? `所持品に${operation.item}がありません。`
    : "原因は観測から特定できていません。";
  return `${statusMessage[outcome]}${observedMessage}${reasonMessage}`;
}

function equipmentSlotObservation(
  observation: PlayerBodyObservation | null | undefined,
  destination: Extract<PlayerOperation, { kind: "equip" }>["destination"],
):
  | { readonly state: "unobserved" }
  | { readonly state: "empty" }
  | {
      readonly state: "item";
      readonly itemName: string;
      readonly count: number;
    } {
  if (
    observation === null ||
    observation === undefined ||
    !Object.prototype.hasOwnProperty.call(
      observation.self.equipment,
      destination,
    )
  )
    return { state: "unobserved" };
  const equipment = observation.self.equipment[destination];
  if (equipment === null) return { state: "empty" };
  if (equipment === undefined) return { state: "unobserved" };
  return {
    state: "item",
    itemName: equipment.name,
    count: equipment.count,
  };
}

const equipmentDestinationLabel: Record<
  Extract<PlayerOperation, { kind: "equip" }>["destination"],
  string
> = {
  hand: "手",
  head: "頭",
  torso: "胴体",
  legs: "脚",
  feet: "足",
  "off-hand": "利き手と反対側の手",
};

function consumeItemCountDecreased(result: PlayerOperationResult): boolean {
  if (
    result.operation.kind !== "consume" ||
    result.before === null ||
    result.after === null
  )
    return false;
  const itemName = result.operation.item;
  const itemNames =
    itemName === undefined
      ? new Set(result.before.self.inventory.map((item) => item.name))
      : new Set([itemName]);
  const count = (
    observation: PlayerOperationResult["before"],
    name: string,
  ): number =>
    observation?.self.inventory
      .filter((item) => item.name === name)
      .reduce((total, item) => total + item.count, 0) ?? 0;
  return [...itemNames].some(
    (name) => count(result.before, name) > count(result.after, name),
  );
}

function observedMovementSummary(result: PlayerOperationResult): string {
  if (
    result.sameLife === false &&
    (result.operation.kind === "move_to" ||
      result.operation.kind === "move_relative" ||
      result.operation.kind === "control")
  )
    return "移動差分はライフ変更をまたぐため記録しない。";
  const movement = observedMovementDelta(result);
  if (movement === undefined) return "";
  const { x, y, z } = movement;
  return `観測した移動差分=Δx:${compactObservedNumber(x)},Δy:${compactObservedNumber(y)},Δz:${compactObservedNumber(z)},距離:${compactObservedNumber(Math.hypot(x, y, z))}。`;
}

function observedMovementDelta(
  result: PlayerOperationResult,
): PlayerObservedDisplacement | undefined {
  if (
    result.operation.kind !== "move_to" &&
    result.operation.kind !== "move_relative" &&
    result.operation.kind !== "control"
  )
    return undefined;
  if (result.sameLife === false) return undefined;
  const { before, after } = result;
  if (before === null || after === null) return undefined;
  if (before.dimension !== after.dimension) return undefined;
  const beforePosition = before.self.position;
  const afterPosition = after.self.position;
  const dx = afterPosition.x - beforePosition.x;
  const dy = afterPosition.y - beforePosition.y;
  const dz = afterPosition.z - beforePosition.z;
  if (![dx, dy, dz].every(Number.isFinite)) return undefined;
  return {
    x: Number(dx.toFixed(1)),
    y: Number(dy.toFixed(1)),
    z: Number(dz.toFixed(1)),
  };
}

function sanitizeDetail(value: string): string {
  let sanitized = "";
  for (const character of value) {
    const codePoint = character.codePointAt(0);
    sanitized +=
      codePoint !== undefined && (codePoint < 32 || codePoint === 127)
        ? " "
        : character;
    if (sanitized.length >= 180) break;
  }
  return sanitized.replace(/\s+/gu, " ").trim().slice(0, 180);
}

function safeDamageToken(value: string, maximumLength: number): string {
  return /^[a-z0-9_.:-]+$/iu.test(value) && value.length <= maximumLength
    ? value
    : "unknown";
}

function damageEventSummary(
  source: PlayerBodyDamageSource | null,
  confidence: "observed" | "unknown",
): string {
  if (source === null || confidence !== "observed")
    return "Bot自身への被害を観測。原因はunknown。新しいBody観測でhealthと可視脅威を確認。";
  const kind = safeDamageToken(source.kind, 48);
  const name = safeDamageToken(source.name, 80);
  const category =
    source.category !== null &&
    source.category.length <= 80 &&
    /^[\p{L}\p{N} _.-]+$/u.test(source.category)
      ? source.category
      : "unknown";
  return `Bot自身への被害を観測。攻撃元source=${kind}:${name}; category=${category}; confidence=observed。新しいBody観測でhealthと可視脅威を確認。`;
}

function causeSourceSummary(cause: PlayerBodyDeathCause): string {
  if (cause.confidence !== "observed" || cause.source === null)
    return "unknown";
  const kind = safeDamageToken(cause.source.kind, 48);
  const name = safeDamageToken(cause.source.name, 80);
  return `${kind}:${name}`;
}

function deathEventSummary(cause: PlayerBodyDeathCause | undefined): string {
  if (cause === undefined)
    return "Bot自身の死亡を観測。観測された死因はunknown。復帰後に現状を再評価。";
  const causeKey =
    cause.causeKey !== undefined &&
    /^death\.(?:attack|fell)\.[a-z0-9_.]{1,96}$/u.test(cause.causeKey)
      ? `; causeKey=${cause.causeKey}`
      : "";
  return `Bot自身の死亡を観測。cause=${causeSourceSummary(cause)}; confidence=${cause.confidence}; provenance=${cause.provenance}${causeKey}。復帰後に現状を再評価。`;
}

function deathCauseUpdateSummary(cause: PlayerBodyDeathCause): string {
  const causeKey =
    cause.causeKey !== undefined &&
    /^death\.(?:attack|fell)\.[a-z0-9_.]{1,96}$/u.test(cause.causeKey)
      ? `; causeKey=${cause.causeKey}`
      : "";
  return `既存のBot死亡記録へcause=${causeSourceSummary(cause)}; confidence=${cause.confidence}; provenance=${cause.provenance}${causeKey}を追加。死亡件数は増やさない。`;
}

export function semanticSignatures(
  observation: Awaited<ReturnType<PlayerBody["observe"]>>,
): Record<string, string> {
  const timeOfDay = observation.time.timeOfDay;
  const timeBand =
    timeOfDay === null
      ? "unknown"
      : timeOfDay >= 11_000 && timeOfDay <= 13_000
        ? "twilight"
        : timeOfDay < 12_000
          ? "day"
          : "night";
  const inWater = observation.self.inWater === true;
  const oxygenState = oxygenObservationState(observation.self.oxygen, inWater);
  const vitals = [
    observation.self.health,
    observation.self.food,
    inWater && oxygenState === "low" ? "low_oxygen" : "oxygen_not_low",
    observation.self.inLava === true,
    observation.self.onFire === true,
    observation.self.suffocating === true,
  ].join("|");
  const environment = [inWater, inWater ? oxygenState : "not_applicable"].join(
    "|",
  );
  const inventory = observation.self.inventory
    .map(({ name, count }) => `${name}:${count}`)
    .sort()
    .join(",");
  const entities = observation.perception.entities
    .map(
      ({ kind, category, distance }) =>
        `${kind}:${category ?? "unknown"}:${distanceBand(distance)}`,
    )
    .sort()
    .slice(0, 32)
    .join(",");
  const droppedItemCounts = new Map<string, number>();
  for (const { droppedItem } of observation.perception.entities) {
    if (droppedItem === undefined) continue;
    const name = droppedItem.name.slice(0, 80);
    droppedItemCounts.set(
      name,
      (droppedItemCounts.get(name) ?? 0) + droppedItem.count,
    );
  }
  const drops = [...droppedItemCounts]
    .map(([name, count]) => `${name}:${count}`)
    .sort()
    .join(",");
  const hostileMap = hostileMapSignature(observation);
  const nearestRelevantBlocks = new Map<string, number>();
  for (const { name, distance } of observation.perception.blocks) {
    if (
      !/chest|barrel|shulker|ore|log|crafting_table|furnace|bed|door|portal|water|lava/u.test(
        name,
      )
    )
      continue;
    const previous = nearestRelevantBlocks.get(name);
    if (previous === undefined || distance < previous)
      nearestRelevantBlocks.set(name, distance);
  }
  const relevantBlocks = [...nearestRelevantBlocks]
    .map(([name, distance]) => `${name}:${distanceBand(distance)}`)
    .sort()
    .slice(0, 48)
    .join(",");
  const window =
    observation.window === null
      ? "closed"
      : `${observation.window.type}:${observation.window.slots.map((item) => (item === null ? "-" : `${item.name}:${item.count}`)).join(",")}`;
  const { x, y, z } = observation.self.position;
  return {
    vitals,
    environment,
    inventory,
    entities,
    drops,
    hostileMap,
    blocks: relevantBlocks,
    time: `${observation.time.day ?? "unknown"}:${timeBand}:${observation.time.raining ?? "unknown"}`,
    position: `${observation.dimension}:${Math.floor(x / 8)}:${Math.floor(y / 8)}:${Math.floor(z / 8)}`,
    window,
  };
}

function hostileMapSignature(observation: PlayerBodyObservation): string {
  const nearbyHostiles = observation.perception.nearbyHostiles;
  if (nearbyHostiles === undefined) return "unavailable";
  const aggregate = nearbyHostiles.aggregate;
  if (aggregate === undefined)
    return nearbyHostiles.entities
      .map(({ kind, distance }) => `${kind}:${threatDistanceBand(distance)}`)
      .sort()
      .slice(0, 32)
      .join(",");
  const kinds = aggregate.byKind
    .map(({ name, count }) => `${name}:${count}`)
    .sort()
    .slice(0, 32)
    .join(",");
  const directions = aggregate.byDirection
    .map(
      ({ direction, count, nearestDistance }) =>
        `${direction}:${count}:${nearestDistance === null ? "none" : threatDistanceBand(nearestDistance)}`,
    )
    .join(",");
  return `${aggregate.countScope}:${aggregate.clientReceivedHostileCount}:${kinds}:${aggregate.omittedKindGroupCount}:${aggregate.omittedKindEntityCount}:${directions}`;
}

function threatDistanceBand(distance: number): string {
  if (distance < 3) return "close";
  if (distance < 6) return "near";
  if (distance < 10) return "medium";
  return "far";
}

function distanceBand(distance: number): string {
  if (distance < 3) return "near";
  if (distance < 8) return "medium";
  return "far";
}
