import { readFileSync } from "node:fs";

import Database from "better-sqlite3";

import { summarizeRuntimeReassessments } from "../src/observability/runtime-reassessment-summary.js";

function main(): void {
  const [logPath, databasePath, since] = process.argv.slice(2);
  if (logPath === undefined || databasePath === undefined || since === undefined) {
    throw new Error("USAGE");
  }
  const sinceMs = Date.parse(since);
  if (!Number.isFinite(sinceMs)) throw new Error("INVALID_TIME");
  const logLines = readFileSync(logPath, "utf8").split("\n");
  const database = new Database(databasePath, { readonly: true, fileMustExist: true });
  try {
    const traces = database
      .prepare<
        [string],
        {
          event: unknown;
          cause: unknown;
          apiCalls: number;
          speeches: number;
        }
      >(
        `SELECT json_extract(root.span_json, '$.attributes.runtimeEvent') AS event,
                json_extract(root.span_json, '$.attributes.runtimeCauseKey') AS cause,
                SUM(CASE WHEN span.stage = 'deliberation' AND json_extract(span.span_json, '$.name') = 'LLM判断を実行' THEN 1 ELSE 0 END) AS apiCalls,
                SUM(CASE WHEN span.stage = 'response' AND json_extract(span.span_json, '$.name') = '利用者向け応答' AND span.status = 'succeeded' THEN 1 ELSE 0 END) AS speeches
         FROM trace_runs AS run
         JOIN trace_spans AS root ON root.trace_id = run.trace_id AND root.span_id = run.root_span_id
         JOIN trace_spans AS span ON span.trace_id = run.trace_id
         WHERE run.started_at >= ?
           AND json_extract(root.span_json, '$.attributes.requestKind') = 'runtime_reassessment'
         GROUP BY run.trace_id`,
      )
      .all(new Date(sinceMs).toISOString());
    process.stdout.write(
      `${JSON.stringify(summarizeRuntimeReassessments(logLines, traces, sinceMs))}\n`,
    );
  } finally {
    database.close();
  }
}

try {
  main();
} catch {
  process.stderr.write("再評価集計に失敗しました。入力ファイルと日時を確認してください。\n");
  process.exitCode = 1;
}
