/** Schedule document reads separately from execution submissions. */
export function startPolling(refresh: () => Promise<unknown>, hidden: () => boolean, delayMs: number): () => void {
  let stopped = false;
  let timer: ReturnType<typeof setTimeout>;
  const tick = async () => {
    try { if (!hidden()) await refresh(); }
    catch { /* The refresh handler reports errors; a failed read must not stop polling. */ }
    finally { if (!stopped) timer = setTimeout(tick, delayMs); }
  };
  timer = setTimeout(tick, delayMs);
  return () => { stopped = true; clearTimeout(timer); };
}

/** Only timeout/transport uncertainty is retried as a status read, never as a submission. */
export function isTransientPollError(code: string | undefined): boolean {
  return Boolean(code && ["step_timeout", "operation_deadline_exceeded", "request_timeout",
    "bridge_timeout_unknown", "request_failed_unknown"].includes(code));
}
