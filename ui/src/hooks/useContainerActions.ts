import type { Dispatch, SetStateAction } from 'react';
import { useCallback, useEffect, useMemo, useRef } from 'react';

import { log } from '../logger';
import { createContainerService } from '../services/containerService';
import type { ExtensionConfig, ContainerStatus, ServiceStatus } from '../types';
import { getDDClient } from '../services/dockerDesktopClient';
import { deriveContainerStatus } from '../utils/containerStatus';
import { retryWithBackoff } from '../utils/retry';

interface UseContainerActionsOptions {
  config: ExtensionConfig;
  status: ContainerStatus | null;
  setStatus: Dispatch<SetStateAction<ContainerStatus | null>>;
  fetchStatus: () => Promise<void>;
  runAsync: <T>(
    fn: () => Promise<T>,
    options?: { errorPrefix?: string; preserveMessage?: boolean },
  ) => Promise<T | undefined>;
  setMessage: Dispatch<SetStateAction<string | null>>;
  setError: Dispatch<SetStateAction<string | null>>;
  validateConfig: (config: ExtensionConfig) => string[];
  persistConfig: (config: ExtensionConfig) => ExtensionConfig;
  configsEqual: (a: ExtensionConfig, b: ExtensionConfig) => boolean;
  ensureIntegration: (options?: { force?: boolean }) => Promise<ServiceStatus | null>;
}

interface UseContainerActionsResult {
  startContainer: () => void;
  stopContainer: () => void;
  restartContainer: () => void;
  updateConfig: (nextConfig: ExtensionConfig) => Promise<void>;
  openBrowser: () => void;
}

export function useContainerActions({
  config,
  status,
  setStatus,
  fetchStatus,
  runAsync,
  setMessage,
  setError,
  validateConfig,
  persistConfig,
  configsEqual,
  ensureIntegration,
}: UseContainerActionsOptions): UseContainerActionsResult {
  const ddClient = getDDClient();
  const service = useMemo(() => createContainerService(), []);
  const refreshTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const scheduleStatusRefresh = useCallback(
    (delayMs: number) => {
      if (refreshTimeoutRef.current) {
        clearTimeout(refreshTimeoutRef.current);
      }

      refreshTimeoutRef.current = setTimeout(() => {
        refreshTimeoutRef.current = null;
        void fetchStatus();
      }, delayMs);
    },
    [fetchStatus],
  );

  const runServiceAction = useCallback(
    (
      action: () => Promise<void>,
      {
        successMessage,
        errorPrefix,
        delayMs = 1000,
      }: { successMessage: string; errorPrefix: string; delayMs?: number },
    ) => {
      void runAsync(
        async () => {
          try {
            await action();
            setMessage(successMessage);
            scheduleStatusRefresh(delayMs);
          } catch (err) {
            log.error(`${errorPrefix}:`, err);
            throw err;
          }
        },
        { errorPrefix },
      );
    },
    [runAsync, scheduleStatusRefresh, setMessage],
  );

  useEffect(() => {
    return () => {
      if (refreshTimeoutRef.current) {
        clearTimeout(refreshTimeoutRef.current);
      }
    };
  }, []);

  const pollForUpdatedStatus = useCallback(
    async (expectedConfig: ExtensionConfig, maxAttempts = 10, delayMs = 500) => {
      const boundedAttempts = Math.max(1, maxAttempts);
      const delays = Array.from({ length: Math.max(0, boundedAttempts - 1) }, () => delayMs);

      try {
        await retryWithBackoff(
          async () => {
            const inspection = await service.getContainerStatus();
            if (
              inspection.exists &&
              inspection.config.image === expectedConfig.image &&
              inspection.config.port === expectedConfig.port
            ) {
              setStatus(deriveContainerStatus(inspection, expectedConfig));
              return;
            }

            log.debug('Container status not updated yet; retrying...');
            throw new Error('Container status not updated yet');
          },
          {
            maxAttempts: boundedAttempts,
            delays,
            errorFactory: (lastError) =>
              lastError instanceof Error ? lastError : new Error(String(lastError)),
          },
        );
      } catch (err) {
        log.warn('Exhausted container status polling attempts; performing full refresh.', err);
        await fetchStatus();
      }
    },
    [fetchStatus, service, setStatus],
  );

  const startContainer = useCallback(() => {
    void runAsync(
      async () => {
        try {
          log.debug('Starting container with config:', config);
          const containerExists = await service.containerExists();
          log.debug('Container exists:', containerExists);

          if (!containerExists) {
            setMessage('Creating new container...');
            await service.createContainer(config);
            setMessage('Container created and started successfully');

            await ensureIntegration({ force: true });
          } else {
            await service.startContainer();
            setMessage('Container started successfully');
          }

          scheduleStatusRefresh(1000);
        } catch (err) {
          log.error('Start container error:', err);
          throw err;
        }
      },
      { errorPrefix: 'Failed to start container' },
    );
  }, [config, ensureIntegration, runAsync, scheduleStatusRefresh, service, setMessage]);

  const stopContainer = useCallback(() => {
    runServiceAction(() => service.stopContainer(), {
      successMessage: 'Container stopped successfully',
      errorPrefix: 'Failed to stop container',
    });
  }, [runServiceAction, service]);

  const restartContainer = useCallback(() => {
    runServiceAction(() => service.restartContainer(), {
      successMessage: 'Container restarted successfully',
      errorPrefix: 'Failed to restart container',
    });
  }, [runServiceAction, service]);

  const updateConfig = useCallback(
    async (nextConfig: ExtensionConfig) => {
      await runAsync(
        async () => {
          try {
            const validationErrors = validateConfig(nextConfig);
            if (validationErrors.length > 0) {
              throw new Error(`Configuration validation failed: ${validationErrors.join(', ')}`);
            }

            const configChanged = !configsEqual(config, nextConfig);
            const normalized = persistConfig(nextConfig);
            const containerExists = await service.containerExists();

            if (containerExists && configChanged) {
              setMessage('Configuration changed. Recreating container...');
              await service.recreateContainer(normalized);
              setMessage('Container recreated successfully with new configuration');
              void pollForUpdatedStatus(normalized);
            } else if (!containerExists) {
              setMessage(
                'Configuration saved. Container will be created with new settings when started.',
              );
              scheduleStatusRefresh(2000);
            } else {
              setMessage('Configuration updated successfully');
              scheduleStatusRefresh(2000);
            }
          } catch (err) {
            log.error('Update config error:', err);
            throw err;
          }
        },
        { errorPrefix: 'Failed to update configuration' },
      );
    },
    [
      config,
      configsEqual,
      persistConfig,
      pollForUpdatedStatus,
      runAsync,
      scheduleStatusRefresh,
      service,
      setMessage,
      validateConfig,
    ],
  );

  const openBrowser = useCallback(() => {
    try {
      const livePort = status?.config?.port || config.port;
      const url = `http://localhost:${livePort}`;
      Promise.resolve(ddClient.host.openExternal(url)).catch((err) => {
        log.error('Open browser error:', err);
        setError('Failed to open browser');
      });
    } catch (err) {
      log.error('Open browser error:', err);
      setError('Failed to open browser');
    }
  }, [config.port, ddClient, setError, status?.config?.port]);

  return {
    startContainer,
    stopContainer,
    restartContainer,
    updateConfig,
    openBrowser,
  };
}
