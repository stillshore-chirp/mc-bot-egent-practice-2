export interface RuntimeReassessmentRequest<Event extends string> {
  readonly event: Event;
  /** A stable, safe category for the observed state. Do not include raw input. */
  readonly stateKey: string;
  /** A stable, safe category for the trigger that produced the request. */
  readonly causeKey?: string | undefined;
}

export type RuntimeReassessmentSuppressionReason =
  | "unchanged_state"
  | "coalesced"
  | "lower_priority"
  | "superseded"
  | "stale_state"
  | "stale_generation"
  | "owner_message"
  | "stopped";

export type RuntimeReassessmentRunOutcome =
  "completed" | "failed" | "cancelled";

export interface RuntimeReassessmentStats {
  readonly requested: number;
  readonly started: number;
  readonly completed: number;
  readonly failed: number;
  readonly cancelled: number;
  readonly suppressed: number;
}

export interface RuntimeReassessmentDecision<Event extends string> {
  readonly event: Event;
  readonly stateKey: string;
  readonly causeKey?: string | undefined;
  readonly outcome:
    | "accepted"
    | "started"
    | "completed"
    | "failed"
    | "cancelled"
    | "suppressed";
  readonly reason?: RuntimeReassessmentSuppressionReason | undefined;
  readonly stats: RuntimeReassessmentStats;
}

interface NormalizedRequest<
  Event extends string,
> extends RuntimeReassessmentRequest<Event> {
  /** Legacy string requests retain the original time cooldown semantics. */
  readonly explicitStateKey: boolean;
}

export class RuntimeReassessmentGate<Event extends string> {
  readonly #run: (
    event: Event,
    request: RuntimeReassessmentRequest<Event>,
  ) => Promise<unknown>;
  readonly #priority: (event: Event) => number;
  readonly #cooldownMs: number;
  readonly #onError: (
    error: unknown,
    event: Event,
    request: RuntimeReassessmentRequest<Event>,
  ) => void;
  readonly #onDecision: (decision: RuntimeReassessmentDecision<Event>) => void;
  #pending: NormalizedRequest<Event> | undefined;
  #runningRequest: NormalizedRequest<Event> | undefined;
  #running: Promise<void> | undefined;
  #timer: NodeJS.Timeout | undefined;
  #nextAllowedAt = 0;
  #generation = 0;
  #stopped = false;
  #lastCompletedStateKey: string | undefined;
  #stats: RuntimeReassessmentStats = {
    requested: 0,
    started: 0,
    completed: 0,
    failed: 0,
    cancelled: 0,
    suppressed: 0,
  };

  public constructor(input: {
    run: (
      event: Event,
      request: RuntimeReassessmentRequest<Event>,
    ) => Promise<unknown>;
    priority: (event: Event) => number;
    cooldownMs: number;
    onError: (
      error: unknown,
      event: Event,
      request: RuntimeReassessmentRequest<Event>,
    ) => void;
    onDecision?:
      ((decision: RuntimeReassessmentDecision<Event>) => void) | undefined;
  }) {
    this.#run = input.run;
    this.#priority = input.priority;
    this.#cooldownMs = input.cooldownMs;
    this.#onError = input.onError;
    this.#onDecision = input.onDecision ?? (() => undefined);
  }

  public captureGeneration(): number {
    return this.#generation;
  }

  public get stats(): RuntimeReassessmentStats {
    return { ...this.#stats };
  }

  public request(
    input: Event | RuntimeReassessmentRequest<Event>,
    generation = this.#generation,
  ): void {
    const request: NormalizedRequest<Event> =
      typeof input === "string"
        ? { event: input, stateKey: input, explicitStateKey: false }
        : { ...input, explicitStateKey: true };
    this.#stats = {
      ...this.#stats,
      requested: this.#stats.requested + 1,
    };
    if (this.#stopped) {
      this.#suppress(request, "stopped");
      return;
    }
    if (generation !== this.#generation) {
      this.#suppress(request, "stale_generation");
      return;
    }
    if (
      request.explicitStateKey &&
      (request.stateKey === this.#lastCompletedStateKey ||
        request.stateKey === this.#runningRequest?.stateKey)
    ) {
      const stalePending = this.#pending;
      if (
        stalePending !== undefined &&
        stalePending.stateKey !== request.stateKey
      ) {
        this.#pending = undefined;
        this.#clearTimer();
        this.#suppress(stalePending, "stale_state");
      }
      this.#suppress(request, "unchanged_state");
      return;
    }
    if (request.stateKey === this.#pending?.stateKey) {
      this.#suppress(request, "coalesced");
      return;
    }
    if (this.#pending === undefined) {
      this.#accept(request);
      this.#schedule();
      return;
    }
    if (this.#priority(request.event) >= this.#priority(this.#pending.event)) {
      const superseded = this.#pending;
      this.#pending = undefined;
      this.#clearTimer();
      this.#suppress(superseded, "superseded");
      this.#accept(request);
      this.#schedule();
      return;
    }
    this.#suppress(request, "lower_priority");
  }

  public cancelPending(reason: "owner_message" | "stopped" = "stopped"): void {
    this.#generation += 1;
    const pending = this.#pending;
    this.#pending = undefined;
    if (this.#timer !== undefined) {
      clearTimeout(this.#timer);
      this.#timer = undefined;
    }
    if (pending !== undefined) this.#suppress(pending, reason);
  }

  public stop(): Promise<void> {
    this.#stopped = true;
    this.cancelPending("stopped");
    return this.#running ?? Promise.resolve();
  }

  #schedule(): void {
    if (
      this.#stopped ||
      this.#running !== undefined ||
      this.#timer !== undefined ||
      this.#pending === undefined
    ) {
      return;
    }
    const delayMs = this.#pending.explicitStateKey
      ? 0
      : Math.max(0, this.#nextAllowedAt - Date.now());
    if (delayMs > 0) {
      this.#timer = setTimeout(() => {
        this.#timer = undefined;
        this.#start();
      }, delayMs);
      return;
    }
    this.#start();
  }

  #start(): void {
    if (this.#stopped || this.#pending === undefined) return;
    const request = this.#pending;
    this.#pending = undefined;
    this.#runningRequest = request;
    this.#stats = {
      ...this.#stats,
      started: this.#stats.started + 1,
    };
    this.#decide(request, "started");
    const operation = this.#run(request.event, request)
      .then((outcome) => {
        const resolvedOutcome: RuntimeReassessmentRunOutcome =
          outcome === "failed"
            ? "failed"
            : outcome === "cancelled"
              ? "cancelled"
              : "completed";
        if (resolvedOutcome === "completed") {
          this.#stats = {
            ...this.#stats,
            completed: this.#stats.completed + 1,
          };
          this.#lastCompletedStateKey =
            this.#pending === undefined ||
            this.#pending.stateKey === request.stateKey
              ? request.stateKey
              : undefined;
          this.#decide(request, "completed");
          return;
        }
        if (resolvedOutcome === "cancelled") {
          this.#stats = {
            ...this.#stats,
            cancelled: this.#stats.cancelled + 1,
          };
          this.#decide(request, "cancelled");
          return;
        }
        this.#stats = {
          ...this.#stats,
          failed: this.#stats.failed + 1,
        };
        this.#decide(request, "failed");
      })
      .catch((error: unknown) => {
        this.#stats = {
          ...this.#stats,
          failed: this.#stats.failed + 1,
        };
        try {
          this.#onError(error, request.event, request);
        } catch {
          // Error reporting must not strand the gate in its running state.
        }
        this.#decide(request, "failed");
      })
      .finally(() => {
        this.#nextAllowedAt = Date.now() + this.#cooldownMs;
        if (this.#running === operation) this.#running = undefined;
        if (this.#runningRequest === request) this.#runningRequest = undefined;
        this.#schedule();
      });
    this.#running = operation;
  }

  #suppress(
    request: NormalizedRequest<Event>,
    reason: RuntimeReassessmentSuppressionReason,
  ): void {
    this.#stats = {
      ...this.#stats,
      suppressed: this.#stats.suppressed + 1,
    };
    this.#decide(request, "suppressed", reason);
  }

  #clearTimer(): void {
    if (this.#timer !== undefined) {
      clearTimeout(this.#timer);
      this.#timer = undefined;
    }
  }

  #accept(request: NormalizedRequest<Event>): void {
    if (request.stateKey !== this.#lastCompletedStateKey) {
      this.#lastCompletedStateKey = undefined;
    }
    this.#pending = request;
    this.#decide(request, "accepted");
  }

  #decide(
    request: RuntimeReassessmentRequest<Event>,
    outcome: RuntimeReassessmentDecision<Event>["outcome"],
    reason?: RuntimeReassessmentSuppressionReason,
  ): void {
    try {
      this.#onDecision({
        event: request.event,
        stateKey: request.stateKey,
        ...(request.causeKey === undefined
          ? {}
          : { causeKey: request.causeKey }),
        outcome,
        ...(reason === undefined ? {} : { reason }),
        stats: this.stats,
      });
    } catch {
      // Telemetry must not affect runtime reassessment.
    }
  }
}
