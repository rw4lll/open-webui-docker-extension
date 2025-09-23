import type { Dispatch, SetStateAction } from 'react';
import { useCallback, useEffect, useRef, useState } from 'react';

import { DMR_SETUP_MESSAGES } from '../constants';
import { log } from '../logger';
import { OpenWebUIApiService } from '../services/openWebUIApiService';
import type { ContainerStatus, ExtensionConfig, ServiceStatus } from '../types';

interface UseDockerModelRunnerOptions {
  config: ExtensionConfig;
  status: ContainerStatus | null;
  onMessage?: Dispatch<SetStateAction<string | null>>;
}

interface EnsureIntegrationOptions {
  force?: boolean;
}

interface UseDockerModelRunnerResult {
  service: OpenWebUIApiService | null;
  initializing: boolean;
  dmrStatus: ServiceStatus | null;
  ensureIntegration: (options?: EnsureIntegrationOptions) => Promise<ServiceStatus | null>;
  retryIntegration: () => Promise<void>;
}

export function useDockerModelRunner({
  config,
  status,
  onMessage,
}: UseDockerModelRunnerOptions): UseDockerModelRunnerResult {
  const [service, setService] = useState<OpenWebUIApiService | null>(null);
  const [initializing, setInitializing] = useState(false);
  const [dmrStatus, setDMRStatus] = useState<ServiceStatus | null>(null);
  const prevConnectedRef = useRef<boolean | undefined>(undefined);
  const mountedRef = useRef(true);

  useEffect(() => {
    return () => {
      mountedRef.current = false;
    };
  }, []);

  useEffect(() => {
    if (service) {
      return;
    }

    try {
      const apiService = new OpenWebUIApiService(config);
      setService(apiService);
      log.debug('OpenWebUIApiService initialized successfully');
    } catch (err) {
      log.error('Failed to initialize OpenWebUI API Service:', err);
    }
  }, [config, service]);

  useEffect(() => {
    if (!service) {
      return;
    }

    try {
      service.updateConfig(config);
    } catch (err) {
      log.error('Failed to update DMR service config:', err);
    }
  }, [service, config]);

  const applyIntegrationMessage = useCallback(
    (integration: ServiceStatus | null) => {
      if (!integration || !onMessage) {
        return;
      }

      if (integration.functionInstalled && integration.functionEnabled) {
        onMessage((prev) => {
          if (prev === DMR_SETUP_MESSAGES.installed_enabled) {
            return prev;
          }
          if (
            prev === DMR_SETUP_MESSAGES.not_installed ||
            prev === DMR_SETUP_MESSAGES.installed_disabled ||
            !prev
          ) {
            return DMR_SETUP_MESSAGES.installed_enabled;
          }
          return prev;
        });
        return;
      }

      if (integration.functionInstalled && !integration.functionEnabled) {
        onMessage((prev) => {
          if (prev === DMR_SETUP_MESSAGES.installed_disabled) {
            return prev;
          }
          return DMR_SETUP_MESSAGES.installed_disabled;
        });
        return;
      }

      onMessage((prev) => {
        if (prev === DMR_SETUP_MESSAGES.not_installed) {
          return prev;
        }
        return DMR_SETUP_MESSAGES.not_installed;
      });
    },
    [onMessage],
  );

  const ensureIntegration = useCallback(
    async ({ force }: EnsureIntegrationOptions = {}): Promise<ServiceStatus | null> => {
      if (!service) {
        return dmrStatus;
      }

      if (status?.status !== 'running') {
        log.debug('DMR setup skipped - container is not running');
        return dmrStatus;
      }

      if (!force) {
        if (initializing) {
          log.debug('DMR setup skipped - initialization already in progress');
          return dmrStatus;
        }

        if (dmrStatus && dmrStatus.containerRunning) {
          const freshness = Date.now() - dmrStatus.lastChecked;
          if (freshness < 30000) {
            log.debug('DMR setup skipped - last check was too recent', { freshness });
            return dmrStatus;
          }
        }

        if (dmrStatus?.functionInstalled && dmrStatus.functionEnabled) {
          log.debug('DMR setup skipped - already configured successfully');
          return dmrStatus;
        }
      }

      if (!mountedRef.current) {
        return dmrStatus;
      }

      setInitializing(true);

      try {
        const result = await service.setupDockerModelRunnerIntegration();
        if (mountedRef.current) {
          setDMRStatus(result);
        }
        applyIntegrationMessage(result);

        if (result.dockerModelRunnerConnected) {
          log.debug('✅ Docker Model Runner connectivity confirmed');
        } else {
          log.warn("⚠️  Docker Model Runner not detected - check if it's running");
        }

        try {
          const refreshed = await service.getServiceStatus();
          if (mountedRef.current) {
            setDMRStatus(refreshed);
          }
          applyIntegrationMessage(refreshed);
          return refreshed;
        } catch (err) {
          log.warn('Failed to refresh Docker Model Runner status after setup:', err);
        }

        return result;
      } catch (err) {
        log.error('Failed to setup Docker Model Runner integration:', err);
        log.warn('Docker Model Runner setup failed - continuing without DMR integration');
        const fallback: ServiceStatus = {
          containerRunning: true,
          functionInstalled: false,
          functionEnabled: false,
          dockerModelRunnerConnected: false,
          lastChecked: Date.now(),
        };
        if (mountedRef.current) {
          setDMRStatus(fallback);
        }
        applyIntegrationMessage(fallback);
        return fallback;
      } finally {
        if (mountedRef.current) {
          setInitializing(false);
        }
      }
    },
    [applyIntegrationMessage, service, status?.status, initializing, dmrStatus],
  );

  useEffect(() => {
    if (status?.status !== 'running') {
      return;
    }

    const timeoutId = setTimeout(() => {
      void ensureIntegration();
    }, 5000);

    return () => {
      clearTimeout(timeoutId);
    };
  }, [status?.status, ensureIntegration]);

  useEffect(() => {
    if (!service || status?.status !== 'running') {
      return;
    }

    let isMounted = true;

    const checkStatus = async () => {
      try {
        const current = await service.getServiceStatus();
        if (!isMounted) {
          return;
        }
        setDMRStatus(current);
        if (import.meta.env.DEV) {
          if (
            prevConnectedRef.current !== undefined &&
            current.dockerModelRunnerConnected !== prevConnectedRef.current
          ) {
            const connection = current.dockerModelRunnerConnected
              ? 'connected to'
              : 'disconnected from';
            log.debug(`Docker Model Runner ${connection}`);
          }
        }
        prevConnectedRef.current = current.dockerModelRunnerConnected;
      } catch (err) {
        log.warn('Failed to check Docker Model Runner status:', err);
      }
    };

    const intervalId = setInterval(() => {
      void checkStatus();
    }, 30000);

    return () => {
      isMounted = false;
      clearInterval(intervalId);
    };
  }, [service, status?.status]);

  useEffect(() => {
    prevConnectedRef.current = dmrStatus?.dockerModelRunnerConnected;
  }, [dmrStatus?.dockerModelRunnerConnected]);

  const retryIntegration = useCallback(async () => {
    if (!service) {
      return;
    }

    try {
      await service.ensureAuthToken();
    } catch (err) {
      log.warn('Failed to refresh auth token before retrying DMR setup:', err);
    }

    await ensureIntegration({ force: true });
  }, [service, ensureIntegration]);

  return {
    service,
    initializing,
    dmrStatus,
    ensureIntegration,
    retryIntegration,
  };
}
