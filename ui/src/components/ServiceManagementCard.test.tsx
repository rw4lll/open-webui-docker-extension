import { ThemeProvider, createTheme } from '@mui/material/styles';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { ContainerStatus, DockerMcpToolkitStatus, ServiceStatus } from '../types';
import { ServiceManagementCard } from './ServiceManagementCard';

describe('ServiceManagementCard', () => {
  let container: HTMLDivElement;
  let root: Root;
  const theme = createTheme();

  const status: ContainerStatus = {
    status: 'running',
    message: 'running',
    config: {
      image: 'ghcr.io/open-webui/open-webui:main',
      port: '8090',
      autoStart: true,
      provisioner: 'openai',
      enableDockerMcpToolkit: true,
    },
  };

  const readyDMRStatus: ServiceStatus = {
    containerRunning: true,
    functionInstalled: false,
    functionEnabled: false,
    dockerModelRunnerConnected: true,
    lastChecked: Date.now(),
    integrationConfigured: true,
    provisionerMode: 'openai',
  };
  const readyMcpStatus: DockerMcpToolkitStatus = {
    enabled: true,
    containerRunning: true,
    supported: true,
    profileAvailable: true,
    gatewayReachable: true,
    openWebUIToolServerConfigured: true,
    integrationConfigured: true,
    lastChecked: Date.now(),
    gatewayUrl: 'http://host.docker.internal:8812/mcp',
  };

  beforeEach(() => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(async () => {
    await act(async () => {
      root.unmount();
    });
    container.remove();
    delete (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
    vi.clearAllMocks();
  });

  it('shows ready status details when container and DMR are ready', async () => {
    await act(async () => {
      root.render(
        <ThemeProvider theme={theme}>
          <ServiceManagementCard
            status={status}
            loading={false}
            dmrStatus={readyDMRStatus}
            mcpToolkitStatus={readyMcpStatus}
            onStart={vi.fn()}
            onStop={vi.fn()}
            onRestart={vi.fn()}
          />
        </ThemeProvider>,
      );
    });

    expect(container.textContent).toContain('Container running on port 8090');
    expect(container.textContent).toContain('Docker Model Runner');
    expect(container.textContent).toContain('Ready');
  });

  it('shows pending integration message when MCP status is not yet checked', async () => {
    await act(async () => {
      root.render(
        <ThemeProvider theme={theme}>
          <ServiceManagementCard
            status={status}
            loading={false}
            dmrStatus={readyDMRStatus}
            onStart={vi.fn()}
            onStop={vi.fn()}
            onRestart={vi.fn()}
          />
        </ThemeProvider>,
      );
    });

    expect(container.textContent).toContain('Checking integration status');
    expect(container.textContent).not.toContain('Integrations look healthy');
    expect(container.textContent).toContain('Pending');
  });

  it('disables stop and restart actions when container is not running', async () => {
    const stoppedStatus: ContainerStatus = {
      ...status,
      status: 'stopped',
      message: 'stopped',
    };

    await act(async () => {
      root.render(
        <ThemeProvider theme={theme}>
          <ServiceManagementCard
            status={stoppedStatus}
            loading={false}
            dmrStatus={readyDMRStatus}
            onStart={vi.fn()}
            onStop={vi.fn()}
            onRestart={vi.fn()}
          />
        </ThemeProvider>,
      );
    });

    const stopButton = Array.from(container.querySelectorAll('button')).find((button) =>
      button.textContent?.includes('Stop'),
    );
    const restartButton = Array.from(container.querySelectorAll('button')).find((button) =>
      button.textContent?.includes('Restart'),
    );
    expect(stopButton?.hasAttribute('disabled')).toBe(true);
    expect(restartButton?.hasAttribute('disabled')).toBe(true);
  });

  it('surfaces disabled MCP cleanup issues and keeps retry enabled', async () => {
    const disabledNotCleanedStatus: DockerMcpToolkitStatus = {
      enabled: false,
      containerRunning: true,
      supported: true,
      profileAvailable: true,
      gatewayReachable: false,
      openWebUIToolServerConfigured: true,
      integrationConfigured: false,
      lastChecked: Date.now(),
      message: 'Docker MCP Toolkit integration is disabled but still provisioned.',
    };

    await act(async () => {
      root.render(
        <ThemeProvider theme={theme}>
          <ServiceManagementCard
            status={status}
            loading={false}
            dmrStatus={readyDMRStatus}
            mcpToolkitStatus={disabledNotCleanedStatus}
            onStart={vi.fn()}
            onStop={vi.fn()}
            onRestart={vi.fn()}
            onRetryMcpToolkit={vi.fn()}
          />
        </ThemeProvider>,
      );
    });

    expect(container.textContent).toContain('still provisioned');
    const retryButton = Array.from(container.querySelectorAll('button')).find((button) =>
      button.textContent?.includes('Retry MCP Toolkit'),
    );
    expect(retryButton).toBeTruthy();
    expect(retryButton?.hasAttribute('disabled')).toBe(false);
  });
});
