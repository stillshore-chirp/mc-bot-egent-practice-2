import {
  distance,
  type ObservationAttribution,
  type OxygenObservationState,
  type Position,
  type WorldSnapshot,
} from "../domain/snapshot.js";
import { recommendArmor } from "../decision/armor-equipment.js";

export const reflexKinds = [
  "hazard",
  "damage",
  "hostile",
  "critical_health",
  "equipment",
  "hunger",
  "stuck",
] as const;
export type ReflexKind = (typeof reflexKinds)[number];

export interface ReflexIncident {
  readonly kind: ReflexKind;
  readonly reason: string;
  readonly priority: number;
  readonly observation: ReflexObservation;
}

export interface ReflexObservation extends ObservationAttribution {
  readonly dimension: string;
  readonly position: Position;
  readonly oxygen: number | null;
  readonly oxygenState: OxygenObservationState;
  readonly inWater: boolean;
}

export interface ReflexThresholds {
  readonly lowFood: number;
  readonly lowOxygen: number;
  readonly hostileDistance: number;
  readonly fallingVelocity: number;
  readonly stuckWindowMs: number;
  readonly stuckDistance: number;
}

export function isCriticalHealth(snapshot: WorldSnapshot): boolean {
  return snapshot.health > 0 && snapshot.health <= 6 && snapshot.food < 18;
}

export class ReflexDetector {
  private previous: WorldSnapshot | undefined;
  private movementAnchor:
    { snapshot: WorldSnapshot; expected: boolean } | undefined;

  public constructor(private readonly thresholds: ReflexThresholds) {}

  public detect(
    current: WorldSnapshot,
    movementExpected: boolean,
    isExpectedDescentDamage?: (
      previous: WorldSnapshot,
      current: WorldSnapshot,
    ) => boolean,
  ): ReflexIncident | undefined {
    const previous = this.previous;
    this.previous = current;

    const observation = reflexObservation(current);
    const oxygenHazard =
      current.inWater &&
      (current.oxygenState === "low" ||
        current.oxygenState === "unknown" ||
        (current.oxygen !== null &&
          current.oxygen <= this.thresholds.lowOxygen));

    if (
      current.inLava ||
      current.onFire ||
      current.suffocating ||
      oxygenHazard ||
      current.velocityY <= this.thresholds.fallingVelocity
    ) {
      return {
        kind: "hazard",
        reason:
          current.inWater &&
          (current.oxygenState === "low" ||
            (current.oxygen !== null &&
              current.oxygen <= this.thresholds.lowOxygen))
            ? "Bot oxygen is low while underwater"
            : current.oxygenState === "unknown" && current.inWater
              ? "Bot oxygen cannot be confirmed while underwater"
              : "Immediate environmental hazard observed",
        priority: 500,
        observation,
      };
    }
    if (
      previous?.health !== undefined &&
      current.health < previous.health &&
      !isExpectedDescentDamage?.(previous, current)
    ) {
      return {
        kind: "damage",
        reason: "Health decreased",
        priority: 400,
        observation,
      };
    }
    if (
      current.nearbyEntities.some(
        (entity) =>
          entity.hostile && entity.distance <= this.thresholds.hostileDistance,
      )
    ) {
      return {
        kind: "hostile",
        reason: "Hostile entity is within safety distance",
        priority: 300,
        observation,
      };
    }
    if (isCriticalHealth(current)) {
      return {
        kind: "critical_health",
        reason: "Bot health is critically low",
        priority: 250,
        observation,
      };
    }
    if (recommendArmor(current).length > 0) {
      return {
        kind: "equipment",
        reason: "Wearable armor is available for an empty slot",
        priority: 225,
        observation,
      };
    }
    if (current.food <= this.thresholds.lowFood) {
      return {
        kind: "hunger",
        reason: "Food level is below the configured threshold",
        priority: 200,
        observation,
      };
    }

    if (!movementExpected) {
      this.movementAnchor = undefined;
      return undefined;
    }
    if (!this.movementAnchor?.expected) {
      this.movementAnchor = { snapshot: current, expected: true };
      return undefined;
    }
    const elapsed =
      Date.parse(current.observedAt) -
      Date.parse(this.movementAnchor.snapshot.observedAt);
    if (elapsed < this.thresholds.stuckWindowMs) return undefined;
    const moved = distance(
      current.position,
      this.movementAnchor.snapshot.position,
    );
    this.movementAnchor = { snapshot: current, expected: true };
    return moved < this.thresholds.stuckDistance
      ? {
          kind: "stuck",
          reason: "Movement was requested but position did not change",
          priority: 100,
          observation,
        }
      : undefined;
  }
}

export function isStableAfterIncident(
  incident: ReflexIncident,
  snapshot: WorldSnapshot,
  thresholds: ReflexThresholds,
): boolean {
  switch (incident.kind) {
    case "hazard":
      return (
        !snapshot.inLava &&
        !snapshot.onFire &&
        !snapshot.suffocating &&
        (incident.observation.inWater &&
        incident.observation.oxygenState !== "normal"
          ? !snapshot.inWater &&
            snapshot.oxygen !== null &&
            snapshot.oxygen > thresholds.lowOxygen &&
            snapshot.health > 0
          : true) &&
        (!snapshot.inWater ||
          (snapshot.oxygenState !== "low" &&
            snapshot.oxygenState !== "unknown" &&
            snapshot.oxygen !== null &&
            snapshot.oxygen > thresholds.lowOxygen))
      );
    case "damage":
    case "hostile":
      return !snapshot.nearbyEntities.some(
        (entity) =>
          entity.hostile && entity.distance <= thresholds.hostileDistance,
      );
    case "hunger":
      return snapshot.food > thresholds.lowFood;
    case "critical_health":
      return snapshot.health > 0;
    case "equipment":
      return snapshot.armor !== null && recommendArmor(snapshot).length === 0;
    case "stuck":
      return true;
  }
}

export function reflexObservation(snapshot: WorldSnapshot): ReflexObservation {
  return {
    subject: snapshot.subject,
    source: snapshot.source,
    observedAt: snapshot.observedAt,
    dimension: snapshot.dimension,
    position: snapshot.position,
    oxygen: snapshot.oxygen,
    oxygenState: snapshot.oxygenState,
    inWater: snapshot.inWater,
  };
}
