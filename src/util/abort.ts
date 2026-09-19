export function abortError(signal: AbortSignal): Error {
  const reason = signal.reason;
  if (reason instanceof Error) return reason;
  return new DOMException(String(reason ?? "Aborted"), "AbortError");
}

export function isAbortError(e: unknown): boolean {
  return e instanceof Error && (e.name === "AbortError" || e.name === "TimeoutError");
}

// Rejects when the signal fires; used to race work that may ignore its signal.
export function whenAborted(signal: AbortSignal): Promise<never> {
  return new Promise((_, reject) => {
    if (signal.aborted) return reject(abortError(signal));
    signal.addEventListener("abort", () => reject(abortError(signal)), { once: true });
  });
}
