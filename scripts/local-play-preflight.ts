import { readFile } from "node:fs/promises";
import { isIP } from "node:net";
import { join } from "node:path";

import { parse as parseEnvironment } from "dotenv";
import nbt from "prismarine-nbt";

type GameMode = "survival" | "creative" | "adventure" | "spectator";
type Difficulty = "peaceful" | "easy" | "normal" | "hard";

const gameModes: GameMode[] = ["survival", "creative", "adventure", "spectator"];
const difficulties: Difficulty[] = ["peaceful", "easy", "normal", "hard"];

export interface LocalPlayReport {
  localOnly: boolean;
  portMatches: boolean;
  defaultMode: GameMode | "unknown";
  difficulty: Difficulty | "unknown";
  forceDefaultMode: boolean;
  savedOwnerMode: GameMode | "unknown";
  ownerOpLevel: number | null;
  modeMatches: boolean;
  savedOwnerModeMatches: boolean;
  difficultyMatches: boolean;
  peacefulSurvival: boolean;
}

function parseProperties(contents: string): Record<string, string> {
  return Object.fromEntries(
    contents
      .split(/\r?\n/)
      .filter((line) => line.includes("=") && !line.trimStart().startsWith("#"))
      .map((line) => {
        const separator = line.indexOf("=");
        return [line.slice(0, separator).trim(), line.slice(separator + 1).trim()];
      }),
  );
}

function gameMode(value: unknown): GameMode | "unknown" {
  if (typeof value === "number") return gameModes[value] ?? "unknown";
  return typeof value === "string" && gameModes.includes(value as GameMode)
    ? (value as GameMode)
    : "unknown";
}

function difficulty(value: unknown): Difficulty | "unknown" {
  if (typeof value === "number") return difficulties[value] ?? "unknown";
  return typeof value === "string" && difficulties.includes(value as Difficulty)
    ? (value as Difficulty)
    : "unknown";
}

function parseJsonList(contents: string): Record<string, unknown>[] {
  const value: unknown = JSON.parse(contents);
  if (!Array.isArray(value)) throw new Error("invalid local server data");
  return value.filter(
    (item): item is Record<string, unknown> =>
      typeof item === "object" && item !== null && !Array.isArray(item),
  );
}

async function readJsonListIfPresent(file: string): Promise<Record<string, unknown>[]> {
  try {
    return parseJsonList(await readFile(file, "utf8"));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
}

function sameName(value: unknown, ownerName: string): boolean {
  return typeof value === "string" && value.toLowerCase() === ownerName.toLowerCase();
}

function isLoopback(host: string): boolean {
  if (host.toLowerCase() === "localhost") return true;
  if (isIP(host) === 4) return host.startsWith("127.");
  if (isIP(host) !== 6) return false;
  const normalized = new URL(`http://[${host}]/`).hostname;
  return normalized === "[::1]" || /^\[::ffff:7f[0-9a-f]{2}:[0-9a-f]{1,4}\]$/.test(normalized);
}

function normalizePort(value: string): number | null {
  const port = Number(value);
  return Number.isInteger(port) && port >= 1 && port <= 65_535 ? port : null;
}

export async function inspectLocalPlay(
  serverDir: string,
  environmentContents: string,
  expectedMode: GameMode,
  expectedDifficulty: Difficulty,
): Promise<LocalPlayReport> {
  const env = parseEnvironment(environmentContents);
  const ownerName = env.OWNER_USERNAME;
  if (!ownerName) throw new Error("OWNER_USERNAME missing");

  const properties = parseProperties(
    await readFile(join(serverDir, "server.properties"), "utf8"),
  );
  const defaultMode = gameMode(properties.gamemode);
  const serverDifficulty = difficulty(properties.difficulty);
  const localOnly =
    isLoopback(env.MINECRAFT_HOST ?? "") &&
    isLoopback(properties["server-ip"] ?? "");
  const clientPort = normalizePort(env.MINECRAFT_PORT ?? "25565");
  const serverPort = normalizePort(properties["server-port"] ?? "25565");
  const portMatches = clientPort !== null && clientPort === serverPort;

  const cache = await readJsonListIfPresent(join(serverDir, "usercache.json"));
  const owner = cache.find((entry) => sameName(entry.name, ownerName));
  const ownerUuid = typeof owner?.uuid === "string" ? owner.uuid : null;
  const ops = await readJsonListIfPresent(join(serverDir, "ops.json"));
  const matchingOp = ops.find(
    (entry) => sameName(entry.name, ownerName) && (!ownerUuid || entry.uuid === ownerUuid),
  );
  const ownerOpLevel =
    typeof matchingOp?.level === "number" ? matchingOp.level : null;

  let savedOwnerMode: GameMode | "unknown" = "unknown";
  if (ownerUuid && /^[0-9a-f-]{36}$/i.test(ownerUuid)) {
    try {
      const file = join(
        serverDir,
        properties["level-name"] ?? "world",
        "playerdata",
        `${ownerUuid}.dat`,
      );
      const parsed = await nbt.parse(await readFile(file));
      savedOwnerMode = gameMode(parsed.parsed.value.playerGameType?.value);
    } catch {
      // A missing or unreadable snapshot cannot establish the player's current mode.
    }
  }

  return {
    localOnly,
    portMatches,
    defaultMode,
    difficulty: serverDifficulty,
    forceDefaultMode: properties["force-gamemode"] === "true",
    savedOwnerMode,
    ownerOpLevel,
    modeMatches: defaultMode === expectedMode,
    savedOwnerModeMatches:
      savedOwnerMode === "unknown" ||
      savedOwnerMode === expectedMode ||
      properties["force-gamemode"] === "true",
    difficultyMatches: serverDifficulty === expectedDifficulty,
    peacefulSurvival:
      serverDifficulty === "peaceful" &&
      (expectedMode === "survival" ||
        defaultMode === "survival" ||
        savedOwnerMode === "survival"),
  };
}

function option(args: string[], name: string): string | undefined {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : undefined;
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const serverDir = option(args, "--server-dir");
  const expectedMode = gameMode(option(args, "--expected-mode"));
  const expectedDifficulty = difficulty(option(args, "--expected-difficulty"));
  if (!serverDir || expectedMode === "unknown" || expectedDifficulty === "unknown") {
    process.stderr.write(
      "使い方: npm run preflight:local -- --server-dir <ローカルサーバーのディレクトリ> --expected-mode survival --expected-difficulty normal\n",
    );
    process.exitCode = 2;
    return;
  }

  try {
    const report = await inspectLocalPlay(
      serverDir,
      await readFile(".env.local", "utf8"),
      expectedMode,
      expectedDifficulty,
    );
    process.stdout.write(`ローカル専用: ${report.localOnly ? "はい" : "要確認"}\n`);
    process.stdout.write(`接続ポート一致: ${report.portMatches ? "はい" : "いいえ"}\n`);
    process.stdout.write(`サーバー既定モード: ${report.defaultMode}\n`);
    process.stdout.write(`難易度: ${report.difficulty}\n`);
    process.stdout.write(`既定モード強制: ${report.forceDefaultMode ? "はい" : "いいえ"}\n`);
    process.stdout.write(`利用者の保存済みモード: ${report.savedOwnerMode}\n`);
    process.stdout.write(
      `利用者の保存済みコマンド権限: ${report.ownerOpLevel === null ? "なし/未確認" : `OP level ${report.ownerOpLevel}`}\n`,
    );
    process.stdout.write("利用者の現在のモード・権限: 接続後にゲーム内で確認してください\n");
    if (report.peacefulSurvival) {
      process.stdout.write("サバイバルでも peaceful では敵対Mobは自然出現しません。\n");
    }
    if (
      !report.localOnly ||
      !report.portMatches ||
      !report.modeMatches ||
      !report.savedOwnerModeMatches ||
      !report.difficultyMatches
    ) {
      process.stdout.write("意図したプレイ条件との不一致があります。変更対象を選んでから運用手順に従ってください。\n");
      process.exitCode = 1;
    }
  } catch {
    process.stderr.write("確認に失敗しました。指定したローカル設定ファイルの存在と形式を確認してください。\n");
    process.exitCode = 2;
  }
}

if (process.argv[1]?.endsWith("local-play-preflight.ts")) await main();
