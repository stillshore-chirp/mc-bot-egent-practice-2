import { describe, expect, it } from "vitest";
import minecraftData from "minecraft-data";

import { isHostileEntity } from "../../src/decision/hostile-classification.js";

describe("versioned hostile classification", () => {
  const registry = minecraftData("1.21.11");

  it("includes current hostile species outside the earlier static list", () => {
    for (const name of [
      "wither",
      "ender_dragon",
      "breeze",
      "bogged",
      "creaking",
    ]) {
      const entity = registry.entitiesByName[name];
      expect(entity, name).toBeDefined();
      expect(isHostileEntity(name, entity?.type ?? "mob", registry)).toBe(true);
    }
  });

  it("keeps passive creatures and players out of hostile response", () => {
    for (const name of ["cow", "wolf", "iron_golem", "player"]) {
      const entity = registry.entitiesByName[name];
      expect(isHostileEntity(name, entity?.type ?? "player", registry)).toBe(
        false,
      );
    }
  });

  it("uses 26.1 registry types so hostile category alone does not promote other entities", () => {
    const registry261 = minecraftData("26.1");
    for (const name of ["zombie", "skeleton", "creeper", "drowned"]) {
      const entity = registry261.entitiesByName[name];
      expect(entity?.type, name).toBe("hostile");
      expect(
        isHostileEntity(name, entity?.type ?? "unknown", registry261),
      ).toBe(true);
    }
    for (const name of ["end_crystal", "strider"]) {
      const entity = registry261.entitiesByName[name];
      expect(entity?.category, name).toBe("Hostile mobs");
      expect(entity?.type).not.toBe("hostile");
      expect(isHostileEntity(name, entity?.type ?? "mob", registry261)).toBe(
        false,
      );
      expect(isHostileEntity(name, "hostile", registry261)).toBe(false);
    }
    expect(isHostileEntity("player", "player", registry261)).toBe(false);
  });

  it("keeps the category fallback only for legacy mob adapter data", () => {
    const legacyRegistry = {
      entitiesByName: {
        legacy_zombie: { category: "Hostile mobs" },
        legacy_crystal: { type: "other", category: "Hostile mobs" },
      },
    };
    expect(isHostileEntity("legacy_zombie", "mob", legacyRegistry)).toBe(true);
    expect(isHostileEntity("legacy_zombie", "hostile", legacyRegistry)).toBe(
      true,
    );
    expect(isHostileEntity("legacy_crystal", "mob", legacyRegistry)).toBe(
      false,
    );
    expect(isHostileEntity("future_hostile", "hostile", registry)).toBe(true);
    expect(isHostileEntity("future_unknown", "other", registry)).toBe(false);
  });
});
