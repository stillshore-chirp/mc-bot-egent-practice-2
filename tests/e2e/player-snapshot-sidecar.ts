import { appendFile, chmod, writeFile } from "node:fs/promises";

const PLAYER_SNAPSHOT_FIELDS = [
  "purpose",
  "goals",
  "recentJudgments",
  "recentOutcomes",
  "activeOperation",
  "proposals",
  "lastObservation",
] as const;
const MAX_SNAPSHOT_ITEMS = 20;

export type RetainedPlayerSnapshot<T extends object> = Pick<
  T,
  Extract<keyof T, (typeof PLAYER_SNAPSHOT_FIELDS)[number]>
>;

export function projectPlayerSnapshot<T extends object>(
  snapshot: T,
): RetainedPlayerSnapshot<T> {
  const projected: Record<string, unknown> = {};
  const source = snapshot as Record<string, unknown>;
  for (const field of PLAYER_SNAPSHOT_FIELDS) {
    const value = source[field];
    if (value === undefined) continue;
    projected[field] = structuredClone(
      Array.isArray(value) ? value.slice(-MAX_SNAPSHOT_ITEMS) : value,
    );
  }
  return projected as RetainedPlayerSnapshot<T>;
}

export async function writePlayerSnapshotRecord(
  path: string,
  record: Readonly<Record<string, unknown>>,
  isFirstRecord: boolean,
): Promise<void> {
  const data = `${JSON.stringify(record)}\n`;
  if (isFirstRecord) {
    await writeFile(path, data, {
      encoding: "utf8",
      mode: 0o600,
      flag: "wx",
    });
  } else {
    await appendFile(path, data, { encoding: "utf8", mode: 0o600 });
  }
  await chmod(path, 0o600);
}
