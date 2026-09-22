import { describe, expect, it } from "vitest";

import { recommendArmor } from "../../src/decision/armor-equipment.js";
import { createSnapshot } from "../support/fake-minecraft.js";

describe("armor equipment decision", () => {
  it("fills empty slots with the strongest carried base item", () => {
    const snapshot = createSnapshot({
      inventory: [
        { name: "leather_helmet", count: 1 },
        { name: "iron_helmet", count: 1 },
        { name: "diamond_chestplate", count: 1 },
      ],
    });
    expect(recommendArmor(snapshot)).toEqual([
      { slot: "head", itemName: "iron_helmet" },
      { slot: "torso", itemName: "diamond_chestplate" },
    ]);
  });

  it("does not replace worn gear or infer unobserved slots", () => {
    const inventory = [{ name: "netherite_helmet", count: 1 }];
    expect(
      recommendArmor(
        createSnapshot({
          inventory,
          armor: {
            head: "leather_helmet",
            torso: null,
            legs: null,
            feet: null,
          },
        }),
      ),
    ).toEqual([]);
    expect(recommendArmor(createSnapshot({ inventory, armor: null }))).toEqual(
      [],
    );
  });
});
