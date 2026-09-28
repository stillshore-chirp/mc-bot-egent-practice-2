export interface NoFoodReplanAcceptanceEvidence {
  readonly startupStateConfirmed: boolean;
  readonly alternativeSuccessfulBodyOutcomeObserved: boolean;
  readonly postOutcomeNoFoodStateConfirmed: boolean;
  readonly postOutcomePurposeJudgmentObserved: boolean;
}

export const NO_FOOD_REPLAN_ACCEPTANCE_LATCHED =
  "NO_FOOD_REPLAN_ACCEPTANCE_LATCHED" as const;

export class NoFoodReplanAcceptanceLatchedError extends Error {
  public constructor() {
    super(NO_FOOD_REPLAN_ACCEPTANCE_LATCHED);
    this.name = "NoFoodReplanAcceptanceLatchedError";
  }
}

export function noFoodReplanAcceptanceEvidenceConfirmed(
  evidence: NoFoodReplanAcceptanceEvidence,
): boolean {
  return (
    evidence.startupStateConfirmed &&
    evidence.alternativeSuccessfulBodyOutcomeObserved &&
    evidence.postOutcomeNoFoodStateConfirmed &&
    evidence.postOutcomePurposeJudgmentObserved
  );
}

export class NoFoodReplanRequestGate {
  #acceptanceLatched = false;
  #requestsStarted = 0;
  #requestsRecorded = 0;
  #providerRequestsBlockedAfterAcceptance = 0;

  public get acceptanceLatched(): boolean {
    return this.#acceptanceLatched;
  }

  public get requestsStarted(): number {
    return this.#requestsStarted;
  }

  public get requestsRecorded(): number {
    return this.#requestsRecorded;
  }

  public get inFlightRequests(): number {
    return Math.max(0, this.#requestsStarted - this.#requestsRecorded);
  }

  public get providerRequestsBlockedAfterAcceptance(): number {
    return this.#providerRequestsBlockedAfterAcceptance;
  }

  public beforeCall(admit: () => void): void {
    if (this.#acceptanceLatched) {
      this.#providerRequestsBlockedAfterAcceptance += 1;
      throw new NoFoodReplanAcceptanceLatchedError();
    }
    admit();
    this.#requestsStarted += 1;
  }

  public observeRecordedCalls(caseCallCount: number): void {
    if (!Number.isSafeInteger(caseCallCount) || caseCallCount < 0) return;
    this.#requestsRecorded = Math.max(this.#requestsRecorded, caseCallCount);
  }

  public latchIfAcceptedEvidence(
    evidence: NoFoodReplanAcceptanceEvidence,
  ): boolean {
    if (!noFoodReplanAcceptanceEvidenceConfirmed(evidence)) return false;
    this.#acceptanceLatched = true;
    return true;
  }
}

export async function waitForNoFoodReplanRequestsSettled(
  readInFlightRequests: () => Promise<number>,
  timeoutMs: number,
  pollIntervalMs = 200,
): Promise<boolean> {
  const deadline = Date.now() + Math.max(0, timeoutMs);
  let inFlightRequests: number | undefined;
  while (inFlightRequests !== 0) {
    const remaining = deadline - Date.now();
    if (remaining <= 0) return false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const read = await Promise.race([
      readInFlightRequests().then((value) => ({
        completed: true as const,
        value,
      })),
      new Promise<{ readonly completed: false }>((resolve) => {
        timer = setTimeout(() => resolve({ completed: false }), remaining);
      }),
    ]).finally(() => {
      if (timer !== undefined) clearTimeout(timer);
    });
    if (!read.completed) return false;
    inFlightRequests = read.value;
    if (inFlightRequests === 0) return true;
    const pollRemaining = deadline - Date.now();
    if (pollRemaining <= 0) return false;
    await new Promise<void>((resolve) =>
      setTimeout(resolve, Math.min(pollIntervalMs, pollRemaining)),
    );
  }
  return true;
}
