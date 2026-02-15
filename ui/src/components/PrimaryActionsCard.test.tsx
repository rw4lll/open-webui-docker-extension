import { ThemeProvider, createTheme } from '@mui/material/styles';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { ContainerStatus, ExtensionConfig, ServiceStatus } from '../types';
import { PrimaryActionsCard } from './PrimaryActionsCard';

describe('PrimaryActionsCard', () => {
  let container: HTMLDivElement;
  let root: Root;
  const theme = createTheme();

  const config: ExtensionConfig = {
    image: 'img:tag',
    port: '8090',
    autoStart: true,
    provisioner: 'openai',
  };

  const runningStatus: ContainerStatus = {
    status: 'running',
    message: 'running',
    config,
  };

  const unreadyDmrStatus: ServiceStatus = {
    containerRunning: true,
    functionInstalled: false,
    functionEnabled: false,
    dockerModelRunnerConnected: false,
    lastChecked: Date.now(),
    integrationConfigured: false,
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

  it('shows open button during soft-gate background setup', async () => {
    await act(async () => {
      root.render(
        <ThemeProvider theme={theme}>
          <PrimaryActionsCard
            status={runningStatus}
            config={config}
            loading={false}
            onSetup={vi.fn()}
            onOpen={vi.fn()}
            onStop={vi.fn()}
            dmrStatus={unreadyDmrStatus}
            dmrInitializing
            dmrGateMode="soft"
            dmrHoldOpen={false}
          />
        </ThemeProvider>,
      );
    });

    expect(container.textContent).toContain('Open Open WebUI');
    expect(container.textContent).toContain('setup continues in the background');
  });

  it('blocks open button during hard-gate hold', async () => {
    await act(async () => {
      root.render(
        <ThemeProvider theme={theme}>
          <PrimaryActionsCard
            status={runningStatus}
            config={config}
            loading={false}
            onSetup={vi.fn()}
            onOpen={vi.fn()}
            onStop={vi.fn()}
            dmrStatus={unreadyDmrStatus}
            dmrInitializing={false}
            dmrGateMode="hard"
            dmrHoldOpen
          />
        </ThemeProvider>,
      );
    });

    expect(container.textContent).toContain('Finishing Docker Model Runner setup');
    expect(container.textContent).toContain('Waiting for Docker Model Runner setup...');
    expect(container.textContent).not.toContain('Open Open WebUI');
  });
});
