import { EventEmitter } from "node:events";
import { describe, expect, it } from "vitest";
import { AppError } from "../../src/domain/errors.js";
import {
  actionGuardChannel,
  queryActionGuard,
  requireActionPermission,
} from "../../src/minecraft/action-guard.js";

class FakeClient extends EventEmitter {
  public writes: { channel: string; data: Buffer }[] = [];

  write(_packet: string, value: { channel: string; data: Buffer }): void {
    this.writes.push(value);
    const request = JSON.parse(value.data.toString("utf8")) as { id: string };
    queueMicrotask(() =>
      this.emit("custom_payload", {
        channel: actionGuardChannel,
        data: Buffer.from(
          JSON.stringify({ id: request.id, decision: "allowed" }),
        ),
      }),
    );
  }
}

describe("generic action guard protocol", () => {
  it("requires a fresh server decision for a mutation", async () => {
    const client = new FakeClient();
    await expect(
      queryActionGuard(client as never, {
        operation: "mine",
        name: "iron_ore",
        position: { x: 1, y: 63, z: 0 },
      }),
    ).resolves.toBe("allowed");
    expect(client.writes).toHaveLength(1);
  });

  it("supports a read-only authoritative state check", async () => {
    const client = new FakeClient();
    await expect(
      queryActionGuard(client as never, {
        operation: "inspect",
        name: "air",
        position: { x: 1, y: 63, z: 0 },
      }),
    ).resolves.toBe("allowed");
    const write = client.writes[0];
    expect(write).toBeDefined();
    expect(JSON.parse(write?.data.toString("utf8") ?? "{}")).toMatchObject({
      operation: "inspect",
      name: "air",
    });
  });

  it("queries server-verified build ground without a mutation permit", async () => {
    const client = new FakeClient();
    await expect(
      queryActionGuard(client as never, {
        operation: "site",
        name: "grass_block",
        position: { x: 1, y: 63, z: 0 },
      }),
    ).resolves.toBe("allowed");
    expect(
      JSON.parse(client.writes[0]?.data.toString("utf8") ?? "{}"),
    ).toMatchObject({
      operation: "site",
      name: "grass_block",
    });
  });

  it("fails closed for a protected decision", () => {
    try {
      requireActionPermission("protected");
      throw new Error("expected protected action to fail");
    } catch (error: unknown) {
      expect(error).toBeInstanceOf(AppError);
      expect((error as AppError).detail.code).toBe("ACTION_PROTECTED");
    }
  });
});
