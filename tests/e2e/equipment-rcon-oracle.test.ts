import { describe, expect, it } from "vitest";

import {
  readEquipmentFieldFromRcon,
  readExecuteIfItemsRconReply,
} from "./equipment-rcon-oracle.js";

describe("equipment RCON oracle", () => {
  it("matches the requested item in the current equipment field", () => {
    expect(
      readEquipmentFieldFromRcon(
        'Bot has the following entity data: {id:"minecraft:iron_helmet",count:1,components:{"minecraft:damage":0}}',
        "minecraft:iron_helmet",
      ),
    ).toEqual({ equipmentFieldObserved: true, expectedItemMatched: true });
    expect(
      readEquipmentFieldFromRcon(
        'Bot has the following entity data: {id:"minecraft:leather_helmet",count:1}',
        "minecraft:iron_helmet",
      ),
    ).toEqual({ equipmentFieldObserved: true, expectedItemMatched: false });
  });

  it("does not treat an unavailable or malformed equipment field as a match", () => {
    expect(
      readEquipmentFieldFromRcon(
        "Found no elements matching equipment.head",
        "minecraft:iron_helmet",
      ),
    ).toEqual({ equipmentFieldObserved: false, expectedItemMatched: false });
    expect(
      readEquipmentFieldFromRcon(
        'Bot has the following entity data: {custom:{id:"minecraft:iron_helmet"}}',
        "minecraft:iron_helmet",
      ),
    ).toEqual({ equipmentFieldObserved: true, expectedItemMatched: false });
  });

  it("classifies the observed execute-if-items count", () => {
    expect(readExecuteIfItemsRconReply("1 matching item")).toEqual({
      resultObserved: true,
      expectedItemMatched: true,
    });
    expect(readExecuteIfItemsRconReply("0")).toEqual({
      resultObserved: true,
      expectedItemMatched: false,
    });
    expect(
      readExecuteIfItemsRconReply("Test failed, no items matched"),
    ).toEqual({ resultObserved: true, expectedItemMatched: false });
    expect(
      readExecuteIfItemsRconReply("Unknown or incomplete command"),
    ).toEqual({ resultObserved: false, expectedItemMatched: false });
  });
});
