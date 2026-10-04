import { describe, expect, it } from "vitest";

import { selectArmorUpgrades } from "../../src/minecraft/player-armor-selection.js";

describe("player armor selection", () => {
  it("fills explicitly empty slots with the best carried known armor", () => {
    const helmet = { name: "diamond_helmet", slot: 1 };
    const boots = { name: "iron_boots", slot: 2 };
    const upgrades = selectArmorUpgrades(
      [{ name: "leather_helmet" }, helmet, { name: "golden_boots" }, boots],
      { head: null, torso: null, legs: null, feet: null },
    );

    expect(upgrades).toEqual([
      { item: helmet, destination: "head" },
      { item: boots, destination: "feet" },
    ]);
    expect(upgrades[0]?.item).toBe(helmet);
    expect(upgrades[1]?.item).toBe(boots);
  });

  it("chooses only a strictly stronger material for occupied slots", () => {
    const candidate = { name: "diamond_boots" };
    const upgrades = selectArmorUpgrades(
      [{ name: "golden_boots" }, candidate, { name: "copper_boots" }],
      { feet: { name: "iron_boots" } },
    );

    expect(upgrades).toEqual([{ item: candidate, destination: "feet" }]);
  });

  it("keeps equal or stronger equipped gear and does not rank unknown gear", () => {
    const upgrades = selectArmorUpgrades(
      [
        { name: "diamond_helmet" },
        { name: "netherite_chestplate" },
        { name: "diamond_leggings" },
      ],
      {
        head: "diamond_helmet",
        torso: "netherite_chestplate",
        legs: "modded_leggings",
      },
    );

    expect(upgrades).toEqual([]);
  });

  it("ignores weapons, elytra, shields, and unknown armor names", () => {
    const upgrades = selectArmorUpgrades(
      [
        { name: "diamond_sword" },
        { name: "elytra" },
        { name: "shield" },
        { name: "turtle_helmet" },
        { name: "obsidian_chestplate" },
      ],
      { head: null, torso: null, legs: null, feet: null },
    );

    expect(upgrades).toEqual([]);
  });

  it("does not treat a slot with no observation as empty", () => {
    const upgrades = selectArmorUpgrades([{ name: "netherite_helmet" }], {
      torso: null,
      legs: null,
      feet: null,
    });

    expect(upgrades).toEqual([]);
  });
});
