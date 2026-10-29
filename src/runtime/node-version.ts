export const SUPPORTED_NODE_VERSION_RANGE = "^22.23.4 || ^24.22.1 || ^26.12.1";

const minimumVersions = new Map<number, readonly [number, number]>([
  [22, [23, 4]],
  [24, [22, 1]],
  [26, [12, 1]],
]);

export function isSupportedNodeVersion(version: string): boolean {
  const match = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.exec(version);
  if (!match) return false;

  const major = Number(match[1]);
  const minor = Number(match[2]);
  const patch = Number(match[3]);
  if (![major, minor, patch].every(Number.isSafeInteger)) return false;

  const minimum = minimumVersions.get(major);
  if (!minimum) return false;

  return minor > minimum[0] || (minor === minimum[0] && patch >= minimum[1]);
}

export function assertSupportedNodeVersion(
  version = process.versions.node,
): void {
  if (isSupportedNodeVersion(version)) return;

  throw new Error(
    `Unsupported Node.js version ${version}. Use a stable release satisfying ${SUPPORTED_NODE_VERSION_RANGE}.`,
  );
}

try {
  assertSupportedNodeVersion();
} catch (error) {
  const message =
    error instanceof Error
      ? error.message
      : "Unsupported Node.js version. Select a supported stable release.";
  process.stderr.write(`${message}\n`);
  process.exit(1);
}
