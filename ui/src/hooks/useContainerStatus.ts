import type { Dispatch, SetStateAction } from 'react';
import { useCallback, useEffect, useState } from 'react';

import {
  CONTAINER_POLL_INTERVAL_RUNNING_MS,
  CONTAINER_POLL_INTERVAL_TRANSIENT_MS,
} from '../constants';
import { log } from '../logger';
import type { ContainerService } from '../services/containerService';
import type { ContainerStatus, ExtensionConfig } from '../types';
import { deriveContainerStatus } from '../utils/containerStatus';

interface UseContainerStatusOptions {
  transientPollIntervalMs?: number;
  runningPollIntervalMs?: number;
  initialDelayMs?: number;
}

interface UseContainerStatusResult {
  status: ContainerStatus | null;
  setStatus: Dispatch<SetStateAction<ContainerStatus | null>>;
  fetchStatus: () => Promise<void>;
  statusError: string;
  clearStatusError: () => void;
}

export function useContainerStatus(
  config: ExtensionConfig,
  service: ContainerService,
  options: UseContainerStatusOptions = {},
): UseContainerStatusResult {
  const [status, setStatus] = useState<ContainerStatus | null>(null);
  const [statusError, setStatusError] = useState('');

  const fetchStatus = useCallback(async () => {
    try {
      const inspection = await service.getContainerStatus();
      setStatus(deriveContainerStatus(inspection, config));
      setStatusError('');
    } catch (err) {
      log.error('Fetch status error:', err);
      const rawMessage = err instanceof Error ? err.message : String(err);
      setStatusError(`Failed to fetch status: ${rawMessage}`);
    }
  }, [config, service]);

  const {
    transientPollIntervalMs = CONTAINER_POLL_INTERVAL_TRANSIENT_MS,
    runningPollIntervalMs = CONTAINER_POLL_INTERVAL_RUNNING_MS,
    initialDelayMs = 100,
  } = options;

  const effectivePollIntervalMs =
    status?.status === 'running' ? runningPollIntervalMs : transientPollIntervalMs;

  useEffect(() => {
    let isMounted = true;
    const timeoutId = setTimeout(() => {
      if (isMounted) {
        fetchStatus();
      }
    }, initialDelayMs);

    const intervalId = setInterval(() => {
      if (isMounted) {
        fetchStatus();
      }
    }, effectivePollIntervalMs);

    return () => {
      isMounted = false;
      clearTimeout(timeoutId);
      clearInterval(intervalId);
    };
  }, [effectivePollIntervalMs, fetchStatus, initialDelayMs]);

  const clearStatusError = useCallback(() => setStatusError(''), []);

  return {
    status,
    setStatus,
    fetchStatus,
    statusError,
    clearStatusError,
  };
}
