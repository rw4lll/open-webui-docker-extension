import type { Dispatch, SetStateAction } from 'react';
import { useCallback, useEffect, useMemo, useState } from 'react';

import { log } from '../logger';
import { createContainerService, type ContainerService } from '../services/containerService';
import type { ContainerStatus, ExtensionConfig } from '../types';
import { deriveContainerStatus } from '../utils/containerStatus';

interface UseContainerStatusOptions {
  pollIntervalMs?: number;
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
  options: UseContainerStatusOptions = {},
  serviceOverride?: ContainerService,
): UseContainerStatusResult {
  const service = useMemo(() => serviceOverride ?? createContainerService(), [serviceOverride]);
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

  const { pollIntervalMs = 5000, initialDelayMs = 100 } = options;

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
    }, pollIntervalMs);

    return () => {
      isMounted = false;
      clearTimeout(timeoutId);
      clearInterval(intervalId);
    };
  }, [fetchStatus, initialDelayMs, pollIntervalMs]);

  const clearStatusError = useCallback(() => setStatusError(''), []);

  return {
    status,
    setStatus,
    fetchStatus,
    statusError,
    clearStatusError,
  };
}
