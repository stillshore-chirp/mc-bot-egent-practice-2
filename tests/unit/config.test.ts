import { describe, expect, it } from "vitest";

import {
  ConfigurationError,
  loadConfig,
} from "../../src/config/load-config.js";

const requiredEnvironment = {
  MINECRAFT_HOST: "minecraft.invalid",
  MINECRAFT_USERNAME: "companion@example.invalid",
  OWNER_USERNAME: "owner",
  OPENAI_API_KEY: "test-only-value",
};

describe("loadConfig", () => {
  it("loads bounded defaults without exposing the API key", () => {
    const config = loadConfig(requiredEnvironment);

    expect(config.minecraft.version).toBe("1.21.11");
    expect(config.limits.maxGatherCount).toBe(64);
    expect(config.reconnect.maxAttempts).toBe(5);
  });

  it("rejects unsafe limits", () => {
    expect(() =>
      loadConfig({ ...requiredEnvironment, MAX_GATHER_COUNT: "65" }),
    ).toThrow(ConfigurationError);
  });

  it("reports only field names and validation messages", () => {
    try {
      loadConfig({ ...requiredEnvironment, OPENAI_API_KEY: "" });
      throw new Error("expected validation failure");
    } catch (error) {
      expect(error).toBeInstanceOf(ConfigurationError);
      expect(String(error)).not.toContain("test-only-value");
    }
  });
});
