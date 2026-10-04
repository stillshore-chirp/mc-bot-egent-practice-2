import { describe, expect, it } from "vitest";

import { playerOperationNames } from "../../src/minecraft/player-body-schema.js";
import { describeOperationManual } from "../../src/minecraft/player-body-manual.js";

describe("PlayerBody capability manual", () => {
  it("keeps implementation presence separate from current readiness", () => {
    for (const kind of playerOperationNames) {
      const manual = describeOperationManual(kind);
      expect(manual.kind).toBe(kind);
      expect(manual.implementation).toBe("body_operation_provided");
      expect(manual.currentAvailability).toBe(
        "requires_fresh_precondition_check",
      );
      expect(manual.unavailable.join(" ")).toContain(
        "Arbitrary chat or console commands",
      );
      expect(manual.preconditions).toContain(
        "Use a fresh Body observation for the current position, visible targets, inventory, vitals, and open window; null or omitted values remain unknown.",
      );
      expect(manual.successEvidence.join(" ")).toContain("`unverified`");
    }
  });

  it("documents food-only consume evidence and retreat before recovery", () => {
    const manual = describeOperationManual("consume");

    expect(manual.preconditions.join(" ")).toContain(
      "only selects items recognized by the current registry as food",
    );
    expect(manual.preconditions.join(" ")).toContain(
      "Recommended action order, not a Body execution precondition or guard",
    );
    expect(manual.preconditions.join(" ")).toContain(
      "each observed hostile at least 8 blocks away",
    );
    expect(manual.preconditions.join(" ")).toContain(
      "when health is low or health loss is observed with hostiles in the fresh FOV or `nearbyHostiles` subset",
    );
    expect(manual.preconditions.join(" ")).toContain(
      "move farther instead of waiting",
    );
    expect(manual.preconditions.join(" ")).toContain(
      "unseen hostiles are not proven absent",
    );
    expect(manual.preconditions.join(" ")).toContain(
      "distance is not guaranteed to hold",
    );
    expect(manual.successEvidence.join(" ")).toContain(
      "a higher observed `food` value or a matching same-Bot/life `entity_status` status 9",
    );
    expect(manual.successEvidence.join(" ")).toContain(
      "Status 9 or item loss alone is insufficient",
    );
    expect(manual.successEvidence.join(" ")).toContain(
      "Report health recovery only when a fresh `self.health` observation actually increases",
    );
  });

  it("treats look sweeps as bounded views, not proof of world absence", () => {
    const manual = describeOperationManual("look_sweep");

    expect(manual.historicalTrial?.status).toBe("not_measured");
    expect(manual.successEvidence.join(" ")).toContain(
      "`worldAbsenceEstablished` is always false",
    );
    expect(manual.preconditions.join(" ")).toContain("eight directions");
  });

  it("requires an identified hit and keeps damage attribution evidence bounded", () => {
    const manual = describeOperationManual("attack");

    expect(manual.historicalTrial?.status).toBe("not_measured");
    expect(manual.preconditions.join(" ")).toContain("fresh visible-entity");
    expect(manual.successEvidence.join(" ")).toContain(
      "with this player as the source",
    );
    expect(manual.successEvidence.join(" ")).toContain(
      "a hit does not imply death",
    );
    expect(manual.damageObservation?.join(" ")).toContain("`bot_damaged`");
    expect(manual.damageObservation?.join(" ")).toContain(
      "`source` (`kind`, `name`, `category`, or null)",
    );
    expect(manual.damageObservation?.join(" ")).toContain("`bot_death`");
    expect(manual.damageObservation?.join(" ")).toContain(
      "`bot_death_cause_updated`",
    );
    expect(manual.damageObservation?.join(" ")).toContain("`deathAt`");
    expect(manual.damageObservation?.join(" ")).toContain("`causeKey`");
    expect(manual.damageObservation?.join(" ")).toContain(
      "provenance (`damage_event` or `death_notification`)",
    );
    expect(manual.damageObservation?.join(" ")).toContain(
      "does not include an entity ID, coordinates, or username",
    );
    expect(manual.damageObservation?.join(" ")).toContain(
      "`self.health` may be null",
    );
  });

  it("records movement trials as historical, scope-limited evidence", () => {
    const manual = describeOperationManual("move_to");

    expect(manual.historicalTrial?.status).toBe("historical_representative");
    expect(manual.historicalTrial?.scope).toContain(
      "does not establish present connection readiness",
    );
    expect(manual.successEvidence.join(" ")).toContain(
      "within the requested range",
    );
  });

  it("keeps a historical look trial separate from an unmeasured sweep", () => {
    const manual = describeOperationManual("look");

    expect(manual.historicalTrial?.status).toBe("historical_representative");
    expect(manual.historicalTrial?.scope).toContain(
      "does not establish present connection readiness",
    );
  });
});
