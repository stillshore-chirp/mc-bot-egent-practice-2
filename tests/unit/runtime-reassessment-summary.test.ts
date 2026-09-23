import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";

import { summarizeRuntimeReassessments } from "../../src/observability/runtime-reassessment-summary.js";

describe("runtime reassessment summary", () => {
  it("counts a delivered fallback response from persisted trace spans", () => {
    const directory = mkdtempSync(join(tmpdir(), "mc20-summary-"));
    const databasePath = join(directory, "trace.sqlite");
    const logPath = join(directory, "log.jsonl");
    try {
      const database = new Database(databasePath);
      database.exec(`
        CREATE TABLE trace_runs (trace_id TEXT, root_span_id TEXT, started_at TEXT);
        CREATE TABLE trace_spans (trace_id TEXT, span_id TEXT, stage TEXT, status TEXT, span_json TEXT);
      `);
      database
        .prepare("INSERT INTO trace_runs VALUES (?, ?, ?)")
        .run("fake-run", "fake-root", "2026-09-23T01:00:00.000Z");
      const addSpan = database.prepare(
        "INSERT INTO trace_spans VALUES (?, ?, ?, ?, ?)",
      );
      addSpan.run(
        "fake-run",
        "fake-root",
        "request",
        "failed",
        JSON.stringify({
          name: "runtime再評価を受信",
          attributes: {
            requestKind: "runtime_reassessment",
            runtimeEvent: "safety_failed",
            runtimeCauseKey: "reflex:damage",
            privateMessage: "secret-chat-text",
          },
        }),
      );
      addSpan.run(
        "fake-run",
        "fake-api",
        "deliberation",
        "failed",
        JSON.stringify({ name: "LLM判断を実行" }),
      );
      addSpan.run(
        "fake-run",
        "fake-response",
        "response",
        "succeeded",
        JSON.stringify({ name: "エラー応答" }),
      );
      database.close();
      writeFileSync(
        logPath,
        `${JSON.stringify({
          time: Date.parse("2026-09-23T01:00:00.000Z"),
          code: "RUNTIME_REASSESSMENT_GATE_DECISION",
          event: "safety_failed",
          cause: "reflex:damage",
          outcome: "started",
          privateMessage: "secret-chat-text",
        })}\n`,
      );

      const output = execFileSync(
        process.execPath,
        [
          "--import",
          "tsx",
          join(process.cwd(), "scripts/summarize-runtime-reassessments.ts"),
          logPath,
          databasePath,
          "2026-09-23T00:00:00.000Z",
        ],
        { cwd: process.cwd(), encoding: "utf8" },
      );
      const result: unknown = JSON.parse(output);
      expect(result).toEqual([
        {
          event: "safety_failed",
          cause: "reflex:damage",
          accepted: 0,
          started: 1,
          completed: 0,
          failed: 0,
          cancelled: 0,
          suppressed: {},
          tracedRuns: 1,
          apiCalls: 1,
          speeches: 1,
        },
      ]);
      expect(output).not.toContain("secret-chat-text");
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("correlates gate decisions and trace counts without exposing raw values", () => {
    const at = Date.parse("2026-09-23T00:00:00.000Z");
    const log = (outcome: string, reason = "none", time = at) =>
      JSON.stringify({
        time,
        code: "RUNTIME_REASSESSMENT_GATE_DECISION",
        event: "safety_stabilized",
        cause: "reflex:hostile",
        outcome,
        reason,
        privateMessage: "secret-chat-text",
      });
    const result = summarizeRuntimeReassessments(
      [
        log("accepted"),
        log("started"),
        log("completed"),
        log("suppressed", "unchanged_state"),
        log("suppressed", "unchanged_state", at - 1),
        JSON.stringify({
          ...JSON.parse(log("suppressed")),
          cause: "secret-id",
        }),
      ],
      [
        {
          event: "safety_stabilized",
          cause: "reflex:hostile",
          apiCalls: 2,
          speeches: 1,
        },
        { event: "secret-event", cause: "secret-id", apiCalls: 1, speeches: 0 },
      ],
      at,
    );
    expect(result).toEqual([
      {
        event: "other",
        cause: "other",
        accepted: 0,
        started: 0,
        completed: 0,
        failed: 0,
        cancelled: 0,
        suppressed: {},
        tracedRuns: 1,
        apiCalls: 1,
        speeches: 0,
      },
      {
        event: "safety_stabilized",
        cause: "other",
        accepted: 0,
        started: 0,
        completed: 0,
        failed: 0,
        cancelled: 0,
        suppressed: { other: 1 },
        tracedRuns: 0,
        apiCalls: 0,
        speeches: 0,
      },
      {
        event: "safety_stabilized",
        cause: "reflex:hostile",
        accepted: 1,
        started: 1,
        completed: 1,
        failed: 0,
        cancelled: 0,
        suppressed: { unchanged_state: 1 },
        tracedRuns: 1,
        apiCalls: 2,
        speeches: 1,
      },
    ]);
    expect(JSON.stringify(result)).not.toContain("secret");
  });
});
