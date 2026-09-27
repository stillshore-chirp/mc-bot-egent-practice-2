import { describe, expect, it } from "vitest";

import { readExecuteIfItemsRconReply } from "./equipment-rcon-oracle.js";
import {
  classifyItemReplaceReply,
  confirmsEmptyItemSlot,
  confirmsEquipmentHeadEmpty,
  parseGameTimeReply,
} from "./equipment-cleanup-rcon.js";

describe("equipment cleanup RCON evidence", () => {
  it("keeps item replacement replies in a fixed safe classification", () => {
    expect(classifyItemReplaceReply("Set the head slot to air")).toBe(
      "changed",
    );
    expect(classifyItemReplaceReply("Nothing changed")).toBe("no_change");
    expect(classifyItemReplaceReply("Unknown or incomplete command")).toBe(
      "error",
    );
    expect(classifyItemReplaceReply("Command completed")).toBe("unclassified");
    expect(classifyItemReplaceReply(null)).toBe("not_received");
  });

  it("requires an observed negative slot predicate before confirming empty", () => {
    expect(confirmsEmptyItemSlot(readExecuteIfItemsRconReply("0"))).toBe(true);
    expect(
      confirmsEmptyItemSlot(
        readExecuteIfItemsRconReply("Test failed, no items matched"),
      ),
    ).toBe(true);
    expect(
      confirmsEmptyItemSlot(
        readExecuteIfItemsRconReply("Unknown or incomplete command"),
      ),
    ).toBe(false);
    expect(
      confirmsEmptyItemSlot(readExecuteIfItemsRconReply("unexpected reply")),
    ).toBe(false);
  });

  it("requires both the absent equipment field and a known empty slot result", () => {
    expect(
      confirmsEquipmentHeadEmpty(
        "Found no elements matching equipment",
        readExecuteIfItemsRconReply("Test failed"),
      ),
    ).toBe(true);
    expect(
      confirmsEquipmentHeadEmpty(
        "Found no elements matching equipment",
        readExecuteIfItemsRconReply("unexpected reply"),
      ),
    ).toBe(false);
    expect(
      confirmsEquipmentHeadEmpty(
        "Unknown or incomplete command",
        readExecuteIfItemsRconReply("Test failed"),
      ),
    ).toBe(false);
  });

  it("reads only the explicit game-time field for the tick boundary", () => {
    expect(parseGameTimeReply("The time is 1250")).toBe(1250);
    expect(parseGameTimeReply("The time is 1251.")).toBe(1251);
    expect(parseGameTimeReply("Unknown command")).toBeUndefined();
    expect(parseGameTimeReply(null)).toBeUndefined();
  });
});
