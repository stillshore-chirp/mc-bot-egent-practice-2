export interface DeathRecoveryDropProof {
  readonly deathEventObserved: boolean;
  readonly freshBodyAfterDeath: boolean;
  readonly dimensionMatched: boolean;
  readonly testItemAbsentFromInventory: boolean;
  readonly rconDropCount: number | undefined;
  readonly bodyVisibleDropCount: number | undefined;
  readonly bodyVisibilityComplete: boolean;
}

export type SafeEntityCountBucket = "0" | "1" | "2+";

export function safeEntityCountBucket(count: number): SafeEntityCountBucket {
  if (count === 0) return "0";
  if (count === 1) return "1";
  return "2+";
}

export function deathRecoveryDropConfirmed(
  proof: DeathRecoveryDropProof,
): boolean {
  return (
    proof.deathEventObserved &&
    proof.freshBodyAfterDeath &&
    proof.dimensionMatched &&
    proof.testItemAbsentFromInventory &&
    proof.rconDropCount === 1 &&
    proof.bodyVisibleDropCount === 1 &&
    proof.bodyVisibilityComplete
  );
}

export function isNoEntitySelectionReply(reply: string): boolean {
  return (
    reply === "" ||
    /^(?:test failed|no entit(?:y|ies) (?:was|were) found)(?:[.!])?$/iu.test(
      reply.trim(),
    )
  );
}
