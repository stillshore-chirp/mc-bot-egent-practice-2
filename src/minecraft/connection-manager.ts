import { AppError } from "../domain/errors.js";
import { retry, type RetryPolicy } from "../runtime/retry.js";
import { withTimeout } from "../runtime/timeout.js";
import type { MinecraftPort } from "./port.js";

export class ConnectionManager {
  private readonly lifetime = new AbortController();
  private unsubscribe: (() => void) | undefined;
  private reconnecting: Promise<void> | undefined;
  private reconnectFailure: unknown;
  private connectionState:
    | "idle"
    | "connecting"
    | "connected"
    | "reconnecting"
    | "failed"
    | "stopped" = "idle";

  public constructor(
    private readonly minecraft: MinecraftPort,
    private readonly retryPolicy: RetryPolicy,
    private readonly connectTimeoutMs: number,
    private readonly reconnectEnabled = true,
  ) {}

  public async connect(signal?: AbortSignal): Promise<void> {
    this.connectionState = "connecting";
    const effectiveSignal =
      signal === undefined
        ? this.lifetime.signal
        : AbortSignal.any([signal, this.lifetime.signal]);
    try {
      await this.connectWithRetry(effectiveSignal);
    } catch (error) {
      this.connectionState = "failed";
      throw error;
    }
    this.connectionState = "connected";
    this.armDisconnectListener();
  }

  public get lastReconnectFailure(): unknown {
    return this.reconnectFailure;
  }

  public get state(): typeof this.connectionState {
    return this.connectionState;
  }

  public async shutdown(reason = "shutdown"): Promise<void> {
    this.connectionState = "stopped";
    this.lifetime.abort(new Error(reason));
    this.unsubscribe?.();
    this.unsubscribe = undefined;
    await this.minecraft.disconnect(reason);
  }

  private async connectWithRetry(signal: AbortSignal): Promise<void> {
    await retry(
      async () =>
        withTimeout(
          async (timeoutSignal) => this.minecraft.connect(timeoutSignal),
          this.connectTimeoutMs,
          signal,
          "minecraft_connect",
        ),
      this.retryPolicy,
      (error) => error instanceof AppError && error.detail.retryable,
      signal,
    );
  }

  private armDisconnectListener(): void {
    this.unsubscribe?.();
    this.unsubscribe = undefined;
    if (this.lifetime.signal.aborted) return;
    this.unsubscribe = this.minecraft.onDisconnected(() => {
      if (this.lifetime.signal.aborted || this.reconnecting !== undefined)
        return;
      this.unsubscribe?.();
      this.unsubscribe = undefined;
      if (!this.reconnectEnabled) {
        this.connectionState = "failed";
        this.reconnectFailure = new AppError({
          category: "connection",
          code: "RECONNECT_DISABLED",
          message: "The Minecraft connection ended and reconnect is disabled",
          retryable: false,
        });
        return;
      }
      this.connectionState = "reconnecting";
      this.reconnecting = this.connectWithRetry(this.lifetime.signal)
        .then(() => {
          this.reconnectFailure = undefined;
          this.connectionState = "connected";
          this.armDisconnectListener();
        })
        .catch((error: unknown) => {
          this.reconnectFailure = error;
          this.connectionState = "failed";
        })
        .finally(() => {
          this.reconnecting = undefined;
        });
    });
  }
}
