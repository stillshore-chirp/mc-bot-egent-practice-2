import { randomUUID } from "node:crypto";
import type { Client } from "minecraft-protocol";
import { AppError } from "../domain/errors.js";
import { throwIfAborted } from "../runtime/cancellation.js";
import type { ResourceTarget } from "./port.js";

export const treeProtectionChannel = "companion:tree_guard";
export type TreeDecision = "allowed" | "unknown" | "protected" | "changed";

/** 許可は保存しない。探索時と採掘直前に、その接続先へ再照会する。 */
export async function queryTreeProtection(
  client: Pick<Client, "on" | "off" | "write">,
  target: ResourceTarget,
  signal?: AbortSignal,
  timeoutMs = 1_500,
): Promise<TreeDecision> {
  if (signal) throwIfAborted(signal, "tree_protection");
  const id = randomUUID();
  return new Promise((resolve, reject) => {
    const cleanup = () => {
      clearTimeout(timer);
      client.off("custom_payload", receive);
      client.off("end", disconnected);
      signal?.removeEventListener("abort", cancelled);
    };
    const fail = (code: string) => {
      cleanup();
      reject(
        new AppError({
          category: "safety",
          code,
          message:
            "採取許可を確認できません。建築保護の補助と成長履歴を確認してください。",
          retryable: false,
          failedAt: "tree_protection",
        }),
      );
    };
    const receive = (packet: { channel: string; data: unknown }) => {
      if (
        packet.channel !== treeProtectionChannel ||
        !Buffer.isBuffer(packet.data) ||
        packet.data.length > 256
      )
        return;
      const parts = packet.data.toString("utf8").split("|");
      if (parts[0] !== id) return;
      const decision = parts[1];
      if (
        parts.length !== 2 ||
        !["allowed", "unknown", "protected", "changed"].includes(decision ?? "")
      ) {
        fail("TREE_PROTECTION_INVALID_RESPONSE");
        return;
      }
      cleanup();
      resolve(decision as TreeDecision);
    };
    const disconnected = () => fail("TREE_PROTECTION_DISCONNECTED");
    const cancelled = () => {
      cleanup();
      try {
        if (signal) throwIfAborted(signal, "tree_protection");
      } catch (error) {
        reject(
          error instanceof Error
            ? error
            : new Error("Tree inspection cancelled"),
        );
      }
    };
    const timer = setTimeout(
      () => fail("TREE_PROTECTION_UNAVAILABLE"),
      timeoutMs,
    );
    client.on("custom_payload", receive);
    client.on("end", disconnected);
    signal?.addEventListener("abort", cancelled, { once: true });
    try {
      client.write("custom_payload", {
        channel: treeProtectionChannel,
        data: Buffer.from(
          [
            id,
            target.position.x,
            target.position.y,
            target.position.z,
            target.name,
          ].join("|"),
        ),
      });
    } catch {
      fail("TREE_PROTECTION_UNAVAILABLE");
    }
  });
}

export function requireTreePermission(decision: TreeDecision): void {
  if (decision !== "allowed")
    throw new AppError({
      category: "safety",
      code: `TREE_${decision.toUpperCase()}`,
      message:
        "原木の安全性を確認できないため採取を停止しました。補助の稼働中に育った、建築に接していない木が必要です。",
      retryable: false,
      failedAt: "tree_protection",
      confirmedState: { decision },
    });
}
