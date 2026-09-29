export const GATHER_MULTI_TARGET_ITEMS = ["oak_log", "birch_log"] as const;
export type GatherMultiTargetItem = (typeof GATHER_MULTI_TARGET_ITEMS)[number];

/** Keep the strict pre-app probe opt-in for the matching no-GPT diagnostic run. */
export function shouldRunGatherMultiTargetOracleProbe(
  targetCase: string | undefined,
  probeOnlyValue: string | undefined,
): boolean {
  return (
    targetCase === "gather_multi_target_continuity" && probeOnlyValue === "YES"
  );
}

type ParsedInventoryTag =
  | {
      readonly kind: "scalar";
      readonly value: string;
      readonly quoted: boolean;
    }
  | {
      readonly kind: "compound";
      readonly fields: readonly {
        readonly key: string;
        readonly value: ParsedInventoryTag;
      }[];
    }
  | { readonly kind: "list"; readonly values: readonly ParsedInventoryTag[] };

export type GatherMultiTargetInventoryReadReason =
  | "read_failed"
  | "command_rejected"
  | "marker_missing"
  | "structure_invalid"
  | "target_count_invalid"
  | "parsed";

export type GatherMultiTargetInventoryParseStage =
  | "not_parsed"
  | "marker_missing"
  | "root_invalid"
  | "nested_token_invalid"
  | "trailing_content"
  | "stack_id_invalid"
  | "target_count_invalid"
  | "response_truncated_possible"
  | "parsed";

export type GatherMultiTargetInventoryReadResult =
  | {
      readonly reason: "parsed";
      readonly parseStage: "parsed";
      readonly counts: Readonly<Record<GatherMultiTargetItem, number>>;
      readonly stackCounts: Readonly<Record<GatherMultiTargetItem, number>>;
    }
  | {
      readonly reason: Exclude<GatherMultiTargetInventoryReadReason, "parsed">;
      readonly parseStage: GatherMultiTargetInventoryParseStage;
    };

export type GatherMultiTargetItemCountReadResult =
  | {
      readonly reason: "parsed";
      readonly parseStage: "parsed";
      readonly counts: Readonly<Record<GatherMultiTargetItem, number>>;
    }
  | {
      readonly reason: "read_failed" | "response_unrecognized";
      readonly parseStage: "not_parsed" | "response_unrecognized";
      readonly counts: Readonly<Record<GatherMultiTargetItem, number | null>>;
    };

export type GatherMultiTargetOracleProbePhase = "Baseline" | "Final";

/** Publish only fixed read classifications and counts; unknown counts stay null. */
export function gatherMultiTargetInventorySafeEvidence(
  phase: GatherMultiTargetOracleProbePhase,
  result: GatherMultiTargetInventoryReadResult | undefined,
): Readonly<Record<string, number | string | null>> {
  const parsed = result?.reason === "parsed" ? result : undefined;
  const prefix = `gatherOracleProbe${phase}`;
  return {
    [`${prefix}InventoryReadReason`]: result?.reason ?? "not_read",
    [`${prefix}InventoryParseStage`]: result?.parseStage ?? "not_parsed",
    [`${prefix}OakCount`]: parsed?.counts.oak_log ?? null,
    [`${prefix}BirchCount`]: parsed?.counts.birch_log ?? null,
    [`${prefix}OakStackCount`]: parsed?.stackCounts.oak_log ?? null,
    [`${prefix}BirchStackCount`]: parsed?.stackCounts.birch_log ?? null,
  };
}

export function gatherMultiTargetPostBirchProgressSinceGoalAcceptance(
  accepted: GatherMultiTargetItemCountReadResult | undefined,
  latest: GatherMultiTargetItemCountReadResult | undefined,
  postBirchBodyOutcomeCount: number,
): Readonly<{ birchDelta: number | null; confirmed: boolean }> {
  const acceptedBirch =
    accepted?.reason === "parsed" ? accepted.counts.birch_log : null;
  const latestBirch =
    latest?.reason === "parsed" ? latest.counts.birch_log : null;
  const birchDelta =
    acceptedBirch !== null && latestBirch !== null
      ? latestBirch - acceptedBirch
      : null;
  const postBirchBodyProgress =
    Number.isSafeInteger(postBirchBodyOutcomeCount) &&
    postBirchBodyOutcomeCount >= 1;
  return {
    birchDelta,
    confirmed: birchDelta !== null && birchDelta >= 1 && postBirchBodyProgress,
  };
}

/** Publish scalar item totals; stack counts are deliberately unmeasured. */
export function gatherMultiTargetItemCountSafeEvidence(
  phase: GatherMultiTargetOracleProbePhase,
  result: GatherMultiTargetItemCountReadResult | undefined,
): Readonly<Record<string, number | string | null>> {
  const prefix = `gatherOracleProbe${phase}`;
  return {
    [`${prefix}InventoryReadReason`]: result?.reason ?? "not_read",
    [`${prefix}InventoryParseStage`]: result?.parseStage ?? "not_parsed",
    [`${prefix}OakCount`]: result?.counts.oak_log ?? null,
    [`${prefix}BirchCount`]: result?.counts.birch_log ?? null,
    [`${prefix}OakStackCount`]: null,
    [`${prefix}BirchStackCount`]: null,
  };
}

/** Keep prestart gather diagnostics on the Body smoke failure artifact only. */
export function gatherMultiTargetBodySmokeSafeFailureEvidence<
  T extends Readonly<Record<string, unknown>>,
>(
  caseId: string,
  targetCase: string | undefined,
  evidence: T,
): T | Readonly<Record<string, never>> {
  return caseId === "body_operation_smoke" &&
    targetCase === "gather_multi_target_continuity"
    ? evidence
    : {};
}

/** Return only confirmed mismatches; an unparsed inventory is not an empty one. */
export function gatherMultiTargetOracleProbeBaselineFailureFields(
  result: GatherMultiTargetInventoryReadResult | undefined,
): readonly string[] {
  if (result?.reason !== "parsed") return ["inventory_read"];
  const fields: string[] = [];
  if (result.counts.oak_log !== 64) fields.push("oak_count");
  if (result.stackCounts.oak_log !== 1) fields.push("oak_stack_count");
  if (result.counts.birch_log !== 0) fields.push("birch_count");
  return fields;
}

/** Return only confirmed mismatches from the final server inventory and drop readback. */
export function gatherMultiTargetOracleProbeResultFailureFields(
  result: GatherMultiTargetInventoryReadResult | undefined,
  dropCountAfterCollection: number,
): readonly string[] {
  const fields: string[] = [];
  if (result?.reason !== "parsed") {
    fields.push("inventory_read");
  } else {
    if (result.counts.oak_log !== 65) fields.push("oak_count");
    if (result.stackCounts.oak_log !== 2) fields.push("oak_stack_count");
    if (result.counts.birch_log !== 0) fields.push("birch_count");
  }
  if (dropCountAfterCollection !== 0) fields.push("drop_after_collection");
  return fields;
}

/** Check only the two queried item totals; unknown scalar replies stay unconfirmed. */
export function gatherMultiTargetOracleProbeBaselineCountFailureFields(
  result: GatherMultiTargetItemCountReadResult | undefined,
): readonly string[] {
  if (result?.reason !== "parsed") return ["inventory_read"];
  const fields: string[] = [];
  if (result.counts.oak_log !== 64) fields.push("oak_count");
  if (result.counts.birch_log !== 0) fields.push("birch_count");
  return fields;
}

/** Check queried final totals and the independent drop readback. */
export function gatherMultiTargetOracleProbeResultCountFailureFields(
  result: GatherMultiTargetItemCountReadResult | undefined,
  dropCountAfterCollection: number,
): readonly string[] {
  const fields: string[] = [];
  if (result?.reason !== "parsed") {
    fields.push("inventory_read");
  } else {
    if (result.counts.oak_log !== 65) fields.push("oak_count");
    if (result.counts.birch_log !== 0) fields.push("birch_count");
  }
  if (dropCountAfterCollection !== 0) fields.push("drop_after_collection");
  return fields;
}

type InventoryTagParserFailureStage = Extract<
  GatherMultiTargetInventoryParseStage,
  "root_invalid" | "nested_token_invalid" | "response_truncated_possible"
>;

class InventoryTagParseError extends Error {
  public constructor(readonly stage: InventoryTagParserFailureStage) {
    super(stage);
  }
}

/** Parse only top-level inventory stacks; malformed or ambiguous replies fail closed. */
export function parseGatherMultiTargetInventoryReply(
  reply: string,
): Readonly<Record<GatherMultiTargetItem, number>> | undefined {
  const result = parseGatherMultiTargetInventoryReplyDetailed(reply);
  return result.reason === "parsed" ? result.counts : undefined;
}

/** Return a fixed safe reason without retaining or exposing the RCON reply. */
export function parseGatherMultiTargetInventoryReplyDetailed(
  reply: string,
): GatherMultiTargetInventoryReadResult {
  const marker = /entity data:\s*/iu.exec(reply);
  if (marker === null)
    return { reason: "marker_missing", parseStage: "marker_missing" };

  let root: Extract<ParsedInventoryTag, { kind: "list" }>;
  const parser = new InventoryTagParser(
    reply.slice(marker.index + marker[0].length),
  );
  try {
    root = parser.parseRootList();
  } catch (error) {
    return {
      reason: "structure_invalid",
      parseStage:
        error instanceof InventoryTagParseError
          ? error.stage
          : "nested_token_invalid",
    };
  }
  if (!parser.isAtEnd())
    return { reason: "structure_invalid", parseStage: "trailing_content" };
  if (root.values.some((value) => value.kind !== "compound"))
    return { reason: "structure_invalid", parseStage: "root_invalid" };

  const counts: Record<GatherMultiTargetItem, number> = {
    oak_log: 0,
    birch_log: 0,
  };
  const stackCounts: Record<GatherMultiTargetItem, number> = {
    oak_log: 0,
    birch_log: 0,
  };
  for (const value of root.values) {
    if (value.kind !== "compound")
      return { reason: "structure_invalid", parseStage: "root_invalid" };
    const ids = value.fields.filter(({ key }) => key === "id");
    if (ids.length !== 1 || ids[0]?.value.kind !== "scalar")
      return { reason: "structure_invalid", parseStage: "stack_id_invalid" };
    const id = ids[0].value.value;
    const target = GATHER_MULTI_TARGET_ITEMS.find(
      (item) => id === `minecraft:${item}`,
    );
    if (target === undefined) continue;

    const stackCountFields = value.fields.filter(
      ({ key }) => key === "count" || key === "Count",
    );
    const stackCount = stackCountFields[0]?.value;
    if (
      stackCountFields.length !== 1 ||
      stackCount?.kind !== "scalar" ||
      stackCount.quoted ||
      !/^\d+[bBsSlL]?$/u.test(stackCount.value)
    ) {
      return {
        reason: "target_count_invalid",
        parseStage: "target_count_invalid",
      };
    }
    const amount = Number.parseInt(
      stackCount.value.replace(/[bBsSlL]$/u, ""),
      10,
    );
    if (!Number.isSafeInteger(amount) || amount < 0)
      return {
        reason: "target_count_invalid",
        parseStage: "target_count_invalid",
      };
    counts[target] += amount;
    stackCounts[target] += 1;
    if (!Number.isSafeInteger(counts[target]))
      return {
        reason: "target_count_invalid",
        parseStage: "target_count_invalid",
      };
  }
  return { reason: "parsed", parseStage: "parsed", counts, stackCounts };
}

/** Read once, returning only safe classification and parsed counts. */
export async function readGatherMultiTargetInventory(
  readReply: () => Promise<string>,
): Promise<GatherMultiTargetInventoryReadResult> {
  let reply: string;
  try {
    reply = await readReply();
  } catch {
    return { reason: "read_failed", parseStage: "not_parsed" };
  }

  const parsed = parseGatherMultiTargetInventoryReplyDetailed(reply);
  if (parsed.reason === "parsed") return parsed;
  if (isGatherMultiTargetInventoryCommandRejection(reply))
    return { reason: "command_rejected", parseStage: "not_parsed" };
  return parsed;
}

/** Read only the two requested item totals through vanilla's count-only clear mode. */
export async function readGatherMultiTargetItemCounts(
  readItemReply: (item: GatherMultiTargetItem) => Promise<string>,
  playerName: string,
): Promise<GatherMultiTargetItemCountReadResult> {
  const counts: Record<GatherMultiTargetItem, number | null> = {
    oak_log: null,
    birch_log: null,
  };
  let unrecognizedReply = false;
  for (const item of GATHER_MULTI_TARGET_ITEMS) {
    let reply: string;
    try {
      reply = await readItemReply(item);
    } catch {
      return { reason: "read_failed", parseStage: "not_parsed", counts };
    }
    const count = parseGatherMultiTargetItemCountReply(reply, playerName);
    if (count === undefined) {
      unrecognizedReply = true;
      continue;
    }
    counts[item] = count;
  }
  if (unrecognizedReply) {
    return {
      reason: "response_unrecognized",
      parseStage: "response_unrecognized",
      counts,
    };
  }
  return {
    reason: "parsed",
    parseStage: "parsed",
    counts: counts as Record<GatherMultiTargetItem, number>,
  };
}

/** Parse only exact 1.21.11 clear count feedback; never retain the player text. */
export function parseGatherMultiTargetItemCountReply(
  reply: string,
  playerName: string,
): number | undefined {
  const text = reply.trim();
  if (text === `No items were found on player ${playerName}`) return 0;
  const match = /^Found ([0-9]+) matching item\(s\) on player (.+)$/u.exec(
    text,
  );
  if (match?.[2] !== playerName) return undefined;
  const count = Number(match[1]);
  return Number.isSafeInteger(count) && count >= 0 ? count : undefined;
}

function isGatherMultiTargetInventoryCommandRejection(reply: string): boolean {
  return /^(?:unknown(?: or incomplete)? command\b|incorrect argument\b|expected\b|usage:|error\b|failed\b|not found\b|no entity was found\b|found no elements matching\b)/iu.test(
    reply.trimStart(),
  );
}

class InventoryTagParser {
  private position = 0;
  private containerDepth = 0;

  constructor(private readonly source: string) {}

  parseRootList(): Extract<ParsedInventoryTag, { kind: "list" }> {
    let parsed: ParsedInventoryTag;
    try {
      parsed = this.parseValue();
    } catch (error) {
      if (error instanceof InventoryTagParseError) throw error;
      throw new InventoryTagParseError(
        this.isAtInputEnd() ? "response_truncated_possible" : "root_invalid",
      );
    }
    if (parsed.kind !== "list")
      throw new InventoryTagParseError("root_invalid");
    return parsed;
  }

  private isAtInputEnd(): boolean {
    this.skipWhitespace();
    return this.position >= this.source.length;
  }

  isAtEnd(): boolean {
    this.skipWhitespace();
    return this.position === this.source.length;
  }

  private parseValue(): ParsedInventoryTag {
    this.skipWhitespace();
    const next = this.source[this.position];
    if (next === "{") return this.parseCompound();
    if (next === "[") return this.parseList();
    if (next === '"' || next === "'")
      return { kind: "scalar", value: this.parseQuoted(), quoted: true };
    const start = this.position;
    while (
      this.position < this.source.length &&
      ![",", "]", "}"].includes(this.source[this.position] ?? "")
    ) {
      this.position += 1;
    }
    const value = this.source.slice(start, this.position).trim();
    if (value.length === 0) throw new Error("empty value");
    return { kind: "scalar", value, quoted: false };
  }

  private parseCompound(): Extract<ParsedInventoryTag, { kind: "compound" }> {
    this.expect("{");
    const isRoot = this.containerDepth === 0;
    this.containerDepth += 1;
    try {
      this.skipWhitespace();
      const fields: { key: string; value: ParsedInventoryTag }[] = [];
      if (this.consume("}")) return { kind: "compound", fields };
      while (this.position < this.source.length) {
        const key = this.parseKey();
        this.expect(":");
        fields.push({ key, value: this.parseValue() });
        this.skipWhitespace();
        if (this.consume("}")) return { kind: "compound", fields };
        this.expect(",");
      }
      throw new Error("unterminated compound");
    } catch (error) {
      if (error instanceof InventoryTagParseError) throw error;
      throw new InventoryTagParseError(
        this.isAtInputEnd()
          ? "response_truncated_possible"
          : isRoot
            ? "root_invalid"
            : "nested_token_invalid",
      );
    } finally {
      this.containerDepth -= 1;
    }
  }

  private parseList(): Extract<ParsedInventoryTag, { kind: "list" }> {
    this.expect("[");
    const isRoot = this.containerDepth === 0;
    this.containerDepth += 1;
    try {
      this.skipWhitespace();
      const values: ParsedInventoryTag[] = [];
      if (this.consume("]")) return { kind: "list", values };
      while (this.position < this.source.length) {
        values.push(this.parseValue());
        this.skipWhitespace();
        if (this.consume("]")) return { kind: "list", values };
        this.expect(",");
      }
      throw new Error("unterminated list");
    } catch (error) {
      if (error instanceof InventoryTagParseError) throw error;
      throw new InventoryTagParseError(
        this.isAtInputEnd()
          ? "response_truncated_possible"
          : isRoot
            ? "root_invalid"
            : "nested_token_invalid",
      );
    } finally {
      this.containerDepth -= 1;
    }
  }

  private parseKey(): string {
    this.skipWhitespace();
    const next = this.source[this.position];
    if (next === '"' || next === "'") return this.parseQuoted();
    const start = this.position;
    while (
      this.position < this.source.length &&
      this.source[this.position] !== ":"
    ) {
      if ([",", "{", "}", "[", "]"].includes(this.source[this.position] ?? ""))
        throw new Error("invalid key");
      this.position += 1;
    }
    const key = this.source.slice(start, this.position).trim();
    if (key.length === 0) throw new Error("empty key");
    return key;
  }

  private parseQuoted(): string {
    const quote = this.source[this.position];
    if (quote !== '"' && quote !== "'") throw new Error("expected quote");
    this.position += 1;
    let result = "";
    while (this.position < this.source.length) {
      const character = this.source[this.position] ?? "";
      this.position += 1;
      if (character === quote) return result;
      if (character === "\\") {
        const escaped = this.source[this.position] ?? "";
        if (escaped.length === 0) throw new Error("unfinished escape");
        result = result.concat(escaped);
        this.position += 1;
      } else {
        result += character;
      }
    }
    throw new Error("unterminated quote");
  }

  private expect(character: string): void {
    this.skipWhitespace();
    if (!this.consume(character)) throw new Error("unexpected token");
  }

  private consume(character: string): boolean {
    if (this.source[this.position] !== character) return false;
    this.position += 1;
    return true;
  }

  private skipWhitespace(): void {
    while (/\s/u.test(this.source[this.position] ?? "")) this.position += 1;
  }
}
