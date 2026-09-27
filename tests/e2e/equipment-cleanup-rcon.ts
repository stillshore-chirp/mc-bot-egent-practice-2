import {
  confirmsEquipmentHeadFieldAbsent,
  type ExecuteIfItemsReadback,
} from "./equipment-rcon-oracle.js";

export type ItemReplaceReplyClass =
  "not_received" | "changed" | "no_change" | "error" | "unclassified";

export function classifyItemReplaceReply(
  reply: string | null,
): ItemReplaceReplyClass {
  if (reply === null) return "not_received";
  if (
    /(?:unknown(?: or incomplete)? command|error|failed|invalid|expected)/iu.test(
      reply,
    )
  ) {
    return "error";
  }
  if (
    /\b(?:nothing changed|no changes|no items? (?:were )?changed|0 slots? (?:changed|modified))\b/iu.test(
      reply,
    )
  ) {
    return "no_change";
  }
  if (/\b(?:set|changed|replaced)\b/iu.test(reply)) return "changed";
  return "unclassified";
}

export function confirmsEmptyItemSlot(
  readback: ExecuteIfItemsReadback,
): boolean {
  return readback.resultObserved && !readback.expectedItemMatched;
}

export function confirmsEquipmentHeadEmpty(
  equipmentFieldReply: string | null,
  anyItemReadback: ExecuteIfItemsReadback,
): boolean {
  return (
    confirmsEquipmentHeadFieldAbsent(equipmentFieldReply) &&
    confirmsEmptyItemSlot(anyItemReadback)
  );
}

export function parseGameTimeReply(reply: string | null): number | undefined {
  if (reply === null) return undefined;
  const match = /\bthe time is\s+(\d+)\s*\.?\s*$/iu.exec(reply.trim());
  if (match === null) return undefined;
  const gameTime = Number(match[1]);
  return Number.isSafeInteger(gameTime) ? gameTime : undefined;
}
