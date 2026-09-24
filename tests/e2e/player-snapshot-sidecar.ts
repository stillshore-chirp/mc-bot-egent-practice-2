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

export type RetainedPlayerSnapshot<T extends Record<string, unknown>> = Pick<
  T,
  Extract<keyof T, (typeof PLAYER_SNAPSHOT_FIELDS)[number]>
>;

export function projectPlayerSnapshot<T extends Record<string, unknown>>(
  snapshot: T,
): RetainedPlayerSnapshot<T> {
  const projected: Record<string, unknown> = {};
  for (const field of PLAYER_SNAPSHOT_FIELDS) {
    const value = snapshot[field];
    if (value === undefined) continue;
    projected[field] = structuredClone(
      Array.isArray(value) ? value.slice(-MAX_SNAPSHOT_ITEMS) : value,
    );
  }
  return projected as RetainedPlayerSnapshot<T>;
}
