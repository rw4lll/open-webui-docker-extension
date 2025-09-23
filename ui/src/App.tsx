import { Box, Stack, Tab, Tabs, Typography } from '@mui/material';
import { alpha } from '@mui/material/styles';
import type { SyntheticEvent } from 'react';
import { useCallback, useEffect, useMemo, useState } from 'react';

import { AboutCard } from './components/AboutCard';
import ConfigCard from './components/ConfigCard';
import { FeedbackAlert } from './components/FeedbackAlert';
import PrimaryActionsCard from './components/PrimaryActionsCard';
import ServiceManagementCard from './components/ServiceManagementCard';
import { useAsyncFeedback } from './hooks/useAsyncFeedback';
import { useContainerStatus } from './hooks/useContainerStatus';
import { useContainerActions } from './hooks/useContainerActions';
import { useDockerModelRunner } from './hooks/useDockerModelRunner';
import { useExtensionConfig } from './hooks/useExtensionConfig';
import { useAutoStartContainer } from './hooks/useAutoStartContainer';
import { getDDClient } from './services/dockerDesktopClient';
import { ErrorBoundary } from './ErrorBoundary';
import { DMR_GATE_TIMEOUT_MS } from './constants';
import { log } from './logger';

type SettingsTab = 'config' | 'service';

export function App() {
  const { config, persistConfig, validateConfig, configsEqual } = useExtensionConfig();
  const { status, setStatus, fetchStatus, statusError, clearStatusError } =
    useContainerStatus(config);
  const { loading, message, error, setMessage, clearMessage, setError, clearError, runAsync } =
    useAsyncFeedback();
  const {
    initializing: dmrInitializing,
    dmrStatus,
    ensureIntegration,
    retryIntegration,
  } = useDockerModelRunner({ config, status, onMessage: setMessage });
  const ddClient = useMemo(() => getDDClient(), []);

  const { startContainer, stopContainer, restartContainer, updateConfig, openBrowser } =
    useContainerActions({
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
    });

  useAutoStartContainer({
    autoStart: config.autoStart,
    status,
    loading,
    startContainer,
  });

  const displayError = useMemo(() => error || statusError, [error, statusError]);
  const [activeSettingsTab, setActiveSettingsTab] = useState<SettingsTab>('config');

  const dmrReady = useMemo(
    () =>
      Boolean(
        dmrStatus &&
          dmrStatus.functionInstalled &&
          dmrStatus.functionEnabled &&
          dmrStatus.dockerModelRunnerConnected,
      ),
    [dmrStatus],
  );

  const containerRunning = status?.status === 'running';
  const { holdOpen: dmrHoldOpen, remainingMs: dmrHoldRemainingMs } = useDmrWarmupGate(
    containerRunning,
    dmrReady,
    DMR_GATE_TIMEOUT_MS,
  );

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

        <FeedbackAlert severity="error" message={displayError} onClose={handleErrorAlertClose} />
        <FeedbackAlert severity="success" message={message} onClose={handleMessageAlertClose} />

        <PrimaryActionsCard
          status={status}
          config={config}
          loading={loading}
          dmrStatus={dmrStatus}
          dmrInitializing={dmrInitializing}
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
                validateConfig={validateConfig}
              />
            ) : (
              <ServiceManagementCard
                status={status}
                loading={loading}
                dmrInitializing={dmrInitializing}
                dmrStatus={dmrStatus}
                dmrHoldOpen={dmrHoldOpen}
                onStart={startContainer}
                onStop={stopContainer}
                onRestart={restartContainer}
                onRetryDMR={handleRetryDMR}
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

function useDmrWarmupGate(
  containerRunning: boolean,
  dmrReady: boolean,
  holdDurationMs: number,
): { holdOpen: boolean; remainingMs: number } {
  const [startedAt, setStartedAt] = useState<number | null>(null);
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    if (containerRunning && !dmrReady) {
      setStartedAt((prev) => (prev === null ? Date.now() : prev));
    } else {
      setStartedAt(null);
    }
  }, [containerRunning, dmrReady]);

  useEffect(() => {
    if (startedAt === null) {
      return;
    }

    let intervalId: number | undefined;

    const tick = () => {
      const current = Date.now();
      setNow(current);
      if (intervalId !== undefined && current - startedAt >= holdDurationMs) {
        window.clearInterval(intervalId);
        intervalId = undefined;
      }
    };

    tick();
    intervalId = window.setInterval(tick, 1000);

    return () => {
      if (intervalId !== undefined) {
        window.clearInterval(intervalId);
      }
    };
  }, [holdDurationMs, startedAt]);

  const elapsedMs = startedAt !== null ? Math.max(0, now - startedAt) : 0;
  const holdOpen =
    containerRunning && !dmrReady && startedAt !== null && elapsedMs < holdDurationMs;
  const remainingMs = holdOpen ? Math.max(0, holdDurationMs - elapsedMs) : 0;

  return { holdOpen, remainingMs };
}
