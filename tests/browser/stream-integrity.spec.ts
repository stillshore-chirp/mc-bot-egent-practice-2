import { readFileSync } from "node:fs";
import { createServer, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { extname, resolve, sep } from "node:path";

import { expect, test } from "@playwright/test";

import { detail, events, traces } from "./fixtures/trace";

test("SSE global stream gap is announced without fabricating a trace", async ({
  page,
}) => {
  await page.route("**/api/dashboard/health", (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ observability: { state: "ok" } }),
    }),
  );
  await page.route("**/api/traces/*", (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify(detail),
    }),
  );
  await page.route("**/api/traces/*/events", (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ events }),
    }),
  );
  await page.route("**/api/traces", (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ traces }),
    }),
  );
  await page.route("**/api/stream", (route) => {
    const first = events[0];
    const afterGap = events[2];
    if (first === undefined || afterGap === undefined)
      throw new Error("sanitized fixture is incomplete");
    return route.fulfill({
      status: 200,
      contentType: "text/event-stream",
      body: `id: 1\nevent: trace\ndata: ${JSON.stringify(first)}\n\nid: 3\nevent: trace\ndata: ${JSON.stringify(afterGap)}\n\n`,
    });
  });
  await page.goto("/");
  await expect(page.getByText(/SSE stream gap/)).toBeVisible({
    timeout: 10_000,
  });
});

test("browser reconnect sends Last-Event-ID from the last received SSE event", async ({
  page,
}) => {
  let connections = 0;
  let resumedFrom: string | undefined;
  const first = events[0];
  if (first === undefined) throw new Error("sanitized fixture is incomplete");
  const staticRoot = resolve("dashboard/dist");
  const server = createServer((request, response) => {
    const path = new URL(request.url ?? "/", "http://dashboard.test").pathname;
    if (path === "/api/dashboard/health") {
      json(response, { observability: { state: "ok" } });
      return;
    }
    if (path === "/api/traces") {
      json(response, { traces });
      return;
    }
    if (path.endsWith("/events")) {
      json(response, { events });
      return;
    }
    if (path.startsWith("/api/traces/")) {
      json(response, detail);
      return;
    }
    if (path !== "/api/stream") {
      const requested = path === "/" ? "index.html" : path.slice(1);
      const candidate = resolve(staticRoot, requested);
      if (
        !candidate.startsWith(`${staticRoot}${sep}`) ||
        (!requested.startsWith("assets/") && requested !== "index.html")
      ) {
        response.writeHead(404).end();
        return;
      }
      try {
        response.writeHead(200, {
          "Content-Type": contentType(candidate),
        });
        response.end(readFileSync(candidate));
      } catch {
        response.writeHead(404).end();
      }
      return;
    }
    connections += 1;
    const lastEventId = request.headers["last-event-id"];
    if (lastEventId !== undefined) {
      resumedFrom = Array.isArray(lastEventId) ? lastEventId[0] : lastEventId;
      response.writeHead(200, { "Content-Type": "text/event-stream" });
      response.end(": resumed\n\n");
      return;
    }
    response.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
    });
    response.flushHeaders();
    response.write(
      `id: 17\nevent: trace\ndata: ${JSON.stringify({ ...first, streamId: 17 })}\n\n`,
    );
    setTimeout(() => response.destroy(), 500);
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      resolve();
    });
  });
  const serverAddress = server.address() as AddressInfo;
  const address = `http://127.0.0.1:${String(serverAddress.port)}`;

  try {
    await page.goto(address);
    await expect.poll(() => resumedFrom, { timeout: 15_000 }).toBe("17");
    expect(connections).toBeGreaterThan(1);
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) =>
      server.close((error) =>
        error === undefined ? resolve() : reject(error),
      ),
    );
  }
});

function json(response: ServerResponse, value: unknown): void {
  response.writeHead(200, { "Content-Type": "application/json" });
  response.end(JSON.stringify(value));
}

function contentType(path: string): string {
  if (extname(path) === ".js") return "text/javascript";
  if (extname(path) === ".css") return "text/css";
  return "text/html";
}
