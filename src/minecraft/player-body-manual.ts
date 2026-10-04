import type { PlayerOperationName } from "./player-body-schema.js";

export type PlayerOperationTrialStatus =
  "historical_representative" | "not_measured";

export interface PlayerOperationManual {
  readonly kind: PlayerOperationName;
  /** The operation is present in the schema, purpose catalog, and Body dispatcher. */
  readonly implementation: "body_operation_provided";
  /** This static manual cannot determine whether the live connection is ready now. */
  readonly currentAvailability: "requires_fresh_precondition_check";
  readonly unavailable: readonly string[];
  readonly preconditions: readonly string[];
  readonly successEvidence: readonly string[];
  readonly historicalTrial?: {
    readonly status: PlayerOperationTrialStatus;
    readonly scope: string;
  };
  readonly damageObservation?: readonly string[];
}

const commonPreconditions = [
  "Check that the current Body connection can accept an operation and that the owner stop latch is not active.",
  "Use a fresh Body observation for the current position, visible targets, inventory, vitals, and open window; null or omitted values remain unknown.",
  "Check the operation schema and ordinary Minecraft reach, inventory, physics, protocol, and server-permission requirements before dispatch.",
] as const;

const commonSuccessEvidence = [
  "Use the returned operation status and before/after observations. `successful` means the operation-specific effect was observed; it does not prove the owner goal was completed.",
  "`unverified` means the effect could not be established from available evidence. Do not describe it as success or infer current readiness from an earlier trial.",
] as const;

const unavailableCapabilities = [
  "Arbitrary chat or console commands, server administration, credential access, and permission bypass are not exposed as PlayerBody operations.",
] as const;

const operationDetails: Partial<
  Record<
    PlayerOperationName,
    Partial<
      Pick<
        PlayerOperationManual,
        | "preconditions"
        | "successEvidence"
        | "historicalTrial"
        | "damageObservation"
      >
    >
  >
> = {
  consume: {
    preconditions: [
      "`consume` only selects items recognized by the current registry as food. Recommended action order, not a Body execution precondition or guard: when health is low or health loss is observed with visible hostiles, move with `move_relative` until fresh observations place each visible hostile at least 8 blocks away; if any remain closer, move farther instead of waiting. Use the actual movement result and fresh distances before eating. This does not prove unseen hostiles are absent or guarantee the distance will hold.",
      "Do not promise direct health recovery from eating; check fresh vitals after the operation.",
    ],
    successEvidence: [
      "The current Body verifier requires a lower count of the selected food and either a higher observed `food` value or a matching same-Bot/life `entity_status` status 9. Status 9 or item loss alone is insufficient. Report health recovery only when a fresh `self.health` observation actually increases.",
    ],
  },
  look: {
    historicalTrial: {
      status: "historical_representative",
      scope:
        "A representative look trial was recorded under Issue #75. It does not establish present connection readiness or prove that a target is visible now.",
    },
  },
  move_to: {
    preconditions: [
      "Check the fresh position and destination against loaded terrain, a reachable path, normal player physics, and the requested arrival range.",
      "A destination or route from an earlier observation may no longer be reachable; choose another route or report the current blocker when no path is observed.",
    ],
    successEvidence: [
      "The after-observation position must be within the requested range of the destination. A pathfinder request or normal `goto()` completion alone is not enough.",
    ],
    historicalTrial: {
      status: "historical_representative",
      scope:
        "A representative look and movement trial was recorded under Issue #75. It does not establish present connection readiness or movement success in a different world state.",
    },
  },
  look_sweep: {
    preconditions: [
      "The Body needs a current observation and finite view angles; the sweep physically turns through eight directions.",
      "Each direction returns only a bounded visible subset. Check omission and candidate-truncation fields when interpreting results.",
    ],
    successEvidence: [
      "Use `lookSweep.complete` and its per-direction visible blocks and entities. `worldAbsenceEstablished` is always false, so a missing target is not proof that it is absent.",
    ],
    historicalTrial: {
      status: "not_measured",
      scope:
        "The current manual records no representative real-game `look_sweep` trial.",
    },
  },
  attack: {
    preconditions: [
      "The target must be present in the fresh visible-entity observation and within normal player reach when the operation starts.",
      "A target that disappeared, became obscured, or moved out of reach is not a currently usable target; reacquire it before deciding.",
    ],
    successEvidence: [
      "A hit is confirmed only when Mineflayer observes `entityHurt` for the target with this player as the source. `observedEffect` distinguishes `entity_hit` from `entity_died`; a hit does not imply death.",
      "If the protocol does not identify the attacker, the hit remains unverified. Do not infer a hit from the attack call or from target health that Mineflayer reports as unknown.",
    ],
    historicalTrial: {
      status: "not_measured",
      scope:
        "The current manual records no representative real-game `attack` trial.",
    },
    damageObservation: [
      "`bot_damaged` carries `at`, `source` (`kind`, `name`, `category`, or null), and `confidence` (`observed` or `unknown`). A missing source or `unknown` confidence does not identify an attacker; the event does not include an entity ID, coordinates, or username.",
      "`bot_death` may include an optional `cause`. A matching structured death notice can emit `bot_death_cause_updated` once within one second; correlate it by `deathAt` and do not count it as another death. The update's cause includes `causeKey`, source, confidence, and provenance (`damage_event` or `death_notification`).",
      "For a recognized mob species, the cause source uses its canonical entity name. Unknown, custom, or player-name text is represented with generic `kind: death_cause` and the structured translation key; it does not reveal a player name.",
      "A vitals state-change should trigger a fresh observation; `self.health` may be null. Compare current visible entities and health without treating either as a complete damage log.",
      "These events support a fresh decision about movement, looking, or attack; they do not establish that any response succeeded. Verify the selected operation result separately.",
    ],
  },
  dig: {
    preconditions: [
      "The requested block must be loaded and within normal player reach. PlayerBody turns toward it, then rechecks current visibility and line of sight; it will not dig a block that remains hidden or obstructed.",
    ],
  },
};

/**
 * Return operation-specific decision guidance without claiming live readiness.
 * The caller should attach this next to the canonical operation schema.
 */
export function describeOperationManual(
  kind: PlayerOperationName,
): PlayerOperationManual {
  const details = operationDetails[kind];
  return {
    kind,
    implementation: "body_operation_provided",
    currentAvailability: "requires_fresh_precondition_check",
    unavailable: [...unavailableCapabilities],
    preconditions: [...commonPreconditions, ...(details?.preconditions ?? [])],
    successEvidence: [
      ...commonSuccessEvidence,
      ...(details?.successEvidence ?? []),
    ],
    ...(details?.historicalTrial === undefined
      ? {}
      : { historicalTrial: { ...details.historicalTrial } }),
    ...(details?.damageObservation === undefined
      ? {}
      : { damageObservation: [...details.damageObservation] }),
  };
}
