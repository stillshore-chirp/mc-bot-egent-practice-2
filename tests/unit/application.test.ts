import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import type { AppConfig } from "../../src/config/schema.js";
import {
  createApplication,
  sanitizeMinecraftChatText,
} from "../../src/app/application.js";

describe("outgoing Minecraft chat normalization", () => {
  it("prevents slash-leading commands on every line and keeps text bounded", () => {
    const guard = "\u200B";
    expect(sanitizeMinecraftChatText("/cmd")).toBe(`${guard}/cmd`);
    expect(sanitizeMinecraftChatText("\n/cmd")).toBe(`${guard}/cmd`);
    expect(sanitizeMinecraftChatText("first\r\n/cmd")).toBe(
      `first ${guard}/cmd`,
    );
    expect(sanitizeMinecraftChatText("a".repeat(241))).toHaveLength(240);
    expect(sanitizeMinecraftChatText("Hello there.")).toBe("Hello there.");
  });
});

describe("companion application setup", () => {
  it("creates a nested database directory before opening the companion store", async () => {
    const temporaryRoot = mkdtempSync(
      join(tmpdir(), "companion-app-database-"),
    );
    const databasePath = join(
      temporaryRoot,
      "nested",
      "fresh",
      "companion.sqlite",
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
      openai: { apiKey: "test-key", model: "gpt-6-luna" },
      databasePath,
      personaPath: fileURLToPath(
        new URL("../../config/persona.example.json", import.meta.url),
      ),
      logLevel: "silent",
      connection: {
        timeoutMs: 60_000,
        reconnectEnabled: true,
        reconnectMaxAttempts: 1,
        reconnectDelayMs: 500,
      },
      memoryContextLimit: 12,
      dashboard: { enabled: true, host: "127.0.0.1", port: 4_310 },
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
