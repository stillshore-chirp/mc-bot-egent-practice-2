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
        if (this.active === lease) this.active = undefined;
      },
    };
  }

  public stop(reason: string): void {
    this.active?.controller.abort(new Error(reason));
    this.active = undefined;
  }

  public get currentOwner(): string | undefined {
    return this.active?.owner;
  }
}
