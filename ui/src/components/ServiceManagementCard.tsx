import { Memory, PlayArrow, Refresh, SettingsEthernet, Stop } from '@mui/icons-material';
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

import { PROVISIONER_LABELS } from '../constants';
import type { ContainerStatus, DockerMcpToolkitStatus, ServiceStatus } from '../types';
import { isDockerMcpToolkitReady } from '../utils/mcpToolkitStatus';

interface ServiceManagementCardProps {
  status: ContainerStatus | null;
  loading: boolean;
  dmrInitializing?: boolean;
  dmrStatus?: ServiceStatus | null;
  dmrGateMode?: 'hard' | 'soft' | 'none';
  dmrHoldOpen?: boolean;
  mcpToolkitInitializing?: boolean;
  mcpToolkitStatus?: DockerMcpToolkitStatus | null;
  onStart: () => void;
  onStop: () => void;
  onRestart: () => void;
  onRetryDMR?: () => void;
  onRetryMcpToolkit?: () => void;
}

export function ServiceManagementCard({
  status,
  loading,
  dmrInitializing,
  dmrStatus,
  dmrGateMode = 'none',
  dmrHoldOpen,
  mcpToolkitInitializing,
  mcpToolkitStatus,
  onStart,
  onStop,
  onRestart,
  onRetryDMR,
  onRetryMcpToolkit,
}: ServiceManagementCardProps) {
  const containerState = status?.status;
  const isRunning = containerState === 'running';
  const canStop = isRunning && !loading;
  const canRestart = isRunning && !loading;
  const canStart = !loading && containerState !== 'running' && containerState !== 'restarting';
  const activeProvisioner = dmrStatus?.provisionerMode ?? status?.config.provisioner ?? 'openai';
  const integrationConfigured =
    dmrStatus?.integrationConfigured ??
    (dmrStatus ? dmrStatus.functionInstalled && dmrStatus.functionEnabled : false);
  const dmrReady = !!dmrStatus && integrationConfigured && dmrStatus.dockerModelRunnerConnected;
  const dmrSetupBlocking = dmrGateMode === 'hard' && Boolean(dmrHoldOpen);
  const dmrSetupInProgress = Boolean(dmrInitializing || dmrSetupBlocking || dmrGateMode === 'soft');
  const mcpReady = isDockerMcpToolkitReady(mcpToolkitStatus);
  const hasMcpStatus = Boolean(mcpToolkitStatus);
  const mcpNeedsAttention = hasMcpStatus && !mcpReady;
  const mcpSetupInProgress = Boolean(mcpToolkitInitializing);

  const effectivePort = status?.config?.port;

  let notificationSeverity: 'success' | 'info' | 'warning' | 'error' = 'info';
  let notificationMessage = 'Fetching service status...';

  if (loading) {
    notificationSeverity = 'info';
    notificationMessage = 'Working on Open WebUI service...';
  } else if (!status) {
    notificationSeverity = 'info';
    notificationMessage = 'Waiting for container status...';
  } else if (isRunning && (dmrSetupInProgress || mcpSetupInProgress)) {
    notificationSeverity = 'info';
    notificationMessage = 'Container running. Integration setup is in progress.';
  } else if (isRunning && !hasMcpStatus) {
    notificationSeverity = 'info';
    notificationMessage = 'Container running. Checking integration status...';
  } else if (isRunning && dmrReady && mcpReady) {
    notificationSeverity = 'success';
    notificationMessage = `Container running${effectivePort ? ` on port ${effectivePort}` : ''}. Integrations look healthy.`;
  } else if (isRunning && !dmrReady) {
    notificationSeverity = 'warning';
    notificationMessage = 'Container running. Docker Model Runner needs attention.';
  } else if (isRunning && mcpNeedsAttention) {
    notificationSeverity = 'warning';
    notificationMessage = 'Container running. Docker MCP Toolkit integration needs attention.';
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
    dmrDescription = dmrSetupBlocking
      ? `Setting up Docker Model Runner integration...`
      : 'Checking Docker Model Runner integration in the background...';
  } else if (!dmrStatus) {
    dmrStatusLabel = 'Pending';
    dmrChipColor = 'default';
    dmrDescription = 'Run a check to see Docker Model Runner integration status.';
  } else if (dmrReady) {
    dmrStatusLabel = 'Ready';
    dmrChipColor = 'success';
    dmrDescription = `Integration configured via ${PROVISIONER_LABELS[activeProvisioner]} mode and connected.`;
  } else {
    const issues: string[] = [];
    if (!integrationConfigured) {
      if (activeProvisioner === 'legacy-function') {
        if (!dmrStatus.functionInstalled) {
          issues.push('Legacy function not installed');
        }
        if (dmrStatus.functionInstalled && !dmrStatus.functionEnabled) {
          issues.push('Legacy function disabled');
        }
      } else {
        issues.push('OpenAI-compatible provider not configured');
      }
    }
    if (!dmrStatus.dockerModelRunnerConnected) {
      issues.push('Not connected to Docker Model Runner');
    }

    dmrStatusLabel = 'Needs Attention';
    dmrChipColor = !integrationConfigured ? 'error' : 'warning';
    dmrDescription = issues.length > 0 ? `${issues.join('. ')}.` : 'Integration needs attention.';
  }

  let mcpStatusLabel = 'Not Checked';
  let mcpChipColor: 'success' | 'warning' | 'default' | 'info' | 'error' = 'default';
  let mcpDescription = 'Docker MCP Toolkit status has not been checked yet.';

  if (mcpSetupInProgress) {
    mcpStatusLabel = 'Setting Up';
    mcpChipColor = 'info';
    mcpDescription = 'Checking Docker MCP Toolkit integration in the background...';
  } else if (!mcpToolkitStatus) {
    mcpStatusLabel = 'Pending';
    mcpChipColor = 'default';
  } else if (!mcpToolkitStatus.enabled) {
    if (mcpToolkitStatus.integrationConfigured) {
      mcpStatusLabel = 'Disabled';
      mcpChipColor = 'default';
      mcpDescription = mcpToolkitStatus.message ?? 'Docker MCP Toolkit integration is disabled.';
    } else {
      mcpStatusLabel = 'Needs Attention';
      mcpChipColor = 'warning';
      mcpDescription =
        mcpToolkitStatus.message ??
        'Docker MCP Toolkit integration is disabled but deprovisioning is incomplete.';
    }
  } else if (mcpToolkitStatus.integrationConfigured) {
    mcpStatusLabel = 'Ready';
    mcpChipColor = 'success';
    mcpDescription = mcpToolkitStatus.gatewayUrl
      ? `Configured via ${mcpToolkitStatus.gatewayUrl}.`
      : 'Configured in Open WebUI.';
  } else {
    const issues: string[] = [];
    if (!mcpToolkitStatus.supported) {
      issues.push('Docker MCP Toolkit unavailable');
    }
    if (!mcpToolkitStatus.profileAvailable) {
      issues.push('Default MCP profile missing (using container defaults)');
    }
    if (!mcpToolkitStatus.gatewayReachable) {
      issues.push('Gateway not reachable from container');
    }
    if (!mcpToolkitStatus.openWebUIToolServerConfigured) {
      issues.push('Open WebUI tool server not configured');
    }
    if (mcpToolkitStatus.details?.openWebUIVerifyError) {
      issues.push('Open WebUI verification failed');
    }

    mcpStatusLabel = !mcpToolkitStatus.supported ? 'Unsupported' : 'Needs Attention';
    mcpChipColor = !mcpToolkitStatus.supported ? 'error' : 'warning';
    mcpDescription =
      mcpToolkitStatus.message ??
      (issues.length > 0 ? `${issues.join('. ')}.` : 'Integration needs attention.');
  }

  const canRetryMcp = Boolean(
    onRetryMcpToolkit &&
      isRunning &&
      !loading &&
      !mcpToolkitInitializing &&
      mcpToolkitStatus &&
      !isDockerMcpToolkitReady(mcpToolkitStatus),
  );

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
          Manage the running Open WebUI container and integration services.
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
                <Typography variant="caption" color="text.secondary">
                  Mode: {PROVISIONER_LABELS[activeProvisioner]}
                </Typography>
              </Box>
              <Chip label={dmrStatusLabel} color={dmrChipColor} variant="filled" size="small" />
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
                <Typography variant="subtitle2">Docker MCP Toolkit</Typography>
                <Typography variant="body2" color="text.secondary">
                  {mcpDescription}
                </Typography>
                {mcpToolkitStatus?.details?.profileId && (
                  <Typography variant="caption" color="text.secondary">
                    Profile: {mcpToolkitStatus.details.profileId}
                  </Typography>
                )}
              </Box>
              <Chip label={mcpStatusLabel} color={mcpChipColor} variant="filled" size="small" />
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
            {onRetryMcpToolkit && (
              <Button
                variant="outlined"
                color="primary"
                startIcon={<SettingsEthernet />}
                onClick={onRetryMcpToolkit}
                disabled={!canRetryMcp}
              >
                Retry MCP Toolkit
              </Button>
            )}
          </Stack>
        </Box>
      </CardContent>
    </Card>
  );
}

export default ServiceManagementCard;
