import { ThemeProvider, createTheme } from '@mui/material/styles';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { ContainerStatus, ServiceStatus } from '../types';
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
            onStart={vi.fn()}
            onStop={vi.fn()}
            onRestart={vi.fn()}
          />
        </ThemeProvider>,
      );
    });

    expect(container.textContent).toContain('Container running on port 8090');
    expect(container.textContent).toContain('Docker Model Runner is connected');
    expect(container.textContent).toContain('Ready');
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
});
