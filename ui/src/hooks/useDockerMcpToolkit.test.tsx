import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { defaultMcpToolkitStatusCache } from '../services/mcpToolkitStatusCache';
import type { OpenWebUIApiService } from '../services/openWebUIApiService';
import type { ContainerStatus, DockerMcpToolkitStatus, ExtensionConfig } from '../types';
import type { UseDockerMcpToolkitResult } from './useDockerMcpToolkit';
import { useDockerMcpToolkit } from './useDockerMcpToolkit';

interface HarnessProps {
  config: ExtensionConfig;
  status: ContainerStatus | null;
  service: OpenWebUIApiService | null;
  onHookUpdate: (value: UseDockerMcpToolkitResult) => void;
}

function HookHarness({ config, status, service, onHookUpdate }: HarnessProps) {
  const value = useDockerMcpToolkit({ config, status, service });
  onHookUpdate(value);
  return null;
}

function runningStatus(config: ExtensionConfig): ContainerStatus {
  return {
    status: 'running',
    message: 'running',
    config,
  };
}

function mcpStatus(overrides: Partial<DockerMcpToolkitStatus>): DockerMcpToolkitStatus {
  return {
    enabled: true,
    containerRunning: true,
    supported: true,
    profileAvailable: true,
    gatewayReachable: true,
    openWebUIToolServerConfigured: true,
    integrationConfigured: true,
    lastChecked: Date.now(),
    ...overrides,
  };
}

function getHookValue(hook: UseDockerMcpToolkitResult | null): UseDockerMcpToolkitResult {
  if (!hook) {
    throw new Error('Expected hook value to be captured');
  }
  return hook;
}

describe('useDockerMcpToolkit', () => {
  let container: HTMLDivElement;
  let root: Root;
  let mockService: {
    verifyDockerMcpToolkitIntegration: ReturnType<typeof vi.fn>;
    setupDockerMcpToolkitIntegration: ReturnType<typeof vi.fn>;
    clearDockerMcpToolkitCache: ReturnType<typeof vi.fn>;
    stopDockerMcpToolkitGatewayContainer: ReturnType<typeof vi.fn>;
    ensureAuthToken: ReturnType<typeof vi.fn>;
  };

  const enabledConfig: ExtensionConfig = {
    image: 'ghcr.io/open-webui/open-webui:main',
    port: '8090',
    autoStart: true,
    provisioner: 'openai',
    enableDockerMcpToolkit: true,
  };

  const disabledConfig: ExtensionConfig = {
    ...enabledConfig,
    enableDockerMcpToolkit: false,
  };

  beforeEach(() => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);

    localStorage.clear();
    defaultMcpToolkitStatusCache.clear();

    mockService = {
      verifyDockerMcpToolkitIntegration: vi.fn(),
      setupDockerMcpToolkitIntegration: vi.fn(),
      clearDockerMcpToolkitCache: vi.fn(),
      stopDockerMcpToolkitGatewayContainer: vi.fn().mockResolvedValue(undefined),
      ensureAuthToken: vi.fn().mockResolvedValue(true),
    };
  });

  afterEach(async () => {
    await act(async () => {
      root.unmount();
    });
    container.remove();
    delete (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;

    localStorage.clear();
    defaultMcpToolkitStatusCache.clear();
    vi.clearAllMocks();
  });

  it('runs setup to deprovision when disabled verify reports lingering managed entry', async () => {
    const disabledStillProvisioned = mcpStatus({
      enabled: false,
      integrationConfigured: false,
      openWebUIToolServerConfigured: true,
      gatewayReachable: false,
    });
    const disabledReady = mcpStatus({
      enabled: false,
      integrationConfigured: true,
      openWebUIToolServerConfigured: false,
      gatewayReachable: false,
    });

    mockService.verifyDockerMcpToolkitIntegration.mockResolvedValue(disabledStillProvisioned);
    mockService.setupDockerMcpToolkitIntegration.mockResolvedValue(disabledReady);

    let latestHook: UseDockerMcpToolkitResult | null = null;
    await act(async () => {
      root.render(
        <HookHarness
          config={disabledConfig}
          status={runningStatus(disabledConfig)}
          service={mockService as unknown as OpenWebUIApiService}
          onHookUpdate={(value) => {
            latestHook = value;
          }}
        />,
      );
    });

    await act(async () => {
      await latestHook?.ensureIntegration({ force: true });
    });

    expect(mockService.verifyDockerMcpToolkitIntegration).toHaveBeenCalled();
    expect(mockService.setupDockerMcpToolkitIntegration).toHaveBeenCalled();
  });

  it('re-runs setup immediately after toggling off and back on', async () => {
    const enabledNeedsSetup = mcpStatus({
      enabled: true,
      integrationConfigured: false,
      openWebUIToolServerConfigured: false,
      gatewayReachable: false,
    });
    const enabledReady = mcpStatus({
      enabled: true,
      integrationConfigured: true,
    });
    const disabledReady = mcpStatus({
      enabled: false,
      integrationConfigured: true,
      openWebUIToolServerConfigured: false,
      gatewayReachable: false,
    });

    mockService.verifyDockerMcpToolkitIntegration.mockResolvedValue(enabledNeedsSetup);
    mockService.setupDockerMcpToolkitIntegration.mockResolvedValue(enabledReady);

    let latestHook: UseDockerMcpToolkitResult | null = null;
    await act(async () => {
      root.render(
        <HookHarness
          config={enabledConfig}
          status={runningStatus(enabledConfig)}
          service={mockService as unknown as OpenWebUIApiService}
          onHookUpdate={(value) => {
            latestHook = value;
          }}
        />,
      );
    });

    await act(async () => {
      await latestHook?.ensureIntegration({ force: true });
    });
    expect(mockService.setupDockerMcpToolkitIntegration).toHaveBeenCalled();

    mockService.verifyDockerMcpToolkitIntegration.mockResolvedValue(disabledReady);
    await act(async () => {
      root.render(
        <HookHarness
          config={disabledConfig}
          status={runningStatus(disabledConfig)}
          service={mockService as unknown as OpenWebUIApiService}
          onHookUpdate={(value) => {
            latestHook = value;
          }}
        />,
      );
    });
    await act(async () => {
      await Promise.resolve();
    });

    mockService.setupDockerMcpToolkitIntegration.mockClear();
    mockService.verifyDockerMcpToolkitIntegration.mockResolvedValue(enabledNeedsSetup);

    await act(async () => {
      root.render(
        <HookHarness
          config={enabledConfig}
          status={runningStatus(enabledConfig)}
          service={mockService as unknown as OpenWebUIApiService}
          onHookUpdate={(value) => {
            latestHook = value;
          }}
        />,
      );
    });

    await act(async () => {
      await latestHook?.ensureIntegration();
    });

    expect(mockService.setupDockerMcpToolkitIntegration).toHaveBeenCalled();
  });

  it('returns skipped sync result when container is not running', async () => {
    let latestHook: UseDockerMcpToolkitResult | null = null;
    await act(async () => {
      root.render(
        <HookHarness
          config={enabledConfig}
          status={{ status: 'stopped', message: 'stopped', config: enabledConfig }}
          service={mockService as unknown as OpenWebUIApiService}
          onHookUpdate={(value) => {
            latestHook = value;
          }}
        />,
      );
    });

    let result: Awaited<ReturnType<UseDockerMcpToolkitResult['syncServers']>> | null = null;
    await act(async () => {
      result = await getHookValue(latestHook).syncServers();
    });

    expect(result).toEqual({ outcome: 'skipped', reason: 'container-not-running' });
  });

  it('tracks manualSyncing only during explicit sync operation', async () => {
    const ready = mcpStatus({ enabled: true, integrationConfigured: true });
    let resolveVerify: ((value: DockerMcpToolkitStatus) => void) | null = null;
    const verifyPromise = new Promise<DockerMcpToolkitStatus>((resolve) => {
      resolveVerify = resolve;
    });

    mockService.verifyDockerMcpToolkitIntegration
      .mockResolvedValueOnce(ready)
      .mockReturnValueOnce(verifyPromise);
    mockService.setupDockerMcpToolkitIntegration.mockResolvedValue(ready);

    let latestHook: UseDockerMcpToolkitResult | null = null;
    await act(async () => {
      root.render(
        <HookHarness
          config={enabledConfig}
          status={runningStatus(enabledConfig)}
          service={mockService as unknown as OpenWebUIApiService}
          onHookUpdate={(value) => {
            latestHook = value;
          }}
        />,
      );
    });

    await act(async () => {
      await Promise.resolve();
    });
    expect(getHookValue(latestHook).manualSyncing).toBe(false);

    let syncPromise: Promise<Awaited<ReturnType<UseDockerMcpToolkitResult['syncServers']>>> | null =
      null;
    await act(async () => {
      syncPromise = getHookValue(latestHook).syncServers();
      await Promise.resolve();
    });
    expect(getHookValue(latestHook).manualSyncing).toBe(true);

    await act(async () => {
      resolveVerify?.(ready);
      await syncPromise;
    });

    expect(getHookValue(latestHook).manualSyncing).toBe(false);
  });
});
