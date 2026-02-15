import { useEffect, useState } from 'react';

interface UseDmrWarmupGateResult {
  holdOpen: boolean;
  remainingMs: number;
}

export function useDmrWarmupGate(
  shouldHold: boolean,
  holdDurationMs: number,
): UseDmrWarmupGateResult {
  const [startedAt, setStartedAt] = useState<number | null>(null);
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    if (shouldHold) {
      setStartedAt((prev) => (prev === null ? Date.now() : prev));
    } else {
      setStartedAt(null);
    }
  }, [shouldHold]);

  useEffect(() => {
    if (startedAt === null) {
      return;
    }

    let intervalId: ReturnType<typeof setInterval> | undefined;

    const tick = () => {
      const current = Date.now();
      setNow(current);
      if (intervalId !== undefined && current - startedAt >= holdDurationMs) {
        clearInterval(intervalId);
        intervalId = undefined;
      }
    };

    tick();
    intervalId = setInterval(tick, 1000);

    return () => {
      if (intervalId !== undefined) {
        clearInterval(intervalId);
      }
    };
  }, [holdDurationMs, startedAt]);

  const elapsedMs = startedAt !== null ? Math.max(0, now - startedAt) : 0;
  const holdOpen = shouldHold && startedAt !== null && elapsedMs < holdDurationMs;
  const remainingMs = holdOpen ? Math.max(0, holdDurationMs - elapsedMs) : 0;

  return { holdOpen, remainingMs };
}
