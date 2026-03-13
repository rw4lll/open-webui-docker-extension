import { Alert, Box, Button, Stack, Tab, Tabs, Typography } from '@mui/material';
import { alpha } from '@mui/material/styles';
import type { SyntheticEvent } from 'react';
import { useCallback, useMemo, useState } from 'react';

import { AboutCard } from './components/AboutCard';
import ConfigCard from './components/ConfigCard';
import { FeedbackAlert } from './components/FeedbackAlert';
import PrimaryActionsCard from './components/PrimaryActionsCard';
import ServiceManagementCard from './components/ServiceManagementCard';
import { useAsyncFeedback } from './hooks/useAsyncFeedback';
import { useContainerStatus } from './hooks/useContainerStatus';
import { useContainerActions } from './hooks/useContainerActions';
import { useDockerModelRunner } from './hooks/useDockerModelRunner';
import { useDockerMcpToolkit } from './hooks/useDockerMcpToolkit';
import { useDmrWarmupGate } from './hooks/useDmrWarmupGate';
import { useExtensionConfig } from './hooks/useExtensionConfig';
import { useAutoStartContainer } from './hooks/useAutoStartContainer';
import { useImageUpdateCheck } from './hooks/useImageUpdateCheck';
import { createContainerService } from './services/containerService';
import { getDDClient } from './services/dockerDesktopClient';
import { ErrorBoundary } from './ErrorBoundary';
import { DMR_GATE_TIMEOUT_MS } from './constants';
import { log } from './logger';

type SettingsTab = 'config' | 'service';
const IMAGE_UPDATE_DISMISS_STORAGE_KEY = 'openwebui-extension-image-update-dismissed';

export function App() {
  const containerService = useMemo(() => createContainerService(), []);
  const { config, persistConfig, validateConfig, configsEqual } = useExtensionConfig();
  const { status, setStatus, fetchStatus, statusError, clearStatusError } = useContainerStatus(
    config,
    containerService,
  );
  const { loading, message, error, setMessage, clearMessage, setError, clearError, runAsync } =
    useAsyncFeedback();
  const {
    service: apiService,
    initializing: dmrInitializing,
    dmrStatus,
    gateMode: dmrGateMode,
    ensureIntegration,
    retryIntegration,
    clearCachedStatus,
  } = useDockerModelRunner({ config, status, onMessage: setMessage });
  const {
    initializing: mcpToolkitInitializing,
    manualSyncing: mcpToolkitManualSyncing,
    mcpStatus,
    retryIntegration: retryMcpToolkitIntegration,
    syncServers: syncMcpToolkitServers,
    clearCachedStatus: clearMcpToolkitCachedStatus,
  } = useDockerMcpToolkit({
    config,
    status,
    service: apiService,
  });
  const ddClient = useMemo(() => getDDClient(), []);

  const {
    startContainer,
    stopContainer,
    restartContainer,
    updateConfig,
    updateImageAndRecreate,
    openBrowser,
  } = useContainerActions({
    config,
    containerService,
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
    invalidateDMRCache: clearCachedStatus,
    invalidateMcpToolkitCache: clearMcpToolkitCachedStatus,
  });

  useAutoStartContainer({
    autoStart: config.autoStart,
    status,
    loading,
    startContainer,
  });

  const {
    imageUpdate,
    checking: imageUpdateChecking,
    checkNow: checkImageUpdateNow,
  } = useImageUpdateCheck(config, status, {}, containerService);

  const displayError = useMemo(() => error || statusError, [error, statusError]);
  const [activeSettingsTab, setActiveSettingsTab] = useState<SettingsTab>('config');
  const [dismissedImageUpdateId, setDismissedImageUpdateId] = useState<string>(() => {
    try {
      return localStorage.getItem(IMAGE_UPDATE_DISMISS_STORAGE_KEY) ?? '';
    } catch {
      return '';
    }
  });

  const imageUpdateBannerId = useMemo(() => {
    if (!imageUpdate?.supported || !imageUpdate.updateAvailable) {
      return '';
    }
    return `${imageUpdate.image}|${imageUpdate.localDigest ?? ''}|${imageUpdate.remoteDigest ?? ''}`;
  }, [imageUpdate]);
  const showImageUpdateBanner =
    imageUpdateBannerId.length > 0 && dismissedImageUpdateId !== imageUpdateBannerId;

  const containerRunning = status?.status === 'running';
  const hardGateRequested = containerRunning && dmrGateMode === 'hard';
  const { holdOpen: dmrHoldOpen } = useDmrWarmupGate(hardGateRequested, DMR_GATE_TIMEOUT_MS);

  const handleErrorAlertClose = useCallback(() => {
    clearError();
    clearStatusError();
  }, [clearError, clearStatusError]);

  const handleMessageAlertClose = useCallback(() => {
    clearMessage();
  }, [clearMessage]);

  const handleSettingsTabChange = useCallback((_: SyntheticEvent, value: SettingsTab) => {
    setActiveSettingsTab(value);
  }, []);

  const handleRetryDMR = useCallback(() => {
    void retryIntegration();
  }, [retryIntegration]);

  const handleRetryMcpToolkit = useCallback(() => {
    void retryMcpToolkitIntegration();
  }, [retryMcpToolkitIntegration]);

  const handleSyncMcpToolkit = useCallback(() => {
    void runAsync(
      async () => {
        const result = await syncMcpToolkitServers();
        if (result.outcome === 'synced') {
          setMessage('Docker MCP Toolkit servers synchronized from host.');
          return;
        }

        if (result.reason === 'container-not-running') {
          setMessage('Start the container before syncing Docker MCP Toolkit servers.');
          return;
        }
        if (result.reason === 'disabled') {
          setMessage('Enable Docker MCP Toolkit integration before syncing servers.');
          return;
        }
        setMessage('Docker MCP Toolkit service is not available yet. Try again in a moment.');
      },
      {
        errorPrefix: 'Failed to synchronize Docker MCP Toolkit servers',
      },
    );
  }, [runAsync, setMessage, syncMcpToolkitServers]);

  const handleUpdateAndRestart = useCallback(() => {
    void (async () => {
      const updated = await updateImageAndRecreate();
      if (updated) {
        await checkImageUpdateNow({ force: true });
      }
    })();
  }, [checkImageUpdateNow, updateImageAndRecreate]);

  const handleDismissImageUpdateBanner = useCallback(() => {
    if (!imageUpdateBannerId) {
      return;
    }
    setDismissedImageUpdateId(imageUpdateBannerId);
    try {
      localStorage.setItem(IMAGE_UPDATE_DISMISS_STORAGE_KEY, imageUpdateBannerId);
    } catch {
      // Ignore localStorage write failures and keep in-memory dismissal.
    }
  }, [imageUpdateBannerId]);

  const handleOpenExternal = useCallback(
    async (url: string) => {
      try {
        await Promise.resolve(ddClient.host.openExternal(url));
      } catch (err) {
        log.error('Failed to open external link:', err);
        setError('Failed to open external link');
      }
    },
    [ddClient, setError],
  );

  return (
    <Box sx={{ p: 3, maxWidth: 1200, mx: 'auto' }}>
      <Stack spacing={3}>
        <Box>
          <Typography
            variant="h3"
            gutterBottom
            sx={{ display: 'flex', alignItems: 'center', gap: 2 }}
          >
            Open WebUI Extension
          </Typography>

          <Typography variant="body1" color="text.secondary">
            Easily launch and manage Open WebUI with full Docker Model Runner integration. Start
            chatting with your AI models in just one click.
          </Typography>
        </Box>

        {showImageUpdateBanner && (
          <Alert severity="info" onClose={handleDismissImageUpdateBanner}>
            <Stack spacing={1} sx={{ pr: 1 }}>
              <Typography variant="body2">
                A new Open WebUI image version is available for {imageUpdate?.image}.
              </Typography>
              <Box sx={{ display: 'flex', alignItems: 'center', gap: 1 }}>
                <Button
                  size="small"
                  variant="contained"
                  onClick={handleUpdateAndRestart}
                  disabled={loading || imageUpdateChecking}
                >
                  Update & Restart
                </Button>
              </Box>
            </Stack>
          </Alert>
        )}
        <FeedbackAlert severity="error" message={displayError} onClose={handleErrorAlertClose} />
        <FeedbackAlert severity="success" message={message} onClose={handleMessageAlertClose} />

        <PrimaryActionsCard
          status={status}
          config={config}
          loading={loading}
          dmrStatus={dmrStatus}
          dmrInitializing={dmrInitializing}
          dmrGateMode={dmrGateMode}
          dmrHoldOpen={dmrHoldOpen}
          onSetup={startContainer}
          onOpen={openBrowser}
          onStop={stopContainer}
        />

        <Box
          sx={(theme) => ({
            borderRadius: 2,
            border: '1px solid',
            borderColor:
              theme.palette.mode === 'dark'
                ? alpha(theme.palette.primary.main, 0.25)
                : alpha(theme.palette.primary.light, 0.35),
            backgroundColor:
              theme.palette.mode === 'dark'
                ? alpha(theme.palette.background.default, 0.9)
                : alpha(theme.palette.background.paper, 0.98),
            boxShadow: theme.shadows[4],
            backdropFilter: 'blur(8px)',
          })}
        >
          <Tabs
            value={activeSettingsTab}
            onChange={handleSettingsTabChange}
            variant="fullWidth"
            sx={(theme) => ({
              borderBottom: '1px solid',
              borderColor: alpha(theme.palette.divider, 0.6),
              '& .MuiTab-root': {
                textTransform: 'none',
                fontWeight: 500,
              },
            })}
          >
            <Tab label="Configuration" value="config" />
            <Tab label="Service Management" value="service" />
          </Tabs>
          <Box sx={{ p: { xs: 2, md: 3 } }}>
            {activeSettingsTab === 'config' ? (
              <ConfigCard
                config={config}
                loading={loading}
                onUpdate={updateConfig}
                onSyncDockerMcpToolkit={handleSyncMcpToolkit}
                syncingDockerMcpToolkit={mcpToolkitManualSyncing}
                canSyncDockerMcpToolkit={status?.status === 'running'}
                validateConfig={validateConfig}
              />
            ) : (
              <ServiceManagementCard
                status={status}
                loading={loading}
                dmrInitializing={dmrInitializing}
                dmrStatus={dmrStatus}
                dmrGateMode={dmrGateMode}
                dmrHoldOpen={dmrHoldOpen}
                mcpToolkitInitializing={mcpToolkitInitializing}
                mcpToolkitStatus={mcpStatus}
                onStart={startContainer}
                onStop={stopContainer}
                onRestart={restartContainer}
                onRetryDMR={handleRetryDMR}
                onRetryMcpToolkit={handleRetryMcpToolkit}
              />
            )}
          </Box>
        </Box>

        <AboutCard onOpenUrl={handleOpenExternal} />
      </Stack>
    </Box>
  );
}

export function AppWithErrorBoundary() {
  return (
    <ErrorBoundary>
      <App />
    </ErrorBoundary>
  );
}
