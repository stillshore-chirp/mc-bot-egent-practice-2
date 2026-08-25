import { describe, expect, it } from "vitest";
import { ConnectionManager } from "../../src/minecraft/connection-manager.js";
import { FakeMinecraft } from "../support/fake-minecraft.js";

describe("Minecraft boundary", () => {
  it("connects through the bounded connection manager", async () => {
    const minecraft = new FakeMinecraft();
    const manager = new ConnectionManager(
      minecraft,
      { maxAttempts: 2, initialDelayMs: 0, maxDelayMs: 0, multiplier: 1 },
      1_000,
    );
    await manager.connect();
    expect(manager.state).toBe("connected");
    expect(minecraft.actions).toEqual(["connect"]);
  });

  it("stops product controls through the port", async () => {
    const minecraft = new FakeMinecraft();
    await minecraft.stopCurrentAction();
    expect(minecraft.stopCount).toBe(1);
  });

  it("returns actually observed bounded surroundings through the port contract", async () => {
    const minecraft = new FakeMinecraft();
    minecraft.resources.push({
      name: "oak_log",
      position: { x: 1, y: 64, z: 0 },
    });
    const surroundings = await minecraft.observeSurroundings(8, false);
    expect(surroundings.blocks).toMatchObject([{ name: "oak_log" }]);
    expect(surroundings.entities).toEqual([]);
  });

  it("subscribes and unsubscribes chat listeners", () => {
    const minecraft = new FakeMinecraft();
    const messages: string[] = [];
    const unsubscribe = minecraft.onChat((_username, message) =>
      messages.push(message),
    );
    minecraft.emitChat("owner", "first");
    unsubscribe();
    minecraft.emitChat("owner", "second");
    expect(messages).toEqual(["first"]);
  });

  it("reconnects with the same bounded policy after a connection end", async () => {
    const minecraft = new FakeMinecraft();
    const manager = new ConnectionManager(
      minecraft,
      { maxAttempts: 2, initialDelayMs: 0, maxDelayMs: 0, multiplier: 1 },
      1_000,
    );
    await manager.connect();
    minecraft.emitDisconnected();
    await new Promise((resolve) => setImmediate(resolve));
    expect(
      minecraft.actions.filter((action) => action === "connect"),
    ).toHaveLength(2);
    await manager.shutdown();
    expect(manager.state).toBe("stopped");
  });

  it("enters an explicit failed state when reconnect is disabled", async () => {
    const minecraft = new FakeMinecraft();
    const manager = new ConnectionManager(
      minecraft,
      { maxAttempts: 1, initialDelayMs: 0, maxDelayMs: 0, multiplier: 1 },
      1_000,
      false,
    );
    await manager.connect();
    minecraft.emitDisconnected();
    expect(manager.state).toBe("failed");
    expect(manager.lastReconnectFailure).toMatchObject({
      detail: { code: "RECONNECT_DISABLED" },
    });
    await manager.shutdown();
  });
});
