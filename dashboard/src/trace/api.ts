import {
  cognitiveTraceBundleSchema,
  cognitiveTraceEventSchema,
  cognitiveTraceLinkSchema,
  cognitiveTraceResultSchema,
  cognitiveTraceSpanSchema,
  cognitiveTraceRunSchema,
  type CognitiveTraceBundle,
  type CognitiveTraceDetail,
  type CognitiveTraceEvent,
  type CognitiveTraceRun,
} from "@trace";

export class DashboardApiError extends Error {
  public readonly status: number;

  public constructor(message: string, status: number) {
    super(message);
    this.name = "DashboardApiError";
    this.status = status;
  }
}

export async function getHealth(signal?: AbortSignal): Promise<unknown> {
  return requestJson("/api/dashboard/health", signal);
}

export async function listTraces(
  signal?: AbortSignal,
): Promise<readonly CognitiveTraceRun[]> {
  const payload: unknown = await requestJson("/api/traces", signal);
  const values = Array.isArray(payload)
    ? payload
    : isRecord(payload) && Array.isArray(payload.traces)
      ? payload.traces
      : [];
  return values.map((value) => cognitiveTraceRunSchema.parse(value));
}

export async function getTrace(
  traceId: string,
  signal?: AbortSignal,
): Promise<CognitiveTraceDetail> {
  const payload = await requestJson(
    `/api/traces/${encodeURIComponent(traceId)}`,
    signal,
  );
  return parseTraceDetail(payload);
}

export async function getTraceEvents(
  traceId: string,
  signal?: AbortSignal,
): Promise<readonly CognitiveTraceEvent[]> {
  const payload: unknown = await requestJson(
    `/api/traces/${encodeURIComponent(traceId)}/events`,
    signal,
  );
  const values = Array.isArray(payload)
    ? payload
    : isRecord(payload) && Array.isArray(payload.events)
      ? payload.events
      : [];
  return values.map((value) => cognitiveTraceEventSchema.parse(value));
}

export async function exportBundle(
  traceId: string,
  signal?: AbortSignal,
): Promise<CognitiveTraceBundle> {
  const payload = await requestJson(
    `/api/traces/${encodeURIComponent(traceId)}/export`,
    signal,
  );
  return cognitiveTraceBundleSchema.parse(payload);
}

export async function markTraceDemoSafe(
  traceId: string,
  signal?: AbortSignal,
): Promise<CognitiveTraceBundle> {
  const payload = await requestJsonWithOptions(
    `/api/traces/${encodeURIComponent(traceId)}/demo-safe`,
    { method: "POST" },
    signal,
  );
  return cognitiveTraceBundleSchema.parse(payload);
}

export async function importDemoBundle(
  value: unknown,
  signal?: AbortSignal,
): Promise<CognitiveTraceRun> {
  const bundle = cognitiveTraceBundleSchema.parse(value);
  const payload = await requestJsonWithOptions(
    "/api/traces/import",
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(bundle),
    },
    signal,
  );
  if (!isRecord(payload) || !("trace" in payload)) {
    throw new DashboardApiError(
      "Trace import response has an invalid shape.",
      200,
    );
  }
  return cognitiveTraceRunSchema.parse(payload.trace);
}

export interface TraceStreamHandlers {
  readonly onEvent: (event: CognitiveTraceEvent) => void;
  readonly onState: (
    state: "connecting" | "connected" | "reconnecting" | "disconnected",
    message?: string,
  ) => void;
  readonly onIntegrity?: (integrity: TraceStreamIntegrity) => void;
}

export interface TraceStreamIntegrity {
  readonly duplicateEventIds: number;
  readonly duplicateStreamIds: number;
  readonly outOfOrderStreamIds: number;
  readonly gaps: readonly { readonly from: number; readonly to: number }[];
}

export class TraceStreamClient {
  #eventSource: EventSource | undefined;
  #handlers: TraceStreamHandlers | undefined;
  #lastStreamId: number | undefined;
  #seenEventIds = new Set<string>();
  #seenStreamIds = new Set<number>();
  #integrity: TraceStreamIntegrity = {
    duplicateEventIds: 0,
    duplicateStreamIds: 0,
    outOfOrderStreamIds: 0,
    gaps: [],
  };

  public connect(handlers: TraceStreamHandlers): void {
    this.disconnect();
    this.#handlers = handlers;
    handlers.onState("connecting");
    handlers.onIntegrity?.(this.#integrity);
    const source = new EventSource("/api/stream");
    this.#eventSource = source;
    source.onopen = () => handlers.onState("connected");
    source.onmessage = (message) => {
      const data: unknown = message.data;
      if (typeof data === "string") this.handleMessage(data);
    };
    source.addEventListener("trace", (event) => {
      if (event instanceof MessageEvent) {
        const data: unknown = event.data;
        if (typeof data === "string") this.handleMessage(data);
      }
    });
    source.onerror = () => {
      if (source.readyState === EventSource.CONNECTING) {
        handlers.onState("reconnecting", "ライブ配信を再接続しています。");
      } else {
        handlers.onState("disconnected", "ライブ配信が切断されました。");
      }
    };
  }

  public disconnect(): void {
    this.#eventSource?.close();
    this.#eventSource = undefined;
    this.#handlers = undefined;
  }

  private handleMessage(raw: string): void {
    try {
      const payload: unknown = JSON.parse(raw);
      const candidate =
        isRecord(payload) && "event" in payload ? payload.event : payload;
      const parsed = cognitiveTraceEventSchema.safeParse(candidate);
      if (parsed.success && this.accept(parsed.data))
        this.#handlers?.onEvent(parsed.data);
    } catch {
      this.#handlers?.onState(
        "disconnected",
        "ライブイベントを解釈できませんでした。",
      );
    }
  }

  private accept(event: CognitiveTraceEvent): boolean {
    if (this.#seenEventIds.has(event.eventId)) {
      this.#integrity = {
        ...this.#integrity,
        duplicateEventIds: this.#integrity.duplicateEventIds + 1,
      };
      this.#handlers?.onIntegrity?.(this.#integrity);
      return false;
    }
    this.#seenEventIds.add(event.eventId);
    if (event.streamId !== undefined) {
      if (this.#seenStreamIds.has(event.streamId)) {
        this.#integrity = {
          ...this.#integrity,
          duplicateStreamIds: this.#integrity.duplicateStreamIds + 1,
        };
        this.#handlers?.onIntegrity?.(this.#integrity);
        return false;
      }
      this.#seenStreamIds.add(event.streamId);
      if (this.#lastStreamId !== undefined) {
        if (event.streamId > this.#lastStreamId + 1) {
          this.#integrity = {
            ...this.#integrity,
            gaps: mergeGap(this.#integrity.gaps, {
              from: this.#lastStreamId + 1,
              to: event.streamId - 1,
            }),
          };
        } else if (event.streamId <= this.#lastStreamId) {
          this.#integrity = {
            ...this.#integrity,
            outOfOrderStreamIds: this.#integrity.outOfOrderStreamIds + 1,
          };
        }
      }
      this.#lastStreamId =
        this.#lastStreamId === undefined
          ? event.streamId
          : Math.max(this.#lastStreamId, event.streamId);
    }
    this.#handlers?.onIntegrity?.(this.#integrity);
    return true;
  }
}

async function requestJson(
  url: string,
  signal?: AbortSignal,
): Promise<unknown> {
  return requestJsonWithOptions(url, {}, signal);
}

async function requestJsonWithOptions(
  url: string,
  init: RequestInit,
  signal?: AbortSignal,
): Promise<unknown> {
  const headers = new Headers(init.headers);
  headers.set("accept", "application/json");
  const response = await fetch(url, {
    ...init,
    headers,
    ...(signal === undefined ? {} : { signal }),
  });
  if (!response.ok) {
    throw new DashboardApiError(
      `Dashboard API request failed: ${response.status}`,
      response.status,
    );
  }
  return response.json();
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function mergeGap(
  gaps: readonly { readonly from: number; readonly to: number }[],
  next: { readonly from: number; readonly to: number },
): readonly { readonly from: number; readonly to: number }[] {
  const merged = [...gaps, next].sort((left, right) => left.from - right.from);
  const result: { from: number; to: number }[] = [];
  for (const gap of merged) {
    const previous = result.at(-1);
    if (previous !== undefined && gap.from <= previous.to + 1)
      previous.to = Math.max(previous.to, gap.to);
    else result.push({ from: gap.from, to: gap.to });
  }
  return result;
}

function parseTraceDetail(value: unknown): CognitiveTraceDetail {
  if (
    !isRecord(value) ||
    !isRecord(value.run) ||
    !Array.isArray(value.spans) ||
    !Array.isArray(value.links) ||
    !Array.isArray(value.results)
  ) {
    throw new DashboardApiError(
      "Trace detail response has an invalid shape.",
      200,
    );
  }
  return {
    run: cognitiveTraceRunSchema.parse(value.run),
    spans: value.spans.map((span) => cognitiveTraceSpanSchema.parse(span)),
    links: value.links.map((link) => cognitiveTraceLinkSchema.parse(link)),
    results: value.results.map((result) =>
      cognitiveTraceResultSchema.parse(result),
    ),
  };
}
