import { randomUUID } from "node:crypto";

import type { Logger } from "pino";

import { sameMinecraftIdentity } from "../domain/minecraft-identity.js";
import type {
  McSkillRepository,
  McSkillOutcomeStatus,
} from "../mc-skills/index.js";
import type {
  PlayerBody,
  PlayerBodyEvent,
  PlayerOperation,
  PlayerOperationResult,
} from "../minecraft/player-body.js";
import { isImmediateStopCommand } from "../agent/chat-coordinator.js";
import type { TraceService, TraceSession } from "../trace/service.js";
import type {
  PlayerMemoryPort,
  PlayerObservedDisplacement,
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

interface ActiveBodyRun {
  readonly operationId: string;
  readonly operation: PlayerOperation;
  readonly skillId?: string;
  readonly skillVersion?: number;
  readonly controller: AbortController;
  promise: Promise<void>;
}

export interface PlayerConversationPort {
  nextTurn(): number;
  handleOwnerMessage(input: {
    readonly username: string;
    readonly message: string;
    readonly turn: number;
    readonly signal?: AbortSignal;
  }): Promise<void>;
}

export interface PlayerPurposePort {
  think(input: {
    readonly snapshot: PlayerRuntimeSnapshot;
    readonly events: readonly PlayerRuntimeEvent[];
    readonly signal?: AbortSignal;
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
}

/** Event-driven coordinator. Only this class owns calls into PlayerBody.execute. */
export class PlayerRuntime {
  readonly #eventTimes = new Map<string, number>();
  readonly #semanticSignatures = new Map<string, string>();
  readonly #lifetime = new AbortController();
  #unsubscribeBody: (() => void) | undefined;
  #activeBody: ActiveBodyRun | undefined;
  #activeThought: AbortController | undefined;
  #activeThoughtCommitted = false;
  #pendingThoughtWake: PendingThoughtWake | undefined;
  #replacementTail: Promise<void> = Promise.resolve();
  #retryTimer: NodeJS.Timeout | undefined;
  #deadlineTimer: NodeJS.Timeout | undefined;
  #sampleTimer: NodeJS.Timeout | undefined;
  #vitalsWakeTimer: NodeJS.Timeout | undefined;
  #samplePromise: Promise<void> | undefined;
  #retryDelayMs = 5_000;
  #bodyNeedsRecovery = false;
  #recoveryRequestedOperationIds = new Set<string>();
  #bodyConnected = true;
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
    this.#handledPurposeCompletionWakeSequence =
      this.options.mind.purposeCompletionWakeState().sequence;
    this.#scheduleDeadline(snapshot.wait?.wakeAt);
    if (!snapshot.stopped) {
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
    ).catch((error: unknown) =>
      this.#logFailure("PLAYER_CONVERSATION_FAILED", error),
    );
  }

  /** Called after a durable owner proposal was recorded; this leaves the body running. */
  public onOwnerProposal(): void {
    const event = this.options.mind
      .pendingEvents(12)
      .findLast(({ kind }) => kind === "owner_proposal");
    this.#requestThought(
      "owner_proposal",
      event?.summary ?? "所有者の目的提案を評価",
    );
  }

  /** Called only after the stop latch has been persisted. */
  public async stopNow(): Promise<void> {
    this.#stopSampler();
    this.#cancelThought("autonomy_stopped");
    await this.#stopBody("autonomy_stopped");
  }

  /** A fresh, owner-authenticated resume wakes the purpose agent. */
  public onResume(): void {
    if (this.options.mind.snapshot().stopped) return;
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
    return this.options.mind.snapshot();
  }

  public handleCommittedDecision(
    snapshot: PlayerRuntimeSnapshot,
    decision: PlayerThoughtDecision,
  ): void {
    if (this.#activeThought !== undefined) this.#activeThoughtCommitted = true;
    this.#retryDelayMs = 5_000;
    if (this.#retryTimer !== undefined) clearTimeout(this.#retryTimer);
    this.#retryTimer = undefined;
    this.#scheduleDeadline(snapshot.wait?.wakeAt);
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
        .then(() => this.#stopBody("action_revision_changed"));
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

  private onBodyEvent(event: PlayerBodyEvent): void {
    if (this.#shuttingDown) return;
    const bodyEvent = event as unknown as Record<string, unknown>;
    const type =
      typeof bodyEvent.type === "string" ? bodyEvent.type : "unknown";
    const at =
      typeof bodyEvent.at === "string"
        ? bodyEvent.at
        : new Date().toISOString();
    if (type === "operation_started") {
      const active = this.#activeBody;
      if (
        active !== undefined &&
        bodyEvent.operation === active.operation.kind
      ) {
        // The adapter generates its own operationId; the runtime's durable ID is the action identity.
        this.options.mind.markOperationStarted(active.operationId, at);
      }
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
      this.options.memory.recordEpisode({
        summary: "Bot自身がMinecraft内で死亡したことを観測",
        status: "observed",
        operationKind: "bot_death",
      });
      this.enqueueAndWake(
        "bot_death",
        "Bot自身の死亡を観測し、復帰後の目的を再評価",
        at,
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
  ): void {
    const now = Date.parse(at);
    const previous = this.#eventTimes.get(key) ?? 0;
    if (Number.isFinite(now) && now - previous < minimumGapMs) {
      if (kind === "state_changed" && summary.includes("vitals")) {
        this.options.mind.enqueueEvent(kind, summary);
        this.#scheduleVitalsWake(Math.max(1, minimumGapMs - (now - previous)));
      }
      return;
    }
    this.#eventTimes.set(key, Number.isFinite(now) ? now : Date.now());
    const deferObservation =
      kind === "state_changed" &&
      !summary.includes("vitals") &&
      this.#activeThought !== undefined;
    const event = this.options.mind.enqueueEvent(
      kind,
      summary,
      deferObservation ? { invalidateDecision: false } : undefined,
    );
    this.#requestThought(kind, event.summary);
  }

  #requestThought(
    kind: PlayerWakeKind,
    reason: string,
    acceptedPendingWake = false,
  ): void {
    if (this.#shuttingDown || this.options.mind.snapshot().stopped) return;
    const current = this.options.mind.snapshot();
    if (
      !acceptedPendingWake &&
      current.wait !== undefined &&
      !current.wait.wakeOn.includes(kind) &&
      kind !== "deadline" &&
      kind !== "owner_proposal"
    )
      return;
    if (
      !acceptedPendingWake &&
      current.wait?.wakeAt !== undefined &&
      Date.parse(current.wait.wakeAt) > Date.now() &&
      kind !== "owner_proposal" &&
      kind !== "manual"
    )
      return;
    const activeThought = this.#activeThought;
    if (activeThought !== undefined) {
      this.#queueThoughtWake(kind, reason);
      if (kind === "owner_proposal") {
        activeThought.abort(new Error("owner_proposal_preempted_thought"));
      } else if (
        !this.#activeThoughtCommitted &&
        (kind !== "state_changed" || reason.includes("vitals"))
      ) {
        // Decision-invalidating events advance CAS. Ordinary observation
        // changes remain queued for the next thought after this one settles.
        activeThought.abort(new Error("new_event_preempted_thought"));
      }
      return;
    }
    const controller = new AbortController();
    this.#activeThought = controller;
    this.#activeThoughtCommitted = false;
    const events = this.options.mind.pendingEvents(32);
    let retry = false;
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
          signal: AbortSignal.any([controller.signal, this.#lifetime.signal]),
        });
        if (
          !result.accepted &&
          !controller.signal.aborted &&
          !this.options.mind.snapshot().stopped
        )
          retry = true;
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
      .finally(() => this.#finishThought(controller, retry));
  }

  #queueThoughtWake(kind: PlayerWakeKind, reason: string): void {
    const pending = this.#pendingThoughtWake;
    if (pending?.kind === "owner_proposal" && kind !== "owner_proposal") return;
    if (kind === "owner_proposal" || pending === undefined) {
      this.#pendingThoughtWake = { kind, reason };
      return;
    }
    if (kind !== "state_changed" || pending.kind === "state_changed")
      this.#pendingThoughtWake = { kind, reason };
  }

  #finishThought(controller: AbortController, retry: boolean): void {
    if (this.#activeThought !== controller) return;
    this.#activeThought = undefined;
    this.#activeThoughtCommitted = false;
    if (this.#shuttingDown || this.options.mind.snapshot().stopped) {
      this.#pendingThoughtWake = undefined;
      return;
    }
    if (retry) {
      this.#retryThought();
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
    this.#requestThought(pending.kind, pending.reason, true);
  }

  async #replaceBodyOperation(
    snapshot: PlayerRuntimeSnapshot,
    decision: Extract<PlayerThoughtDecision, { kind: "act" }>,
  ): Promise<void> {
    const running = this.#activeBody;
    if (running !== undefined)
      await this.#settleBody(running, "body_operation_replaced");
    const latest = this.options.mind.snapshot();
    if (
      this.#shuttingDown ||
      latest.stopped ||
      latest.actionRevision !== snapshot.actionRevision ||
      latest.activeOperation?.operationId !== decision.operationId
    )
      return;
    if (this.#bodyNeedsRecovery || !this.#bodyConnected) {
      this.options.mind.deferOperationUntilReconnect(decision.operationId);
      return;
    }
    const controller = new AbortController();
    const run: ActiveBodyRun = {
      operationId: decision.operationId,
      operation: decision.operation,
      ...(decision.skillId === undefined ? {} : { skillId: decision.skillId }),
      ...(decision.skillVersion === undefined
        ? {}
        : { skillVersion: decision.skillVersion }),
      controller,
      promise: Promise.resolve(),
    };
    this.#activeBody = run;
    run.promise = this.#executeBody(
      run,
      decision.operation,
      decision.expectedOutcome,
    );
    await run.promise;
  }

  async #executeBody(
    run: ActiveBodyRun,
    operation: Parameters<PlayerBody["execute"]>[0],
    expectedOutcome: string,
  ): Promise<void> {
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
        : `期待したstep=${sanitizeDetail(expectedOutcome)}。${groundedOperationSummary(result)}`;
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
        expectedOutcome,
        ...(skillId === undefined ? {} : { skillId }),
        ...(skillVersion === undefined ? {} : { skillVersion }),
      },
      recoveryRequired,
    });
    if (this.#activeBody === run) this.#activeBody = undefined;
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

  async #stopBody(reason: string): Promise<void> {
    const running = this.#activeBody;
    if (running !== undefined) await this.#settleBody(running, reason);
    try {
      await this.options.body.stop();
    } catch (error) {
      this.#logFailure("PLAYER_BODY_STOP_FAILED", error);
    }
  }

  async #settleBody(run: ActiveBodyRun, reason: string): Promise<void> {
    run.controller.abort(new Error(reason));
    try {
      await this.options.body.stop();
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
    this.#pendingThoughtWake = undefined;
    this.#activeThoughtCommitted = false;
    thought?.abort(new Error(reason));
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
            const gap = criticalVitals
              ? 3_000
              : meaningful.includes("time")
                ? 60_000
                : 12_000;
            this.enqueueAndWake(
              "state_changed",
              `観測上の意味のある変化: ${meaningful.join(", ")}`,
              observation.observedAt,
              `semantic:${meaningful.sort().join(",")}`,
              gap,
            );
          }
        }
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
    if (this.#vitalsWakeTimer !== undefined)
      clearTimeout(this.#vitalsWakeTimer);
    this.#vitalsWakeTimer = undefined;
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

  #retryThought(): void {
    if (
      this.#retryTimer !== undefined ||
      this.#shuttingDown ||
      this.options.mind.snapshot().stopped
    )
      return;
    const delay = this.#retryDelayMs;
    this.#retryDelayMs = Math.min(60_000, Math.round(this.#retryDelayMs * 2));
    this.#retryTimer = setTimeout(() => {
      this.#retryTimer = undefined;
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

function groundedOperationSummary(result: PlayerOperationResult): string {
  const status = result.status;
  const beforeAvailable = result.before !== null;
  const afterAvailable = result.after !== null;
  const detail =
    result.detail === undefined ? "" : sanitizeDetail(result.detail);
  const observedEffect = result.observedEffect?.type;
  const movement = observedMovementSummary(result);
  return `${result.operation.kind} は ${status}。実行前観測=${beforeAvailable ? "あり" : "なし"}、実行後観測=${afterAvailable ? "あり" : "なし"}.${observedEffect === undefined ? "" : `確認済み効果=${observedEffect}。`}${detail.length === 0 ? "" : `結果概要=${detail}。`}${movement}次の判断では結果の実観測を再確認する。`;
}

function observedMovementSummary(result: PlayerOperationResult): string {
  const movement = observedMovementDelta(result);
  if (movement === undefined) return "";
  const { x, y, z } = movement;
  return `観測した移動差分=Δx:${x.toFixed(1)},Δy:${y.toFixed(1)},Δz:${z.toFixed(1)},距離:${Math.hypot(x, y, z).toFixed(1)}。`;
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

function semanticSignatures(
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
  const vitals = [
    observation.self.health,
    observation.self.food,
    observation.self.oxygen,
    observation.self.inWater,
    observation.self.inLava,
    observation.self.onFire,
    observation.self.suffocating,
  ].join("|");
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
  const relevantBlocks = observation.perception.blocks
    .filter(({ name }) =>
      /chest|barrel|shulker|ore|log|crafting_table|furnace|bed|door|portal|water|lava/u.test(
        name,
      ),
    )
    .map(({ name, distance }) => `${name}:${distanceBand(distance)}`)
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
    inventory,
    entities,
    blocks: relevantBlocks,
    time: `${observation.time.day ?? "unknown"}:${timeBand}:${observation.time.raining ?? "unknown"}`,
    position: `${observation.dimension}:${Math.floor(x / 8)}:${Math.floor(y / 8)}:${Math.floor(z / 8)}`,
    window,
  };
}

function distanceBand(distance: number): string {
  if (distance < 3) return "near";
  if (distance < 8) return "medium";
  return "far";
}
