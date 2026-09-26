export interface EquipmentFieldReadback {
  readonly equipmentFieldObserved: boolean;
  readonly expectedItemMatched: boolean;
}

export interface ExecuteIfItemsReadback {
  readonly resultObserved: boolean;
  readonly expectedItemMatched: boolean;
}

export function readEquipmentFieldFromRcon(
  reply: string | null,
  expectedItem: string,
): EquipmentFieldReadback {
  if (
    reply === null ||
    !/^minecraft:[a-z0-9_./-]+$/u.test(expectedItem) ||
    /(?:unknown(?: or incomplete)? command|error|failed|no data|not found)/iu.test(
      reply,
    )
  ) {
    return { equipmentFieldObserved: false, expectedItemMatched: false };
  }

  const compound = findRconCompound(reply);
  if (compound === undefined)
    return { equipmentFieldObserved: false, expectedItemMatched: false };
  return {
    equipmentFieldObserved: true,
    expectedItemMatched:
      topLevelItemId(compound)?.toLowerCase() === expectedItem.toLowerCase(),
  };
}

export function readExecuteIfItemsRconReply(
  reply: string | null,
): ExecuteIfItemsReadback {
  if (
    reply === null ||
    /(?:unknown(?: or incomplete)? command|error|expected.*run|not found)/iu.test(
      reply,
    )
  ) {
    return { resultObserved: false, expectedItemMatched: false };
  }

  if (/test failed[^\n]*no items matched/iu.test(reply)) {
    return { resultObserved: true, expectedItemMatched: false };
  }

  const countMatch = /(?:^|\D)(\d+)\s*(?:matching\s+items?)?\s*\.?\s*$/iu.exec(
    reply.trim(),
  );
  if (countMatch === null)
    return { resultObserved: false, expectedItemMatched: false };
  return {
    resultObserved: true,
    expectedItemMatched: Number(countMatch[1]) > 0,
  };
}

function findRconCompound(reply: string): string | undefined {
  const marker = reply.indexOf("entity data:");
  if (marker < 0) return undefined;
  const start = reply.indexOf("{", marker + "entity data:".length);
  if (start < 0) return undefined;

  let depth = 0;
  let quoted: "'" | '"' | undefined;
  let escaped = false;
  for (let index = start; index < reply.length; index += 1) {
    const character = reply[index];
    if (quoted !== undefined) {
      if (escaped) escaped = false;
      else if (character === "\\") escaped = true;
      else if (character === quoted) quoted = undefined;
      continue;
    }
    if (character === "'" || character === '"') {
      quoted = character;
      continue;
    }
    if (character === "{") depth += 1;
    else if (character === "}") {
      depth -= 1;
      if (depth === 0) return reply.slice(start, index + 1);
      if (depth < 0) return undefined;
    }
  }
  return undefined;
}

function topLevelItemId(compound: string): string | undefined {
  if (!compound.startsWith("{") || !compound.endsWith("}")) return undefined;
  const fields = splitTopLevelFields(compound.slice(1, -1));
  if (fields === undefined) return undefined;
  for (const field of fields) {
    const match = /^\s*id\s*:\s*["']?(minecraft:[a-z0-9_./-]+)["']?\s*$/iu.exec(
      field,
    );
    if (match !== null) return match[1];
  }
  return undefined;
}

function splitTopLevelFields(compound: string): string[] | undefined {
  if (compound.trim() === "") return [];
  const fields: string[] = [];
  let start = 0;
  let braceDepth = 0;
  let bracketDepth = 0;
  let quoted: "'" | '"' | undefined;
  let escaped = false;
  for (let index = 0; index < compound.length; index += 1) {
    const character = compound[index];
    if (quoted !== undefined) {
      if (escaped) escaped = false;
      else if (character === "\\") escaped = true;
      else if (character === quoted) quoted = undefined;
      continue;
    }
    if (character === "'" || character === '"') {
      quoted = character;
      continue;
    }
    if (character === "{") braceDepth += 1;
    else if (character === "}") {
      braceDepth -= 1;
      if (braceDepth < 0) return undefined;
    } else if (character === "[") bracketDepth += 1;
    else if (character === "]") {
      bracketDepth -= 1;
      if (bracketDepth < 0) return undefined;
    } else if (character === "," && braceDepth === 0 && bracketDepth === 0) {
      fields.push(compound.slice(start, index).trim());
      start = index + 1;
    }
  }
  if (quoted !== undefined || braceDepth !== 0 || bracketDepth !== 0)
    return undefined;
  fields.push(compound.slice(start).trim());
  return fields.some((field) => field.length === 0) ? undefined : fields;
}
