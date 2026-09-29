import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import {
  countCarriedHelmetBodyItems,
  createOwnerReturnApplicationWithBodyCapture,
  parseArmorCapabilityEquipmentHeadReply,
  parseArmorCapabilityInventoryReply,
} from "./ai-player-live.js";
import { createApplication } from "../../src/app/application.js";
import type { AppConfig } from "../../src/config/schema.js";
import {
  isArmorCapabilityTargeted,
  TARGETABLE_CASES,
} from "./target-case-selection.js";

describe("armor capability targeted E2E case", () => {
  it("is selected only for its explicit target", () => {
    expect(TARGETABLE_CASES).toContain("armor_capability");
    expect(isArmorCapabilityTargeted("armor_capability")).toBe(true);
    expect(isArmorCapabilityTargeted(undefined)).toBe(false);
    expect(isArmorCapabilityTargeted("owner_stop_latch")).toBe(false);
  });

  it("separates carried item count from the server head equipment slot", () => {
    expect(
      countCarriedHelmetBodyItems(
        [
          { slot: 0, name: "leather_helmet", count: 1 },
          { slot: 5, name: "leather_helmet", count: 1 },
        ],
        [{ slot: 5 }, null],
      ),
    ).toBe(1);
    expect(
      parseArmorCapabilityInventoryReply(
        `Bot has the following entity data: [{Slot:0b,id:"minecraft:leather_helmet",count:1,components:{"minecraft:custom_data":{value:1}}}]`,
      ),
    ).toBe(1);
    expect(
      parseArmorCapabilityInventoryReply(
        `Bot has the following entity data: [{Slot:103b,id:"minecraft:leather_helmet",count:1,components:{"minecraft:custom_data":{value:1}}}]`,
      ),
    ).toBe(0);
    expect(
      parseArmorCapabilityInventoryReply(
        "Bot has the following entity data: []",
      ),
    ).toBe(0);
    expect(parseArmorCapabilityInventoryReply("read failed")).toBeNull();
    expect(
      parseArmorCapabilityEquipmentHeadReply(
        'ArmorBot has the following entity data: "minecraft:leather_helmet"',
        "ArmorBot",
      ),
    ).toBe("expected_item");
    expect(
      parseArmorCapabilityEquipmentHeadReply(
        'ArmorBot has the following entity data: "minecraft:stone"',
        "ArmorBot",
      ),
    ).toBe("other_item");
    expect(
      parseArmorCapabilityEquipmentHeadReply(
        "Found no elements matching equipment.head.id",
        "ArmorBot",
      ),
    ).toBe("empty");
    for (const reply of [
      "read failed",
      'OtherBot has the following entity data: "minecraft:leather_helmet"',
      'ArmorBot has the following entity data: "minecraft:leather_helmet',
      'ArmorBot has the following entity data: "minecraft:leather_helmet" "minecraft:stone"',
    ]) {
      expect(parseArmorCapabilityEquipmentHeadReply(reply, "ArmorBot")).toBe(
        "unknown",
      );
    }
  });

  it("keeps malformed or truncated replies unknown", () => {
    const replies = [
      "Found 0 elements: []",
      `Bot has the following entity data: [{Slot:0b,id:"minecraft:stone",count:1}] {Slot:103b,id:"minecraft:leather_helmet"`,
      `Bot has the following entity data: [{Slot:0b,id:"minecraft:leather_helmet",count:1}`,
      `Bot has the following entity data: [{id:"minecraft:leather_helmet",count:1}]`,
      `Bot has the following entity data: [{Slot:"0",id:"minecraft:leather_helmet",count:1}]`,
      `Bot has the following entity data: [{Slot:0b,id:"minecraft:leather_helmet",count:"1"}]`,
    ];
    for (const reply of replies)
      expect(parseArmorCapabilityInventoryReply(reply)).toBeNull();
  });

  it("reads only top-level stack id, slot, and count fields", () => {
    expect(
      parseArmorCapabilityInventoryReply(
        `Bot has the following entity data: [{Slot:0b,id:"minecraft:stone",count:1,components:{id:"minecraft:leather_helmet",count:64}}]`,
      ),
    ).toBe(0);
    expect(
      parseArmorCapabilityInventoryReply(
        `Bot has the following entity data: [{Slot:103b,id:"minecraft:stone",count:1}]`,
      ),
    ).toBe(0);
  });

  it("captures the application Body only for the explicit armor target", async () => {
    const temporaryRoot = mkdtempSync(
      join(tmpdir(), "armor-capability-body-capture-"),
    );
    const config: AppConfig = {
      minecraft: {
        host: "127.0.0.1",
        port: 25565,
        username: "armor-body-capture-bot",
        auth: "offline",
        version: "1.21.11",
      },
      ownerUsername: "armor-body-capture-owner",
      openai: { apiKey: "test-only-value", model: "test-model" },
      databasePath: join(temporaryRoot, "player.sqlite"),
      personaPath: fileURLToPath(
        new URL("../../config/persona.example.json", import.meta.url),
      ),
      logLevel: "silent",
      limits: {
        maxMoveDistance: 128,
        maxGatherCount: 64,
        taskTimeoutMs: 900_000,
        skillRetryLimit: 2,
        followDistance: 3,
        hungerThreshold: 14,
        memoryContextLimit: 12,
      },
      reconnect: { enabled: false, maxAttempts: 0, delayMs: 250 },
      dashboard: {
        enabled: false,
        host: "127.0.0.1",
        port: 4310,
        staticDirectory: "dashboard/dist",
        maxAgeDays: 30,
        maxTraces: 500,
      },
    };
    let capturedBodies = 0;
    const created = createOwnerReturnApplicationWithBodyCapture(
      "armor_capability",
      createApplication,
      config,
      () => {
        throw new Error("PROVIDER_REQUEST_NOT_EXPECTED_IN_FACTORY_TEST");
      },
      () => {
        capturedBodies += 1;
      },
    );
    try {
      expect(capturedBodies).toBe(1);
    } finally {
      try {
        await created.application.shutdown("test_complete");
      } finally {
        created.restoreProbe?.();
        rmSync(temporaryRoot, { recursive: true, force: true });
      }
    }
  });
});
