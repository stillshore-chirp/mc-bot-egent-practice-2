import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import type { AppConfig } from "../../src/config/schema.js";
import { createApplication } from "../../src/app/application.js";

describe("player application database setup", () => {
  it("creates a missing nested database directory before opening stores", async () => {
    const temporaryRoot = mkdtempSync(join(tmpdir(), "player-app-database-"));
    const databasePath = join(
      temporaryRoot,
      "nested",
      "fresh",
      "player.sqlite",
    );
    const config: AppConfig = {
      minecraft: {
        host: "127.0.0.1",
        port: 25565,
        username: "companion",
        auth: "offline",
        version: "1.21.11",
      },
      ownerUsername: "owner",
      openai: { apiKey: "test-key", model: "test-model" },
      databasePath,
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
      reconnect: { enabled: true, maxAttempts: 1, delayMs: 500 },
      dashboard: {
        enabled: false,
        host: "127.0.0.1",
        port: 4310,
        staticDirectory: "dashboard/dist",
        maxAgeDays: 30,
        maxTraces: 500,
      },
    };

    try {
      const application = createApplication(config);
      expect(existsSync(dirname(databasePath))).toBe(true);
      expect(existsSync(databasePath)).toBe(true);
      await application.shutdown("test_complete");
    } finally {
      rmSync(temporaryRoot, { recursive: true, force: true });
    }
  });
});
