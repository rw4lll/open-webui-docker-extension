import { Memory, PlayArrow, Refresh, Stop } from '@mui/icons-material';
import {
  Alert,
  Box,
  Button,
  Card,
  CardContent,
  Divider,
  Stack,
  Chip,
  Typography,
} from '@mui/material';
import { alpha } from '@mui/material/styles';

import type { ContainerStatus, ServiceStatus } from '../types';

interface ServiceManagementCardProps {
  status: ContainerStatus | null;
  loading: boolean;
  dmrInitializing?: boolean;
  dmrStatus?: ServiceStatus | null;
  dmrHoldOpen?: boolean;
  dmrHoldRemainingMs?: number;
  onStart: () => void;
  onStop: () => void;
  onRestart: () => void;
  onRetryDMR?: () => void;
}

export function ServiceManagementCard({
  status,
  loading,
  dmrInitializing,
  dmrStatus,
  dmrHoldOpen,
  onStart,
  onStop,
  onRestart,
  onRetryDMR,
}: ServiceManagementCardProps) {
  const containerState = status?.status;
  const isRunning = containerState === 'running';
  const canStop = isRunning && !loading;
  const canRestart = isRunning && !loading;
  const canStart = !loading && containerState !== 'running' && containerState !== 'restarting';
  const dmrReady =
    !!dmrStatus &&
    dmrStatus.functionInstalled &&
    dmrStatus.functionEnabled &&
    dmrStatus.dockerModelRunnerConnected;
  const dmrSetupInProgress = Boolean(dmrInitializing || dmrHoldOpen);

  const effectivePort = status?.config?.port;

  let notificationSeverity: 'success' | 'info' | 'warning' | 'error' = 'info';
  let notificationMessage = 'Fetching service status...';

  if (loading) {
    notificationSeverity = 'info';
    notificationMessage = 'Working on Open WebUI service...';
  } else if (!status) {
    notificationSeverity = 'info';
    notificationMessage = 'Waiting for container status...';
  } else if (isRunning && dmrReady) {
    notificationSeverity = 'success';
    notificationMessage = `Container running${effectivePort ? ` on port ${effectivePort}` : ''}. Docker Model Runner is connected.`;
  } else if (isRunning && dmrSetupInProgress) {
    notificationSeverity = 'info';
    notificationMessage = 'Container running. Docker Model Runner setup is in progress.';
  } else if (isRunning && !dmrReady) {
    notificationSeverity = 'warning';
    notificationMessage = 'Container running. Docker Model Runner needs attention.';
  } else if (containerState === 'not_found') {
    notificationSeverity = 'warning';
    notificationMessage = 'Open WebUI container not found. Start the service to create it.';
  } else if (containerState === 'restarting') {
    notificationSeverity = 'info';
    notificationMessage = 'Container is restarting...';
  } else if (containerState) {
    notificationSeverity = 'info';
    notificationMessage = status?.message ?? `Container is ${containerState}.`;
  }

  const containerStatusLabel = containerState
    ? containerState === 'running'
      ? 'Running'
      : containerState === 'not_found'
        ? 'Not Installed'
        : containerState.charAt(0).toUpperCase() + containerState.slice(1)
    : 'Unknown';

  const containerChipColor: 'success' | 'warning' | 'default' | 'info' | 'error' = containerState
    ? containerState === 'running'
      ? 'success'
      : containerState === 'not_found'
        ? 'warning'
        : containerState === 'restarting'
          ? 'info'
          : 'warning'
    : 'default';

  let containerDescription = status?.message || 'Waiting for container status.';
  if (containerState === 'running' && effectivePort) {
    containerDescription = `Running on port ${effectivePort}.`;
  } else if (containerState === 'not_found') {
    containerDescription = 'Container will be created on first start.';
  }

  let dmrStatusLabel = 'Not Checked';
  let dmrChipColor: 'success' | 'warning' | 'default' | 'info' | 'error' = 'default';
  let dmrDescription = 'Integration status has not been checked yet.';

  if (dmrSetupInProgress) {
    dmrStatusLabel = 'Setting Up';
    dmrChipColor = 'info';
    dmrDescription = dmrHoldOpen
      ? `Setting up Docker Model Runner integration...`
      : 'Checking Docker Model Runner integration...';
  } else if (!dmrStatus) {
    dmrStatusLabel = 'Pending';
    dmrChipColor = 'default';
    dmrDescription = 'Run a check to see Docker Model Runner integration status.';
  } else if (dmrReady) {
    dmrStatusLabel = 'Ready';
    dmrChipColor = 'success';
    dmrDescription = 'Integration installed, enabled, and connected.';
  } else {
    const issues: string[] = [];
    if (!dmrStatus.functionInstalled) {
      issues.push('Function not installed');
    }
    if (dmrStatus.functionInstalled && !dmrStatus.functionEnabled) {
      issues.push('Function disabled');
    }
    if (!dmrStatus.dockerModelRunnerConnected) {
      issues.push('Not connected to Docker Model Runner');
    }

    dmrStatusLabel = 'Needs Attention';
    dmrChipColor = !dmrStatus.functionInstalled ? 'error' : 'warning';
    dmrDescription = issues.length > 0 ? `${issues.join('. ')}.` : 'Integration needs attention.';
  }

  return (
    <Card
      sx={(theme) => ({
        minHeight: '100%',
        borderRadius: 2,
        border: '1px solid',
        borderColor: alpha(theme.palette.primary.main, 0.08),
        backgroundColor:
          theme.palette.mode === 'dark'
            ? alpha(theme.palette.background.paper, 0.85)
            : alpha(theme.palette.background.paper, 0.95),
        backdropFilter: 'blur(8px)',
      })}
    >
      <CardContent>
        <Typography variant="h6" gutterBottom>
          Service Management
        </Typography>
        <Typography variant="body2" color="text.secondary">
          Manage the running Open WebUI container and Docker Model Runner integration.
        </Typography>
        <Alert severity={notificationSeverity} sx={{ mt: 2 }}>
          {notificationMessage}
        </Alert>

        <Box
          sx={(theme) => ({
            mt: 3,
            p: { xs: 2, md: 3 },
            borderRadius: 2,
            border: '1px solid',
            borderColor: alpha(theme.palette.primary.main, 0.12),
            backgroundColor:
              theme.palette.mode === 'dark'
                ? alpha(theme.palette.background.default, 0.8)
                : alpha(theme.palette.primary.light, 0.08),
          })}
        >
          <Stack spacing={2.5}>
            <Box
              sx={{
                display: 'flex',
                flexDirection: { xs: 'column', sm: 'row' },
                justifyContent: 'space-between',
                gap: 1,
              }}
            >
              <Box>
                <Typography variant="subtitle2">Open WebUI Container</Typography>
                <Typography variant="body2" color="text.secondary">
                  {containerDescription}
                </Typography>
              </Box>
              <Chip
                label={containerStatusLabel}
                color={containerChipColor}
                variant="filled"
                size="small"
              />
            </Box>

            <Divider sx={{ borderStyle: 'dashed' }} />

            <Box
              sx={{
                display: 'flex',
                flexDirection: { xs: 'column', sm: 'row' },
                justifyContent: 'space-between',
                gap: 1,
              }}
            >
              <Box>
                <Typography variant="subtitle2">Docker Model Runner</Typography>
                <Typography variant="body2" color="text.secondary">
                  {dmrDescription}
                </Typography>
              </Box>
              <Chip label={dmrStatusLabel} color={dmrChipColor} variant="filled" size="small" />
            </Box>
          </Stack>
        </Box>

        <Box
          sx={(theme) => ({
            mt: 3,
            p: { xs: 2, md: 3 },
            borderRadius: 2,
            border: '1px solid',
            borderColor: alpha(theme.palette.divider, 0.6),
            backgroundColor:
              theme.palette.mode === 'dark'
                ? alpha(theme.palette.background.default, 0.65)
                : alpha(theme.palette.background.paper, 0.92),
          })}
        >
          <Typography variant="subtitle2" sx={{ mb: 1.5 }}>
            Actions
          </Typography>
          <Stack spacing={1.5} direction={{ xs: 'column', md: 'row' }} flexWrap="wrap">
            <Button
              variant="contained"
              color="success"
              startIcon={<PlayArrow />}
              onClick={onStart}
              disabled={!canStart}
            >
              Start
            </Button>
            <Button
              variant="outlined"
              color="error"
              startIcon={<Stop />}
              onClick={onStop}
              disabled={!canStop}
            >
              Stop
            </Button>
            <Button
              variant="outlined"
              color="warning"
              startIcon={<Refresh />}
              onClick={onRestart}
              disabled={!canRestart}
            >
              Restart
            </Button>
            {onRetryDMR && (
              <Button
                variant="outlined"
                color="primary"
                startIcon={<Memory />}
                onClick={onRetryDMR}
                disabled={!!dmrInitializing || loading || dmrReady}
              >
                Retry Integration
              </Button>
            )}
          </Stack>
        </Box>
      </CardContent>
    </Card>
  );
}

export default ServiceManagementCard;
