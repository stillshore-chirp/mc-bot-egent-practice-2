import {
  AppError,
  toFailureDetail,
  type FailureDetail,
} from "../domain/errors.js";
import type { WorldSnapshot } from "../domain/snapshot.js";
import { recommendArmor } from "../decision/armor-equipment.js";
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
  private noSafeFoodContext: string | undefined;

  public constructor(
    private readonly detector: ReflexDetector,
    private readonly thresholds: ReflexThresholds,
    private readonly minecraft: MinecraftPort,
    private readonly tasks: TaskRuntime,
    private readonly arbiter: ActionArbiter,
    private readonly actionTimeoutMs: number,
    private readonly stuckRecoveryAttempts = 3,
    private readonly ownerUsername?: string,
  ) {}

  public get state(): ReflexState {
    return this.currentState;
  }

  public async tick(
    snapshot: WorldSnapshot,
    movementExpected: boolean,
  ): Promise<ReflexState> {
    if (this.handling) return this.currentState;
    const incident = this.detector.detect(
      snapshot,
      movementExpected,
      (previous, current) =>
        this.minecraft.isExpectedDescentDamage(previous, current),
    );
    if (
      this.currentState.state === "failed" &&
      incident?.kind === this.currentState.incident.kind &&
      incident.reason === this.currentState.incident.reason &&
      (this.currentState.failure.code === "NO_SAFE_FOOD"
        ? this.noSafeFoodContext ===
          noSafeFoodContext(snapshot, this.ownerUsername)
        : Date.now() < this.retryNotBefore)
    ) {
      return this.currentState;
    }
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
          if (incident.kind === "equipment") {
            const result = await this.minecraft.equipAvailableArmor(signal);
            if (result.failed || result.equipped.length === 0) {
              throw new AppError({
                category: "safety",
                code: "AUTONOMOUS_ARMOR_EQUIP_FAILED",
                message: "No armor slot was confirmed equipped",
                retryable: true,
                failedAt: "reflex:equipment",
              });
            }
          } else if (incident.kind === "critical_health") {
            const hostile = snapshot.nearbyEntities.some(
              (entity) =>
                entity.hostile &&
                entity.distance <= this.thresholds.hostileDistance,
            );
            if (hostile) {
              await this.minecraft.escapeDanger("hostile", signal);
            } else if (recommendArmor(snapshot).length > 0) {
              const result = await this.minecraft.equipAvailableArmor(signal);
              if (result.failed || result.equipped.length === 0) {
                throw new AppError({
                  category: "safety",
                  code: "AUTONOMOUS_ARMOR_EQUIP_FAILED",
                  message: "No armor slot was confirmed equipped",
                  retryable: true,
                  failedAt: "reflex:critical_health",
                });
              }
            } else if (snapshot.food < 18) {
              try {
                await this.minecraft.eatBestFood(signal);
              } catch (error) {
                const owner = safeOwnerForRecovery(
                  snapshot,
                  this.ownerUsername,
                );
                if (
                  !(error instanceof AppError) ||
                  error.detail.code !== "NO_SAFE_FOOD" ||
                  owner === undefined
                ) {
                  throw error;
                }
                await this.minecraft.moveToWithSafeDescent(
                  owner.position,
                  2,
                  signal,
                );
              }
            } else {
              throw new AppError({
                category: "safety",
                code: "CRITICAL_HEALTH_NO_SAFE_ACTION",
                message: "No safe immediate recovery action is available",
                retryable: true,
                failedAt: "reflex:critical_health",
              });
            }
          } else if (incident.kind === "hunger")
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
      if (!isStableAfterIncident(incident, afterSnapshot, this.thresholds)) {
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
      this.noSafeFoodContext = undefined;
    } catch (error) {
      if (after === undefined) {
        try {
          after = reflexObservation(await this.minecraft.observe());
        } catch {
          // A failed observation must not replace the original escape failure.
        }
      }
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
      this.noSafeFoodContext =
        this.currentState.failure.code === "NO_SAFE_FOOD"
          ? noSafeFoodContext(snapshot, this.ownerUsername)
          : undefined;
    } finally {
      lease?.release();
      this.handling = false;
    }
    return this.currentState;
  }
}

function inventorySignature(snapshot: WorldSnapshot): string {
  return snapshot.inventory
    .map((item) => `${item.name}:${String(item.count)}`)
    .sort()
    .join("|");
}

function safeOwnerForRecovery(
  snapshot: WorldSnapshot,
  ownerUsername: string | undefined,
): WorldSnapshot["players"][number] | undefined {
  if (
    ownerUsername === undefined ||
    snapshot.inWater ||
    snapshot.nearbyEntities.some(
      (entity) => entity.hostile && entity.distance <= 12,
    )
  ) {
    return undefined;
  }
  return snapshot.players.find(
    (player) =>
      player.username === ownerUsername &&
      player.distance > 3 &&
      player.distance <= 12,
  );
}

function noSafeFoodContext(
  snapshot: WorldSnapshot,
  ownerUsername: string | undefined,
): string {
  return `${inventorySignature(snapshot)}:${safeOwnerForRecovery(snapshot, ownerUsername) === undefined ? "no_fallback" : "owner_available"}`;
}
