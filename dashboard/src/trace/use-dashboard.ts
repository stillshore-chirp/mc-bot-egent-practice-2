import {
  useCallback,
  useEffect,
  useMemo,
  useReducer,
  useRef,
  useState,
  type Dispatch,
} from "react";

import type {
  CognitiveTraceDetail,
  CognitiveTraceEvent,
  CognitiveTraceRun,
} from "@trace";

import {
  getHealth,
  getTrace,
  getTraceEvents,
  listTraces,
  TraceStreamClient,
  type TraceStreamIntegrity,
} from "./api";
import {
  emptyTraceState,
  reduceReplay,
  traceReducer,
  type TraceState,
  type TraceStreamState,
} from "./reducer";

export type DashboardMode = "live" | "replay";

/**
 * Pausing is intentionally bounded.  A long pause cannot make the browser a
 * second event store; when the bound is exceeded resume rehydrates from the
 * persisted trace endpoint and reports the degraded observability state.
 */
export const LIVE_EVENT_BUFFER_LIMIT = 500;

export interface DashboardBotHealth {
  readonly botState?: string;
  readonly connectionState?: string;
  readonly aiState?: string;
  readonly memoryState?: string;
  readonly reflexState?: string;
  readonly taskStatus?: string;
  readonly taskPhase?: string;
  readonly health?: number | string;
  readonly food?: number | string;
  readonly positionState?: string;
}

export interface DashboardData {
  readonly healthState: "unknown" | "healthy" | "degraded" | "offline";
  readonly botHealth: DashboardBotHealth;
  readonly streamState: TraceStreamState;
  readonly streamMessage?: string;
  readonly streamIntegrity: TraceStreamIntegrity;
  readonly runs: readonly CognitiveTraceRun[];
  readonly selectedTraceId?: string;
  readonly detail?: CognitiveTraceDetail;
  readonly events: readonly CognitiveTraceEvent[];
  readonly state: TraceState;
  readonly mode: DashboardMode;
  readonly livePaused: boolean;
  readonly liveBufferedCount: number;
  readonly liveBufferOverflow: boolean;
  readonly error?: string;
  readonly loading: boolean;
  readonly refresh: () => Promise<void>;
  readonly selectTrace: (traceId: string) => Promise<void>;
  readonly setMode: (mode: DashboardMode) => void;
  readonly setLivePaused: (paused: boolean) => void;
  readonly setReplayIndex: (index: number) => void;
  readonly dispatch: Dispatch<Parameters<typeof traceReducer>[1]>;
}

export function useDashboardData(): DashboardData {
  const [runs, setRuns] = useState<readonly CognitiveTraceRun[]>([]);
  const [selectedTraceId, setSelectedTraceId] = useState<string>();
  const [detail, setDetail] = useState<CognitiveTraceDetail>();
  const [events, setEvents] = useState<readonly CognitiveTraceEvent[]>([]);
  const [mode, setMode] = useState<DashboardMode>("live");
  // undefined means the initial recorded view is positioned at the latest
  // persisted event; once the user seeks, -1 is a real "before event 1"
  // position and must remain an empty graph.
  const [replayCursor, setReplayCursor] = useState<number | undefined>(
    undefined,
  );
  const [livePaused, setLivePausedState] = useState(false);
  const [liveBufferedCount, setLiveBufferedCount] = useState(0);
  const [liveBufferOverflow, setLiveBufferOverflow] = useState(false);
  const [healthState, setHealthState] =
    useState<DashboardData["healthState"]>("unknown");
  const [botHealth, setBotHealth] = useState<DashboardBotHealth>({});
  const [streamState, setStreamState] = useState<TraceStreamState>("idle");
  const [streamMessage, setStreamMessage] = useState<string>();
  const [streamIntegrity, setStreamIntegrity] = useState<TraceStreamIntegrity>({
    duplicateEventIds: 0,
    duplicateStreamIds: 0,
    outOfOrderStreamIds: 0,
    gaps: [],
  });
  const [error, setError] = useState<string>();
  const [loading, setLoading] = useState(true);
  const [baseState, dispatch] = useReducer(traceReducer, emptyTraceState);
  const stream = useRef<TraceStreamClient | undefined>(undefined);
  const runsRef = useRef(runs);
  const selectedTraceIdRef = useRef(selectedTraceId);
  const modeRef = useRef(mode);
  const livePausedRef = useRef(false);
  const liveBufferRef = useRef<CognitiveTraceEvent[]>([]);
  const liveBufferOverflowRef = useRef(false);
  const pendingTraceRefresh = useRef(new Set<string>());
  runsRef.current = runs;
  selectedTraceIdRef.current = selectedTraceId;
  modeRef.current = mode;

  const clearLiveBuffer = useCallback((clearOverflow = true): void => {
    liveBufferRef.current = [];
    setLiveBufferedCount(0);
    if (clearOverflow) {
      liveBufferOverflowRef.current = false;
      setLiveBufferOverflow(false);
    }
  }, []);

  const enqueueLiveEvent = useCallback((event: CognitiveTraceEvent): void => {
    if (liveBufferRef.current.length >= LIVE_EVENT_BUFFER_LIMIT) {
      if (!liveBufferOverflowRef.current) {
        liveBufferOverflowRef.current = true;
        setLiveBufferOverflow(true);
        setStreamState("degraded");
        setStreamMessage(
          `Live停止中のeventが上限(${LIVE_EVENT_BUFFER_LIMIT}件)を超えました。再開時に保存済みeventsから再構築します。`,
        );
      }
      return;
    }
    liveBufferRef.current = [...liveBufferRef.current, event];
    setLiveBufferedCount(liveBufferRef.current.length);
  }, []);

  const loadTrace = useCallback(
    async (
      traceId: string,
      requestedMode?: DashboardMode,
    ): Promise<readonly CognitiveTraceEvent[]> => {
      const [nextDetail, nextEvents] = await Promise.all([
        getTrace(traceId),
        getTraceEvents(traceId),
      ]);
      setSelectedTraceId(traceId);
      setDetail(nextDetail);
      setEvents(nextEvents);
      setReplayCursor(undefined);
      dispatch({ type: "reset", detail: nextDetail });
      dispatch({ type: "apply-many", events: nextEvents });
      setMode(
        requestedMode ??
          (nextDetail.run.source === "recorded" ? "replay" : "live"),
      );
      return nextEvents;
    },
    [],
  );

  const refresh = useCallback(async (): Promise<void> => {
    const controller = new AbortController();
    setError(undefined);
    try {
      const [nextRuns, health] = await Promise.all([
        listTraces(controller.signal),
        getHealth(controller.signal),
      ]);
      setRuns(nextRuns);
      const parsedHealth = parseHealth(health);
      setHealthState(parsedHealth.observabilityState);
      setBotHealth(parsedHealth.bot);
      if (
        selectedTraceId !== undefined &&
        !nextRuns.some(({ traceId }) => traceId === selectedTraceId)
      ) {
        setSelectedTraceId(undefined);
        setDetail(undefined);
        setEvents([]);
        dispatch({ type: "reset" });
        livePausedRef.current = false;
        setLivePausedState(false);
        clearLiveBuffer();
      }
    } catch {
      setHealthState("offline");
      setBotHealth({});
      setError(
        "ダッシュボードAPIへ接続できません。ボットの観測状態を確認してください。",
      );
    } finally {
      setLoading(false);
    }
    controller.abort();
  }, [clearLiveBuffer, selectedTraceId]);

  const selectTrace = useCallback(
    async (traceId: string): Promise<void> => {
      livePausedRef.current = false;
      setLivePausedState(false);
      clearLiveBuffer();
      setLoading(true);
      setError(undefined);
      try {
        await loadTrace(traceId);
      } catch {
        setError(
          "トレースを読み込めませんでした。保存済みデータを確認してください。",
        );
      } finally {
        setLoading(false);
      }
    },
    [clearLiveBuffer, loadTrace],
  );

  const resumeLive = useCallback(async (): Promise<void> => {
    const traceId = selectedTraceIdRef.current;
    const pending = liveBufferRef.current;
    const overflowed = liveBufferOverflowRef.current;

    if (overflowed && traceId !== undefined) {
      // Keep accepting into the bounded buffer while the persisted snapshot
      // is being fetched. Events that arrive after the snapshot are applied
      // after it, so the resume boundary cannot lose a live event.
      liveBufferRef.current = [];
      setLiveBufferedCount(0);
      livePausedRef.current = true;
      setLivePausedState(true);
      setLoading(true);
      try {
        const persistedEvents = await loadTrace(traceId, "live");
        const persistedIds = new Set(
          persistedEvents.map(({ eventId }) => eventId),
        );
        const afterReload = [...liveBufferRef.current]
          .filter(({ eventId }) => !persistedIds.has(eventId))
          .sort((left, right) => left.sequence - right.sequence);
        if (afterReload.length > 0) {
          setEvents((current) => {
            const existing = new Set(current.map(({ eventId }) => eventId));
            return [
              ...current,
              ...afterReload.filter(({ eventId }) => !existing.has(eventId)),
            ];
          });
          dispatch({ type: "apply-many", events: afterReload });
          setRuns((current) => {
            const next = afterReload.reduce(updateRunList, current);
            runsRef.current = next;
            return next;
          });
        }
        clearLiveBuffer();
        livePausedRef.current = false;
        setLivePausedState(false);
        setStreamMessage(
          "Live更新を再開しました。保存済みeventsから表示を再構築しました。",
        );
      } catch {
        const afterFailure = liveBufferRef.current;
        liveBufferRef.current = [...pending, ...afterFailure].slice(
          0,
          LIVE_EVENT_BUFFER_LIMIT,
        );
        setLiveBufferedCount(liveBufferRef.current.length);
        livePausedRef.current = true;
        setLivePausedState(true);
        setError(
          "Live更新を再開できませんでした。保存済みeventsを再取得してください。",
        );
      } finally {
        setLoading(false);
      }
      return;
    }

    livePausedRef.current = false;
    setLivePausedState(false);
    const ordered = [...pending].sort(
      (left, right) => left.sequence - right.sequence,
    );
    if (ordered.length > 0) {
      setEvents((current) => {
        const existing = new Set(current.map(({ eventId }) => eventId));
        return [
          ...current,
          ...ordered.filter(({ eventId }) => !existing.has(eventId)),
        ];
      });
      dispatch({ type: "apply-many", events: ordered });
      setRuns((current) => {
        const next = ordered.reduce(updateRunList, current);
        runsRef.current = next;
        return next;
      });
    }
    clearLiveBuffer();
  }, [clearLiveBuffer, loadTrace]);

  const setLivePaused = useCallback(
    (paused: boolean): void => {
      if (paused) {
        if (modeRef.current !== "live") return;
        livePausedRef.current = true;
        setLivePausedState(true);
        return;
      }
      void resumeLive();
    },
    [resumeLive],
  );

  const changeMode = useCallback(
    (nextMode: DashboardMode): void => {
      if (nextMode === "live" && livePausedRef.current) void resumeLive();
      setMode(nextMode);
    },
    [resumeLive],
  );

  useEffect(() => {
    void refresh();
  }, [refresh]);

  useEffect(() => {
    if (selectedTraceId !== undefined || runs[0] === undefined) return;
    void selectTrace(runs[0].traceId);
  }, [runs, selectedTraceId, selectTrace]);

  useEffect(() => {
    const controller = new AbortController();
    let disposed = false;
    const pollHealth = async (): Promise<void> => {
      try {
        const health = await getHealth(controller.signal);
        if (disposed) return;
        const parsedHealth = parseHealth(health);
        setHealthState(parsedHealth.observabilityState);
        setBotHealth(parsedHealth.bot);
      } catch {
        if (!disposed && !controller.signal.aborted) {
          setHealthState("offline");
          setBotHealth({});
        }
      }
    };
    const interval = window.setInterval(() => void pollHealth(), 10_000);
    return () => {
      disposed = true;
      controller.abort();
      window.clearInterval(interval);
    };
  }, []);

  useEffect(() => {
    const client = new TraceStreamClient();
    stream.current = client;
    client.connect({
      onEvent: (event) => {
        const selected = event.traceId === selectedTraceIdRef.current;
        const pausedSelectedLive =
          selected && modeRef.current === "live" && livePausedRef.current;
        const knownTrace = runsRef.current.some(
          ({ traceId }) => traceId === event.traceId,
        );
        if (!knownTrace) {
          if (!pendingTraceRefresh.current.has(event.traceId)) {
            pendingTraceRefresh.current.add(event.traceId);
            void listTraces()
              .then((nextRuns) => {
                runsRef.current = nextRuns;
                setRuns(nextRuns);
                if (
                  selectedTraceIdRef.current === undefined &&
                  nextRuns.some(({ traceId }) => traceId === event.traceId)
                ) {
                  void selectTrace(event.traceId);
                }
              })
              .catch(() =>
                setError("新しい実runを一覧へ反映できませんでした。"),
              )
              .finally(() => pendingTraceRefresh.current.delete(event.traceId));
          }
          return;
        }
        if (!pausedSelectedLive) {
          setRuns((current) => {
            const nextRuns = updateRunList(current, event);
            runsRef.current = nextRuns;
            return nextRuns;
          });
        }
        if (selected) {
          if (modeRef.current === "live" && livePausedRef.current) {
            // While paused the bounded buffer is the only in-memory hold for
            // new events. Resume either flushes it or rehydrates persisted
            // events after an overflow.
            enqueueLiveEvent(event);
          } else {
            setEvents((current) =>
              current.some(({ eventId }) => eventId === event.eventId)
                ? current
                : [...current, event],
            );
            if (modeRef.current === "live") dispatch({ type: "apply", event });
          }
        }
      },
      onState: (nextState, message) => {
        setStreamState(
          nextState === "connected" && liveBufferOverflowRef.current
            ? "degraded"
            : nextState,
        );
        setStreamMessage(message);
      },
      onIntegrity: (integrity) => {
        setStreamIntegrity(integrity);
        if (
          integrity.gaps.length > 0 ||
          integrity.duplicateEventIds > 0 ||
          integrity.duplicateStreamIds > 0 ||
          integrity.outOfOrderStreamIds > 0
        ) {
          setStreamState("degraded");
          setStreamMessage(
            "SSEの連続性に問題があります。保存済みeventsで欠落を確認してください。",
          );
        }
      },
    });
    return () => {
      client.disconnect();
      stream.current = undefined;
    };
  }, [enqueueLiveEvent, selectTrace]);

  const state = useMemo(
    () =>
      mode === "replay" && detail !== undefined
        ? reduceReplay(detail, events, replayCursor ?? events.length - 1)
        : baseState,
    [baseState, detail, events, mode, replayCursor],
  );

  const setReplayIndex = useCallback((index: number): void => {
    setReplayCursor(index);
    dispatch({ type: "replay-index", index });
  }, []);

  return {
    healthState,
    botHealth,
    streamState,
    streamMessage,
    streamIntegrity,
    runs,
    selectedTraceId,
    detail,
    events,
    state,
    mode,
    error,
    loading,
    refresh,
    selectTrace,
    setMode: changeMode,
    livePaused,
    liveBufferedCount,
    liveBufferOverflow,
    setLivePaused,
    setReplayIndex,
    dispatch,
  };
}

function parseHealth(value: unknown): {
  readonly observabilityState: DashboardData["healthState"];
  readonly bot: DashboardBotHealth;
} {
  if (!isRecord(value)) return { observabilityState: "unknown", bot: {} };
  const observability = isRecord(value.observability)
    ? value.observability
    : value;
  const state =
    typeof observability.state === "string" ? observability.state : undefined;
  const bot = isRecord(value.bot) ? value.bot : undefined;
  return {
    observabilityState:
      state === "ok"
        ? "healthy"
        : state === "degraded"
          ? "degraded"
          : "unknown",
    bot: {
      ...(readString(bot?.botState) === undefined
        ? {}
        : { botState: readString(bot?.botState) }),
      ...(readString(bot?.connectionState) === undefined
        ? {}
        : { connectionState: readString(bot?.connectionState) }),
      ...(readString(bot?.aiState) === undefined
        ? {}
        : { aiState: readString(bot?.aiState) }),
      ...(readString(bot?.memoryState) === undefined
        ? {}
        : { memoryState: readString(bot?.memoryState) }),
      ...(readString(bot?.reflexState) === undefined
        ? {}
        : { reflexState: readString(bot?.reflexState) }),
      ...(readString(bot?.taskStatus) === undefined
        ? {}
        : { taskStatus: readString(bot?.taskStatus) }),
      ...(readString(bot?.taskPhase) === undefined
        ? {}
        : { taskPhase: readString(bot?.taskPhase) }),
      ...(readHealthValue(bot?.health) === undefined
        ? {}
        : { health: readHealthValue(bot?.health) }),
      ...(readHealthValue(bot?.food) === undefined
        ? {}
        : { food: readHealthValue(bot?.food) }),
      ...(readString(bot?.positionState) === undefined
        ? {}
        : { positionState: readString(bot?.positionState) }),
    },
  };
}

function readString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0
    ? value
    : undefined;
}

function readHealthValue(value: unknown): number | string | undefined {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  return readString(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function updateRunList(
  runs: readonly CognitiveTraceRun[],
  event: CognitiveTraceEvent,
): readonly CognitiveTraceRun[] {
  const index = runs.findIndex(({ traceId }) => traceId === event.traceId);
  if (index < 0) return runs;
  return runs.map((run, runIndex) =>
    runIndex !== index
      ? run
      : {
          ...run,
          lastSequence: Math.max(run.lastSequence, event.sequence),
          // SSE reconnect/backfill may repeat a persisted sequence. The
          // sequence itself is the trace-local event count contract, so a
          // duplicate must not increment the run twice.
          eventCount: Math.max(run.eventCount, event.sequence),
          ...(event.span?.spanId === run.rootSpanId
            ? { status: event.span.status }
            : {}),
          ...(event.type === "trace.completed" &&
          event.span?.spanId === run.rootSpanId
            ? { endedAt: event.timestamp }
            : {}),
        },
  );
}
