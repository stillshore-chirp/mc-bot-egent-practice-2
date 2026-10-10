import { randomBytes } from "node:crypto";
import { createWriteStream, type WriteStream } from "node:fs";
import {
  copyFile,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createConnection, createServer } from "node:net";

import { MineflayerClient } from "../../src/minecraft/mineflayer-client.js";
import type {
  PlayerBody,
  PlayerBodyObservation,
  PlayerOperationResult,
} from "../../src/minecraft/player-body.js";
import { LocalRcon } from "./local-rcon.js";

const startupTimeoutMs = 150_000;
const operationTimeoutMs = 90_000;
const observationTimeoutMs = 20_000;
const logFileName = "server-private.log";

type SmokeCode =
  | "SERVER_INPUT_REQUIRED"
  | "SERVER_JAR_INVALID"
  | "EULA_NOT_ACCEPTED"
  | "ISOLATED_SETUP_FAILED"
  | "SERVER_START_FAILED"
  | "SERVER_READINESS_FAILED"
  | "WORLD_FIXTURE_FAILED"
  | "BOT_CONNECT_FAILED"
  | "MOVE_NOT_CONFIRMED"
  | "ITEM_NOT_VISIBLE"
  | "ITEM_COLLECTION_NOT_CONFIRMED"
  | "CRAFT_NOT_CONFIRMED"
  | "SERVER_READBACK_MISMATCH"
  | "CLEANUP_FAILED"
  | "UNEXPECTED_FAILURE";

class SmokeError extends Error {
  public constructor(public readonly code: SmokeCode) {
    super(code);
    this.name = "SmokeError";
  }
}

interface SmokeEvidence {
  serverStarted: boolean;
  serverReady: boolean;
  botConnected: boolean;
  moveBodyObserved: boolean | null;
  moveServerObserved: boolean | null;
  moveBodyServerMatch: boolean | null;
  droppedItemVisibleToBody: boolean | null;
  itemCollectionObservedByBody: boolean | null;
  droppedItemRemovedByServer: boolean | null;
  craftObservedByBody: boolean | null;
  inventoryMatchesServerReadback: boolean | null;
  providerCalls: 0;
}

interface CleanupEvidence {
  bodyStopped: boolean;
  clientDisconnected: boolean;
  serverProcessExited: boolean;
  ownedProcessGroupGone: boolean;
  minecraftListenerClosed: boolean;
  rconListenerClosed: boolean;
  temporaryWorldRemoved: boolean;
  privateLogClosed: boolean;
}

interface SmokeState {
  directory?: string;
  server?: ChildProcessWithoutNullStreams;
  processGroupId?: number;
  rcon?: LocalRcon;
  client?: MineflayerClient;
  body?: PlayerBody;
  log?: WriteStream;
  minecraftPort?: number;
  rconPort?: number;
  evidence: SmokeEvidence;
}

function freshEvidence(): SmokeEvidence {
  return {
    serverStarted: false,
    serverReady: false,
    botConnected: false,
    moveBodyObserved: null,
    moveServerObserved: null,
    moveBodyServerMatch: null,
    droppedItemVisibleToBody: null,
    itemCollectionObservedByBody: null,
    droppedItemRemovedByServer: null,
    craftObservedByBody: null,
    inventoryMatchesServerReadback: null,
    providerCalls: 0,
  };
}

function freshCleanup(): CleanupEvidence {
  return {
    bodyStopped: true,
    clientDisconnected: true,
    serverProcessExited: true,
    ownedProcessGroupGone: true,
    minecraftListenerClosed: true,
    rconListenerClosed: true,
    temporaryWorldRemoved: true,
    privateLogClosed: true,
  };
}

async function main(): Promise<void> {
  const state: SmokeState = { evidence: freshEvidence() };
  let failure: SmokeCode | undefined;
  try {
    await executeSmoke(state);
  } catch (error) {
    failure = error instanceof SmokeError ? error.code : "UNEXPECTED_FAILURE";
  }
  const cleanup = await cleanupSmoke(state);
  if (Object.values(cleanup).some((passed) => !passed))
    failure ??= "CLEANUP_FAILED";
  const status = failure === undefined ? "pass" : "incomplete";
  process.stdout.write(
    `${JSON.stringify({
      status,
      ...(failure === undefined ? {} : { code: failure }),
      scope: "isolated-local-minecraft-no-provider",
      actions: ["move_to", "collect_item", "craft"],
      evidence: state.evidence,
      cleanup,
    })}\n`,
  );
  if (failure !== undefined) process.exitCode = 1;
}

async function executeSmoke(state: SmokeState): Promise<void> {
  const jarValue = process.env.COMPANION_SMOKE_SERVER_JAR;
  const eulaValue = process.env.COMPANION_SMOKE_EULA_FILE;
  if (jarValue === undefined || eulaValue === undefined)
    throw new SmokeError("SERVER_INPUT_REQUIRED");
  const jarPath = resolve(jarValue);
  const eulaPath = resolve(eulaValue);
  const jarStat = await lstat(jarPath).catch(() => undefined);
  const eulaStat = await lstat(eulaPath).catch(() => undefined);
  if (
    jarStat === undefined ||
    eulaStat === undefined ||
    !jarStat.isFile() ||
    jarStat.isSymbolicLink() ||
    !eulaStat.isFile() ||
    eulaStat.isSymbolicLink()
  ) {
    throw new SmokeError("SERVER_JAR_INVALID");
  }
  const eulaContents = await readFile(eulaPath, "utf8").catch(() => "");
  if (!/^eula=true\s*$/mu.test(eulaContents))
    throw new SmokeError("EULA_NOT_ACCEPTED");

  state.directory = await mkdtemp(join(tmpdir(), "companion-smoke-"));
  await mkdir(join(state.directory, "server"), { mode: 0o700 });
  const serverDirectory = join(state.directory, "server");
  const privateLogPath = join(state.directory, logFileName);
  await copyFile(jarPath, join(serverDirectory, "server.jar"));
  await writeFile(join(serverDirectory, "eula.txt"), eulaContents, {
    encoding: "utf8",
    mode: 0o600,
  });
  const minecraftPort = await unusedLoopbackPort();
  state.minecraftPort = minecraftPort;
  let rconPort = await unusedLoopbackPort();
  while (rconPort === minecraftPort) rconPort = await unusedLoopbackPort();
  state.rconPort = rconPort;

  const rconPassword = randomBytes(24).toString("hex");
  const properties = [
    "server-ip=127.0.0.1",
    `server-port=${minecraftPort}`,
    "online-mode=false",
    "white-list=false",
    "spawn-protection=0",
    "enable-command-block=false",
    "allow-flight=false",
    "difficulty=peaceful",
    "gamemode=survival",
    "max-players=4",
    "view-distance=5",
    "simulation-distance=5",
    "sync-chunk-writes=true",
    "level-name=companion-fixture",
    "level-seed=0",
    "level-type=minecraft:flat",
    "generate-structures=false",
    "enable-rcon=true",
    `rcon.port=${rconPort}`,
    `rcon.password=${rconPassword}`,
    "rcon.ip=127.0.0.1",
    "motd=isolated companion smoke",
  ].join("\n");
  await writeFile(
    join(serverDirectory, "server.properties"),
    `${properties}\n`,
    {
      encoding: "utf8",
      mode: 0o600,
    },
  );

  state.log = createWriteStream(privateLogPath, {
    flags: "wx",
    mode: 0o600,
  });
  await new Promise<void>((resolveReady, reject) => {
    state.log?.once("open", () => resolveReady());
    state.log?.once("error", () =>
      reject(new SmokeError("ISOLATED_SETUP_FAILED")),
    );
  });
  const javaHome = process.env.JAVA_HOME?.trim();
  const javaPath =
    javaHome === undefined || javaHome.length === 0
      ? "java"
      : join(resolve(javaHome), "bin", "java");
  const server = spawn(
    javaPath,
    ["-Xms512M", "-Xmx1G", "-jar", "server.jar", "--nogui"],
    {
      cwd: serverDirectory,
      detached: process.platform !== "win32",
      env: {
        PATH: process.env.PATH ?? "/usr/bin:/bin",
        ...(javaHome === undefined || javaHome.length === 0
          ? {}
          : { JAVA_HOME: resolve(javaHome) }),
      },
      stdio: ["pipe", "pipe", "pipe"],
    },
  );
  state.server = server;
  if (process.platform !== "win32" && server.pid !== undefined)
    state.processGroupId = server.pid;
  server.stdout.on("data", (chunk: Buffer) => state.log?.write(chunk));
  server.stderr.on("data", (chunk: Buffer) => state.log?.write(chunk));
  await new Promise<void>((resolveStarted, rejectStarted) => {
    server.once("spawn", () => {
      state.evidence.serverStarted = true;
      resolveStarted();
    });
    server.once("error", () =>
      rejectStarted(new SmokeError("SERVER_START_FAILED")),
    );
  });
  const rcon = await waitForRcon(server, rconPort, rconPassword);
  state.rcon = rcon;
  state.evidence.serverReady = true;

  await createFixtureWorld(rcon);
  const suffix = randomBytes(5).toString("hex");
  const botName = `Comp${suffix}`;
  const ownerUsername = `Owner${suffix}`;
  const client = new MineflayerClient({
    bot: {
      host: "127.0.0.1",
      port: minecraftPort,
      username: botName,
      auth: "offline",
    },
    ownerUsername,
  });
  state.client = client;
  const body = client.createPlayerBody();
  state.body = body;
  const connectController = new AbortController();
  const connectTimer = setTimeout(
    () => connectController.abort(new SmokeError("BOT_CONNECT_FAILED")),
    30_000,
  );
  try {
    await client.connect(connectController.signal);
  } catch {
    throw new SmokeError("BOT_CONNECT_FAILED");
  } finally {
    clearTimeout(connectTimer);
  }
  state.evidence.botConnected = true;
  await rcon.command(`tp ${botName} 0.5 70 0.5`);
  await waitForBodyPosition(body, 0.5, 70, 0.5);

  const beforeMoveBody = await body.observe();
  const beforeMoveServer = await readServerPosition(rcon, botName);
  const moveResult = await withTimeout(
    body.execute({
      kind: "move_to",
      position: { x: 0.5, y: 70, z: 3.5 },
      range: 0.5,
    }),
    operationTimeoutMs,
    "MOVE_NOT_CONFIRMED",
  );
  const afterMoveBody = moveResult.after ?? (await body.observe());
  const afterMoveServer = await readServerPosition(rcon, botName);
  state.evidence.moveBodyObserved =
    successful(moveResult) &&
    distance(beforeMoveBody.self.position, afterMoveBody.self.position) >= 1.5;
  state.evidence.moveServerObserved =
    distance(beforeMoveServer, afterMoveServer) >= 1.5;
  state.evidence.moveBodyServerMatch =
    distance(afterMoveBody.self.position, afterMoveServer) <= 0.75;
  if (
    !state.evidence.moveBodyObserved ||
    !state.evidence.moveServerObserved ||
    !state.evidence.moveBodyServerMatch
  ) {
    throw new SmokeError("MOVE_NOT_CONFIRMED");
  }

  await rcon.command(
    'summon item 0.5 70 8.5 {Item:{id:"minecraft:oak_log",count:1}}',
  );
  await waitForDroppedItemOnServer(rcon, "#fixture", "fixture", "oak_log");
  const lookResult = await withTimeout(
    body.execute({
      kind: "look",
      target: { x: 0.5, y: 70, z: 8.5 },
    }),
    operationTimeoutMs,
    "ITEM_NOT_VISIBLE",
  );
  if (!successful(lookResult)) throw new SmokeError("ITEM_NOT_VISIBLE");
  const itemEntity = await waitForDroppedItem(body, "oak_log");
  state.evidence.droppedItemVisibleToBody = itemEntity !== undefined;
  if (itemEntity === undefined) throw new SmokeError("ITEM_NOT_VISIBLE");

  const collectResult = await withTimeout(
    body.execute({ kind: "collect_item", entityId: itemEntity.id }),
    operationTimeoutMs,
    "ITEM_COLLECTION_NOT_CONFIRMED",
  );
  const bodyLogCount = inventoryCount(collectResult.after, "oak_log");
  const serverLogCount = await readInventoryCount(
    rcon,
    botName,
    "oak_log",
    "#inventory",
    "inventory",
  );
  const serverItemPresent = await droppedItemExists(
    rcon,
    "#fixture",
    "oak_log",
    "item",
  );
  state.evidence.itemCollectionObservedByBody =
    successful(collectResult) &&
    collectResult.itemCollectionOutcome === "collected" &&
    collectResult.observedEffect?.type === "item_collected" &&
    bodyLogCount === 1 &&
    serverLogCount === 1;
  state.evidence.droppedItemRemovedByServer = !serverItemPresent;
  if (
    !state.evidence.itemCollectionObservedByBody ||
    !state.evidence.droppedItemRemovedByServer
  ) {
    throw new SmokeError("ITEM_COLLECTION_NOT_CONFIRMED");
  }

  const craftResult = await withTimeout(
    body.execute({ kind: "craft", item: "oak_planks", count: 4 }),
    operationTimeoutMs,
    "CRAFT_NOT_CONFIRMED",
  );
  const bodyAfterCraft = craftResult.after ?? (await body.observe());
  const bodyPlanks = inventoryCount(bodyAfterCraft, "oak_planks");
  const bodyLogsAfterCraft = inventoryCount(bodyAfterCraft, "oak_log");
  const serverPlanks = await readInventoryCount(
    rcon,
    botName,
    "oak_planks",
    "#inventory",
    "planks",
  );
  const serverLogsAfterCraft = await readInventoryCount(
    rcon,
    botName,
    "oak_log",
    "#inventory",
    "logs",
  );
  state.evidence.craftObservedByBody =
    successful(craftResult) && bodyPlanks === 4 && bodyLogsAfterCraft === 0;
  state.evidence.inventoryMatchesServerReadback =
    serverPlanks === bodyPlanks && serverLogsAfterCraft === bodyLogsAfterCraft;
  if (!state.evidence.craftObservedByBody)
    throw new SmokeError("CRAFT_NOT_CONFIRMED");
  if (!state.evidence.inventoryMatchesServerReadback) {
    throw new SmokeError("SERVER_READBACK_MISMATCH");
  }
}

async function createFixtureWorld(rcon: LocalRcon): Promise<void> {
  const objective = "fixture";
  const holder = "#fixture";
  await expectRconSuccess(rcon, "fill -16 69 -16 16 69 16 stone");
  await expectRconSuccess(rcon, "setblock 0 69 0 grass_block");
  await expectRconSuccess(rcon, "gamerule doDaylightCycle false");
  await expectRconSuccess(rcon, "gamerule doMobSpawning false");
  await expectRconSuccess(rcon, "time set noon");
  await expectRconSuccess(rcon, `scoreboard objectives add ${objective} dummy`);
  await expectRconSuccess(
    rcon,
    `scoreboard players set ${holder} ${objective} 0`,
  );
  await rcon.command(
    `execute if block 0 69 0 minecraft:grass_block run scoreboard players set ${holder} ${objective} 1`,
  );
  if ((await readScore(rcon, holder, objective)) !== 1)
    throw new SmokeError("WORLD_FIXTURE_FAILED");
  await rcon.command(
    `execute if block 0 70 0 minecraft:air run scoreboard players set ${holder} ${objective} 2`,
  );
  if ((await readScore(rcon, holder, objective)) !== 2)
    throw new SmokeError("WORLD_FIXTURE_FAILED");
}

async function waitForRcon(
  server: ChildProcessWithoutNullStreams,
  port: number,
  password: string,
): Promise<LocalRcon> {
  const deadline = Date.now() + startupTimeoutMs;
  while (Date.now() < deadline) {
    if (server.exitCode !== null || server.signalCode !== null)
      throw new SmokeError("SERVER_START_FAILED");
    try {
      const rcon = new LocalRcon(port, password);
      await rcon.command("list");
      return rcon;
    } catch {
      await delay(500);
    }
  }
  throw new SmokeError("SERVER_READINESS_FAILED");
}

async function waitForBodyPosition(
  body: PlayerBody,
  x: number,
  y: number,
  z: number,
): Promise<PlayerBodyObservation> {
  const deadline = Date.now() + observationTimeoutMs;
  while (Date.now() < deadline) {
    const observation = await body.observe().catch(() => undefined);
    if (
      observation !== undefined &&
      distance(observation.self.position, { x, y, z }) <= 1
    ) {
      return observation;
    }
    await delay(200);
  }
  throw new SmokeError("BOT_CONNECT_FAILED");
}

async function waitForDroppedItem(
  body: PlayerBody,
  itemName: string,
): Promise<{ readonly id: number } | undefined> {
  const deadline = Date.now() + observationTimeoutMs;
  while (Date.now() < deadline) {
    const observation = await body.observe().catch(() => undefined);
    const entity = observation?.perception.entities.find(
      (candidate) => candidate.droppedItem?.name === itemName,
    );
    if (entity !== undefined) return { id: entity.id };
    await delay(200);
  }
  return undefined;
}

async function readServerPosition(
  rcon: LocalRcon,
  botName: string,
): Promise<{ readonly x: number; readonly y: number; readonly z: number }> {
  const reply = await rcon.command(`data get entity ${botName} Pos`);
  const match =
    /\[(-?\d+(?:\.\d+)?)(?:d)?,\s*(-?\d+(?:\.\d+)?)(?:d)?,\s*(-?\d+(?:\.\d+)?)(?:d)?\]/u.exec(
      reply,
    );
  if (match === null) throw new SmokeError("SERVER_READBACK_MISMATCH");
  const position = {
    x: Number(match[1]),
    y: Number(match[2]),
    z: Number(match[3]),
  };
  if (![position.x, position.y, position.z].every(Number.isFinite))
    throw new SmokeError("SERVER_READBACK_MISMATCH");
  return position;
}

async function droppedItemExists(
  rcon: LocalRcon,
  holder: string,
  objective: string,
  itemName: string,
): Promise<boolean> {
  await rcon.command(`scoreboard players set ${holder} ${objective} 0`);
  await rcon.command(
    `execute if entity @e[type=item,nbt={Item:{id:"minecraft:${itemName}"}}] run scoreboard players set ${holder} ${objective} 1`,
  );
  return (await readScore(rcon, holder, objective)) === 1;
}

async function waitForDroppedItemOnServer(
  rcon: LocalRcon,
  holder: string,
  objective: string,
  itemName: string,
): Promise<void> {
  const deadline = Date.now() + observationTimeoutMs;
  while (Date.now() < deadline) {
    if (await droppedItemExists(rcon, holder, objective, itemName)) return;
    await delay(200);
  }
  throw new SmokeError("WORLD_FIXTURE_FAILED");
}

async function readInventoryCount(
  rcon: LocalRcon,
  botName: string,
  itemName: string,
  holder: string,
  objective: string,
): Promise<number> {
  await rcon.command(`scoreboard players set ${holder} ${objective} 0`);
  await rcon.command(
    `execute as ${botName} store result score ${holder} ${objective} run clear @s minecraft:${itemName} 0`,
  );
  const count = await readScore(rcon, holder, objective);
  if (count < 0 || !Number.isSafeInteger(count))
    throw new SmokeError("SERVER_READBACK_MISMATCH");
  return count;
}

async function readScore(
  rcon: LocalRcon,
  holder: string,
  objective: string,
): Promise<number> {
  const reply = await rcon.command(
    `scoreboard players get ${holder} ${objective}`,
  );
  const escapedHolder = escapeRegExp(holder);
  const escapedObjective = escapeRegExp(objective);
  const match = new RegExp(
    `^(?:Score ${escapedHolder} is|${escapedHolder} has) (-?\\d+)(?: \\[${escapedObjective}\\])?$`,
    "iu",
  ).exec(reply.trim());
  if (match === null) throw new SmokeError("SERVER_READBACK_MISMATCH");
  return Number(match[1]);
}

async function expectRconSuccess(
  rcon: LocalRcon,
  command: string,
): Promise<void> {
  const reply = (await rcon.command(command)).trim();
  if (
    /^(?:Unknown command|Incorrect argument|Expected |No entity was found|Nothing changed)/iu.test(
      reply,
    )
  ) {
    throw new SmokeError("WORLD_FIXTURE_FAILED");
  }
}

function inventoryCount(
  observation: PlayerBodyObservation | null,
  itemName: string,
): number {
  if (observation === null) return -1;
  return observation.self.inventory
    .filter((item) => item.name === itemName)
    .reduce((total, item) => total + item.count, 0);
}

function successful(result: PlayerOperationResult): boolean {
  return (
    result.status === "successful" &&
    result.before !== null &&
    result.after !== null &&
    result.sameLife === true &&
    !result.recoveryRequired
  );
}

function distance(
  left: { readonly x: number; readonly y: number; readonly z: number },
  right: { readonly x: number; readonly y: number; readonly z: number },
): number {
  return Math.hypot(left.x - right.x, left.y - right.y, left.z - right.z);
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}

async function unusedLoopbackPort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolveListen, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolveListen);
  });
  const address = server.address();
  if (address === null || typeof address === "string")
    throw new SmokeError("ISOLATED_SETUP_FAILED");
  await new Promise<void>((resolveClose, reject) =>
    server.close((error) => (error ? reject(error) : resolveClose())),
  );
  return address.port;
}

async function withTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number,
  code: SmokeCode,
): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new SmokeError(code)), timeoutMs);
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

async function cleanupSmoke(state: SmokeState): Promise<CleanupEvidence> {
  const cleanup = freshCleanup();
  if (state.body !== undefined) {
    try {
      await withTimeout(state.body.stop(), 5_000, "CLEANUP_FAILED");
    } catch {
      cleanup.bodyStopped = false;
    }
  }
  if (state.client !== undefined) {
    const client = state.client;
    const wasConnected = client.isConnected;
    let unsubscribe = (): void => undefined;
    const disconnected = wasConnected
      ? new Promise<boolean>((resolveDisconnected) => {
          unsubscribe = client.onDisconnected(() => resolveDisconnected(true));
        })
      : Promise.resolve(true);
    try {
      await withTimeout(
        client.disconnect("isolated-smoke-cleanup"),
        5_000,
        "CLEANUP_FAILED",
      );
      cleanup.clientDisconnected = await withTimeout(
        disconnected,
        5_000,
        "CLEANUP_FAILED",
      );
    } catch {
      cleanup.clientDisconnected = false;
    } finally {
      unsubscribe();
    }
  }
  if (state.rcon !== undefined) {
    try {
      await state.rcon.close();
    } catch {
      cleanup.rconListenerClosed = false;
    }
  }

  const server = state.server;
  if (server !== undefined && !childExited(server)) {
    try {
      server.stdin.write("stop\n");
      await waitForChildExit(server, 10_000);
    } catch {
      // The bounded signal cleanup below handles an unavailable stdin.
    }
  }
  if (server !== undefined && !childExited(server))
    signalOwnedServer(state, "SIGTERM");
  if (server !== undefined) {
    await waitForChildExit(server, 5_000);
    if (!childExited(server)) signalOwnedServer(state, "SIGKILL");
    await waitForChildExit(server, 5_000);
    cleanup.serverProcessExited = childExited(server);
  }
  if (
    state.processGroupId !== undefined &&
    server !== undefined &&
    childExited(server)
  ) {
    const groupGone = await waitForProcessGroupGone(
      state.processGroupId,
      5_000,
    );
    if (!groupGone) {
      signalOwnedServer(state, "SIGTERM");
      await waitForProcessGroupGone(state.processGroupId, 3_000);
    }
    if (!(await processGroupGone(state.processGroupId)))
      signalOwnedServer(state, "SIGKILL");
    cleanup.ownedProcessGroupGone = await waitForProcessGroupGone(
      state.processGroupId,
      3_000,
    );
  }
  if (state.minecraftPort !== undefined)
    cleanup.minecraftListenerClosed = await waitForPortClosed(
      state.minecraftPort,
    );
  if (state.rconPort !== undefined)
    cleanup.rconListenerClosed = await waitForPortClosed(state.rconPort);

  if (state.log !== undefined) {
    await new Promise<void>((resolveClose) => {
      state.log?.end(() => resolveClose());
    });
    cleanup.privateLogClosed = state.log.closed;
  }
  const ownedServerStopped =
    state.server === undefined ||
    (cleanup.serverProcessExited && cleanup.ownedProcessGroupGone);
  if (state.directory !== undefined && ownedServerStopped) {
    await rm(state.directory, { recursive: true, force: true }).catch(
      () => undefined,
    );
    cleanup.temporaryWorldRemoved = !(await pathExists(state.directory));
  } else if (state.directory !== undefined) {
    cleanup.temporaryWorldRemoved = false;
  }
  return cleanup;
}

function signalOwnedServer(state: SmokeState, signal: NodeJS.Signals): void {
  const server = state.server;
  if (server === undefined) return;
  try {
    if (state.processGroupId !== undefined)
      process.kill(-state.processGroupId, signal);
    else if (!childExited(server)) server.kill(signal);
  } catch {
    // The process may have exited between the state check and the signal.
  }
}

function childExited(server: ChildProcessWithoutNullStreams): boolean {
  return server.exitCode !== null || server.signalCode !== null;
}

async function waitForChildExit(
  server: ChildProcessWithoutNullStreams,
  timeoutMs: number,
): Promise<boolean> {
  if (childExited(server)) return true;
  return new Promise<boolean>((resolveExit) => {
    const timer = setTimeout(() => {
      server.removeListener("exit", onExit);
      resolveExit(childExited(server));
    }, timeoutMs);
    const onExit = (): void => {
      clearTimeout(timer);
      resolveExit(true);
    };
    server.once("exit", onExit);
  });
}

async function processGroupGone(processGroupId: number): Promise<boolean> {
  try {
    process.kill(-processGroupId, 0);
    return false;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "ESRCH";
  }
}

async function waitForProcessGroupGone(
  processGroupId: number,
  timeoutMs: number,
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await processGroupGone(processGroupId)) return true;
    await delay(100);
  }
  return processGroupGone(processGroupId);
}

async function waitForPortClosed(port: number): Promise<boolean> {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    const open = await new Promise<boolean>((resolveOpen) => {
      const socket = createConnection({ host: "127.0.0.1", port });
      const timer = setTimeout(() => {
        socket.destroy();
        resolveOpen(true);
      }, 400);
      socket.once("connect", () => {
        clearTimeout(timer);
        socket.destroy();
        resolveOpen(true);
      });
      socket.once("error", () => {
        clearTimeout(timer);
        resolveOpen(false);
      });
    });
    if (!open) return true;
    await delay(100);
  }
  return false;
}

async function pathExists(path: string): Promise<boolean> {
  return lstat(path)
    .then(() => true)
    .catch(() => false);
}

void main();
