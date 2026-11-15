export function startBlobSyncLoop(
  deps: { syncBlobs(): Promise<void>; log(message: string): void; setIntervalFn?: typeof setInterval },
  intervalMs: number,
): NodeJS.Timeout {
  let inFlight = false;
  deps.log(`[blob-sync] Periodic sync every ${intervalMs / 1000}s`);
  return (deps.setIntervalFn ?? setInterval)(async () => {
    if (inFlight) return;
    inFlight = true;
    try { await deps.syncBlobs(); }
    catch (error) { deps.log(`[blob-sync] Error: ${error instanceof Error ? error.message : String(error)}`); }
    finally { inFlight = false; }
  }, intervalMs);
}
