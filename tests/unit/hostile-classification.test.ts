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

  it("uses a hostile protocol type only when registry data is unavailable", () => {
    expect(isHostileEntity("future_hostile", "hostile", registry)).toBe(true);
    expect(isHostileEntity("future_unknown", "other", registry)).toBe(false);
  });
});
