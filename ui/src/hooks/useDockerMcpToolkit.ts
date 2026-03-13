import type { Dispatch, SetStateAction } from 'react';
import { useCallback, useEffect, useRef, useState } from 'react';

import {
  MCP_TOOLKIT_POLL_INTERVAL_NOT_READY_MS,
  MCP_TOOLKIT_POLL_INTERVAL_READY_MS,
  MCP_TOOLKIT_SETUP_COOLDOWN_MS,
  MCP_TOOLKIT_SETUP_MESSAGES,
} from '../constants';
import { log } from '../logger';
import {
  createMcpToolkitConfigSignature,
  defaultMcpToolkitStatusCache,
} from '../services/mcpToolkitStatusCache';
import type { OpenWebUIApiService } from '../services/openWebUIApiService';
import type { ContainerStatus, DockerMcpToolkitStatus, ExtensionConfig } from '../types';
import { isDockerMcpToolkitReady } from '../utils/mcpToolkitStatus';

interface UseDockerMcpToolkitOptions {
  config: ExtensionConfig;
  status: ContainerStatus | null;
  service: OpenWebUIApiService | null;
  onMessage?: Dispatch<SetStateAction<string | null>>;
}

interface EnsureIntegrationOptions {
  force?: boolean;
}

export type DockerMcpToolkitSyncSkipReason =
  | 'service-unavailable'
  | 'container-not-running'
  | 'disabled';

export type DockerMcpToolkitSyncResult =
  | { outcome: 'synced'; status: DockerMcpToolkitStatus | null }
  | { outcome: 'skipped'; reason: DockerMcpToolkitSyncSkipReason };

export interface UseDockerMcpToolkitResult {
  initializing: boolean;
  manualSyncing: boolean;
  mcpStatus: DockerMcpToolkitStatus | null;
  ensureIntegration: (options?: EnsureIntegrationOptions) => Promise<DockerMcpToolkitStatus | null>;
  retryIntegration: () => Promise<void>;
  syncServers: () => Promise<DockerMcpToolkitSyncResult>;
  clearCachedStatus: () => void;
}

function applySetupMessage(
  status: DockerMcpToolkitStatus | null,
  setMessage: Dispatch<SetStateAction<string | null>> | undefined,
): void {
  if (!status || !setMessage) {
    return;
  }

  let message: string = MCP_TOOLKIT_SETUP_MESSAGES.needs_attention;
  if (!status.enabled) {
    message = MCP_TOOLKIT_SETUP_MESSAGES.disabled;
  } else if (status.integrationConfigured) {
    message = MCP_TOOLKIT_SETUP_MESSAGES.configured;
  } else if (!status.supported) {
    message = MCP_TOOLKIT_SETUP_MESSAGES.unsupported;
  }

  setMessage((prev) => (prev === message ? prev : message));
}

export function useDockerMcpToolkit({
  config,
  status,
  service,
  onMessage,
}: UseDockerMcpToolkitOptions): UseDockerMcpToolkitResult {
  const configSignature = createMcpToolkitConfigSignature(config);
  const [initializing, setInitializing] = useState(false);
  const [manualSyncing, setManualSyncing] = useState(false);
  const [mcpStatus, setMcpStatus] = useState<DockerMcpToolkitStatus | null>(null);
  const statusRef = useRef(status);
  const mcpStatusRef = useRef<DockerMcpToolkitStatus | null>(null);
  const prevReadyRef = useRef<boolean | undefined>(undefined);
  const inFlightRef = useRef<Promise<DockerMcpToolkitStatus | null> | null>(null);
  const setupAttemptedAtRef = useRef(0);
  const mountedRef = useRef(true);
  const runIdRef = useRef(0);

  useEffect(() => {
    statusRef.current = status;
  }, [status]);

  useEffect(() => {
    mcpStatusRef.current = mcpStatus;
  }, [mcpStatus]);

  useEffect(() => {
    return () => {
      mountedRef.current = false;
    };
  }, []);

  const clearCachedStatus = useCallback(() => {
    defaultMcpToolkitStatusCache.clear();
  }, []);

  const prevConfigSignatureRef = useRef(configSignature);
  useEffect(() => {
    if (prevConfigSignatureRef.current === configSignature) {
      return;
    }

    prevConfigSignatureRef.current = configSignature;
    runIdRef.current += 1;
    setupAttemptedAtRef.current = 0;
    clearCachedStatus();
    service?.clearDockerMcpToolkitCache();
  }, [clearCachedStatus, configSignature, service]);

  const commitStatus = useCallback(
    (
      next: DockerMcpToolkitStatus,
      options: { fromCache?: boolean; source?: string; runId?: number } = {},
    ) => {
      if (!mountedRef.current) {
        return;
      }

      if (options.runId !== undefined) {
        if (statusRef.current?.status !== 'running' || runIdRef.current !== options.runId) {
          log.debug('MCP Toolkit commit skipped - stale run', {
            runId: options.runId,
            currentRunId: runIdRef.current,
            containerStatus: statusRef.current?.status,
            source: options.source,
          });
          return;
        }
      }

      setMcpStatus(next);
      mcpStatusRef.current = next;
      applySetupMessage(next, onMessage);
      const ready = isDockerMcpToolkitReady(next);
      if (prevReadyRef.current !== ready) {
        if (ready) {
          log.info('Docker MCP Toolkit integration is ready', {
            gatewayUrl: next.gatewayUrl,
          });
        } else {
          log.warn('Docker MCP Toolkit integration is not ready', {
            message: next.message,
            details: next.details,
          });
        }
      }
      prevReadyRef.current = ready;

      if (options.fromCache) {
        return;
      }

      if (isDockerMcpToolkitReady(next)) {
        defaultMcpToolkitStatusCache.set({
          status: next,
          configSignature,
          containerStateHint: 'running',
          checkedAt: next.lastChecked || Date.now(),
        });
      } else {
        clearCachedStatus();
      }
    },
    [clearCachedStatus, configSignature, onMessage],
  );

  const ensureIntegration = useCallback(
    async ({ force }: EnsureIntegrationOptions = {}): Promise<DockerMcpToolkitStatus | null> => {
      if (!service) {
        return mcpStatusRef.current;
      }

      if (status?.status !== 'running') {
        return mcpStatusRef.current;
      }

      if (inFlightRef.current) {
        return inFlightRef.current;
      }

      const run = async (): Promise<DockerMcpToolkitStatus | null> => {
        const runId = (runIdRef.current += 1);
        const isRunCurrent = () =>
          mountedRef.current &&
          runIdRef.current === runId &&
          statusRef.current?.status === 'running';

        setInitializing(true);
        try {
          if (force) {
            clearCachedStatus();
            service.clearDockerMcpToolkitCache();
          }

          let verified: DockerMcpToolkitStatus | null = null;
          try {
            verified = await service.verifyDockerMcpToolkitIntegration();
            if (!isRunCurrent()) {
              return mcpStatusRef.current;
            }
            commitStatus(verified, { source: 'verify', runId });
          } catch (error) {
            log.warn('Failed to verify Docker MCP Toolkit integration:', error);
          }

          if (verified && isDockerMcpToolkitReady(verified)) {
            return verified;
          }

          if (!isRunCurrent()) {
            return verified ?? mcpStatusRef.current;
          }

          const pendingDisableCleanup =
            verified?.enabled === false && verified.integrationConfigured === false;

          if (!force && !pendingDisableCleanup) {
            const lastSetupAgo = Date.now() - setupAttemptedAtRef.current;
            if (lastSetupAgo < MCP_TOOLKIT_SETUP_COOLDOWN_MS) {
              return verified ?? mcpStatusRef.current;
            }
          }

          setupAttemptedAtRef.current = Date.now();
          try {
            const setupResult = await service.setupDockerMcpToolkitIntegration();
            if (!isRunCurrent()) {
              return mcpStatusRef.current;
            }
            commitStatus(setupResult, { source: 'setup', runId });
            return setupResult;
          } catch (error) {
            log.error('Failed to setup Docker MCP Toolkit integration:', error);
            return verified ?? mcpStatusRef.current;
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
    [clearCachedStatus, commitStatus, service, status?.status],
  );

  useEffect(() => {
    if (status?.status === 'running') {
      return;
    }

    runIdRef.current += 1;
    clearCachedStatus();
    setMcpStatus(null);
    mcpStatusRef.current = null;
    prevReadyRef.current = undefined;
    setInitializing(false);
    setManualSyncing(false);
  }, [clearCachedStatus, status?.status]);

  useEffect(() => {
    if (!service || config.enableDockerMcpToolkit !== false) {
      return;
    }

    void service.stopDockerMcpToolkitGatewayContainer().catch((error) => {
      log.warn('Failed to remove managed Docker MCP Toolkit gateway container after disabling toggle', error);
    });
  }, [config.enableDockerMcpToolkit, service]);

  useEffect(() => {
    if (!service || status?.status !== 'running') {
      return;
    }

    const cached = defaultMcpToolkitStatusCache.get(configSignature);
    if (cached) {
      commitStatus(cached.status, { fromCache: true, source: 'cache' });
    }
  }, [commitStatus, configSignature, service, status?.status]);

  useEffect(() => {
    if (!service || status?.status !== 'running') {
      return;
    }

    void ensureIntegration();
  }, [configSignature, ensureIntegration, service, status?.status]);

  const mcpReady = isDockerMcpToolkitReady(mcpStatus);
  const pollIntervalMs = mcpReady
    ? MCP_TOOLKIT_POLL_INTERVAL_READY_MS
    : MCP_TOOLKIT_POLL_INTERVAL_NOT_READY_MS;

  useEffect(() => {
    if (!service || status?.status !== 'running') {
      return;
    }

    const intervalId = setInterval(() => {
      void ensureIntegration();
    }, pollIntervalMs);

    return () => {
      clearInterval(intervalId);
    };
  }, [ensureIntegration, pollIntervalMs, service, status?.status]);

  const retryIntegration = useCallback(async () => {
    if (!service) {
      return;
    }

    clearCachedStatus();
    try {
      await service.ensureAuthToken();
    } catch (error) {
      log.warn('Failed to refresh auth token before retrying MCP Toolkit setup:', error);
    }

    await ensureIntegration({ force: true });
  }, [clearCachedStatus, ensureIntegration, service]);

  const syncServers = useCallback(async (): Promise<DockerMcpToolkitSyncResult> => {
    if (!service) {
      return { outcome: 'skipped', reason: 'service-unavailable' };
    }
    if (statusRef.current?.status !== 'running') {
      return { outcome: 'skipped', reason: 'container-not-running' };
    }
    if (!config.enableDockerMcpToolkit) {
      return { outcome: 'skipped', reason: 'disabled' };
    }

    setManualSyncing(true);

    const currentInFlight = inFlightRef.current;
    if (currentInFlight) {
      try {
        await currentInFlight;
      } catch {
        // Continue with explicit sync flow even if a previous run failed.
      }
    }

    clearCachedStatus();
    service.clearDockerMcpToolkitCache();
    try {
      await service.ensureAuthToken();
    } catch (error) {
      log.warn('Failed to refresh auth token before syncing MCP Toolkit servers:', error);
    }

    try {
      await service.stopDockerMcpToolkitGatewayContainer();
    } catch (error) {
      log.warn('Failed to remove managed Docker MCP Toolkit gateway container before sync:', error);
    }

    try {
      const syncedStatus = await ensureIntegration({ force: true });
      return { outcome: 'synced', status: syncedStatus };
    } finally {
      if (mountedRef.current) {
        setManualSyncing(false);
      }
    }
  }, [clearCachedStatus, config.enableDockerMcpToolkit, ensureIntegration, service]);

  return {
    initializing,
    manualSyncing,
    mcpStatus,
    ensureIntegration,
    retryIntegration,
    syncServers,
    clearCachedStatus,
  };
}

