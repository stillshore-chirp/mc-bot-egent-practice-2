export interface OracleRegion {
  readonly minX: number;
  readonly minY: number;
  readonly minZ: number;
  readonly maxX: number;
  readonly maxY: number;
  readonly maxZ: number;
}

export interface OracleRcon {
  command(command: string, timeoutMs?: number): Promise<string>;
}

export type OracleFailure = (code: string) => never;
export type RconReplyClass = "success" | "unloaded" | "syntax" | "error";

const LOAD_TIMEOUT_MS = 5_000;
const LOAD_POLL_MS = 100;
const SCORE_NAME = "#oracle";
const SCORE_OBJECTIVE = "ai_e2e";

export function cloneCommand(
  region: OracleRegion,
  destination: { readonly x: number; readonly y: number; readonly z: number },
): string {
  return `clone ${region.minX} ${region.minY} ${region.minZ} ${region.maxX} ${region.maxY} ${region.maxZ} ${destination.x} ${destination.y} ${destination.z} replace force`;
}

export function forceloadCommand(region: OracleRegion): string {
  return `forceload add ${region.minX} ${region.minZ} ${region.maxX} ${region.maxZ}`;
}

export function classifyRconReply(reply: string): RconReplyClass {
  if (/not loaded|unloaded|outside (?:of )?(?:the )?world/iu.test(reply))
    return "unloaded";
  if (
    /unknown(?: or incomplete)? command|incomplete command|incorrect argument|expected |syntax|usage:/iu.test(
      reply,
    )
  )
    return "syntax";
  if (/error:|could not|failed to|cannot|can't|not found|must be/iu.test(reply))
    return "error";
  if (
    /marked \d+ chunks? .*force loaded|marked chunk \[[^\]]+\] in \S+ to be force loaded|chunk at \[[^\]]+\] in \S+ is marked for force loading|forceloaded|cloned? \d+ blocks?|^filled \d+ blocks?\.?$|^no blocks (?:were )?filled\.?$|successfully|created new objective|block placed|set .+ to -?\d+|added .+ to .+|score .+ is -?\d+|#\S+ has -?\d+ \[[a-z0-9_.:-]+\]|test (?:passed|failed)/iu.test(
      reply,
    )
  ) {
    return "success";
  }
  return "error";
}

export function parseScore(
  reply: string,
  holder = SCORE_NAME,
  objective = SCORE_OBJECTIVE,
): number | undefined {
  const escapedHolder = holder.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
  const escapedObjective = objective.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
  const normalized = reply.trim();
  const canonical = new RegExp(
    `^Score ${escapedHolder} is (-?\\d+)$`,
    "iu",
  ).exec(normalized);
  if (canonical !== null) return Number(canonical[1]);
  const withObjective = new RegExp(
    `^${escapedHolder} has (-?\\d+) \\[${escapedObjective}\\]$`,
    "iu",
  ).exec(normalized);
  return withObjective === null ? undefined : Number(withObjective[1]);
}

export function parseCloneCount(reply: string): number | undefined {
  const match = /^(?:Successfully )?cloned? (\d+) block(?:s|\(s\))?$/iu.exec(
    reply.trim(),
  );
  return match === null ? undefined : Number(match[1]);
}

export function regionChunkChecks(region: OracleRegion): readonly {
  readonly x: number;
  readonly y: number;
  readonly z: number;
}[] {
  const checks: { x: number; y: number; z: number }[] = [];
  for (
    let chunkX = Math.floor(region.minX / 16);
    chunkX <= Math.floor(region.maxX / 16);
    chunkX += 1
  ) {
    for (
      let chunkZ = Math.floor(region.minZ / 16);
      chunkZ <= Math.floor(region.maxZ / 16);
      chunkZ += 1
    ) {
      checks.push({ x: chunkX * 16 + 8, y: region.minY, z: chunkZ * 16 + 8 });
    }
  }
  return checks;
}

export async function forceLoadRegion(
  rcon: OracleRcon,
  region: OracleRegion,
  fail: OracleFailure,
): Promise<void> {
  const reply = await rcon.command(forceloadCommand(region));
  const alreadyMarked = /^No chunks were marked for force loading$/iu.test(
    reply.trim(),
  );
  if (classifyRconReply(reply) !== "success" && !alreadyMarked)
    fail("WORLD_ORACLE_FORCELOAD_REJECTED");

  const checks = regionChunkChecks(region);
  for (const check of checks) {
    const queryReply = await rcon.command(
      `forceload query ${check.x} ${check.z}`,
    );
    if (classifyRconReply(queryReply) !== "success")
      fail("WORLD_ORACLE_CHUNK_NOT_FORCELOADED");
  }
  const deadline = Date.now() + LOAD_TIMEOUT_MS;
  while (Date.now() <= deadline) {
    const remaining = (): number => {
      const value = deadline - Date.now();
      if (value <= 0) fail("WORLD_ORACLE_CHUNKS_NOT_LOADED");
      return value;
    };
    await checkedCommand(
      rcon,
      `scoreboard players set ${SCORE_NAME} ${SCORE_OBJECTIVE} 0`,
      "WORLD_ORACLE_LOAD_CHECK_REJECTED",
      fail,
      remaining(),
    );
    for (const check of checks) {
      const loadedReply = await rcon.command(
        `execute if loaded ${check.x} ${check.y} ${check.z} run scoreboard players add ${SCORE_NAME} ${SCORE_OBJECTIVE} 1`,
        remaining(),
      );
      if (loadedReply !== "" && classifyRconReply(loadedReply) !== "success") {
        fail("WORLD_ORACLE_LOAD_CHECK_REJECTED");
      }
    }
    const score = await readScore(rcon, fail, remaining());
    if (score === checks.length) return;
    await new Promise((resolve) => setTimeout(resolve, LOAD_POLL_MS));
  }
  fail("WORLD_ORACLE_CHUNKS_NOT_LOADED");
}

export async function cloneBaseline(
  rcon: OracleRcon,
  region: OracleRegion,
  destination: { readonly x: number; readonly y: number; readonly z: number },
  fail: OracleFailure,
): Promise<void> {
  const cloneReply = await rcon.command(cloneCommand(region, destination));
  const cloned = parseCloneCount(cloneReply);
  const expected =
    (region.maxX - region.minX + 1) *
    (region.maxY - region.minY + 1) *
    (region.maxZ - region.minZ + 1);
  if (classifyRconReply(cloneReply) !== "success" || cloned !== expected)
    fail("WORLD_ORACLE_CLONE_NOT_CONFIRMED");
}

export function destinationRegion(
  region: OracleRegion,
  destination: { readonly x: number; readonly y: number; readonly z: number },
): OracleRegion {
  return {
    minX: destination.x,
    minY: destination.y,
    minZ: destination.z,
    maxX: destination.x + region.maxX - region.minX,
    maxY: destination.y + region.maxY - region.minY,
    maxZ: destination.z + region.maxZ - region.minZ,
  };
}

export async function establishBaseline(
  rcon: OracleRcon,
  region: OracleRegion,
  destination: { readonly x: number; readonly y: number; readonly z: number },
  fail: OracleFailure,
): Promise<void> {
  const target = destinationRegion(region, destination);
  await forceLoadRegion(rcon, region, fail);
  await forceLoadRegion(rcon, target, fail);
  await cloneBaseline(rcon, region, destination, fail);
  if (!(await regionsEqual(rcon, region, destination, fail)))
    fail("WORLD_ORACLE_INITIAL_BASELINE_MISMATCH");
}

export async function regionsEqual(
  rcon: OracleRcon,
  region: OracleRegion,
  destination: { readonly x: number; readonly y: number; readonly z: number },
  fail: OracleFailure,
): Promise<boolean> {
  await checkedCommand(
    rcon,
    `scoreboard players set ${SCORE_NAME} ${SCORE_OBJECTIVE} 0`,
    "WORLD_ORACLE_COMPARE_RESET_REJECTED",
    fail,
  );
  const executeReply = await rcon.command(
    `execute if blocks ${region.minX} ${region.minY} ${region.minZ} ${region.maxX} ${region.maxY} ${region.maxZ} ${destination.x} ${destination.y} ${destination.z} all run scoreboard players set ${SCORE_NAME} ${SCORE_OBJECTIVE} 1`,
  );
  if (executeReply !== "" && classifyRconReply(executeReply) !== "success") {
    fail("WORLD_ORACLE_COMPARE_COMMAND_REJECTED");
  }
  const score = await readScore(rcon, fail);
  if (score !== 0 && score !== 1) fail("WORLD_ORACLE_COMPARE_READBACK_INVALID");
  return score === 1;
}

export async function blockIs(
  rcon: OracleRcon,
  position: { readonly x: number; readonly y: number; readonly z: number },
  block: string,
  fail: OracleFailure,
): Promise<boolean> {
  await checkedCommand(
    rcon,
    `scoreboard players set ${SCORE_NAME} ${SCORE_OBJECTIVE} 0`,
    "WORLD_ORACLE_BLOCK_CHECK_RESET_REJECTED",
    fail,
  );
  const executeReply = await rcon.command(
    `execute if block ${position.x} ${position.y} ${position.z} minecraft:${block} run scoreboard players set ${SCORE_NAME} ${SCORE_OBJECTIVE} 1`,
  );
  if (executeReply !== "" && classifyRconReply(executeReply) !== "success") {
    fail("WORLD_ORACLE_BLOCK_CHECK_REJECTED");
  }
  const score = await readScore(rcon, fail);
  if (score !== 0 && score !== 1) fail("WORLD_ORACLE_BLOCK_READBACK_INVALID");
  return score === 1;
}

async function readScore(
  rcon: OracleRcon,
  fail: OracleFailure,
  timeoutMs?: number,
): Promise<number> {
  const reply = await rcon.command(
    `scoreboard players get ${SCORE_NAME} ${SCORE_OBJECTIVE}`,
    timeoutMs,
  );
  const score = parseScore(reply, SCORE_NAME, SCORE_OBJECTIVE);
  if (score === undefined) fail("WORLD_ORACLE_SCORE_READBACK_UNAVAILABLE");
  return score;
}

async function checkedCommand(
  rcon: OracleRcon,
  command: string,
  errorCode: string,
  fail: OracleFailure,
  timeoutMs?: number,
): Promise<void> {
  const reply = await rcon.command(command, timeoutMs);
  if (classifyRconReply(reply) !== "success") fail(errorCode);
}
