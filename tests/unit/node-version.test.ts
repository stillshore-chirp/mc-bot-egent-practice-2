import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import {
  assertSupportedNodeVersion,
  isSupportedNodeVersion,
  SUPPORTED_NODE_VERSION_RANGE,
} from "../../src/runtime/node-version.js";

describe("Node.js runtime support", () => {
  it.each([
    ["22.23.4", true],
    ["22.24.0", true],
    ["24.22.1", true],
    ["24.22.2", true],
    ["26.12.1", true],
    ["26.13.0", true],
    ["22.22.2", false],
    ["22.23.3", false],
    ["24.22.0", false],
    ["26.12.0", false],
    ["23.99.99", false],
    ["25.99.99", false],
    ["27.0.0", false],
    ["24.22.1-rc.1", false],
    ["v24.22.1", false],
    ["024.22.1", false],
  ] as const)("classifies %s as supported=%s", (version, expected) => {
    expect(isSupportedNodeVersion(version)).toBe(expected);
  });

  it("provides a safe actionable message for unsupported versions", () => {
    expect(() => assertSupportedNodeVersion("22.23.3")).toThrow(
      `Unsupported Node.js version 22.23.3. Use a stable release satisfying ${SUPPORTED_NODE_VERSION_RANGE}.`,
    );
  });

  it("accepts supported releases through the assertion", () => {
    expect(() => assertSupportedNodeVersion("24.22.1")).not.toThrow();
  });

  it("keeps manifests and the preferred version aligned with the startup guard", () => {
    const manifest = JSON.parse(
      readFileSync(new URL("../../package.json", import.meta.url), "utf8"),
    ) as { engines: { node: string } };
    const lockfile = JSON.parse(
      readFileSync(new URL("../../package-lock.json", import.meta.url), "utf8"),
    ) as { packages: Record<string, { engines?: { node?: string } }> };
    const preferredVersion = readFileSync(
      new URL("../../.nvmrc", import.meta.url),
      "utf8",
    ).trim();

    expect(manifest.engines.node).toBe(SUPPORTED_NODE_VERSION_RANGE);
    expect(lockfile.packages[""]?.engines?.node).toBe(
      SUPPORTED_NODE_VERSION_RANGE,
    );
    expect(isSupportedNodeVersion(preferredVersion)).toBe(true);
  });

  it("imports the guard before startup modules", () => {
    const entry = readFileSync(
      new URL("../../src/index.ts", import.meta.url),
      "utf8",
    );
    const firstImport = entry.match(/^\s*import\b[^\n]*/m)?.[0].trim();

    expect(firstImport).toBe('import "./runtime/node-version.js";');
  });
});
