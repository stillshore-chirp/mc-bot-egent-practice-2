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
  readonly hydrationIssue?: string;
  readonly error?: string;
  readonly loading: boolean;
  readonly refresh: () => Promise<void>;
  readonly selectTrace: (traceId: string) => Promise<void>;
  readonly setMode: (mode: DashboardMode) => void;
  readonly setLivePaused: (paused: boolean) => void;
  readonly setReplayIndex: (index: number) => void;
  readonly dispatch: Dispatch<Parameters<typeof traceReducer>[1]>;
}

interface ActiveTraceHydration {
  readonly generation: number;
  readonly traceId: string;
  events: CognitiveTraceEvent[];
  overflowed: boolean;
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
  const [hydrationIssue, setHydrationIssue] = useState<string>();
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
  const hydrationGenerationRef = useRef(0);
  const activeHydrationRef = useRef<ActiveTraceHydration | undefined>(
    undefined,
  );
  const modeRef = useRef(mode);
  // A late detail response must not overwrite a mode the operator selected.
  const modeChangeVersionRef = useRef(0);
  const livePausedRef = useRef(false);
  const liveBufferRef = useRef<CognitiveTraceEvent[]>([]);
  const liveBufferOverflowRef = useRef(false);
  const hydrationIssueRef = useRef<string | undefined>(undefined);
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

  const recordHydrationIssue = useCallback((message?: string): void => {
    hydrationIssueRef.current = message;
    setHydrationIssue(message);
    if (message !== undefined) {
      setStreamState("degraded");
      setStreamMessage(message);
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

  const beginTraceHydration = useCallback((traceId: string): number => {
    const generation = hydrationGenerationRef.current + 1;
    hydrationGenerationRef.current = generation;
    activeHydrationRef.current = {
      generation,
      traceId,
      events: [],
      overflowed: false,
    };
    return generation;
  }, []);

  const isCurrentHydration = useCallback(
    (traceId: string, generation: number): boolean => {
      const active = activeHydrationRef.current;
      return active?.traceId === traceId && active.generation === generation;
    },
    [],
  );

  const enqueueHydrationEvent = useCallback(
    (event: CognitiveTraceEvent): boolean => {
      const active = activeHydrationRef.current;
      if (active?.traceId !== event.traceId) return false;
      if (active.events.some(({ eventId }) => eventId === event.eventId)) {
        return true;
      }
      if (active.events.length >= LIVE_EVENT_BUFFER_LIMIT) {
        if (!active.overflowed) {
          active.overflowed = true;
          setStreamState("degraded");
          setStreamMessage(
            `Trace読込中のeventが上限(${LIVE_EVENT_BUFFER_LIMIT}件)を超えました。保存済みeventsとの連続性を確認してください。`,
          );
        }
        return true;
      }
      active.events = [...active.events, event];
      return true;
    },
    [],
  );

  const loadTrace = useCallback(
    async (
      traceId: string,
      generation: number,
      requestedMode?: DashboardMode,
    ): Promise<readonly CognitiveTraceEvent[] | undefined> => {
      const modeVersion = modeChangeVersionRef.current;
      const [nextDetail, nextEvents] = await Promise.all([
        getTrace(traceId),
        getTraceEvents(traceId),
      ]);
      const hydration = activeHydrationRef.current;
      if (
        hydration?.traceId !== traceId ||
        hydration.generation !== generation
      ) {
        return undefined;
      }
      const merged = mergeHydratedEvents(nextEvents, hydration.events);
      const nextHydrationIssue = hydration.overflowed
        ? `Trace hydration overflow: ${LIVE_EVENT_BUFFER_LIMIT}件を保持しました。保存済みeventsを再取得してください。`
        : merged.sequenceConflicts > 0
          ? `Trace hydration integrity: ${String(merged.sequenceConflicts)}件のsequence競合を除外しました。保存済みeventsを確認してください。`
          : undefined;
      recordHydrationIssue(nextHydrationIssue);
      const mergedEvents = merged.events;
      selectedTraceIdRef.current = traceId;
      setSelectedTraceId(traceId);
      setDetail(nextDetail);
      setEvents(mergedEvents);
      setReplayCursor(undefined);
      dispatch({ type: "reset", detail: nextDetail });
      dispatch({ type: "apply-many", events: mergedEvents });
      if (modeChangeVersionRef.current === modeVersion) {
        const nextMode =
          requestedMode ??
          (nextDetail.run.source === "recorded" ? "replay" : "live");
        modeRef.current = nextMode;
        setMode(nextMode);
      }
      return mergedEvents;
    },
    [recordHydrationIssue],
  );

  const reconcileRuns = useCallback(
    (nextRuns: readonly CognitiveTraceRun[]): void => {
      runsRef.current = nextRuns;
      setRuns(nextRuns);
      const activeHydration = activeHydrationRef.current;
      if (
        activeHydration !== undefined &&
        !nextRuns.some(({ traceId }) => traceId === activeHydration.traceId)
      ) {
        hydrationGenerationRef.current += 1;
        activeHydrationRef.current = undefined;
        setLoading(false);
      }
      const currentSelectedTraceId = selectedTraceIdRef.current;
      if (
        currentSelectedTraceId !== undefined &&
        !nextRuns.some(({ traceId }) => traceId === currentSelectedTraceId)
      ) {
        selectedTraceIdRef.current = undefined;
        setSelectedTraceId(undefined);
        setDetail(undefined);
        setEvents([]);
        dispatch({ type: "reset" });
        livePausedRef.current = false;
        setLivePausedState(false);
        clearLiveBuffer();
      }
    },
    [clearLiveBuffer],
  );

  const refresh = useCallback(async (): Promise<void> => {
    const controller = new AbortController();
    setError(undefined);
    try {
      const [nextRuns, health] = await Promise.all([
        listTraces(controller.signal),
        getHealth(controller.signal),
      ]);
      reconcileRuns(nextRuns);
      const parsedHealth = parseHealth(health);
      setHealthState(parsedHealth.observabilityState);
      setBotHealth(parsedHealth.bot);
    } catch {
      setHealthState("offline");
      setBotHealth({});
      setError(
        "ダッシュボードAPIへ接続できません。ボットの観測状態を確認してください。",
      );
    } finally {
      if (activeHydrationRef.current === undefined) setLoading(false);
    }
    controller.abort();
  }, [reconcileRuns]);

  const selectTrace = useCallback(
    async (traceId: string): Promise<void> => {
      const generation = beginTraceHydration(traceId);
      livePausedRef.current = false;
      setLivePausedState(false);
      clearLiveBuffer();
      setLoading(true);
      setError(undefined);
      try {
        await loadTrace(traceId, generation);
      } catch {
        if (isCurrentHydration(traceId, generation)) {
          setError(
            "トレースを読み込めませんでした。保存済みデータを確認してください。",
          );
        }
      } finally {
        if (isCurrentHydration(traceId, generation)) {
          activeHydrationRef.current = undefined;
          setLoading(false);
        }
      }
    },
    [beginTraceHydration, clearLiveBuffer, isCurrentHydration, loadTrace],
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
      const generation = beginTraceHydration(traceId);
      try {
        const persistedEvents = await loadTrace(traceId, generation, "live");
        if (persistedEvents === undefined) return;
        const merged = mergeHydratedEvents(
          persistedEvents,
          liveBufferRef.current,
        );
        const afterReload = merged.additions;
        if (merged.sequenceConflicts > 0) {
          recordHydrationIssue(
            `Trace hydration integrity: ${String(merged.sequenceConflicts)}件のsequence競合を除外しました。保存済みeventsを確認してください。`,
          );
        }
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
        if (isCurrentHydration(traceId, generation)) {
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
        }
      } finally {
        if (isCurrentHydration(traceId, generation)) {
          activeHydrationRef.current = undefined;
          setLoading(false);
        }
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
  }, [
    beginTraceHydration,
    clearLiveBuffer,
    isCurrentHydration,
    loadTrace,
    recordHydrationIssue,
  ]);

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
      modeChangeVersionRef.current += 1;
      modeRef.current = nextMode;
      if (nextMode === "live" && livePausedRef.current) void resumeLive();
      setMode(nextMode);
    },
    [resumeLive],
  );

  useEffect(() => {
    void refresh();
  }, [refresh]);

  useEffect(() => {
    if (
      selectedTraceId !== undefined ||
      activeHydrationRef.current !== undefined ||
      runs[0] === undefined
    )
      return;
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
        const hydrating = activeHydrationRef.current?.traceId === event.traceId;
        const selected =
          event.traceId === selectedTraceIdRef.current || hydrating;
        const pausedSelectedLive =
          selected && modeRef.current === "live" && livePausedRef.current;
        const bufferedByHydration =
          hydrating && !pausedSelectedLive
            ? enqueueHydrationEvent(event)
            : false;
        const knownTrace = runsRef.current.some(
          ({ traceId }) => traceId === event.traceId,
        );
        if (!knownTrace) {
          if (!pendingTraceRefresh.current.has(event.traceId)) {
            pendingTraceRefresh.current.add(event.traceId);
            void listTraces()
              .then((nextRuns) => {
                reconcileRuns(nextRuns);
                if (
                  selectedTraceIdRef.current === undefined &&
                  activeHydrationRef.current === undefined &&
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
        if (bufferedByHydration) return;
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
        const persistentHydrationIssue = hydrationIssueRef.current;
        const remainsDegraded =
          nextState === "connected" &&
          (liveBufferOverflowRef.current ||
            persistentHydrationIssue !== undefined);
        setStreamState(remainsDegraded ? "degraded" : nextState);
        setStreamMessage(
          remainsDegraded && persistentHydrationIssue !== undefined
            ? persistentHydrationIssue
            : message,
        );
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
  }, [enqueueHydrationEvent, enqueueLiveEvent, reconcileRuns, selectTrace]);

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
    hydrationIssue,
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

function mergeHydratedEvents(
  persisted: readonly CognitiveTraceEvent[],
  live: readonly CognitiveTraceEvent[],
): {
  readonly events: readonly CognitiveTraceEvent[];
  readonly additions: readonly CognitiveTraceEvent[];
  readonly sequenceConflicts: number;
} {
  const eventIds = new Set(persisted.map(({ eventId }) => eventId));
  const sequences = new Map(
    persisted.map(({ sequence, eventId }) => [sequence, eventId] as const),
  );
  const additions: CognitiveTraceEvent[] = [];
  let sequenceConflicts = 0;

  for (const event of live) {
    if (eventIds.has(event.eventId)) continue;
    const existingEventId = sequences.get(event.sequence);
    if (existingEventId !== undefined && existingEventId !== event.eventId) {
      sequenceConflicts += 1;
      continue;
    }
    eventIds.add(event.eventId);
    sequences.set(event.sequence, event.eventId);
    additions.push(event);
  }

  additions.sort((left, right) => left.sequence - right.sequence);
  return {
    events: [...persisted, ...additions].sort(
      (left, right) => left.sequence - right.sequence,
    ),
    additions,
    sequenceConflicts,
  };
}
