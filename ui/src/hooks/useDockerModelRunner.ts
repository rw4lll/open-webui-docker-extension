import type { Dispatch, SetStateAction } from 'react';
import { useCallback, useEffect, useRef, useState } from 'react';

import {
  DMR_POLL_INTERVAL_NOT_READY_MS,
  DMR_POLL_INTERVAL_READY_MS,
  DMR_SETUP_COOLDOWN_MS,
  DMR_SETUP_MESSAGES,
} from '../constants';
import { log } from '../logger';
import { createDMRConfigSignature, defaultDMRStatusCache } from '../services/dmrStatusCache';
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

export type DMRGateMode = 'hard' | 'soft' | 'none';

export interface UseDockerModelRunnerResult {
  service: OpenWebUIApiService | null;
  initializing: boolean;
  dmrStatus: ServiceStatus | null;
  gateMode: DMRGateMode;
  ensureIntegration: (options?: EnsureIntegrationOptions) => Promise<ServiceStatus | null>;
  retryIntegration: () => Promise<void>;
  clearCachedStatus: () => void;
}

export function isIntegrationConfigured(status: ServiceStatus | null | undefined): boolean {
  if (!status) {
    return false;
  }
  if (typeof status.integrationConfigured === 'boolean') {
    return status.integrationConfigured;
  }
  return status.functionInstalled && status.functionEnabled;
}

function statusMatchesProvisioner(
  status: ServiceStatus | null | undefined,
  provisioner: ExtensionConfig['provisioner'],
): boolean {
  if (!status) {
    return false;
  }

  if (status.provisionerMode) {
    return status.provisionerMode === provisioner;
  }

  // Backward compatibility: older status payloads were legacy-function only.
  return provisioner === 'legacy-function';
}

function isDMRReady(status: ServiceStatus | null | undefined): boolean {
  if (!status) {
    return false;
  }
  return Boolean(
    status.containerRunning && isIntegrationConfigured(status) && status.dockerModelRunnerConnected,
  );
}

export function useDockerModelRunner({
  config,
  status,
  onMessage,
}: UseDockerModelRunnerOptions): UseDockerModelRunnerResult {
  const configSignature = createDMRConfigSignature(config);
  const [service, setService] = useState<OpenWebUIApiService | null>(null);
  const [initializing, setInitializing] = useState(false);
  const [dmrStatus, setDMRStatus] = useState<ServiceStatus | null>(null);
  const [gateMode, setGateMode] = useState<DMRGateMode>('none');
  const prevConnectedRef = useRef<boolean | undefined>(undefined);
  const dmrStatusRef = useRef<ServiceStatus | null>(null);
  const setupAttemptedAtRef = useRef(0);
  const inFlightRef = useRef<Promise<ServiceStatus | null> | null>(null);
  const trustedCacheRef = useRef(false);
  const mountedRef = useRef(true);
  const statusRef = useRef(status);
  const runIdRef = useRef(0);

  useEffect(() => {
    dmrStatusRef.current = dmrStatus;
  }, [dmrStatus]);

  useEffect(() => {
    statusRef.current = status;
  }, [status]);

  const prevConfigSignatureRef = useRef(configSignature);
  useEffect(() => {
    if (prevConfigSignatureRef.current !== configSignature) {
      prevConfigSignatureRef.current = configSignature;
      runIdRef.current += 1;
    }
  }, [configSignature]);

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

  const clearCachedStatus = useCallback(() => {
    trustedCacheRef.current = false;
    defaultDMRStatusCache.clear();
  }, []);

  const applyIntegrationMessage = useCallback(
    (integration: ServiceStatus | null) => {
      if (!integration || !onMessage) {
        return;
      }

      const mode = integration.provisionerMode ?? config.provisioner;
      const configured = isIntegrationConfigured(integration);

      if (mode === 'openai') {
        onMessage((prev) => {
          const target = configured
            ? DMR_SETUP_MESSAGES.openai_configured
            : DMR_SETUP_MESSAGES.openai_not_configured;
          if (prev === target) {
            return prev;
          }
          return target;
        });
        return;
      }

      if (integration.functionInstalled && integration.functionEnabled) {
        onMessage((prev) => {
          if (prev === DMR_SETUP_MESSAGES.legacy_installed_enabled) {
            return prev;
          }
          if (
            prev === DMR_SETUP_MESSAGES.legacy_not_installed ||
            prev === DMR_SETUP_MESSAGES.legacy_installed_disabled ||
            !prev
          ) {
            return DMR_SETUP_MESSAGES.legacy_installed_enabled;
          }
          return prev;
        });
        return;
      }

      if (integration.functionInstalled && !integration.functionEnabled) {
        onMessage((prev) => {
          if (prev === DMR_SETUP_MESSAGES.legacy_installed_disabled) {
            return prev;
          }
          return DMR_SETUP_MESSAGES.legacy_installed_disabled;
        });
        return;
      }

      onMessage((prev) => {
        if (prev === DMR_SETUP_MESSAGES.legacy_not_installed) {
          return prev;
        }
        return DMR_SETUP_MESSAGES.legacy_not_installed;
      });
    },
    [onMessage, config.provisioner],
  );

  const commitStatus = useCallback(
    (
      next: ServiceStatus,
      options: { fromCache?: boolean; source?: string; runId?: number } = {},
    ) => {
      if (!mountedRef.current) {
        return;
      }

      if (options.runId !== undefined) {
        if (
          statusRef.current?.status !== 'running' ||
          runIdRef.current !== options.runId
        ) {
          log.debug('DMR commit skipped - stale run (container stopped or superseded)', {
            runId: options.runId,
            currentRunId: runIdRef.current,
            containerStatus: statusRef.current?.status,
          });
          return;
        }
      }

      setDMRStatus(next);
      dmrStatusRef.current = next;
      applyIntegrationMessage(next);

      if (import.meta.env.DEV) {
        if (
          prevConnectedRef.current !== undefined &&
          next.dockerModelRunnerConnected !== prevConnectedRef.current
        ) {
          const connection = next.dockerModelRunnerConnected ? 'connected to' : 'disconnected from';
          log.debug(`Docker Model Runner ${connection}`, { source: options.source ?? 'unknown' });
        }
      }
      prevConnectedRef.current = next.dockerModelRunnerConnected;

      if (options.fromCache) {
        return;
      }

      if (isDMRReady(next)) {
        trustedCacheRef.current = true;
        defaultDMRStatusCache.set({
          status: next,
          configSignature,
          containerStateHint: 'running',
          checkedAt: next.lastChecked || Date.now(),
        });
      } else {
        clearCachedStatus();
      }
    },
    [applyIntegrationMessage, clearCachedStatus, configSignature],
  );

  const ensureIntegration = useCallback(
    async ({ force }: EnsureIntegrationOptions = {}): Promise<ServiceStatus | null> => {
      if (!service) {
        return dmrStatusRef.current;
      }

      if (status?.status !== 'running') {
        log.debug('DMR setup skipped - container is not running');
        return dmrStatusRef.current;
      }

      if (inFlightRef.current) {
        if (!force) {
          log.debug('DMR check skipped - operation already in progress');
        }
        return inFlightRef.current;
      }

      if (!mountedRef.current) {
        return dmrStatusRef.current;
      }

      const run = async (): Promise<ServiceStatus | null> => {
        const runId = (runIdRef.current += 1);
        const isRunCurrent = () =>
          mountedRef.current &&
          runIdRef.current === runId &&
          statusRef.current?.status === 'running';

        setInitializing(true);

        try {
          const previous = dmrStatusRef.current;
          const hasPreviousStatus = Boolean(previous);
          const previousReady = isDMRReady(previous);
          const matchesProvisioner =
            !hasPreviousStatus || statusMatchesProvisioner(previous, config.provisioner);

          if (!matchesProvisioner && isRunCurrent()) {
            setGateMode('hard');
            log.debug('DMR setup will run because provisioner mode changed', {
              previous: previous?.provisionerMode ?? 'unknown',
              next: config.provisioner,
            });
          }

          if (force) {
            if (isRunCurrent()) {
              setGateMode('hard');
            }
            clearCachedStatus();
          }

          let verified: ServiceStatus | null = null;
          try {
            verified = await service.verifyDockerModelRunnerIntegration();
            if (!isRunCurrent()) {
              log.debug('Skipping stale DMR verify result', {
                runId,
                currentRunId: runIdRef.current,
                containerStatus: statusRef.current?.status,
              });
              return dmrStatusRef.current;
            }
            commitStatus(verified, { source: 'verify', runId });
          } catch (err) {
            log.warn('Failed to verify Docker Model Runner status:', err);
          }

          if (verified && isDMRReady(verified) && matchesProvisioner) {
            if (isRunCurrent()) {
              setGateMode('none');
            }
            log.debug('DMR verify succeeded - full setup skipped');
            return verified;
          }

          if (!isRunCurrent()) {
            return verified ?? dmrStatusRef.current;
          }

          if (force || !previousReady || !trustedCacheRef.current) {
            setGateMode('hard');
          } else {
            setGateMode('soft');
          }

          if (!force) {
            const lastSetupAgo = Date.now() - setupAttemptedAtRef.current;
            if (lastSetupAgo < DMR_SETUP_COOLDOWN_MS) {
              log.debug('DMR full setup skipped due cooldown', { lastSetupAgo });
              if (previousReady && isRunCurrent()) {
                setGateMode('soft');
              }
              return verified ?? dmrStatusRef.current;
            }
          }

          if (!isRunCurrent()) {
            return verified ?? dmrStatusRef.current;
          }

          setupAttemptedAtRef.current = Date.now();

          try {
            const result = await service.setupDockerModelRunnerIntegration();
            if (!isRunCurrent()) {
              log.debug('Skipping stale DMR setup result', {
                runId,
                currentRunId: runIdRef.current,
                containerStatus: statusRef.current?.status,
              });
              return dmrStatusRef.current;
            }
            commitStatus(result, { source: 'setup', runId });

            if (isDMRReady(result)) {
              if (isRunCurrent()) {
                setGateMode('none');
              }
              return result;
            }

            log.warn('DMR full setup completed but integration is still not ready');
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
              integrationConfigured: false,
              provisionerMode: config.provisioner,
            };
            commitStatus(fallback, { source: 'setup-fallback', runId });
            return fallback;
          }
        } finally {
          if (mountedRef.current) {
            setInitializing(false);
          }
        }
      };

      const inFlightPromise = run().finally(() => {
        if (inFlightRef.current === inFlightPromise) {
          inFlightRef.current = null;
        }
      });
      inFlightRef.current = inFlightPromise;
      return inFlightPromise;
    },
    [
      clearCachedStatus,
      commitStatus,
      config.provisioner,
      service,
      status?.status,
      setupAttemptedAtRef,
    ],
  );

  useEffect(() => {
    if (status?.status === 'running') {
      return;
    }

    runIdRef.current += 1;
    if (status) {
      clearCachedStatus();
    }

    setGateMode('none');
    setDMRStatus(null);
    dmrStatusRef.current = null;
    setInitializing(false);
  }, [status, clearCachedStatus]);

  useEffect(() => {
    if (status?.status !== 'running') {
      return;
    }

    const cached = defaultDMRStatusCache.get(configSignature);
    const trustedCacheReady = Boolean(
      cached && isDMRReady(cached.status) && statusMatchesProvisioner(cached.status, config.provisioner),
    );

    trustedCacheRef.current = trustedCacheReady;
    setGateMode(trustedCacheReady ? 'soft' : 'hard');
    log.debug('DMR gate mode initialized from cache', {
      gate: trustedCacheReady ? 'soft' : 'hard',
      hasCache: Boolean(cached),
      trustedCacheReady,
    });

    if (cached) {
      commitStatus(cached.status, { fromCache: true, source: 'cache' });
    }
  }, [status?.status, config.provisioner, configSignature, commitStatus]);

  useEffect(() => {
    if (!service || status?.status !== 'running') {
      return;
    }

    void ensureIntegration();
  }, [service, status?.status, configSignature, ensureIntegration]);

  const dmrReady = isDMRReady(dmrStatus);
  const dmrPollIntervalMs = dmrReady ? DMR_POLL_INTERVAL_READY_MS : DMR_POLL_INTERVAL_NOT_READY_MS;

  useEffect(() => {
    if (!service || status?.status !== 'running') {
      return;
    }

    const intervalId = setInterval(() => {
      void ensureIntegration();
    }, dmrPollIntervalMs);

    return () => {
      clearInterval(intervalId);
    };
  }, [dmrPollIntervalMs, ensureIntegration, service, status?.status]);

  useEffect(() => {
    prevConnectedRef.current = dmrStatus?.dockerModelRunnerConnected;
  }, [dmrStatus?.dockerModelRunnerConnected]);

  const retryIntegration = useCallback(async () => {
    if (!service) {
      return;
    }

    clearCachedStatus();
    setGateMode('hard');

    try {
      await service.ensureAuthToken();
    } catch (err) {
      log.warn('Failed to refresh auth token before retrying DMR setup:', err);
    }

    await ensureIntegration({ force: true });
  }, [clearCachedStatus, ensureIntegration, service]);

  return {
    service,
    initializing,
    dmrStatus,
    gateMode,
    ensureIntegration,
    retryIntegration,
    clearCachedStatus,
  };
}
