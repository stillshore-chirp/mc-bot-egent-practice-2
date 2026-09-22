import { randomUUID } from "node:crypto";
import type { Client } from "minecraft-protocol";
import { z } from "zod";
import type { StorageIdentity } from "./port.js";
import { AppError } from "../domain/errors.js";
import type { Position } from "../domain/snapshot.js";
import { throwIfAborted } from "../runtime/cancellation.js";
export const storageChannel = "companion:storage";
const responseSchema = z
  .object({
    id: z.uuid(),
    worldId: z.uuid(),
    position: z
      .object({
        x: z.number().min(-30_000_000).max(30_000_000),
        y: z.number().min(-2048).max(2048),
        z: z.number().min(-30_000_000).max(30_000_000),
      })
      .strict()
      .optional(),
    identity: z.string().max(500).nullable(),
    observation: z
      .object({
        chestCount: z.number().int().nonnegative(),
        playerCount: z.number().int().nonnegative(),
        revision: z.number().int().nonnegative(),
        epoch: z.uuid(),
        uncontested: z.boolean(),
      })
      .strict()
      .nullable(),
  })
  .strict();
export async function queryStorageIdentity(
  client: Pick<Client, "on" | "off" | "write">,
  position: Position | null,
  register: boolean,
  signal: AbortSignal,
  resource?: string,
) {
  throwIfAborted(signal, "storage_identity");
  const id = randomUUID();
  return new Promise<StorageIdentity>((resolve, reject) => {
    const finish = (error?: Error, value?: StorageIdentity) => {
      clearTimeout(timer);
      client.off("custom_payload", receive);
      client.off("end", disconnected);
      signal.removeEventListener("abort", cancelled);
      if (error) reject(error);
      else if (value) resolve(value);
    };
    const failure = () =>
      new AppError({
        category: "observation",
        code: "STORAGE_IDENTITY_UNAVAILABLE",
        message:
          "登録先をサーバーで確認できません。補助と指定チェストを確認してください。",
        retryable: false,
        failedAt: "storage_identity",
      });
    const receive = (packet: { channel: string; data: unknown }) => {
      if (
        packet.channel !== storageChannel ||
        !Buffer.isBuffer(packet.data) ||
        packet.data.length > 2048
      )
        return;
      try {
        const parsed = responseSchema.safeParse(
          JSON.parse(packet.data.toString()),
        );
        if (parsed.success && parsed.data.id === id)
          finish(undefined, parsed.data);
      } catch {
        /* Unrelated malformed messages never authorize a container. */
      }
    };
    const disconnected = () => finish(failure());
    const cancelled = () => {
      try {
        throwIfAborted(signal, "storage_identity");
      } catch (error) {
        finish(error instanceof Error ? error : failure());
      }
    };
    const timer = setTimeout(() => finish(failure()), 1500);
    client.on("custom_payload", receive);
    client.on("end", disconnected);
    signal.addEventListener("abort", cancelled, { once: true });
    try {
      client.write("custom_payload", {
        channel: storageChannel,
        data: Buffer.from(
          JSON.stringify({
            id,
            operation:
              position === null ? "world" : register ? "register" : "inspect",
            position,
            resource: resource ?? null,
          }),
        ),
      });
    } catch {
      finish(failure());
    }
  });
}
