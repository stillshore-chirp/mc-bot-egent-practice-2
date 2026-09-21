import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { DeliveryController } from "../../src/app/delivery-controller.js";
import { MemoryStore } from "../../src/memory/store.js";
import { ActionArbiter } from "../../src/runtime/action-arbiter.js";
import type { ToolContext } from "../../src/tools/contracts.js";
import { ToolExecutor } from "../../src/tools/executor.js";
import { FakeMinecraft } from "../support/fake-minecraft.js";
const directories: string[] = [];
const stores: MemoryStore[] = [];
afterEach(() => {
  for (const store of stores.splice(0)) store.close();
  for (const dir of directories.splice(0))
    rmSync(dir, { recursive: true, force: true });
});
function setup() {
  const dir = mkdtempSync(join(tmpdir(), "delivery-fixture-"));
  directories.push(dir);
  const path = join(dir, "memory.sqlite");
  const memory = MemoryStore.open(path);
  stores.push(memory);
  const minecraft = new FakeMinecraft();
  const arbiter = new ActionArbiter();
  const delivery = new DeliveryController(minecraft, memory, "owner", arbiter);
  return {
    path,
    memory,
    minecraft,
    delivery,
    arbiter,
    signal: new AbortController().signal,
  };
}
describe("explicit delivery target registration", () => {
  it("does not invent targets, restores after restart, supports correction and deletion", async () => {
    const { delivery, minecraft, memory, path, signal } = setup();
    expect(delivery.list()).toEqual([]);
    await delivery.register("home", null, signal);
    const position = { x: 2, y: 64, z: 1 };
    minecraft.storageIdentities.set(
      JSON.stringify(position),
      "fixture-chest-v1",
    );
    await delivery.register("chest", position, signal);
    minecraft.storageIdentities.set(
      JSON.stringify(position),
      "fixture-chest-v2",
    );
    await delivery.register("chest", position, signal);
    const id = memory.getOrCreatePlayer("owner").id;
    memory.close();
    const restored = MemoryStore.open(path);
    stores.push(restored);
    expect(restored.getDeliveryTargets(id)).toHaveLength(2);
    expect(
      restored.getDeliveryTargets(id).find((t) => t.kind === "chest"),
    ).toMatchObject({ identity: "fixture-chest-v2" });
    restored.forgetDeliveryTarget(id, "chest");
    expect(restored.getDeliveryTargets(id).map((t) => t.kind)).toEqual([
      "home",
    ]);
    const other = restored.getOrCreatePlayer("another_owner");
    expect(restored.getDeliveryTargets(other.id)).toEqual([]);
  });
  it("rejects absent chest and pre-aborted registration without retaining a lease", async () => {
    const { delivery, arbiter, signal } = setup();
    await expect(
      delivery.register("chest", { x: 2, y: 64, z: 1 }, signal),
    ).rejects.toMatchObject({ detail: { code: "CHEST_NOT_REGISTERABLE" } });
    await expect(
      delivery.register("home", null, AbortSignal.abort()),
    ).rejects.toThrow();
    expect(delivery.list()).toEqual([]);
    arbiter.acquire("next", 50).release();
  });
  it("requires authorized owner message for registration and deletion", async () => {
    const { delivery, signal } = setup();
    const executor = new ToolExecutor();
    const base = {
      requesterUsername: "other",
      authorizedOwnerUsername: "owner",
      requestKind: "owner_message",
      signal,
      game: { delivery },
      executionEvidence: { verifiedActionReceipts: [] },
    } as unknown as ToolContext;
    for (const [name, args] of [
      ["register_delivery_target", { kind: "home", position: null }],
      ["forget_delivery_target", { kind: "home" }],
    ] as const) {
      expect(
        await executor.execute(name, JSON.stringify(args), base),
      ).toMatchObject({
        success: false,
        error: { code: "REQUESTER_NOT_AUTHORIZED" },
      });
      expect(
        await executor.execute(name, JSON.stringify(args), {
          ...base,
          requesterUsername: "owner",
          requestKind: "runtime_reassessment",
        }),
      ).toMatchObject({
        success: false,
        error: { code: "RUNTIME_REASSESSMENT_TOOL_NOT_ALLOWED" },
      });
    }
    expect(delivery.list()).toEqual([]);
    expect(
      await executor.execute(
        "register_delivery_target",
        JSON.stringify({ kind: "home", position: null }),
        { ...base, requesterUsername: "owner" },
      ),
    ).toMatchObject({ success: true });
  });
  it("does not modify a target while a task holds the action lock", async () => {
    const { delivery, arbiter, signal } = setup();
    await delivery.register("home", null, signal);
    const lease = arbiter.acquire("gather", 50);
    expect(() => delivery.forget("home", signal)).toThrow();
    await expect(delivery.register("home", null, signal)).rejects.toThrow();
    expect(delivery.list()).toHaveLength(1);
    lease.release();
  });
});
