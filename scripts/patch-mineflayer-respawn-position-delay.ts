import { createHash } from "node:crypto";
import * as fs from "node:fs";
import { createRequire } from "node:module";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const EXPECTED_VERSION = "4.39.0";
const EXPECTED_SOURCE_SHA256 =
  "881ed2ccb2b3f188684e9681ef309df6d097060c297e876b95953d61b0d7f425";
const DECLARATION = "function inject (bot, { physicsEnabled, maxCatchupTicks }) {";
const PATCHED_DECLARATION = `function inject (bot, { physicsEnabled, maxCatchupTicks, respawnPositionDelayMs }) {\n  // codex: configurable post-respawn correction delay (default preserves upstream behavior)\n  const RESPAWN_POSITION_DELAY_MS = Number.isSafeInteger(respawnPositionDelayMs) && respawnPositionDelayMs >= 0 ? respawnPositionDelayMs : 1500`;
const DELAY_BLOCK = `    if (respawnTimer > 0 && Date.now() - respawnTimer < 2000) {
      respawnTimer = 0 // only delay once
      const delayedPos = pos.clone()
      const delayedYaw = newYaw
      const delayedPitch = newPitch
      const delayedOnGround = bot.entity.onGround
      setTimeout(() => {
        sendPacketPositionAndLook(delayedPos, delayedYaw, delayedPitch, delayedOnGround)
        shouldUsePhysics = true
        bot.jumpTicks = 0
        lastSentYaw = bot.entity.yaw
        lastSentPitch = bot.entity.pitch
        bot.emit('forcedMove')
      }, 1500)
      return
    }
`;
const PATCHED_DELAY_BLOCK = `    if (respawnTimer > 0 && Date.now() - respawnTimer < 2000) {
      respawnTimer = 0 // only delay once
      if (RESPAWN_POSITION_DELAY_MS > 0) {
        const delayedPos = pos.clone()
        const delayedYaw = newYaw
        const delayedPitch = newPitch
        const delayedOnGround = bot.entity.onGround
        setTimeout(() => {
          sendPacketPositionAndLook(delayedPos, delayedYaw, delayedPitch, delayedOnGround)
          shouldUsePhysics = true
          bot.jumpTicks = 0
          lastSentYaw = bot.entity.yaw
          lastSentPitch = bot.entity.pitch
          bot.emit('forcedMove')
        }, RESPAWN_POSITION_DELAY_MS)
        return
      }
    }
`;

interface PackageJson {
  dependencies?: Record<string, unknown>;
  version?: unknown;
}

function replaceExactly(source: string, from: string, to: string): string {
  const first = source.indexOf(from);
  if (first < 0 || source.includes(from, first + from.length)) {
    throw new Error("ANCHOR_MISMATCH");
  }
  return source.slice(0, first) + to + source.slice(first + from.length);
}

export function transformSource(source: string): string {
  if (source.includes("codex: configurable post-respawn correction delay")) {
    throw new Error("PATCH_ALREADY_PRESENT");
  }
  return replaceExactly(
    replaceExactly(source, DECLARATION, PATCHED_DECLARATION),
    DELAY_BLOCK,
    PATCHED_DELAY_BLOCK,
  );
}

export function restoreSource(source: string): string {
  const original = replaceExactly(
    replaceExactly(source, PATCHED_DECLARATION, DECLARATION),
    PATCHED_DELAY_BLOCK,
    DELAY_BLOCK,
  );
  if (!source.includes("codex: configurable post-respawn correction delay")) {
    throw new Error("PATCH_MARKER_MISSING");
  }
  return original;
}

function isWithinRoot(root: string, target: string): boolean {
  const pathFromRoot = relative(root, target);
  return (
    pathFromRoot !== "" &&
    pathFromRoot !== ".." &&
    !pathFromRoot.startsWith(`..${sep}`) &&
    !isAbsolute(pathFromRoot)
  );
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function patchInstalledMineflayer(): void {
  const root = fs.realpathSync(resolve(dirname(fileURLToPath(import.meta.url)), ".."));
  const rootRequire = createRequire(join(root, "package.json"));
  const entry = fs.realpathSync(rootRequire.resolve("mineflayer"));
  const packageRoot = fs.realpathSync(dirname(entry));
  const packageFile = join(packageRoot, "package.json");
  const physicsFile = fs.realpathSync(join(packageRoot, "lib/plugins/physics.js"));
  if (!isWithinRoot(root, packageRoot) || !isWithinRoot(root, physicsFile)) {
    throw new Error("DEPENDENCY_OUTSIDE_PROJECT");
  }
  const appPackage = JSON.parse(
    fs.readFileSync(join(root, "package.json"), "utf8"),
  ) as PackageJson;
  if (appPackage.dependencies?.mineflayer !== EXPECTED_VERSION) {
    throw new Error("PIN_MISMATCH");
  }
  const dependency = JSON.parse(fs.readFileSync(packageFile, "utf8")) as PackageJson;
  if (dependency.version !== EXPECTED_VERSION) throw new Error("VERSION_MISMATCH");

  const current = fs.readFileSync(physicsFile, "utf8");
  const currentHash = sha256(current);
  let patched: string;
  if (currentHash === EXPECTED_SOURCE_SHA256) {
    patched = transformSource(current);
  } else {
    try {
      const restored = restoreSource(current);
      if (sha256(restored) !== EXPECTED_SOURCE_SHA256) {
        throw new Error("PATCH_HASH_MISMATCH");
      }
      process.stdout.write("mineflayer_respawn_delay=already_patched\n");
      return;
    } catch {
      throw new Error("SOURCE_HASH_MISMATCH");
    }
  }

  const temporary = `${physicsFile}.codex-${process.pid}.tmp`;
  const mode = fs.statSync(physicsFile).mode & 0o777;
  try {
    const fd = fs.openSync(temporary, "wx", mode);
    try {
      fs.writeFileSync(fd, patched, "utf8");
      fs.fchmodSync(fd, mode);
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
    fs.renameSync(temporary, physicsFile);
  } catch (error) {
    try {
      fs.unlinkSync(temporary);
    } catch {
      // No temporary file to remove.
    }
    throw error;
  }
  process.stdout.write("mineflayer_respawn_delay=patched\n");
}

function isMainModule(): boolean {
  const entry = process.argv[1];
  return entry !== undefined && pathToFileURL(resolve(entry)).href === import.meta.url;
}

if (isMainModule()) {
  try {
    patchInstalledMineflayer();
  } catch (error) {
    const code =
      error instanceof Error && /^[A-Z_]+$/.test(error.message)
        ? error.message
        : "PATCH_FAILED";
    process.stderr.write(`mineflayer_respawn_delay=${code}\n`);
    process.exitCode = 1;
  }
}
