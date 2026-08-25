import type {
  CognitiveTraceDetail,
  CognitiveTraceEvent,
  CognitiveTraceLink,
  CognitiveTraceResult,
  CognitiveTraceRun,
  CognitiveTraceSpan,
  TraceStatus,
} from "@trace";

export type TraceStreamState =
  | "idle"
  | "connecting"
  | "connected"
  | "reconnecting"
  | "disconnected"
  | "degraded";

export interface SequenceGap {
  readonly from: number;
  readonly to: number;
}

export interface TraceState {
  readonly run?: CognitiveTraceRun;
  readonly spans: readonly CognitiveTraceSpan[];
  readonly links: readonly CognitiveTraceLink[];
  readonly results: readonly CognitiveTraceResult[];
  readonly events: readonly CognitiveTraceEvent[];
  readonly progressBySpanId: Readonly<Record<string, number>>;
  readonly lastSequence: number;
  readonly duplicateEvents: number;
  readonly outOfOrderEvents: number;
  readonly gaps: readonly SequenceGap[];
  readonly selectedSpanId?: string;
  readonly replayIndex: number;
  readonly streamState: TraceStreamState;
  readonly streamMessage?: string;
}

export type TraceAction =
  | { readonly type: "reset"; readonly detail?: CognitiveTraceDetail }
  | { readonly type: "apply"; readonly event: CognitiveTraceEvent }
  | {
      readonly type: "apply-many";
      readonly events: readonly CognitiveTraceEvent[];
    }
  | { readonly type: "select"; readonly spanId?: string }
  | { readonly type: "replay-index"; readonly index: number }
  | {
      readonly type: "stream";
      readonly state: TraceStreamState;
      readonly message?: string;
    };

export const emptyTraceState: TraceState = {
  spans: [],
  links: [],
  results: [],
  events: [],
  progressBySpanId: {},
  lastSequence: 0,
  duplicateEvents: 0,
  outOfOrderEvents: 0,
  gaps: [],
  replayIndex: -1,
  streamState: "idle",
};

export function initialTraceState(detail?: CognitiveTraceDetail): TraceState {
  if (detail === undefined) return emptyTraceState;
  return {
    ...emptyTraceState,
    // Keep only stable run metadata.  Terminal status, counters and endedAt
    // belong to the event stream so replay index -1 cannot expose the future.
    run: {
      ...detail.run,
      status: "queued",
      endedAt: undefined,
      lastSequence: 0,
      eventCount: 0,
    },
    // The detail snapshot is a persisted supplement. Event application starts
    // from sequence zero so replay and live updates use the same integrity path.
    lastSequence: 0,
    replayIndex: -1,
  };
}

export function traceReducer(
  state: TraceState,
  action: TraceAction,
): TraceState {
  switch (action.type) {
    case "reset":
      return initialTraceState(action.detail);
    case "apply":
      return applyEvent(state, action.event);
    case "apply-many":
      return action.events.reduce(applyEvent, state);
    case "select":
      return { ...state, selectedSpanId: action.spanId };
    case "replay-index":
      return { ...state, replayIndex: action.index };
    case "stream":
      return {
        ...state,
        streamState: action.state,
        ...(action.message === undefined
          ? { streamMessage: undefined }
          : { streamMessage: action.message }),
      };
  }
}

export function reduceReplay(
  detail: CognitiveTraceDetail,
  events: readonly CognitiveTraceEvent[],
  index: number,
): TraceState {
  const boundedIndex = Math.min(Math.max(index, -1), events.length - 1);
  const state = initialTraceState(detail);
  if (boundedIndex < 0) {
    return { ...state, replayIndex: -1, streamState: "idle" };
  }
  return {
    ...events
      .slice(0, boundedIndex + 1)
      .reduce(applyEvent, { ...state, streamState: "idle" }),
    replayIndex: boundedIndex,
  };
}

function applyEvent(state: TraceState, event: CognitiveTraceEvent): TraceState {
  if (state.events.some(({ eventId }) => eventId === event.eventId)) {
    return { ...state, duplicateEvents: state.duplicateEvents + 1 };
  }

  const gap =
    event.sequence > state.lastSequence + 1
      ? { from: state.lastSequence + 1, to: event.sequence - 1 }
      : undefined;
  const outOfOrder = event.sequence <= state.lastSequence && gap === undefined;
  const spans =
    event.span === undefined
      ? updateSpanStatus(state.spans, event)
      : upsertById(state.spans, event.span, (span) => span.spanId);
  const links =
    event.link === undefined
      ? state.links
      : upsertByKey(state.links, event.link, linkKey);
  const results =
    event.result === undefined
      ? state.results
      : upsertByKey(state.results, event.result, ({ resultId }) => resultId);
  const progressBySpanId =
    event.progress === undefined
      ? state.progressBySpanId
      : {
          ...state.progressBySpanId,
          [event.spanId]: event.progress,
        };
  const run = updateRun(state.run, event, state.events.length + 1);

  return {
    ...state,
    run,
    spans,
    links,
    results,
    progressBySpanId,
    events: [...state.events, event],
    lastSequence: Math.max(state.lastSequence, event.sequence),
    gaps:
      gap === undefined
        ? resolveGap(state.gaps, event.sequence)
        : mergeGap(state.gaps, gap),
    outOfOrderEvents: state.outOfOrderEvents + (outOfOrder ? 1 : 0),
    replayIndex:
      state.replayIndex < 0 ? state.replayIndex : state.replayIndex + 1,
  };
}

function updateSpanStatus(
  spans: readonly CognitiveTraceSpan[],
  event: CognitiveTraceEvent,
): readonly CognitiveTraceSpan[] {
  const status = statusForEvent(event.type);
  if (status === undefined) return spans;
  return spans.map((span) =>
    span.spanId !== event.spanId
      ? span
      : {
          ...span,
          status,
          ...(status === "succeeded" ||
          status === "failed" ||
          status === "cancelled" ||
          status === "skipped"
            ? { endedAt: event.timestamp }
            : {}),
          ...(event.summary === undefined ? {} : { summary: event.summary }),
        },
  );
}

function statusForEvent(
  type: CognitiveTraceEvent["type"],
): TraceStatus | undefined {
  switch (type) {
    case "span.queued":
      return "queued";
    case "span.started":
      return "running";
    case "span.waiting":
      return "waiting";
    case "span.succeeded":
      return "succeeded";
    case "span.failed":
      return "failed";
    case "span.cancelled":
      return "cancelled";
    case "span.skipped":
      return "skipped";
    case "span.progress":
    case "result.created":
    case "link.created":
    case "trace.completed":
      return undefined;
  }
}

function updateRun(
  run: CognitiveTraceRun | undefined,
  event: CognitiveTraceEvent,
  eventCount: number,
): CognitiveTraceRun | undefined {
  if (run === undefined) return undefined;
  const completed = event.type === "trace.completed";
  const isRootSpanEvent = event.spanId === run.rootSpanId;
  const isRootCompletion =
    completed &&
    (event.spanId === run.rootSpanId || event.span?.spanId === run.rootSpanId);
  const status = isRootCompletion
    ? event.span?.status
    : isRootSpanEvent &&
        (event.type === "span.queued" ||
          event.type === "span.started" ||
          event.type === "span.waiting")
      ? statusForEvent(event.type)
      : undefined;
  return {
    ...run,
    ...(status === undefined ? {} : { status }),
    ...(isRootCompletion ? { endedAt: event.timestamp } : {}),
    lastSequence: Math.max(run.lastSequence, event.sequence),
    eventCount,
  };
}

function upsertById<T>(
  values: readonly T[],
  value: T,
  id: (item: T) => string,
): readonly T[] {
  const key = id(value);
  const index = values.findIndex((item) => id(item) === key);
  if (index < 0) return [...values, value];
  return values.map((item, itemIndex) => (itemIndex === index ? value : item));
}

function upsertByKey<T>(
  values: readonly T[],
  value: T,
  key: (item: T) => string,
): readonly T[] {
  return upsertById(values, value, key);
}

function linkKey(link: CognitiveTraceLink): string {
  return `${link.type}:${link.sourceSpanId}:${link.targetSpanId}`;
}

function mergeGap(
  gaps: readonly SequenceGap[],
  next: SequenceGap,
): readonly SequenceGap[] {
  const merged: SequenceGap[] = [];
  let candidate = next;
  for (const gap of [...gaps].sort((left, right) => left.from - right.from)) {
    if (gap.to + 1 < candidate.from || candidate.to + 1 < gap.from) {
      merged.push(gap);
      continue;
    }
    candidate = {
      from: Math.min(candidate.from, gap.from),
      to: Math.max(candidate.to, gap.to),
    };
  }
  merged.push(candidate);
  return merged.sort((left, right) => left.from - right.from);
}

function resolveGap(
  gaps: readonly SequenceGap[],
  sequence: number,
): readonly SequenceGap[] {
  return gaps.flatMap((gap) => {
    if (sequence < gap.from || sequence > gap.to) return [gap];
    if (gap.from === gap.to) return [];
    if (sequence === gap.from) return [{ from: gap.from + 1, to: gap.to }];
    if (sequence === gap.to) return [{ from: gap.from, to: gap.to - 1 }];
    return [
      { from: gap.from, to: sequence - 1 },
      { from: sequence + 1, to: gap.to },
    ];
  });
}
