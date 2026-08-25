import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import pino from "pino";
import { afterEach, describe, expect, it } from "vitest";

import { DashboardHttpServer } from "../../src/dashboard/http-server.js";
import { TraceService } from "../../src/trace/service.js";
import { TraceStore } from "../../src/trace/store.js";

const cleanup: (() => void)[] = [];

afterEach(async () => {
  for (const dispose of cleanup.splice(0).reverse()) dispose();
});

describe("DashboardHttpServer", () => {
  it("serves persisted traces and resumes SSE after Last-Event-ID", async () => {
    const staticDirectory = mkdtempSync(join(tmpdir(), "trace-dashboard-"));
    writeFileSync(
      join(staticDirectory, "index.html"),
      "<!doctype html><title>dashboard</title>",
    );
    cleanup.push(() =>
      rmSync(staticDirectory, { recursive: true, force: true }),
    );
    const store = TraceStore.open(":memory:");
    cleanup.push(() => store.close());
    const service = new TraceService(store, pino({ level: "silent" }));
    const session = await service.startTrace("利用者依頼");
    await session.complete("succeeded", { summary: "応答完了" });
    const events = store.listEvents(session.traceId);
    const server = new DashboardHttpServer(
      service,
      {
        enabled: true,
        host: "127.0.0.1",
        port: 0,
        staticDirectory,
        maxAgeDays: 30,
        maxTraces: 500,
      },
      pino({ level: "silent" }),
    );
    await server.start();
    cleanup.push(() => void server.stop());
    const address = server.address;
    if (address === undefined) throw new Error("dashboard server did not bind");

    const listResponse = await fetch(`${address}/api/traces`);
    expect(listResponse.status).toBe(200);
    await expect(listResponse.json()).resolves.toMatchObject({
      traces: [{ traceId: session.traceId, status: "succeeded" }],
    });
    const spanResponse = await fetch(
      `${address}/api/spans/${session.rootSpanId}`,
    );
    expect(spanResponse.status).toBe(200);
    await expect(spanResponse.json()).resolves.toMatchObject({
      traceId: session.traceId,
      span: { spanId: session.rootSpanId, status: "succeeded" },
    });
    const invalidImport = await fetch(`${address}/api/traces/import`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
    });
    expect(invalidImport.status).toBe(400);

    const previous = events.at(-2)?.streamId;
    if (previous === undefined)
      throw new Error("SSE resume fixture is incomplete");
    const controller = new AbortController();
    const streamResponse = await fetch(`${address}/api/stream`, {
      headers: { "Last-Event-ID": String(previous) },
      signal: controller.signal,
    });
    expect(streamResponse.status).toBe(200);
    const reader = streamResponse.body?.getReader();
    if (reader === undefined)
      throw new Error("SSE response body is unavailable");
    const decoder = new TextDecoder();
    let output = "";
    while (!output.includes("trace.completed")) {
      const next = await reader.read();
      if (next.done) break;
      output += decoder.decode(next.value, { stream: true });
    }
    controller.abort();
    const finalStreamId = events.at(-1)?.streamId;
    if (finalStreamId === undefined)
      throw new Error("SSE completion fixture is incomplete");
    expect(output).toContain(`id: ${String(finalStreamId)}`);
    expect(output).toContain("trace.completed");
    await server.stop();
  });

  it("refuses a non-loopback bind without a strong token", () => {
    const store = TraceStore.open(":memory:");
    cleanup.push(() => store.close());
    const service = new TraceService(store, pino({ level: "silent" }));
    expect(
      () =>
        new DashboardHttpServer(
          service,
          {
            enabled: true,
            host: "0.0.0.0",
            port: 4_310,
            staticDirectory: "dashboard/dist",
            maxAgeDays: 30,
            maxTraces: 500,
          },
          pino({ level: "silent" }),
        ),
    ).toThrow("DASHBOARD_NON_LOOPBACK_AUTH_REQUIRED");
  });

  it("accepts browser-compatible Basic authentication without exposing the token", async () => {
    const staticDirectory = mkdtempSync(
      join(tmpdir(), "trace-dashboard-auth-"),
    );
    writeFileSync(
      join(staticDirectory, "index.html"),
      "<!doctype html><title>dashboard</title>",
    );
    cleanup.push(() =>
      rmSync(staticDirectory, { recursive: true, force: true }),
    );
    const store = TraceStore.open(":memory:");
    cleanup.push(() => store.close());
    const service = new TraceService(store, pino({ level: "silent" }));
    const token = "test-only-dashboard-token-32-characters";
    const server = new DashboardHttpServer(
      service,
      {
        enabled: true,
        host: "127.0.0.1",
        port: 0,
        authToken: token,
        staticDirectory,
        maxAgeDays: 30,
        maxTraces: 500,
      },
      pino({ level: "silent" }),
    );
    await server.start();
    const address = server.address;
    if (address === undefined) throw new Error("dashboard server did not bind");
    expect((await fetch(`${address}/api/dashboard/health`)).status).toBe(401);
    const authorization = Buffer.from(`observer:${token}`).toString("base64");
    const authorized = await fetch(`${address}/api/dashboard/health`, {
      headers: { authorization: `Basic ${authorization}` },
    });
    expect(authorized.status).toBe(200);
    expect(await authorized.text()).not.toContain(token);
    await server.stop();
  });

  it("closes active SSE responses during graceful shutdown", async () => {
    const staticDirectory = mkdtempSync(
      join(tmpdir(), "trace-dashboard-stop-"),
    );
    writeFileSync(
      join(staticDirectory, "index.html"),
      "<!doctype html><title>dashboard</title>",
    );
    cleanup.push(() =>
      rmSync(staticDirectory, { recursive: true, force: true }),
    );
    const store = TraceStore.open(":memory:");
    cleanup.push(() => store.close());
    const service = new TraceService(store, pino({ level: "silent" }));
    const server = new DashboardHttpServer(
      service,
      {
        enabled: true,
        host: "127.0.0.1",
        port: 0,
        staticDirectory,
        maxAgeDays: 30,
        maxTraces: 500,
      },
      pino({ level: "silent" }),
    );
    await server.start();
    const address = server.address;
    if (address === undefined) throw new Error("dashboard server did not bind");
    const response = await fetch(`${address}/api/stream`);
    expect(response.status).toBe(200);
    const reader = response.body?.getReader();
    if (reader === undefined)
      throw new Error("SSE response body is unavailable");

    await expect(server.stop()).resolves.toBeUndefined();
    let done = false;
    while (!done) {
      const next = await reader.read();
      done = next.done;
    }
    expect(done).toBe(true);
  });
});
