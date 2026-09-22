import { randomUUID } from "node:crypto";
import type { Client } from "minecraft-protocol";
import { AppError } from "../domain/errors.js";
import { throwIfAborted } from "../runtime/cancellation.js";
import type { Position } from "../domain/snapshot.js";

export const actionGuardChannel = "companion:action_guard";

export type ActionGuardOperation = "mine" | "place";

export type ActionGuardDecision =
  "allowed" | "unknown" | "protected" | "changed";

export interface ActionGuardRequest {
  readonly operation: ActionGuardOperation;
  readonly name: string;
  readonly position: Position;
}

/**
 * Ask the server about a world mutation immediately before performing it.
 * The result is intentionally short lived: callers must query again for every
 * block rather than reusing an earlier candidate observation.
 */
export async function queryActionGuard(
  client: Pick<Client, "on" | "off" | "write">,
  request: ActionGuardRequest,
  signal?: AbortSignal,
  timeoutMs = 1_500,
): Promise<ActionGuardDecision> {
  if (signal) throwIfAborted(signal, "action_guard");
  const id = randomUUID();
  return new Promise((resolve, reject) => {
    const cleanup = (): void => {
      clearTimeout(timer);
      client.off("custom_payload", receive);
      client.off("end", disconnected);
      signal?.removeEventListener("abort", cancelled);
    };
    const fail = (code: string): void => {
      cleanup();
      reject(
        new AppError({
          category: "safety",
          code,
          message: "サーバー側の建築保護と操作権限を確認できません。",
          retryable: false,
          failedAt: "action_guard",
        }),
      );
    };
    const receive = (packet: { channel: string; data: unknown }): void => {
      if (
        packet.channel !== actionGuardChannel ||
        !Buffer.isBuffer(packet.data) ||
        packet.data.length > 512
      )
        return;
      let parsed: unknown;
      try {
        parsed = JSON.parse(packet.data.toString("utf8"));
      } catch {
        fail("ACTION_GUARD_INVALID_RESPONSE");
        return;
      }
      if (parsed === null || typeof parsed !== "object") return;
      const value = parsed as {
        readonly id?: unknown;
        readonly decision?: unknown;
      };
      if (value.id !== id) return;
      if (
        typeof value.decision !== "string" ||
        !["allowed", "unknown", "protected", "changed"].includes(value.decision)
      ) {
        fail("ACTION_GUARD_INVALID_RESPONSE");
        return;
      }
      cleanup();
      resolve(value.decision as ActionGuardDecision);
    };
    const disconnected = (): void => fail("ACTION_GUARD_DISCONNECTED");
    const cancelled = (): void => {
      cleanup();
      try {
        if (signal) throwIfAborted(signal, "action_guard");
      } catch (error) {
        reject(
          error instanceof Error ? error : new Error("Action guard cancelled"),
        );
      }
    };
    const timer = setTimeout(() => fail("ACTION_GUARD_UNAVAILABLE"), timeoutMs);
    client.on("custom_payload", receive);
    client.on("end", disconnected);
    signal?.addEventListener("abort", cancelled, { once: true });
    try {
      client.write("custom_payload", {
        channel: actionGuardChannel,
        data: Buffer.from(
          JSON.stringify({
            id,
            operation: request.operation,
            name: request.name,
            position: {
              x: request.position.x,
              y: request.position.y,
              z: request.position.z,
            },
          }),
        ),
      });
    } catch {
      fail("ACTION_GUARD_UNAVAILABLE");
    }
  });
}

export function requireActionPermission(decision: ActionGuardDecision): void {
  if (decision === "allowed") return;
  throw new AppError({
    category: "safety",
    code: `ACTION_${decision.toUpperCase()}`,
    message:
      "サーバー側で保護・不明・変更済みと判定されたため操作を停止しました。",
    retryable: false,
    failedAt: "action_guard",
    confirmedState: { decision },
  });
}
