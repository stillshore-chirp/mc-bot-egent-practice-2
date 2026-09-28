export interface NoFoodReplanAcceptanceEvidence {
  readonly startupStateConfirmed: boolean;
  readonly alternativeSuccessfulBodyOutcomeObserved: boolean;
  readonly postOutcomeNoFoodStateConfirmed: boolean;
  readonly postOutcomePurposeJudgmentObserved: boolean;
}

export const NO_FOOD_REPLAN_ACCEPTANCE_LATCHED =
  "NO_FOOD_REPLAN_ACCEPTANCE_LATCHED" as const;

export const ACCEPTED_PROVIDER_REQUEST_ADMISSION_LATCHED =
  "ACCEPTED_PROVIDER_REQUEST_ADMISSION_LATCHED" as const;

export class AcceptedProviderRequestAdmissionLatchedError extends Error {
  public constructor() {
    super(ACCEPTED_PROVIDER_REQUEST_ADMISSION_LATCHED);
    this.name = "AcceptedProviderRequestAdmissionLatchedError";
  }
}

export type AcceptedProviderRequestSettleStatus =
  | "settled"
  | "pending"
  | "timed_out"
  | "usage_unknown"
  | "budget_exceeded"
  | "accounting_mismatch"
  | "unknown";

export interface AcceptedProviderRequestUsage {
  readonly requestsStarted: number;
  readonly requestsRecorded: number;
  readonly calls: number;
  readonly tokens: number;
  readonly usageUnknownCalls: number;
  readonly caseCallLimit: number;
  readonly caseTokenLimit: number;
  readonly runCalls?: number;
  readonly runTokens?: number;
  readonly runCallLimit?: number;
  readonly runTokenLimit?: number;
}

export function classifyAcceptedProviderRequestUsage(
  usage: AcceptedProviderRequestUsage,
): AcceptedProviderRequestSettleStatus {
  const counts = [
    usage.requestsStarted,
    usage.requestsRecorded,
    usage.calls,
    usage.tokens,
    usage.usageUnknownCalls,
    usage.caseCallLimit,
    usage.caseTokenLimit,
    ...(usage.runCalls === undefined ? [] : [usage.runCalls]),
    ...(usage.runTokens === undefined ? [] : [usage.runTokens]),
    ...(usage.runCallLimit === undefined ? [] : [usage.runCallLimit]),
    ...(usage.runTokenLimit === undefined ? [] : [usage.runTokenLimit]),
  ];
  if (
    counts.some((value) => !Number.isSafeInteger(value) || value < 0) ||
    usage.caseCallLimit === 0 ||
    usage.caseTokenLimit === 0 ||
    (usage.runCalls === undefined) !== (usage.runCallLimit === undefined) ||
    (usage.runTokens === undefined) !== (usage.runTokenLimit === undefined)
  )
    return "unknown";
  if (
    usage.requestsRecorded > usage.requestsStarted ||
    usage.requestsRecorded !== usage.calls ||
    usage.calls > usage.requestsStarted ||
    (usage.tokens > 0 && usage.calls === 0)
  )
    return "accounting_mismatch";
  if (usage.usageUnknownCalls > 0 || (usage.calls > 0 && usage.tokens === 0))
    return "usage_unknown";
  if (
    usage.calls > usage.caseCallLimit ||
    usage.tokens > usage.caseTokenLimit ||
    (usage.runCalls !== undefined &&
      usage.runCallLimit !== undefined &&
      usage.runCalls > usage.runCallLimit) ||
    (usage.runTokens !== undefined &&
      usage.runTokenLimit !== undefined &&
      usage.runTokens > usage.runTokenLimit)
  )
    return "budget_exceeded";
  if (usage.requestsStarted > usage.requestsRecorded) return "pending";
  return "settled";
}

export class AcceptedProviderRequestGate {
  #latched = false;
  #requestsStarted = 0;
  #requestsRecorded = 0;
  #providerRequestsBlockedAfterLatch = 0;

  public get latched(): boolean {
    return this.#latched;
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

  public get providerRequestsBlockedAfterLatch(): number {
    return this.#providerRequestsBlockedAfterLatch;
  }

  public beforeCall(
    admit: () => void,
    createLatchedError: () => Error = () =>
      new AcceptedProviderRequestAdmissionLatchedError(),
  ): void {
    if (this.#latched) {
      this.#providerRequestsBlockedAfterLatch += 1;
      throw createLatchedError();
    }
    admit();
    this.#requestsStarted += 1;
  }

  public observeRecordedCalls(caseCallCount: number): void {
    if (!Number.isSafeInteger(caseCallCount) || caseCallCount < 0) return;
    this.#requestsRecorded = Math.max(this.#requestsRecorded, caseCallCount);
  }

  public latch(): void {
    this.#latched = true;
  }
}

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
  readonly #requests = new AcceptedProviderRequestGate();

  public get acceptanceLatched(): boolean {
    return this.#acceptanceLatched;
  }

  public get requestsStarted(): number {
    return this.#requests.requestsStarted;
  }

  public get requestsRecorded(): number {
    return this.#requests.requestsRecorded;
  }

  public get inFlightRequests(): number {
    return this.#requests.inFlightRequests;
  }

  public get providerRequestsBlockedAfterAcceptance(): number {
    return this.#requests.providerRequestsBlockedAfterLatch;
  }

  public beforeCall(admit: () => void): void {
    this.#requests.beforeCall(
      admit,
      () => new NoFoodReplanAcceptanceLatchedError(),
    );
  }

  public observeRecordedCalls(caseCallCount: number): void {
    if (!Number.isSafeInteger(caseCallCount) || caseCallCount < 0) return;
    this.#requests.observeRecordedCalls(caseCallCount);
  }

  public latchIfAcceptedEvidence(
    evidence: NoFoodReplanAcceptanceEvidence,
  ): boolean {
    if (!noFoodReplanAcceptanceEvidenceConfirmed(evidence)) return false;
    this.#acceptanceLatched = true;
    this.#requests.latch();
    return true;
  }
}

export async function waitForAcceptedProviderRequestsSettled(
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

export const waitForNoFoodReplanRequestsSettled =
  waitForAcceptedProviderRequestsSettled;
