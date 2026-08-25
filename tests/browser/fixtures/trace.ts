import type {
  CognitiveTraceBundle,
  CognitiveTraceDetail,
  CognitiveTraceEvent,
  CognitiveTraceRun,
  CognitiveTraceSpan,
} from "../../../src/trace/contracts";

const traceId = "11111111-1111-4111-8111-111111111111";
const requestSpanId = "22222222-2222-4222-8222-222222222222";
const deliberationSpanId = "33333333-3333-4333-8333-333333333333";
const toolSpanId = "44444444-4444-4444-8444-444444444444";
const verifySpanId = "55555555-5555-4555-8555-555555555555";
const rootTime = "2026-08-25T00:00:00.000Z";

const base = {
  schemaVersion: 1,
  traceId,
  sensitivity: "public" as const,
};

export const run: CognitiveTraceRun = {
  ...base,
  rootSpanId: requestSpanId,
  status: "succeeded",
  requestSummary: "資源収集の処理を確認",
  startedAt: rootTime,
  endedAt: "2026-08-25T00:00:04.000Z",
  lastSequence: 5,
  eventCount: 5,
  demoSafe: true,
  source: "recorded",
};

export const spans: readonly CognitiveTraceSpan[] = [
  {
    ...base,
    spanId: requestSpanId,
    sequence: 1,
    stage: "request",
    name: "owner request",
    status: "succeeded",
    startedAt: rootTime,
    endedAt: "2026-08-25T00:00:00.200Z",
    summary: "依頼を受け付けました",
  },
  {
    ...base,
    spanId: deliberationSpanId,
    parentSpanId: requestSpanId,
    sequence: 2,
    stage: "deliberation",
    name: "structured deliberation",
    status: "succeeded",
    startedAt: "2026-08-25T00:00:00.300Z",
    endedAt: "2026-08-25T00:00:00.800Z",
    summary: "観測結果から次の処理を決定",
    decisionSummary: "登録済みtoolを選択",
    expectedResult: "対象資源を確認する",
  },
  {
    ...base,
    spanId: toolSpanId,
    parentSpanId: deliberationSpanId,
    sequence: 3,
    stage: "tool",
    name: "observe_status",
    status: "succeeded",
    startedAt: "2026-08-25T00:00:01.000Z",
    endedAt: "2026-08-25T00:00:01.300Z",
    summary: "現在状態を取得",
    actualResult: "構造化観測を受信",
    outputRefs: ["66666666-6666-4666-8666-666666666666"],
  },
  {
    ...base,
    spanId: verifySpanId,
    parentSpanId: toolSpanId,
    sequence: 4,
    stage: "verification",
    name: "state verification",
    status: "succeeded",
    startedAt: "2026-08-25T00:00:02.000Z",
    endedAt: "2026-08-25T00:00:02.500Z",
    summary: "観測された結果を確認",
    verificationResult: "観測値と期待結果が一致",
  },
];

export const events: readonly CognitiveTraceEvent[] = [
  {
    ...base,
    eventId: "77777777-7777-4777-8777-777777777777",
    streamId: 1,
    spanId: requestSpanId,
    sequence: 1,
    timestamp: rootTime,
    type: "span.succeeded",
    span: spans[0],
  },
  {
    ...base,
    eventId: "88888888-8888-4888-8888-888888888888",
    streamId: 2,
    spanId: deliberationSpanId,
    sequence: 2,
    timestamp: "2026-08-25T00:00:00.800Z",
    type: "span.succeeded",
    span: spans[1],
  },
  {
    ...base,
    eventId: "99999999-9999-4999-8999-999999999999",
    streamId: 3,
    spanId: toolSpanId,
    sequence: 3,
    timestamp: "2026-08-25T00:00:01.300Z",
    type: "span.succeeded",
    span: spans[2],
  },
  {
    ...base,
    eventId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
    streamId: 4,
    spanId: verifySpanId,
    sequence: 4,
    timestamp: "2026-08-25T00:00:02.500Z",
    type: "span.succeeded",
    span: spans[3],
  },
  {
    ...base,
    eventId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
    streamId: 5,
    spanId: requestSpanId,
    sequence: 5,
    timestamp: "2026-08-25T00:00:04.000Z",
    type: "trace.completed",
    span: spans[0],
    summary: "トレースが完了しました",
  },
];

export const detail: CognitiveTraceDetail = {
  run,
  spans,
  links: [
    {
      type: "parent",
      sourceSpanId: requestSpanId,
      targetSpanId: deliberationSpanId,
    },
    {
      type: "parent",
      sourceSpanId: deliberationSpanId,
      targetSpanId: toolSpanId,
    },
    { type: "verifies", sourceSpanId: toolSpanId, targetSpanId: verifySpanId },
  ],
  results: [
    {
      resultId: "66666666-6666-4666-8666-666666666666",
      spanId: toolSpanId,
      kind: "tool_result",
      summary: "構造化された観測結果",
      verificationSummary: "検証ノードで確認済み",
      sensitivity: "public",
    },
  ],
};

export const traces: readonly CognitiveTraceRun[] = [run];

export const bundle: CognitiveTraceBundle = {
  schemaVersion: 1,
  kind: "recorded-real-trace",
  exportedAt: "2026-08-25T00:00:00.000Z",
  trace: { ...run, demoSafe: true },
  events,
  redaction: {
    schemaVersion: 1,
    generatedAt: "2026-08-25T00:00:00.000Z",
    policy: "presenter-v1",
    removedFields: [],
  },
};
