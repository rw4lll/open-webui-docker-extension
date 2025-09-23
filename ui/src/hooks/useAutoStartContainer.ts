import { useEffect, useRef } from 'react';

import type { ContainerState, ContainerStatus } from '../types';

const AUTO_START_ELIGIBLE_STATES: Set<ContainerState> = new Set([
  'not_found',
  'exited',
  'stopped',
  'created',
  'paused',
]);

interface UseAutoStartContainerOptions {
  autoStart: boolean;
  status: ContainerStatus | null;
  loading: boolean;
  startContainer: () => void;
}

/**
 * Automatically ensures the Open WebUI container is running when auto-start is enabled.
 */
export function useAutoStartContainer({
  autoStart,
  status,
  loading,
  startContainer,
}: UseAutoStartContainerOptions): void {
  const hasAttemptedRef = useRef(false);

  useEffect(() => {
    if (!autoStart) {
      hasAttemptedRef.current = false;
      return;
    }

    if (!status || loading) {
      return;
    }

    if (status.status === 'running') {
      hasAttemptedRef.current = false;
      return;
    }

    if (AUTO_START_ELIGIBLE_STATES.has(status.status) && !hasAttemptedRef.current) {
      hasAttemptedRef.current = true;
      startContainer();
    }
  }, [autoStart, status, loading, startContainer]);
}
