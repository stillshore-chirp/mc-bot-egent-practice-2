import { request as httpRequest } from "node:http";
import type { OutgoingHttpHeaders } from "node:http";
import { Script } from "node:vm";

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  DashboardHttpServer,
  type DashboardSnapshot,
} from "../../src/dashboard/http-server.js";

const secret = "synthetic-dashboard-token-0123456789abcdef";
const providerSecret = "synthetic-provider-error-body";

function fixture(): DashboardSnapshot {
  return {
    generatedAt: "2026-10-10T00:00:00.000Z",
    connectionState: "connected",
    runtime: {
      running: true,
      stopped: false,
      thinking: false,
      goal: {
        title: "拠点へ木材を届ける",
        successCondition: "丸太をチェストに入れ、結果を確認する",
      },
      currentOperation: null,
      nextWakeAt: "2026-10-10T00:01:00.000Z",
      lastOutcome: {
        status: "successful",
        operationKind: "collect_item",
        summary: "Body observed the requested world effect.",
        observedAt: "2026-10-10T00:00:00.000Z",
      },
      recentErrors: [
        { code: "request_failed", at: "2026-10-09T23:59:00.000Z" },
      ],
      usage: {
        requests: 3,
        usageResponses: 2,
        missingUsageRequests: 1,
        errors: 1,
        inputTokens: null,
        outputTokens: null,
        cachedInputTokens: null,
        lastErrorCode: "request_failed",
      },
    },
    plan: {
      purpose: "木材を集める",
      firstStep: {
        kind: "collect_item",
        expectedOutcome: "木材がインベントリに入る",
      },
    },
    activeOperation: null,
    memories: [
      {
        content: "<img src=x onerror=alert(1)>",
        source: "player_stated",
        updatedAt: "2026-10-09T20:00:00.000Z",
      },
    ],
  };
}

function makeServer(
  getSnapshot: (
    query: string,
  ) => DashboardSnapshot | Promise<DashboardSnapshot>,
): DashboardHttpServer {
  return new DashboardHttpServer({
    host: "127.0.0.1",
    port: 0,
    authToken: secret,
    getSnapshot,
  });
}

function boundPort(server: DashboardHttpServer): number {
  const address = server.address();
  if (address === null) throw new Error("Dashboard server did not bind.");
  return address.port;
}

async function rawRequest(
  port: number,
  path: string,
  method: string,
  headers: OutgoingHttpHeaders,
  body = "",
): Promise<Response> {
  return new Promise((resolve, reject) => {
    const request = httpRequest(
      {
        hostname: "127.0.0.1",
        port,
        path,
        method,
        headers,
      },
      (response) => {
        const chunks: Buffer[] = [];
        response.on("data", (chunk: Buffer) => chunks.push(chunk));
        response.on("end", () => {
          resolve(
            new Response(Buffer.concat(chunks), {
              status: response.statusCode ?? 0,
            }),
          );
        });
      },
    );
    request.on("error", reject);
    request.end(body);
  });
}

describe("DashboardHttpServer", () => {
  const servers: DashboardHttpServer[] = [];

  afterEach(async () => {
    await Promise.all(servers.splice(0).map((server) => server.close()));
  });

  it("serves a nonce-protected shell and protects all snapshot data with bearer auth", async () => {
    const publicSnapshot = fixture();
    const getSnapshot = vi.fn(
      () =>
        ({
          ...publicSnapshot,
          runtime: {
            ...publicSnapshot.runtime,
            relationshipSummary: "private relationship context",
          },
          memories: publicSnapshot.memories.map((memory) => ({
            ...memory,
            metadata: { credential: "private memory metadata" },
          })),
          privateConfig: { token: "private application configuration" },
        }) as DashboardSnapshot,
    );
    const server = makeServer(getSnapshot);
    servers.push(server);
    await server.start();
    const port = boundPort(server);

    const page = await fetch("http://127.0.0.1:" + String(port));
    const html = await page.text();
    const policy = page.headers.get("content-security-policy") ?? "";
    expect(page.status).toBe(200);
    expect(policy).toContain("script-src 'nonce-");
    expect(policy).not.toContain("unsafe-inline");
    expect(html).toContain("コンパニオン運用状況");
    expect(html).toContain('type="password"');
    expect(html).toContain(".innerText");
    expect(html).not.toContain(".innerHTML");
    expect(html).not.toContain(secret);
    const script = [
      ...html.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/gu),
    ][0]?.[1];
    expect(script).toBeDefined();
    expect(() => new Script(script ?? "")).not.toThrow();
    const referencedIds = [
      ...(script ?? "").matchAll(/byId\("([^"]+)"\)/gu),
    ].map((match) => match[1]);
    const declaredIds = new Set(
      [...html.matchAll(/\bid="([^"]+)"/gu)].map((match) => match[1]),
    );
    expect(referencedIds.every((id) => declaredIds.has(id))).toBe(true);

    const unauthorized = await fetch(
      "http://127.0.0.1:" + String(port) + "/api/snapshot",
    );
    expect(unauthorized.status).toBe(401);
    expect(await unauthorized.text()).not.toContain(secret);
    expect(getSnapshot).not.toHaveBeenCalled();

    const authorized = await fetch(
      "http://127.0.0.1:" + String(port) + "/api/snapshot",
      { headers: { Authorization: "Bearer " + secret } },
    );
    expect(authorized.status).toBe(200);
    const payload: unknown = await authorized.json();
    expect(payload).toMatchObject({
      runtime: { usage: { inputTokens: null, requests: 3 } },
      memories: [
        {
          content: "<img src=x onerror=alert(1)>",
          source: "player_stated",
          updatedAt: "2026-10-09T20:00:00.000Z",
        },
      ],
    });
    expect(authorized.headers.get("cache-control")).toBe("no-store");
    const serialized = JSON.stringify(payload);
    expect(serialized).not.toContain(secret);
    expect(serialized).not.toContain("private relationship context");
    expect(serialized).not.toContain("private memory metadata");
    expect(serialized).not.toContain("private application configuration");
  });

  it("passes a bounded search query and rejects unexpected or duplicate query fields", async () => {
    const getSnapshot = vi.fn((query: string) => {
      expect(query).toBe("木材");
      return fixture();
    });
    const server = makeServer(getSnapshot);
    servers.push(server);
    await server.start();
    const port = boundPort(server);
    const base = "http://127.0.0.1:" + String(port);
    const headers = { Authorization: "Bearer " + secret };

    expect(
      (await fetch(base + "/api/snapshot?q=%E6%9C%A8%E6%9D%90", { headers }))
        .status,
    ).toBe(200);
    expect(getSnapshot).toHaveBeenCalledTimes(1);
    expect(
      (await fetch(base + "/api/snapshot?q=a&q=b", { headers })).status,
    ).toBe(400);
    expect(
      (await fetch(base + "/api/snapshot?token=secret", { headers })).status,
    ).toBe(400);
    expect(
      (await fetch(base + "/api/snapshot?q=" + "x".repeat(2_001), { headers }))
        .status,
    ).toBe(400);
    expect(getSnapshot).toHaveBeenCalledTimes(1);
  });

  it("rejects unexpected Host and cross-origin browser requests before reading data", async () => {
    const getSnapshot = vi.fn(() => fixture());
    const server = makeServer(getSnapshot);
    servers.push(server);
    await server.start();
    const port = boundPort(server);
    const url = "http://127.0.0.1:" + String(port) + "/api/snapshot";
    const authorization = "Bearer " + secret;

    const wrongHost = await rawRequest(port, "/api/snapshot", "GET", {
      Authorization: authorization,
      Host: "rebind.invalid:" + String(port),
    });
    expect(wrongHost.status).toBe(421);
    const wrongOrigin = await fetch(url, {
      headers: {
        Authorization: authorization,
        Origin: "http://attacker.invalid",
        "Sec-Fetch-Site": "cross-site",
      },
    });
    expect(wrongOrigin.status).toBe(403);
    expect(getSnapshot).not.toHaveBeenCalled();
  });

  it("rejects request bodies and unsupported methods without invoking the snapshot provider", async () => {
    const getSnapshot = vi.fn(() => fixture());
    const server = makeServer(getSnapshot);
    servers.push(server);
    await server.start();
    const port = boundPort(server);
    const bodyResponse = await rawRequest(
      port,
      "/api/snapshot",
      "GET",
      {
        Host: "127.0.0.1:" + String(port),
        "Content-Length": "3",
        Connection: "close",
      },
      "abc",
    );
    expect(bodyResponse.status).toBe(400);
    expect(await bodyResponse.json()).toEqual({
      error: "request_body_not_allowed",
    });

    const postResponse = await fetch(
      "http://127.0.0.1:" + String(port) + "/api/snapshot",
      {
        method: "POST",
        headers: { Authorization: "Bearer " + secret },
        body: "ignored",
      },
    );
    expect(postResponse.status).toBe(405);
    expect(getSnapshot).not.toHaveBeenCalled();
  });

  it("returns a generic error when the read-only data provider fails", async () => {
    const server = makeServer(() => {
      throw new Error(providerSecret);
    });
    servers.push(server);
    await server.start();
    const response = await fetch(
      "http://127.0.0.1:" + String(boundPort(server)) + "/api/snapshot",
      { headers: { Authorization: "Bearer " + secret } },
    );
    expect(response.status).toBe(503);
    const body = await response.text();
    expect(body).toBe('{"error":"dashboard_snapshot_unavailable"}');
    expect(body).not.toContain(providerSecret);
  });

  it("rejects all non-loopback binds and weak configured tokens", () => {
    const getSnapshot = () => fixture();
    expect(
      () =>
        new DashboardHttpServer({
          host: "0.0.0.0",
          port: 4310,
          getSnapshot,
        }),
    ).toThrow("Dashboard server only supports loopback binding.");
    expect(
      () =>
        new DashboardHttpServer({
          host: "0.0.0.0",
          port: 4310,
          authToken: secret,
          getSnapshot,
        }),
    ).toThrow("Dashboard server only supports loopback binding.");
    expect(
      () =>
        new DashboardHttpServer({
          host: "0.0.0.0",
          port: 4310,
          authToken: "short",
          getSnapshot,
        }),
    ).toThrow("Dashboard authentication token is too short.");
    expect(
      () =>
        new DashboardHttpServer({
          host: "127.0.0.1",
          port: 4310,
          getSnapshot,
        }),
    ).not.toThrow();
  });

  it("pins the localhost hostname to numeric IPv4 loopback before binding", async () => {
    const server = new DashboardHttpServer({
      host: "localhost",
      port: 0,
      getSnapshot: () => fixture(),
    });
    servers.push(server);
    await server.start();
    expect(server.address()?.address).toBe("127.0.0.1");
  });

  it("allows an unauthenticated data request on loopback when no token is configured", async () => {
    const server = new DashboardHttpServer({
      host: "127.0.0.1",
      port: 0,
      getSnapshot: () => fixture(),
    });
    servers.push(server);
    await server.start();
    const response = await fetch(
      "http://127.0.0.1:" + String(boundPort(server)) + "/api/snapshot",
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      connectionState: "connected",
      runtime: { usage: { requests: 3 } },
    });
  });
});
