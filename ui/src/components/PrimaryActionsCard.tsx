import { OpenInNew, RocketLaunch } from '@mui/icons-material';
import { Box, Button, Card, Chip, CircularProgress, Stack, Typography } from '@mui/material';
import { alpha } from '@mui/material/styles';

import type { ContainerState, ContainerStatus, ExtensionConfig, ServiceStatus } from '../types';

interface PrimaryActionsCardProps {
  status: ContainerStatus | null;
  config: ExtensionConfig;
  loading: boolean;
  onSetup: () => void;
  onOpen: () => void;
  onStop: () => void;
  dmrStatus?: ServiceStatus | null;
  dmrInitializing?: boolean;
  dmrHoldOpen?: boolean;
  dmrHoldRemainingMs?: number;
}

const STATUS_LABELS: Partial<Record<ContainerState, string>> = {
  running: 'Running',
  paused: 'Paused',
  restarting: 'Restarting',
  stopped: 'Stopped',
  exited: 'Stopped',
  created: 'Created',
  not_found: 'Not Installed',
};

const STATUS_CHIP_COLOR: Partial<
  Record<ContainerState, 'success' | 'warning' | 'info' | 'default'>
> = {
  running: 'success',
  paused: 'warning',
  restarting: 'info',
  stopped: 'warning',
  exited: 'warning',
  created: 'info',
  not_found: 'default',
};

export function PrimaryActionsCard({
  status,
  config,
  loading,
  onSetup,
  onOpen,
  onStop,
  dmrStatus,
  dmrInitializing,
  dmrHoldOpen,
}: PrimaryActionsCardProps) {
  const containerState = status?.status;
  const isRunning = containerState === 'running';
  const needsSetup = !status || containerState === 'not_found';
  const needsStart =
    !needsSetup &&
    containerState !== 'running' &&
    containerState !== 'restarting' &&
    containerState !== 'paused';
  const effectiveConfig = status?.config ?? config;

  const dmrReady = Boolean(
    dmrStatus &&
      dmrStatus.functionInstalled &&
      dmrStatus.functionEnabled &&
      dmrStatus.dockerModelRunnerConnected,
  );
  const dmrSetupInProgress = isRunning && !dmrReady && (dmrInitializing || dmrHoldOpen);
  const dmrFailed = isRunning && !dmrReady && !dmrSetupInProgress;

  const title = isRunning
    ? dmrReady
      ? 'Open WebUI is ready'
      : dmrSetupInProgress
        ? 'Finishing Docker Model Runner setup'
        : 'Open WebUI is ready (DMR needs attention)'
    : needsSetup
      ? 'Set up Open WebUI'
      : 'Start Open WebUI';

  const description = isRunning
    ? dmrReady
      ? `Open WebUI is listening on port ${effectiveConfig.port}. Launch the interface to start using it.`
      : dmrSetupInProgress
        ? 'Docker Model Runner integration is finalizing. Access will be enabled once setup completes (up to one minute).'
        : 'Docker Model Runner integration did not finish successfully. You can still open Open WebUI, but integration features may be unavailable.'
    : needsSetup
      ? 'Click the button to download the image and create the Open WebUI container with the current configuration.'
      : 'Start the container to make Open WebUI available with the latest saved configuration.';

  const actionLabel = isRunning
    ? 'Open Open WebUI'
    : needsSetup
      ? 'Set Up Open WebUI'
      : 'Start Open WebUI';

  const chipLabel = containerState
    ? (STATUS_LABELS[containerState] ?? containerState)
    : 'Checking status';
  const chipColor = containerState ? (STATUS_CHIP_COLOR[containerState] ?? 'info') : 'info';

  const handleAction = () => {
    if (isRunning) {
      onOpen();
      return;
    }
    onSetup();
  };

  const loadingText = needsSetup ? 'Setting up Open WebUI...' : 'Working on Open WebUI...';
  const dmrLoadingText = dmrHoldOpen
    ? `Waiting for Docker Model Runner setup...`
    : 'Setting up Docker Model Runner integration...';

  return (
    <Card
      sx={(theme) => ({
        px: { xs: 3, md: 4 },
        py: { xs: 3, md: 4 },
        borderRadius: 3,
        border: '1px solid',
        borderColor: alpha(theme.palette.primary.main, 0.2),
        background:
          theme.palette.mode === 'dark'
            ? `linear-gradient(140deg, ${alpha(theme.palette.primary.main, 0.18)}, ${alpha(theme.palette.success.main, 0.12)})`
            : `linear-gradient(140deg, ${alpha(theme.palette.primary.light, 0.25)}, ${alpha(theme.palette.success.light, 0.15)})`,
        boxShadow: theme.shadows[6],
      })}
    >
      <Stack spacing={2.5} alignItems="center" textAlign="center">
        <Box sx={{ display: 'flex', alignItems: 'center', gap: 1 }}>
          <Chip label={chipLabel} color={chipColor} size="small" variant="filled" />
        </Box>

        <Typography variant="h4" sx={{ fontWeight: 600 }}>
          {title}
        </Typography>

        <Typography variant="body1" color="text.secondary" sx={{ maxWidth: 520 }}>
          {description}
        </Typography>

        {loading ? (
          <Box sx={{ display: 'flex', alignItems: 'center', gap: 2, py: 1 }}>
            <CircularProgress size={32} />
            <Typography variant="body1" color="text.secondary">
              {loadingText}
            </Typography>
          </Box>
        ) : dmrSetupInProgress ? (
          <Box sx={{ display: 'flex', alignItems: 'center', gap: 2, py: 1 }}>
            <CircularProgress size={32} />
            <Typography variant="body1" color="text.secondary">
              {dmrLoadingText}
            </Typography>
          </Box>
        ) : (
          <Stack spacing={0.5} alignItems="center" sx={{ width: '100%' }}>
            <Button
              variant="contained"
              color={isRunning ? 'primary' : 'success'}
              size="large"
              startIcon={isRunning ? <OpenInNew /> : <RocketLaunch />}
              onClick={handleAction}
              disabled={containerState === 'restarting'}
              sx={{
                px: 4,
                py: 1.5,
                fontSize: '1.05rem',
                fontWeight: 600,
                minWidth: { xs: '100%', sm: 280 },
                borderRadius: 2,
              }}
            >
              {actionLabel}
            </Button>

            {isRunning && (
              <Button
                variant="text"
                color="error"
                size="small"
                onClick={onStop}
                sx={{ textTransform: 'none', fontSize: '0.85rem', fontWeight: 500 }}
              >
                Stop Open WebUI
              </Button>
            )}
          </Stack>
        )}

        {dmrFailed && (
          <Typography variant="body2" color="warning.main" sx={{ textAlign: 'center', mt: 1 }}>
            Docker Model Runner integration did not finish. Check the Service Management tab for
            retry options.
          </Typography>
        )}

        <Typography
          variant="body2"
          color="text.secondary"
          sx={{ display: 'flex', gap: 1, flexWrap: 'wrap', justifyContent: 'center' }}
        >
          <span>Image: {effectiveConfig.image}</span>
          <span>•</span>
          <span>Port: {effectiveConfig.port}</span>
          {needsStart && (
            <>
              <span>•</span>
              <span>Container ready to start</span>
            </>
          )}
        </Typography>
      </Stack>
    </Card>
  );
}

export default PrimaryActionsCard;
