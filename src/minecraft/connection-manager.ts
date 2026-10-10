import { AppError } from "../domain/errors.js";
import { retry, type RetryPolicy } from "../runtime/retry.js";
import { withTimeout } from "../runtime/timeout.js";

export interface MinecraftConnectionLifecycle {
  connect(signal?: AbortSignal): Promise<void>;
  disconnect(reason?: string): Promise<void>;
  onDisconnected(listener: (reason: string) => void): () => void;
}

type ConnectionState =
  "idle" | "connecting" | "connected" | "reconnecting" | "failed" | "stopped";

export class ConnectionManager {
  private readonly lifetime = new AbortController();
  private unsubscribe: (() => void) | undefined;
  private connecting: Promise<void> | undefined;
  private reconnecting: Promise<void> | undefined;
  private reconnectFailure: unknown;
  private connectionState: ConnectionState = "idle";

  public constructor(
    private readonly minecraft: MinecraftConnectionLifecycle,
    private readonly retryPolicy: RetryPolicy,
    private readonly connectTimeoutMs: number,
    private readonly reconnectEnabled = true,
  ) {}

  public async connect(signal?: AbortSignal): Promise<void> {
    if (this.connectionState === "stopped") {
      const reason: unknown = this.lifetime.signal.reason;
      throw reason instanceof Error
        ? reason
        : new Error("Connection manager stopped");
    }
    if (this.connectionState === "connected") return Promise.resolve();
    if (this.connecting !== undefined) return this.connecting;

    this.connectionState = "connecting";
    const effectiveSignal =
      signal === undefined
        ? this.lifetime.signal
        : AbortSignal.any([signal, this.lifetime.signal]);
    const connecting = this.connectWithRetry(effectiveSignal)
      .then(() => {
        if (this.lifetime.signal.aborted) return;
        this.connectionState = "connected";
        this.armDisconnectListener();
      })
      .catch((error: unknown) => {
        if (!this.lifetime.signal.aborted) this.connectionState = "failed";
        throw error;
      })
      .finally(() => {
        if (this.connecting === connecting) this.connecting = undefined;
      });
    this.connecting = connecting;
    return connecting;
  }

  public get lastReconnectFailure(): unknown {
    return this.reconnectFailure;
  }

  public get state(): ConnectionState {
    return this.connectionState;
  }

  public async shutdown(reason = "shutdown"): Promise<void> {
    if (!this.lifetime.signal.aborted) {
      this.connectionState = "stopped";
      this.lifetime.abort(new Error(reason));
    }
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
          message: "Minecraft disconnected and reconnect is disabled",
          retryable: false,
        });
        return;
      }
      this.connectionState = "reconnecting";
      const reconnecting = this.connectWithRetry(this.lifetime.signal)
        .then(() => {
          if (this.lifetime.signal.aborted) return;
          this.reconnectFailure = undefined;
          this.connectionState = "connected";
          this.armDisconnectListener();
        })
        .catch((error: unknown) => {
          if (this.lifetime.signal.aborted) return;
          this.reconnectFailure = error;
          this.connectionState = "failed";
        })
        .finally(() => {
          if (this.reconnecting === reconnecting) this.reconnecting = undefined;
        });
      this.reconnecting = reconnecting;
    });
  }
}
