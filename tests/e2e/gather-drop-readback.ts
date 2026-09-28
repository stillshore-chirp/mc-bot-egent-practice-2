export type GatherDropReadbackClass =
  | "not_attempted"
  | "position"
  | "known_negative"
  | "unknown_reply"
  | "timeout"
  | "unavailable";

export function gatherDropReadbackConfirmsAbsence(
  classification: GatherDropReadbackClass,
): boolean {
  return classification === "known_negative";
}

export function gatherFixtureCleanupProofConfirmed(
  dropReadbacks: readonly GatherDropReadbackClass[],
  sourceBlocksAbsent: boolean,
  fixtureInventoryEmpty: boolean,
): boolean {
  return (
    dropReadbacks.length === 2 &&
    dropReadbacks.every(gatherDropReadbackConfirmsAbsence) &&
    sourceBlocksAbsent &&
    fixtureInventoryEmpty
  );
}

export function classifyGatherDropReadbackReply(
  reply: string,
): "position" | "known_negative" | "unknown_reply" {
  const match =
    /\[\s*(-?\d+(?:\.\d+)?)d?\s*,\s*(-?\d+(?:\.\d+)?)d?\s*,\s*(-?\d+(?:\.\d+)?)d?\s*\]/u.exec(
      reply,
    );
  if (match !== null) {
    const x = Number(match[1]);
    const y = Number(match[2]);
    const z = Number(match[3]);
    if ([x, y, z].every(Number.isFinite)) return "position";
  }

  const normalized = reply.trim();
  if (/^(?:test failed|no entity was found)\.?$/iu.test(normalized))
    return "known_negative";
  return "unknown_reply";
}

export function classifyGatherDropReadbackFailure(
  code: string | undefined,
): "timeout" | "unavailable" {
  return code === "RCON_TIMEOUT" ? "timeout" : "unavailable";
}
