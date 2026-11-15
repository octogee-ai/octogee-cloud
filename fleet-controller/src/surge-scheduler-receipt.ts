export function isSurgeSchedulerAlreadyResumed(error: unknown): boolean {
  if (error instanceof Error && error.message === "Cron migration already resumed") return true;
  const response = error as { status?: unknown; body?: { error?: unknown; message?: unknown } } | null;
  return response?.status === 500 && response.body?.error === "scheduler migration failed" && response.body.message === "Cron migration already resumed";
}
