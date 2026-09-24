export type FurnaceRconReplyClass =
  "canonical_item" | "empty_list" | "no_data" | "error" | "other";

export interface FurnaceRconReplyClassification {
  readonly replyClass: FurnaceRconReplyClass;
  readonly hasCanonicalRawIron: boolean;
}

export function classifyFurnaceRconReply(
  reply: string | null,
): FurnaceRconReplyClassification {
  if (reply === null) {
    return { replyClass: "error", hasCanonicalRawIron: false };
  }
  const normalized = reply.trim().toLowerCase();
  if (/\b(no data|no block data|data not found)\b/.exec(normalized) !== null) {
    return { replyClass: "no_data", hasCanonicalRawIron: false };
  }
  if (
    /\b(error|failed|unknown command|exception)\b/.exec(normalized) !== null
  ) {
    return { replyClass: "error", hasCanonicalRawIron: false };
  }
  if (
    /(?:^|:\s*)\[\s*\]$/.exec(normalized) !== null ||
    /\bitems\s*:\s*\[\s*\]\s*\}\s*$/.exec(normalized) !== null
  ) {
    return { replyClass: "empty_list", hasCanonicalRawIron: false };
  }
  if (/minecraft:raw_iron(?![a-z0-9_.\/-])/.exec(normalized) !== null) {
    return { replyClass: "canonical_item", hasCanonicalRawIron: true };
  }
  if (/(?:^|\b)raw_iron(?:\b|$)/.exec(normalized) !== null) {
    return { replyClass: "other", hasCanonicalRawIron: false };
  }
  return { replyClass: "other", hasCanonicalRawIron: false };
}
