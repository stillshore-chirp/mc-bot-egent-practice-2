export const GATHER_MULTI_TARGET_ITEMS = ["oak_log", "birch_log"] as const;
export type GatherMultiTargetItem = (typeof GATHER_MULTI_TARGET_ITEMS)[number];

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
    }
  | {
      readonly reason: Exclude<GatherMultiTargetInventoryReadReason, "parsed">;
      readonly parseStage: GatherMultiTargetInventoryParseStage;
    };

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

    const stackCounts = value.fields.filter(
      ({ key }) => key === "count" || key === "Count",
    );
    const stackCount = stackCounts[0]?.value;
    if (
      stackCounts.length !== 1 ||
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
    if (!Number.isSafeInteger(counts[target]))
      return {
        reason: "target_count_invalid",
        parseStage: "target_count_invalid",
      };
  }
  return { reason: "parsed", parseStage: "parsed", counts };
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
