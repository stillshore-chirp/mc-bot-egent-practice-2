import { AppError } from "../domain/errors.js";

export const actionPriorities = {
  idle: 0,
  task: 50,
  reflex: 100,
  stop: 1_000,
} as const;

export interface ActionLease {
  readonly owner: string;
  readonly priority: number;
  readonly signal: AbortSignal;
  release(): void;
}

interface ActiveLease {
  readonly owner: string;
  readonly priority: number;
  readonly controller: AbortController;
}

export class ActionArbiter {
  private active: ActiveLease | undefined;
  private readonly availabilityWaiters = new Set<() => void>();

  public async waitForAvailable(
    priority: number,
    signal?: AbortSignal,
  ): Promise<void> {
    if (signal?.aborted)
      throw signal.reason ?? new Error("Action wait aborted");
    if (this.active === undefined || this.active.priority < priority) return;

    await new Promise<void>((resolve, reject) => {
      let settled = false;
      const check = () => {
        if (
          settled ||
          (this.active !== undefined && this.active.priority >= priority)
        )
          return;
        settled = true;
        this.availabilityWaiters.delete(check);
        signal?.removeEventListener("abort", onAbort);
        resolve();
      };
      const onAbort = () => {
        if (settled) return;
        settled = true;
        this.availabilityWaiters.delete(check);
        signal?.removeEventListener("abort", onAbort);
        reject(signal?.reason ?? new Error("Action wait aborted"));
      };
      this.availabilityWaiters.add(check);
      signal?.addEventListener("abort", onAbort, { once: true });
      check();
    });
  }

  public acquire(owner: string, priority: number): ActionLease {
    if (this.active !== undefined && this.active.priority >= priority) {
      throw new AppError({
        category: "safety",
        code: "ACTION_LEASE_BUSY",
        message: `Action control is held by ${this.active.owner}`,
        retryable: true,
      });
    }

    this.active?.controller.abort(new Error(`Preempted by ${owner}`));
    const lease: ActiveLease = {
      owner,
      priority,
      controller: new AbortController(),
    };
    this.active = lease;
    return {
      owner,
      priority,
      signal: lease.controller.signal,
      release: () => {
        if (this.active === lease) {
          this.active = undefined;
          this.notifyAvailabilityWaiters();
        }
      },
    };
  }

  public stop(reason: string): void {
    this.active?.controller.abort(new Error(reason));
    this.active = undefined;
    this.notifyAvailabilityWaiters();
  }

  public get currentOwner(): string | undefined {
    return this.active?.owner;
  }

  private notifyAvailabilityWaiters(): void {
    for (const check of [...this.availabilityWaiters]) check();
  }
}
