export type GatherDropReadbackClass =
  | "not_attempted"
  | "position"
  | "known_negative"
  | "unknown_reply"
  | "timeout"
  | "unavailable";

export interface GatherDropReadbackOrigin {
  readonly x: number;
  readonly y: number;
  readonly z: number;
}

export function gatherDropReadbackConfirmsAbsence(
  classification: GatherDropReadbackClass,
): boolean {
  return classification === "known_negative";
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
  if (/^no entity was found\.?$/iu.test(normalized)) return "known_negative";
  return "unknown_reply";
}

export function gatherDropPositionReadbackCommand(
  origin: GatherDropReadbackOrigin,
  item: "oak_log" | "birch_log",
): string {
  const selector = `@e[type=minecraft:item,limit=1,sort=nearest,distance=..3,nbt={Item:{id:"minecraft:${item}"}}]`;
  return `execute positioned ${origin.x + 0.5} ${origin.y + 0.5} ${origin.z + 0.5} run data get entity ${selector} Pos`;
}

export function classifyGatherDropReadbackFailure(
  code: string | undefined,
): "timeout" | "unavailable" {
  return code === "RCON_TIMEOUT" ? "timeout" : "unavailable";
}
