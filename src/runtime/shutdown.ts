export function registerGracefulShutdown(
  shutdown: () => Promise<void>,
): () => void {
  let shuttingDown = false;
  const handler = (): void => {
    if (shuttingDown) return;
    shuttingDown = true;
    void shutdown().finally(() => {
      process.exitCode = 0;
    });
  };
  process.once("SIGINT", handler);
  process.once("SIGTERM", handler);
  return () => {
    process.off("SIGINT", handler);
    process.off("SIGTERM", handler);
  };
}
