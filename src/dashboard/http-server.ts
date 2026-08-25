import { createHash, timingSafeEqual } from "node:crypto";
import { createReadStream, existsSync, statSync } from "node:fs";
import {
  createServer,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";
import { extname, resolve, sep } from "node:path";

import type { Logger } from "pino";

import type { CognitiveTraceEvent } from "../trace/contracts.js";
import type { TraceService } from "../trace/service.js";
import { TraceStoreError } from "../trace/store.js";

import { z } from "zod";

const TRACE_ID = z.uuid();
const SPAN_ID = z.uuid();
const MAX_REQUEST_BYTES = 5 * 1024 * 1024;
const SSE_KEEPALIVE_MS = 15_000;
const SSE_BACKFILL_PAGE = 2_000;
const SSE_MAX_BUFFER_BYTES = 1024 * 1024;

export interface DashboardBotHealth {
  readonly botState: "active" | "unavailable" | "unknown";
  readonly connectionState: string;
  readonly aiState: "active" | "idle";
  readonly memoryState: "available";
  readonly reflexState: string;
  readonly health?: number | undefined;
  readonly food?: number | undefined;
  readonly positionState: "available_redacted" | "unavailable";
  readonly taskStatus?: string | undefined;
  readonly taskPhase?: string | undefined;
}

export interface DashboardServerOptions {
  readonly enabled: boolean;
  readonly host: string;
  readonly port: number;
  readonly authToken?: string | undefined;
  readonly staticDirectory: string;
  readonly maxAgeDays: number;
  readonly maxTraces: number;
  readonly getBotHealth?: (() => Promise<DashboardBotHealth>) | undefined;
}

export class DashboardHttpServer {
  readonly #service: TraceService;
  readonly #options: DashboardServerOptions;
  readonly #logger: Logger;
  readonly #streams = new Set<ServerResponse>();
  readonly #server = createServer((request, response) => {
    void this.#handle(request, response).catch((error: unknown) => {
      const status = statusForError(error);
      const log =
        status >= 500
          ? this.#logger.error.bind(this.#logger)
          : this.#logger.warn.bind(this.#logger);
      log(
        {
          category: "observability",
          code: "DASHBOARD_REQUEST_FAILED",
          errorType: error instanceof Error ? error.name : "UnknownError",
        },
        "dashboard request failed",
      );
      if (!response.headersSent) {
        this.#json(response, status, {
          code:
            error instanceof TraceStoreError
              ? error.code
              : "DASHBOARD_REQUEST_FAILED",
        });
      } else {
        response.end();
      }
    });
  });
  #started = false;

  public constructor(
    service: TraceService,
    options: DashboardServerOptions,
    logger: Logger,
  ) {
    if (options.authToken !== undefined && !hasStrongToken(options.authToken)) {
      throw new Error("DASHBOARD_AUTH_TOKEN_WEAK");
    }
    if (
      options.enabled &&
      !isLoopbackHost(options.host) &&
      !hasStrongToken(options.authToken)
    ) {
      throw new Error("DASHBOARD_NON_LOOPBACK_AUTH_REQUIRED");
    }
    this.#service = service;
    this.#options = options;
    this.#logger = logger;
  }

  public async start(): Promise<void> {
    if (!this.#options.enabled || this.#started) return;
    const removed = this.#service.store.enforceRetention({
      maxAgeDays: this.#options.maxAgeDays,
      maxTraces: this.#options.maxTraces,
    });
    await new Promise<void>((resolveStart, rejectStart) => {
      const onError = (error: Error): void => rejectStart(error);
      this.#server.once("error", onError);
      this.#server.listen(this.#options.port, this.#options.host, () => {
        this.#server.off("error", onError);
        this.#started = true;
        resolveStart();
      });
    });
    this.#logger.info(
      {
        category: "observability",
        host: this.#options.host,
        port: this.#options.port,
        retentionRemoved: removed,
      },
      "trace dashboard started",
    );
  }

  public get address(): string | undefined {
    const address = this.#server.address();
    if (address === null || typeof address === "string") return undefined;
    const host =
      address.family === "IPv6" ? `[${address.address}]` : address.address;
    return `http://${host}:${String(address.port)}`;
  }

  public async stop(): Promise<void> {
    if (!this.#started) return;
    for (const response of this.#streams) response.end();
    await new Promise<void>((resolveStop, rejectStop) => {
      this.#server.close((error) => {
        if (error === undefined) resolveStop();
        else rejectStop(error);
      });
    });
    this.#started = false;
  }

  async #handle(
    request: IncomingMessage,
    response: ServerResponse,
  ): Promise<void> {
    this.#securityHeaders(response);
    if (!this.#authorized(request)) {
      response.setHeader(
        "WWW-Authenticate",
        'Basic realm="companion-trace-dashboard", charset="UTF-8"',
      );
      this.#json(response, 401, { code: "DASHBOARD_UNAUTHORIZED" });
      return;
    }
    const requestUrl = new URL(request.url ?? "/", "http://dashboard.local");
    const path = requestUrl.pathname;

    if (request.method === "GET" && path === "/api/dashboard/health") {
      const bot = await this.#options.getBotHealth?.().catch(() => undefined);
      this.#json(response, 200, {
        observability: this.#service.health,
        ...(bot === undefined ? {} : { bot }),
      });
      return;
    }
    if (request.method === "GET" && path === "/api/traces") {
      const requestedLimit = Number(requestUrl.searchParams.get("limit") ?? 50);
      const limit = Number.isInteger(requestedLimit) ? requestedLimit : 50;
      this.#json(response, 200, {
        traces: this.#service.store.listTraces(limit),
      });
      return;
    }
    if (request.method === "GET" && path === "/api/stream") {
      this.#stream(request, response);
      return;
    }
    if (request.method === "POST" && path === "/api/traces/import") {
      const input = await readJson(request);
      this.#json(response, 201, {
        trace: this.#service.store.importDemoBundle(input),
      });
      return;
    }
    const spanId = spanRoute(path);
    if (request.method === "GET" && spanId !== undefined) {
      const span = this.#service.store.getSpan(spanId);
      if (span === undefined) {
        this.#json(response, 404, { code: "TRACE_SPAN_NOT_FOUND" });
      } else {
        this.#json(response, 200, span);
      }
      return;
    }

    const route = traceRoute(path);
    if (route !== undefined) {
      const { traceId, action } = route;
      if (request.method === "GET" && action === "detail") {
        const trace = this.#service.store.getTrace(traceId);
        if (trace === undefined) {
          this.#json(response, 404, { code: "TRACE_NOT_FOUND" });
        } else {
          this.#json(response, 200, trace);
        }
        return;
      }
      if (request.method === "GET" && action === "events") {
        const requestedAfter = Number(
          requestUrl.searchParams.get("after") ?? 0,
        );
        const after = Number.isInteger(requestedAfter) ? requestedAfter : 0;
        this.#json(response, 200, {
          events: this.#service.store.listEvents(traceId, after),
        });
        return;
      }
      if (request.method === "POST" && action === "demo-safe") {
        this.#json(response, 200, this.#service.store.markDemoSafe(traceId));
        return;
      }
      if (request.method === "GET" && action === "export") {
        response.setHeader(
          "Content-Disposition",
          `attachment; filename="trace-${traceId}.json"`,
        );
        this.#json(
          response,
          200,
          this.#service.store.exportDemoBundle(traceId),
        );
        return;
      }
    }

    if (
      !path.startsWith("/api/") &&
      (request.method === "GET" || request.method === "HEAD")
    ) {
      if (this.#serveStatic(path, request.method === "HEAD", response)) return;
    }
    this.#json(response, 404, { code: "DASHBOARD_ROUTE_NOT_FOUND" });
  }

  #stream(request: IncomingMessage, response: ServerResponse): void {
    response.writeHead(200, {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    });
    response.flushHeaders();
    this.#streams.add(response);
    const lastEventHeader = request.headers["last-event-id"];
    let lastSent = parseLastEventId(
      Array.isArray(lastEventHeader) ? lastEventHeader[0] : lastEventHeader,
    );
    const send = (event: CognitiveTraceEvent): void => {
      if (event.streamId === undefined || event.streamId <= lastSent) return;
      if (
        response.writableEnded ||
        response.writableLength > SSE_MAX_BUFFER_BYTES
      ) {
        response.end();
        return;
      }
      response.write(`id: ${String(event.streamId)}\n`);
      response.write("event: trace\n");
      response.write(`data: ${JSON.stringify(event)}\n\n`);
      lastSent = event.streamId;
    };
    let catchingUp = true;
    const pending: CognitiveTraceEvent[] = [];
    const unsubscribe = this.#service.subscribe((event) => {
      if (catchingUp) pending.push(event);
      else send(event);
    });
    let backfill = this.#service.store.listStreamEventsAfter(lastSent);
    for (const event of backfill) send(event);
    while (backfill.length === SSE_BACKFILL_PAGE) {
      backfill = this.#service.store.listStreamEventsAfter(lastSent);
      for (const event of backfill) send(event);
    }
    pending.sort((left, right) => (left.streamId ?? 0) - (right.streamId ?? 0));
    for (const event of pending) send(event);
    catchingUp = false;
    response.write(": connected\n\n");
    const keepalive = setInterval(() => {
      if (!response.writableEnded) response.write(": keepalive\n\n");
    }, SSE_KEEPALIVE_MS);
    const close = (): void => {
      clearInterval(keepalive);
      unsubscribe();
      this.#streams.delete(response);
      response.end();
    };
    request.once("close", close);
    response.once("close", close);
  }

  #serveStatic(
    path: string,
    headOnly: boolean,
    response: ServerResponse,
  ): boolean {
    const root = resolve(this.#options.staticDirectory);
    const requested = path === "/" ? "/index.html" : path;
    const candidate = resolve(root, `.${requested}`);
    const safeCandidate =
      candidate === root || candidate.startsWith(`${root}${sep}`);
    const file =
      safeCandidate && existsSync(candidate) && statSync(candidate).isFile()
        ? candidate
        : resolve(root, "index.html");
    if (!existsSync(file) || !statSync(file).isFile()) return false;
    if (!file.startsWith(`${root}${sep}`)) return false;
    response.statusCode = 200;
    response.setHeader("Content-Type", contentType(file));
    response.setHeader(
      "Cache-Control",
      file.endsWith("index.html")
        ? "no-store"
        : "public, max-age=31536000, immutable",
    );
    if (headOnly) response.end();
    else createReadStream(file).pipe(response);
    return true;
  }

  #authorized(request: IncomingMessage): boolean {
    const expected = this.#options.authToken;
    if (expected === undefined) return isLoopbackHost(this.#options.host);
    const authorization = request.headers.authorization;
    const bearer = authorization?.match(/^Bearer\s+(.+)$/iu)?.[1];
    const supplied = bearer ?? basicPassword(authorization);
    if (supplied === undefined) return false;
    return safeEqual(supplied, expected);
  }

  #securityHeaders(response: ServerResponse): void {
    response.setHeader("X-Content-Type-Options", "nosniff");
    response.setHeader("Referrer-Policy", "no-referrer");
    response.setHeader("Cross-Origin-Resource-Policy", "same-origin");
    response.setHeader(
      "Content-Security-Policy",
      "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; font-src 'self'; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'",
    );
  }

  #json(response: ServerResponse, status: number, value: unknown): void {
    response.statusCode = status;
    response.setHeader("Content-Type", "application/json; charset=utf-8");
    response.setHeader("Cache-Control", "no-store");
    response.end(JSON.stringify(value));
  }
}

function spanRoute(path: string): string | undefined {
  const match = /^\/api\/spans\/([^/]+)$/u.exec(path);
  if (match === null) return undefined;
  const parsed = SPAN_ID.safeParse(match[1]);
  return parsed.success ? parsed.data : undefined;
}

function traceRoute(path: string):
  | {
      readonly traceId: string;
      readonly action: "detail" | "events" | "demo-safe" | "export";
    }
  | undefined {
  const match =
    /^\/api\/traces\/([^/]+)(?:\/(events|demo-safe|export))?$/u.exec(path);
  if (match === null) return undefined;
  const parsed = TRACE_ID.safeParse(match[1]);
  if (!parsed.success) return undefined;
  const rawAction = match[2];
  return {
    traceId: parsed.data,
    action:
      rawAction === "events" ||
      rawAction === "demo-safe" ||
      rawAction === "export"
        ? rawAction
        : "detail",
  };
}

async function readJson(request: IncomingMessage): Promise<unknown> {
  const chunks: Uint8Array[] = [];
  let size = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buffer.byteLength;
    if (size > MAX_REQUEST_BYTES) {
      throw new TraceStoreError(
        "TRACE_IMPORT_TOO_LARGE",
        "Trace bundle exceeds the request limit",
      );
    }
    chunks.push(new Uint8Array(buffer));
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw new TraceStoreError(
      "TRACE_IMPORT_JSON_INVALID",
      "Trace bundle JSON is invalid",
    );
  }
}

function parseLastEventId(value: string | undefined): number {
  if (value === undefined || !/^\d+$/u.test(value)) return 0;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : 0;
}

function hasStrongToken(value: string | undefined): value is string {
  return value !== undefined && value.length >= 32;
}

function isLoopbackHost(host: string): boolean {
  return host === "127.0.0.1" || host === "::1" || host === "localhost";
}

function safeEqual(left: string, right: string): boolean {
  const leftHash = createHash("sha256").update(left).digest();
  const rightHash = createHash("sha256").update(right).digest();
  return timingSafeEqual(leftHash, rightHash);
}

function basicPassword(authorization: string | undefined): string | undefined {
  if (!authorization?.startsWith("Basic ")) {
    return undefined;
  }
  try {
    const decoded = Buffer.from(authorization.slice(6), "base64").toString(
      "utf8",
    );
    const separator = decoded.indexOf(":");
    return separator < 0 ? undefined : decoded.slice(separator + 1);
  } catch {
    return undefined;
  }
}

function contentType(path: string): string {
  return (
    {
      ".css": "text/css; charset=utf-8",
      ".html": "text/html; charset=utf-8",
      ".js": "text/javascript; charset=utf-8",
      ".json": "application/json; charset=utf-8",
      ".map": "application/json; charset=utf-8",
      ".svg": "image/svg+xml",
      ".woff2": "font/woff2",
    }[extname(path)] ?? "application/octet-stream"
  );
}

function statusForError(error: unknown): number {
  if (error instanceof z.ZodError) return 400;
  if (!(error instanceof TraceStoreError)) return 500;
  if (error.code === "TRACE_NOT_FOUND") return 404;
  if (
    error.code === "TRACE_NOT_DEMO_SAFE" ||
    error.code === "TRACE_NOT_COMPLETE" ||
    error.code === "TRACE_IMPORT_NOT_DEMO_SAFE" ||
    error.code === "TRACE_EVENT_ID_CONFLICT"
  ) {
    return 409;
  }
  if (
    error.code.includes("INVALID") ||
    error.code.includes("UNSUPPORTED") ||
    error.code.includes("TOO_LARGE") ||
    error.code.includes("MISSING") ||
    error.code.includes("GAP") ||
    error.code.includes("MISMATCH")
  ) {
    return 400;
  }
  return 500;
}
