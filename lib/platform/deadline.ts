/** Bound one I/O wait. Never race a workflow that could later allocate compute. */
import { SpikeError } from "./security.ts";

export function requireActive(signal: AbortSignal | undefined, stage: string): void {
  if (signal?.aborted) throw new SpikeError("operation_deadline_exceeded", stage);
}

export async function boundedStep<T>(
  stage: string, timeoutMs: number, parentSignal: AbortSignal | undefined,
  work: (signal: AbortSignal) => Promise<T>,
): Promise<T> {
  requireActive(parentSignal, stage);
  if (timeoutMs <= 0) throw new SpikeError("operation_deadline_exceeded", stage);
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  let aborted: (() => void) | undefined;
  try {
    return await new Promise<T>((resolve, reject) => {
      aborted = () => {
        controller.abort();
        reject(new SpikeError("operation_deadline_exceeded", stage));
      };
      parentSignal?.addEventListener("abort", aborted, { once: true });
      timer = setTimeout(() => {
        controller.abort();
        reject(new SpikeError("step_timeout", stage));
      }, timeoutMs);
      // Check again before starting I/O, including when invoked on a microtask.
      Promise.resolve().then(() => {
        requireActive(parentSignal, stage);
        requireActive(controller.signal, stage);
        return work(controller.signal);
      }).then(resolve, reject);
    });
  } finally {
    if (timer !== undefined) clearTimeout(timer);
    if (aborted) parentSignal?.removeEventListener("abort", aborted);
  }
}
