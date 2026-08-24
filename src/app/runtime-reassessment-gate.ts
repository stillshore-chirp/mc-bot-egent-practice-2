export class RuntimeReassessmentGate<Event extends string> {
  readonly #run: (event: Event) => Promise<void>;
  readonly #priority: (event: Event) => number;
  readonly #cooldownMs: number;
  readonly #onError: (error: unknown, event: Event) => void;
  #pending: Event | undefined;
  #running: Promise<void> | undefined;
  #timer: NodeJS.Timeout | undefined;
  #nextAllowedAt = 0;
  #generation = 0;
  #stopped = false;

  public constructor(input: {
    run: (event: Event) => Promise<void>;
    priority: (event: Event) => number;
    cooldownMs: number;
    onError: (error: unknown, event: Event) => void;
  }) {
    this.#run = input.run;
    this.#priority = input.priority;
    this.#cooldownMs = input.cooldownMs;
    this.#onError = input.onError;
  }

  public captureGeneration(): number {
    return this.#generation;
  }

  public request(event: Event, generation = this.#generation): void {
    if (this.#stopped || generation !== this.#generation) return;
    if (
      this.#pending === undefined ||
      this.#priority(event) > this.#priority(this.#pending)
    ) {
      this.#pending = event;
    }
    this.#schedule();
  }

  public cancelPending(): void {
    this.#generation += 1;
    this.#pending = undefined;
    if (this.#timer !== undefined) {
      clearTimeout(this.#timer);
      this.#timer = undefined;
    }
  }

  public stop(): Promise<void> {
    this.#stopped = true;
    this.cancelPending();
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
    const delayMs = Math.max(0, this.#nextAllowedAt - Date.now());
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
    const event = this.#pending;
    this.#pending = undefined;
    const operation = this.#run(event)
      .catch((error: unknown) => {
        try {
          this.#onError(error, event);
        } catch {
          // Error reporting must not strand the gate in its running state.
        }
      })
      .finally(() => {
        this.#nextAllowedAt = Date.now() + this.#cooldownMs;
        if (this.#running === operation) this.#running = undefined;
        this.#schedule();
      });
    this.#running = operation;
  }
}
