export interface UnknownWorldBaselineSteps {
  readonly forceLoadSource: () => Promise<void>;
  readonly forceLoadDestination: () => Promise<void>;
  readonly waitForTickWindow: () => Promise<void>;
  readonly withFrozenTicks: (operation: () => Promise<void>) => Promise<void>;
  readonly captureBaseline: () => Promise<void>;
  readonly compareBaseline: () => Promise<boolean>;
  readonly fail: (code: string) => never;
}

const MAX_REPRODUCIBILITY_WINDOWS = 6;
const REQUIRED_CONSECUTIVE_MATCHES = 2;

export async function captureReproducibleUnknownWorldBaseline(
  steps: UnknownWorldBaselineSteps,
): Promise<void> {
  await steps.forceLoadSource();
  await steps.forceLoadDestination();

  let consecutiveMatches = 0;
  for (let window = 0; window < MAX_REPRODUCIBILITY_WINDOWS; window += 1) {
    await steps.captureBaseline();
    await steps.waitForTickWindow();
    consecutiveMatches = (await steps.compareBaseline())
      ? consecutiveMatches + 1
      : 0;
    if (consecutiveMatches === REQUIRED_CONSECUTIVE_MATCHES) break;
  }
  if (consecutiveMatches !== REQUIRED_CONSECUTIVE_MATCHES)
    steps.fail("WORLD_ORACLE_FIXTURE_BASELINE_NOT_REPRODUCIBLE");

  await steps.withFrozenTicks(async () => {
    await steps.captureBaseline();
    if (!(await steps.compareBaseline()))
      steps.fail("WORLD_ORACLE_INITIAL_BASELINE_MISMATCH");
  });
}
