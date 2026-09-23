import { reflexKinds } from "../reflexes/detectors.js";

const events = new Set([
  "startup_reassessment",
  "safety_stabilized",
  "safety_failed",
  "connection_recovered",
]);
const causes = new Set([
  "startup",
  "connection",
  ...reflexKinds.map((kind) => `reflex:${kind}`),
]);
const outcomes = new Set([
  "accepted",
  "started",
  "completed",
  "failed",
  "cancelled",
  "suppressed",
]);
const suppressionReasons = new Set([
  "unchanged_state",
  "coalesced",
  "lower_priority",
  "superseded",
  "stale_state",
  "stale_generation",
  "owner_message",
  "stopped",
]);

export interface ReassessmentTraceCount {
  readonly event: unknown;
  readonly cause: unknown;
  readonly apiCalls: number;
  readonly speeches: number;
}

interface CauseSummary {
  event: string;
  cause: string;
  accepted: number;
  started: number;
  completed: number;
  failed: number;
  cancelled: number;
  suppressed: Record<string, number>;
  tracedRuns: number;
  apiCalls: number;
  speeches: number;
}

function safeCategory(value: unknown, allowed: ReadonlySet<string>): string {
  return typeof value === "string" && allowed.has(value) ? value : "other";
}

/** Only allowlisted categories and counts leave this module. */
export function summarizeRuntimeReassessments(
  logLines: Iterable<string>,
  traces: Iterable<ReassessmentTraceCount>,
  sinceMs: number,
): readonly CauseSummary[] {
  const byCause = new Map<string, CauseSummary>();
  const summaryFor = (event: unknown, cause: unknown): CauseSummary => {
    const safeEvent = safeCategory(event, events);
    const safeCause = safeCategory(cause, causes);
    const key = `${safeEvent}:${safeCause}`;
    let summary = byCause.get(key);
    if (summary === undefined) {
      summary = {
        event: safeEvent,
        cause: safeCause,
        accepted: 0,
        started: 0,
        completed: 0,
        failed: 0,
        cancelled: 0,
        suppressed: {},
        tracedRuns: 0,
        apiCalls: 0,
        speeches: 0,
      };
      byCause.set(key, summary);
    }
    return summary;
  };

  for (const line of logLines) {
    let record: Record<string, unknown>;
    try {
      const parsed: unknown = JSON.parse(line);
      if (
        parsed === null ||
        typeof parsed !== "object" ||
        Array.isArray(parsed)
      )
        continue;
      record = parsed as Record<string, unknown>;
    } catch {
      continue;
    }
    if (
      record.code !== "RUNTIME_REASSESSMENT_GATE_DECISION" ||
      typeof record.time !== "number" ||
      record.time < sinceMs
    ) {
      continue;
    }
    const outcome = safeCategory(record.outcome, outcomes);
    if (outcome === "other") continue;
    const summary = summaryFor(record.event, record.cause);
    if (outcome === "suppressed") {
      const reason = safeCategory(record.reason, suppressionReasons);
      summary.suppressed[reason] = (summary.suppressed[reason] ?? 0) + 1;
    } else {
      switch (outcome) {
        case "accepted":
          summary.accepted += 1;
          break;
        case "started":
          summary.started += 1;
          break;
        case "completed":
          summary.completed += 1;
          break;
        case "failed":
          summary.failed += 1;
          break;
        case "cancelled":
          summary.cancelled += 1;
          break;
      }
    }
  }

  for (const trace of traces) {
    const summary = summaryFor(trace.event, trace.cause);
    summary.tracedRuns += 1;
    summary.apiCalls += Math.max(0, trace.apiCalls);
    summary.speeches += Math.max(0, trace.speeches);
  }

  return [...byCause.values()].sort(
    (a, b) => a.event.localeCompare(b.event) || a.cause.localeCompare(b.cause),
  );
}
