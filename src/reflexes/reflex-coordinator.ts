import {
  AppError,
  toFailureDetail,
  type FailureDetail,
} from "../domain/errors.js";
import type { WorldSnapshot } from "../domain/snapshot.js";
import type { MinecraftPort } from "../minecraft/port.js";
import {
  actionPriorities,
  type ActionArbiter,
  type ActionLease,
} from "../runtime/action-arbiter.js";
import type { TaskRuntime } from "../runtime/task-service.js";
import { withTimeout } from "../runtime/timeout.js";
import {
  isStableAfterIncident,
  reflexObservation,
  type ReflexIncident,
  type ReflexObservation,
  type ReflexDetector,
  type ReflexThresholds,
} from "./detectors.js";

export type ReflexState =
  | { readonly state: "safe" }
  | {
      readonly state: "intervening";
      readonly incident: ReflexIncident;
      readonly startedAt?: string;
      readonly endedAt?: string;
      readonly after?: ReflexObservation;
    }
  | {
      readonly state: "stabilizing";
      readonly incident: ReflexIncident;
      readonly startedAt?: string;
      readonly endedAt?: string;
      readonly after?: ReflexObservation;
    }
  | {
      readonly state: "failed";
      readonly incident: ReflexIncident;
      readonly failure: FailureDetail;
      readonly startedAt?: string;
      readonly endedAt?: string;
      readonly after?: ReflexObservation;
    };

export class ReflexCoordinator {
  private currentState: ReflexState = { state: "safe" };
  private handling = false;
  private retryNotBefore = 0;

  public constructor(
    private readonly detector: ReflexDetector,
    private readonly thresholds: ReflexThresholds,
    private readonly minecraft: MinecraftPort,
    private readonly tasks: TaskRuntime,
    private readonly arbiter: ActionArbiter,
    private readonly actionTimeoutMs: number,
    private readonly stuckRecoveryAttempts = 3,
  ) {}

  public get state(): ReflexState {
    return this.currentState;
  }

  public async tick(
    snapshot: WorldSnapshot,
    movementExpected: boolean,
  ): Promise<ReflexState> {
    if (this.handling) return this.currentState;
    if (
      this.currentState.state === "failed" &&
      Date.now() < this.retryNotBefore
    ) {
      return this.currentState;
    }
    const incident = this.detector.detect(snapshot, movementExpected);
    if (incident === undefined) {
      if (this.currentState.state !== "safe") {
        this.currentState = { state: "safe" };
        this.retryNotBefore = 0;
      }
      return this.currentState;
    }

    this.handling = true;
    this.currentState = {
      state: "intervening",
      incident,
      startedAt: incident.observation.observedAt,
    };
    let lease: ActionLease | undefined;
    let after: ReflexObservation | undefined;
    try {
      const acquiredLease = this.arbiter.acquire(
        `reflex:${incident.kind}`,
        actionPriorities.reflex,
      );
      lease = acquiredLease;
      await this.tasks.suspend(`reflex:${incident.kind}`);
      await withTimeout(
        async (timeoutSignal) => {
          const signal = AbortSignal.any([acquiredLease.signal, timeoutSignal]);
          if (incident.kind === "hunger")
            await this.minecraft.eatBestFood(signal);
          else if (incident.kind === "stuck") {
            await this.minecraft.recoverFromStuck(
              this.stuckRecoveryAttempts,
              signal,
            );
          } else {
            const hostileEscape =
              incident.kind === "hostile" ||
              (incident.kind === "damage" &&
                snapshot.nearbyEntities.some(
                  (entity) =>
                    entity.hostile &&
                    entity.distance <= this.thresholds.hostileDistance,
                ));
            await this.minecraft.escapeDanger(
              hostileEscape ? "hostile" : "environment",
              signal,
            );
          }
        },
        this.actionTimeoutMs,
        undefined,
        `reflex:${incident.kind}`,
      );
      const afterSnapshot = await this.minecraft.observe();
      after = reflexObservation(afterSnapshot);
      if (
        !isStableAfterIncident(incident.kind, afterSnapshot, this.thresholds)
      ) {
        throw new AppError({
          category: "safety",
          code: "REFLEX_NOT_STABLE",
          message:
            "The reflex action completed without observing a stable state",
          retryable: true,
          failedAt: `reflex:${incident.kind}`,
        });
      }
      this.currentState = {
        state: "stabilizing",
        incident,
        startedAt: incident.observation.observedAt,
        endedAt: after.observedAt,
        after,
      };
      this.retryNotBefore = 0;
    } catch (error) {
      this.currentState = {
        state: "failed",
        incident,
        failure: toFailureDetail(error, {
          category: "safety",
          code: "REFLEX_FAILED",
          message:
            error instanceof Error ? error.message : "Reflex action failed",
          retryable: false,
          failedAt: `reflex:${incident.kind}`,
        }),
        startedAt: incident.observation.observedAt,
        endedAt: after?.observedAt ?? new Date().toISOString(),
        ...(after === undefined ? {} : { after }),
      };
      this.retryNotBefore = Date.now() + 5_000;
    } finally {
      lease?.release();
      this.handling = false;
    }
    return this.currentState;
  }
}
