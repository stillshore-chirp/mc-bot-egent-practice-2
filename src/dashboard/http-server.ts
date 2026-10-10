import {
  createServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from "node:http";
import { isIP } from "node:net";
import type { AddressInfo } from "node:net";
import { timingSafeEqual, randomBytes } from "node:crypto";

import { renderDashboardPage } from "./page.js";

export type DashboardConnectionState =
  "idle" | "connecting" | "connected" | "reconnecting" | "failed" | "stopped";

export interface DashboardUsageSnapshot {
  readonly requests: number;
  readonly usageResponses: number;
  readonly missingUsageRequests: number;
  readonly errors: number;
  readonly inputTokens: number | null;
  readonly outputTokens: number | null;
  readonly cachedInputTokens: number | null;
  readonly lastErrorCode: string | null;
}

export interface DashboardRuntimeSnapshot {
  readonly running: boolean;
  readonly stopped: boolean;
  readonly thinking: boolean;
  readonly goal: {
    readonly title: string;
    readonly successCondition: string;
  } | null;
  readonly currentOperation: {
    readonly kind: string;
    readonly startedAt: string;
  } | null;
  readonly nextWakeAt: string | null;
  readonly lastOutcome: {
    readonly status: string;
    readonly operationKind: string;
    readonly summary: string;
    readonly observedAt: string;
  } | null;
  readonly recentErrors?:
    | readonly {
        readonly code: string;
        readonly at: string;
      }[]
    | undefined;
  readonly usage: DashboardUsageSnapshot;
}

export interface DashboardSnapshot {
  readonly generatedAt: string;
  readonly connectionState: DashboardConnectionState;
  readonly runtime: DashboardRuntimeSnapshot;
  readonly plan: {
    readonly purpose: string;
    readonly firstStep: {
      readonly kind: string;
      readonly expectedOutcome: string;
    } | null;
  } | null;
  readonly activeOperation: {
    readonly kind: string;
    readonly expectedOutcome: string;
  } | null;
  readonly memories: readonly {
    readonly content: string;
    readonly source: string;
    readonly updatedAt: string;
  }[];
}

export interface DashboardHttpServerOptions {
  readonly host: string;
  readonly port: number;
  readonly authToken?: string | undefined;
  readonly getSnapshot: (
    query: string,
  ) => DashboardSnapshot | Promise<DashboardSnapshot>;
}

const connectionStates = new Set<DashboardConnectionState>([
  "idle",
  "connecting",
  "connected",
  "reconnecting",
  "failed",
  "stopped",
]);
const memorySources = new Set([
  "player_stated",
  "minecraft_observed",
  "bot_inferred",
  "system",
]);
const outcomeStatuses = new Set([
  "successful",
  "failed",
  "interrupted",
  "cancelled",
  "unverified",
]);
const maximumQueryLength = 2_000;
const maximumMemoryCount = 30;
const maximumMemoryLength = 4_000;

/**
 * Small, read-only companion operations page. The provider is called only for
 * an authenticated GET and its result is copied through a strict display-field
 * allowlist before it leaves this process.
 */
export class DashboardHttpServer {
  readonly #host: string;
  readonly #port: number;
  readonly #authToken: string | undefined;
  readonly #getSnapshot: DashboardHttpServerOptions["getSnapshot"];
  #server: Server | undefined;

  public constructor(options: DashboardHttpServerOptions) {
    if (
      options.host.trim().length === 0 ||
      !Number.isInteger(options.port) ||
      options.port < 0 ||
      options.port > 65_535
    ) {
      throw new Error("Invalid dashboard bind address.");
    }
    if (options.authToken !== undefined && options.authToken.length < 32) {
      throw new Error("Dashboard authentication token is too short.");
    }
    if (!isLoopbackHost(options.host)) {
      throw new Error("Dashboard server only supports loopback binding.");
    }
    this.#host = normalizeBindHost(options.host);
    this.#port = options.port;
    this.#authToken = options.authToken;
    this.#getSnapshot = options.getSnapshot;
  }

  public start(): Promise<void> {
    if (this.#server !== undefined) {
      return Promise.reject(new Error("Dashboard server is already started."));
    }
    const server = createServer((request, response) => {
      void this.#handle(request, response);
    });
    this.#server = server;
    return new Promise((resolve, reject) => {
      const onError = (error: Error) => {
        this.#server = undefined;
        reject(
          new Error("Dashboard server could not start.", { cause: error }),
        );
      };
      server.once("error", onError);
      server.listen(this.#port, this.#host, () => {
        server.off("error", onError);
        resolve();
      });
    });
  }

  public close(): Promise<void> {
    const server = this.#server;
    if (server === undefined) return Promise.resolve();
    this.#server = undefined;
    return new Promise((resolve, reject) => {
      server.close((error) => {
        if (error !== undefined)
          reject(new Error("Dashboard server could not close."));
        else resolve();
      });
    });
  }

  /** Exposes the bound address for lifecycle wiring and port-0 tests. */
  public address(): AddressInfo | null {
    const address = this.#server?.address();
    return address !== undefined &&
      address !== null &&
      typeof address !== "string"
      ? address
      : null;
  }

  async #handle(
    request: IncomingMessage,
    response: ServerResponse,
  ): Promise<void> {
    setSecurityHeaders(response);
    if (!this.#validHost(request)) {
      sendJson(response, 421, { error: "host_not_allowed" });
      return;
    }
    if (!this.#sameOrigin(request)) {
      sendJson(response, 403, { error: "origin_not_allowed" });
      return;
    }
    if (request.method !== "GET") {
      response.setHeader("Allow", "GET");
      sendJson(response, 405, { error: "method_not_allowed" });
      return;
    }
    if (hasRequestBody(request)) {
      response.setHeader("Connection", "close");
      sendJson(response, 400, { error: "request_body_not_allowed" });
      return;
    }

    const requestUrl = parseOriginForm(request.url);
    if (requestUrl === null) {
      sendJson(response, 400, { error: "invalid_request_target" });
      return;
    }
    if (requestUrl.pathname === "/") {
      if (requestUrl.search.length > 0) {
        sendJson(response, 404, { error: "not_found" });
        return;
      }
      const nonce = randomBytes(18).toString("base64");
      response.statusCode = 200;
      response.setHeader("Content-Type", "text/html; charset=utf-8");
      response.setHeader(
        "Content-Security-Policy",
        [
          "default-src 'none'",
          "base-uri 'none'",
          "connect-src 'self'",
          "form-action 'self'",
          "frame-ancestors 'none'",
          "img-src 'none'",
          "object-src 'none'",
          "script-src 'nonce-" + nonce + "'",
          "style-src 'nonce-" + nonce + "'",
        ].join("; "),
      );
      response.end(renderDashboardPage(nonce));
      return;
    }

    if (requestUrl.pathname.startsWith("/api/") && !this.#authorized(request)) {
      response.setHeader(
        "WWW-Authenticate",
        'Bearer realm="companion-dashboard"',
      );
      sendJson(response, 401, { error: "authentication_required" });
      return;
    }
    if (requestUrl.pathname !== "/api/snapshot") {
      sendJson(response, 404, { error: "not_found" });
      return;
    }
    const query = readQuery(requestUrl);
    if (query === null) {
      sendJson(response, 400, { error: "invalid_query" });
      return;
    }

    try {
      const snapshot = await this.#getSnapshot(query);
      sendJson(response, 200, sanitizeSnapshot(snapshot));
    } catch {
      sendJson(response, 503, { error: "dashboard_snapshot_unavailable" });
    }
  }

  #authorized(request: IncomingMessage): boolean {
    if (this.#authToken === undefined) return true;
    const header = request.headers.authorization;
    if (typeof header !== "string" || !header.startsWith("Bearer "))
      return false;
    const provided = Buffer.from(header.slice(7), "utf8");
    const expected = Buffer.from(this.#authToken, "utf8");
    return (
      provided.length === expected.length && timingSafeEqual(provided, expected)
    );
  }

  #validHost(request: IncomingMessage): boolean {
    const rawAuthority = request.headers.host;
    if (typeof rawAuthority !== "string") return false;
    const authority = parseAuthority(rawAuthority);
    if (authority === null || authority.port !== request.socket.localPort)
      return false;
    const localAddress = normalizeAddress(request.socket.localAddress ?? "");
    if (authority.hostname === localAddress) return true;
    if (authority.hostname === "localhost" && isLoopbackHost(localAddress))
      return true;
    return authority.hostname === normalizeConfiguredHost(this.#host);
  }

  #sameOrigin(request: IncomingMessage): boolean {
    const fetchSite = request.headers["sec-fetch-site"];
    if (typeof fetchSite === "string" && fetchSite !== "same-origin")
      return false;
    const originHeader = request.headers.origin;
    if (originHeader === undefined) return true;
    if (typeof originHeader !== "string" || originHeader === "null")
      return false;
    try {
      const origin = new URL(originHeader);
      const authority = request.headers.host?.toLowerCase();
      return (
        origin.protocol === "http:" &&
        origin.username.length === 0 &&
        origin.password.length === 0 &&
        origin.pathname === "/" &&
        origin.search.length === 0 &&
        origin.hash.length === 0 &&
        authority !== undefined &&
        origin.host.toLowerCase() === authority
      );
    } catch {
      return false;
    }
  }
}

function setSecurityHeaders(response: ServerResponse): void {
  response.setHeader("Cache-Control", "no-store");
  response.setHeader("X-Content-Type-Options", "nosniff");
  response.setHeader("X-Frame-Options", "DENY");
  response.setHeader("Referrer-Policy", "no-referrer");
  response.setHeader("Cross-Origin-Resource-Policy", "same-origin");
  response.setHeader(
    "Permissions-Policy",
    "camera=(), microphone=(), geolocation=()",
  );
}

function sendJson(
  response: ServerResponse,
  status: number,
  value: unknown,
): void {
  response.statusCode = status;
  response.setHeader("Content-Type", "application/json; charset=utf-8");
  response.end(JSON.stringify(value));
}

function hasRequestBody(request: IncomingMessage): boolean {
  const contentLength = request.headers["content-length"];
  if (
    contentLength !== undefined &&
    (Array.isArray(contentLength) ||
      !/^(?:0|[1-9][0-9]*)$/u.test(contentLength) ||
      Number(contentLength) > 0)
  ) {
    return true;
  }
  return request.headers["transfer-encoding"] !== undefined;
}

function parseOriginForm(target: string | undefined): URL | null {
  if (
    target === undefined ||
    !target.startsWith("/") ||
    target.startsWith("//") ||
    target.length > 8_192
  ) {
    return null;
  }
  try {
    const parsed = new URL(target, "http://dashboard.local");
    if (parsed.origin !== "http://dashboard.local" || parsed.hash.length > 0)
      return null;
    return parsed;
  } catch {
    return null;
  }
}

function parseAuthority(
  authority: string,
): { hostname: string; port: number } | null {
  if (authority.length > 300 || /[\s/@?#]/u.test(authority)) return null;
  try {
    const parsed = new URL("http://" + authority);
    if (
      parsed.username.length > 0 ||
      parsed.password.length > 0 ||
      parsed.pathname !== "/" ||
      parsed.search.length > 0 ||
      parsed.hash.length > 0 ||
      parsed.port.length === 0
    ) {
      return null;
    }
    return {
      hostname: normalizeAddress(parsed.hostname),
      port: Number(parsed.port),
    };
  } catch {
    return null;
  }
}

function readQuery(url: URL): string | null {
  const keys = [...url.searchParams.keys()];
  if (keys.some((key) => key !== "q")) return null;
  const values = url.searchParams.getAll("q");
  if (values.length > 1) return null;
  const query = values[0] ?? "";
  return query.length <= maximumQueryLength ? query : null;
}

function sanitizeSnapshot(snapshot: DashboardSnapshot): DashboardSnapshot {
  const runtime = snapshot.runtime;
  const usage = runtime.usage;
  const lastOutcome = runtime.lastOutcome;
  const currentOperation = runtime.currentOperation;
  const goal = runtime.goal;
  const plan = snapshot.plan;
  const activeOperation = snapshot.activeOperation;
  return {
    generatedAt: safeText(snapshot.generatedAt, 64) ?? new Date().toISOString(),
    connectionState: connectionStates.has(snapshot.connectionState)
      ? snapshot.connectionState
      : "failed",
    runtime: {
      running: runtime.running,
      stopped: runtime.stopped,
      thinking: runtime.thinking,
      goal:
        goal === null
          ? null
          : {
              title: safeText(goal.title, 160) ?? "",
              successCondition: safeText(goal.successCondition, 320) ?? "",
            },
      currentOperation:
        currentOperation === null
          ? null
          : {
              kind: safeCode(currentOperation.kind) ?? "UNKNOWN",
              startedAt: safeText(currentOperation.startedAt, 64) ?? "",
            },
      nextWakeAt: safeText(runtime.nextWakeAt, 64),
      lastOutcome:
        lastOutcome === null
          ? null
          : {
              status: outcomeStatuses.has(lastOutcome.status)
                ? lastOutcome.status
                : "unverified",
              operationKind: safeCode(lastOutcome.operationKind) ?? "UNKNOWN",
              summary: safeText(lastOutcome.summary, 240) ?? "",
              observedAt: safeText(lastOutcome.observedAt, 64) ?? "",
            },
      recentErrors: (runtime.recentErrors ?? [])
        .slice(0, 5)
        .flatMap((error) => {
          const code = safeCode(error.code);
          return code === null
            ? []
            : [{ code, at: safeText(error.at, 64) ?? "" }];
        }),
      usage: {
        requests: safeCount(usage.requests),
        usageResponses: safeCount(usage.usageResponses),
        missingUsageRequests: safeCount(usage.missingUsageRequests),
        errors: safeCount(usage.errors),
        inputTokens: safeOptionalCount(usage.inputTokens),
        outputTokens: safeOptionalCount(usage.outputTokens),
        cachedInputTokens: safeOptionalCount(usage.cachedInputTokens),
        lastErrorCode:
          usage.lastErrorCode === null ? null : safeCode(usage.lastErrorCode),
      },
    },
    plan:
      plan === null
        ? null
        : {
            purpose: safeText(plan.purpose, 240) ?? "",
            firstStep:
              plan.firstStep === null
                ? null
                : {
                    kind: safeCode(plan.firstStep.kind) ?? "UNKNOWN",
                    expectedOutcome:
                      safeText(plan.firstStep.expectedOutcome, 240) ?? "",
                  },
          },
    activeOperation:
      activeOperation === null
        ? null
        : {
            kind: safeCode(activeOperation.kind) ?? "UNKNOWN",
            expectedOutcome:
              safeText(activeOperation.expectedOutcome, 240) ?? "",
          },
    memories: snapshot.memories
      .slice(0, maximumMemoryCount)
      .flatMap((memory) => {
        const source = safeMemorySource(memory.source);
        const content = safeText(memory.content, maximumMemoryLength);
        if (source === null || content === null) return [];
        return [
          {
            content,
            source,
            updatedAt: safeText(memory.updatedAt, 64) ?? "",
          },
        ];
      }),
  };
}

function safeText(value: unknown, limit: number): string | null {
  if (typeof value !== "string") return null;
  const controlBytes = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/gu; // eslint-disable-line no-control-regex -- Strip non-printing bytes from display text.
  const printable = value.replace(controlBytes, "");
  return printable.slice(0, limit);
}

function safeCode(value: unknown): string | null {
  if (typeof value !== "string" || !/^[a-z][a-z0-9_]{0,47}$/iu.test(value)) {
    return null;
  }
  return value.toUpperCase();
}

function safeCount(value: unknown): number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0
    ? value
    : 0;
}

function safeOptionalCount(value: unknown): number | null {
  return typeof value === "number" ? safeCount(value) : null;
}

function safeMemorySource(value: unknown): string | null {
  return typeof value === "string" && memorySources.has(value) ? value : null;
}

function normalizeConfiguredHost(host: string): string {
  return normalizeAddress(host.toLowerCase().replace(/^\[|\]$/gu, ""));
}

function normalizeBindHost(host: string): string {
  const normalized = normalizeConfiguredHost(host);
  return normalized === "localhost" ? "127.0.0.1" : normalized;
}

function normalizeAddress(address: string): string {
  const lower = address.toLowerCase().replace(/^\[|\]$/gu, "");
  if (lower.startsWith("::ffff:")) return lower.slice("::ffff:".length);
  return lower;
}

function isLoopbackHost(host: string): boolean {
  const normalized = normalizeConfiguredHost(host);
  if (normalized === "localhost" || normalized === "::1") return true;
  if (isIP(normalized) === 4) return normalized.startsWith("127.");
  return false;
}
