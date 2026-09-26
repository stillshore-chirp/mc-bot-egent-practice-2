import { describe, expect, it } from "vitest";

import { classifyFurnaceRconReply } from "../e2e/furnace-rcon-classifier.js";

describe("furnace RCON reply classification", () => {
  it("recognizes a canonical item in an NBT payload without inventing a count", () => {
    expect(
      classifyFurnaceRconReply(
        'Block data: {Items:[{Slot:0b,id:"minecraft:raw_iron",count:1}]}',
      ),
    ).toEqual({ replyClass: "canonical_item", hasCanonicalRawIron: true });
  });

  it("accepts only an explicit empty Items payload", () => {
    expect(classifyFurnaceRconReply("Block data: {Items: []}")).toEqual({
      replyClass: "empty_list",
      hasCanonicalRawIron: false,
    });
    expect(
      classifyFurnaceRconReply(
        'Block data: {Items:[{id:"minecraft:iron_ingot",tag:{display:[]}}]}',
      ),
    ).toEqual({ replyClass: "other", hasCanonicalRawIron: false });
  });

  it("does not treat a similarly named item identifier as raw iron", () => {
    expect(
      classifyFurnaceRconReply(
        'Block data: {Items:[{id:"minecraft:raw_iron_block",count:1}]}',
      ),
    ).toEqual({ replyClass: "other", hasCanonicalRawIron: false });
  });

  it("keeps error, no-data, and transport replies from confirming an item", () => {
    expect(
      classifyFurnaceRconReply("Error reading minecraft:raw_iron data"),
    ).toEqual({ replyClass: "error", hasCanonicalRawIron: false });
    expect(classifyFurnaceRconReply("No block data found")).toEqual({
      replyClass: "no_data",
      hasCanonicalRawIron: false,
    });
    expect(classifyFurnaceRconReply(null)).toEqual({
      replyClass: "error",
      hasCanonicalRawIron: false,
    });
  });
});
