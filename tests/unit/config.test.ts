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
  it("loads companion defaults and keeps the provider credential available", () => {
    const config = loadConfig(requiredEnvironment);

    expect(config.minecraft.version).toBe("1.21.11");
    expect(config.openai.model).toBe("gpt-6-luna");
    expect(config.memoryContextLimit).toBe(12);
    expect(config.connection).toEqual({
      timeoutMs: 60_000,
      reconnectEnabled: true,
      reconnectMaxAttempts: 5,
      reconnectDelayMs: 5_000,
    });
    expect(config.dashboard).toEqual({
      enabled: true,
      host: "127.0.0.1",
      port: 4_310,
      authToken: undefined,
    });
    expect(config.openai.apiKey).toBe("test-only-value");
  });

  it("rejects a Bot identity that would replace the authorized player", () => {
    expect(() =>
      loadConfig({
        ...requiredEnvironment,
        MINECRAFT_USERNAME: "OwNeR",
      }),
    ).toThrow(
      /OWNER_USERNAME: owner and Bot must use different Minecraft identities/u,
    );
  });

  it("reports validation failures without echoing credentials", () => {
    const syntheticCredential = "synthetic-api-key-for-error-test";
    try {
      loadConfig({
        ...requiredEnvironment,
        OPENAI_API_KEY: syntheticCredential,
        MINECRAFT_PORT: "not-a-port",
      });
      throw new Error("expected validation failure");
    } catch (error) {
      expect(error).toBeInstanceOf(ConfigurationError);
      expect(String(error)).not.toContain(syntheticCredential);
    }
  });

  it("bounds the Minecraft connection timeout and retry delay", () => {
    expect(() =>
      loadConfig({ ...requiredEnvironment, CONNECT_TIMEOUT_MS: "999" }),
    ).toThrow(ConfigurationError);
    expect(() =>
      loadConfig({ ...requiredEnvironment, RECONNECT_DELAY_MS: "70000" }),
    ).toThrow(ConfigurationError);
  });

  it("keeps dashboard binding on loopback regardless of token", () => {
    expect(() =>
      loadConfig({ ...requiredEnvironment, DASHBOARD_HOST: "0.0.0.0" }),
    ).toThrow(/DASHBOARD_HOST: dashboard only supports loopback binding/u);
    expect(() =>
      loadConfig({
        ...requiredEnvironment,
        DASHBOARD_HOST: "0.0.0.0",
        DASHBOARD_AUTH_TOKEN: "too-short",
      }),
    ).toThrow(/dashboard token must contain at least 32 characters/u);
    expect(() =>
      loadConfig({
        ...requiredEnvironment,
        DASHBOARD_HOST: "0.0.0.0",
        DASHBOARD_AUTH_TOKEN: "t".repeat(32),
      }),
    ).toThrow(/DASHBOARD_HOST: dashboard only supports loopback binding/u);
    expect(() =>
      loadConfig({
        ...requiredEnvironment,
        DASHBOARD_ENABLED: "false",
        DASHBOARD_HOST: "0.0.0.0",
        DASHBOARD_AUTH_TOKEN: "t".repeat(32),
      }),
    ).toThrow(/DASHBOARD_HOST: dashboard only supports loopback binding/u);

    const loopbackConfig = loadConfig({
      ...requiredEnvironment,
      DASHBOARD_AUTH_TOKEN: "t".repeat(32),
    });
    expect(loopbackConfig.dashboard.authToken).toBe("t".repeat(32));
  });
});
