import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';

import { DMR_SETUP_MESSAGES } from '../constants';
import { createDMRConfigSignature, defaultDMRStatusCache } from '../services/dmrStatusCache';
import type { ContainerStatus, ExtensionConfig, ServiceStatus } from '../types';
import type { UseDockerModelRunnerResult } from './useDockerModelRunner';
import { useDockerModelRunner } from './useDockerModelRunner';

let mockService: {
  updateConfig: ReturnType<typeof vi.fn>;
  verifyDockerModelRunnerIntegration: ReturnType<typeof vi.fn>;
  setupDockerModelRunnerIntegration: ReturnType<typeof vi.fn>;
  getServiceStatus: ReturnType<typeof vi.fn>;
  ensureAuthToken: ReturnType<typeof vi.fn>;
};

vi.mock('../services/openWebUIApiService', () => ({
  OpenWebUIApiService: vi.fn().mockImplementation(() => mockService),
}));

interface HarnessProps {
  config: ExtensionConfig;
  status: ContainerStatus | null;
  onMessage: (update: string | ((prev: string | null) => string | null) | null) => void;
  onHookUpdate: (value: UseDockerModelRunnerResult) => void;
}

function HookHarness({ config, status, onMessage, onHookUpdate }: HarnessProps) {
  const value = useDockerModelRunner({ config, status, onMessage });
  onHookUpdate(value);
  return null;
}

describe('useDockerModelRunner', () => {
  let container: HTMLDivElement;
  let root: Root;
  const config: ExtensionConfig = {
    image: 'img:tag',
    port: '8090',
    autoStart: true,
    provisioner: 'openai',
    enableDockerMcpToolkit: true,
  };
  const runningStatus: ContainerStatus = {
    status: 'running',
    message: 'running',
    config,
  };
  const readyStatus = (): ServiceStatus => ({
    containerRunning: true,
    functionInstalled: false,
    functionEnabled: false,
    dockerModelRunnerConnected: true,
    lastChecked: Date.now(),
    integrationConfigured: true,
    provisionerMode: 'openai',
    details: { modelsApiReachable: true, openAIProviderConfigured: true, prefixIdConfigured: true },
  });
  const unconfiguredStatus = (): ServiceStatus => ({
    containerRunning: true,
    functionInstalled: false,
    functionEnabled: false,
    dockerModelRunnerConnected: true,
    lastChecked: Date.now(),
    integrationConfigured: false,
    provisionerMode: 'openai',
    details: {
      modelsApiReachable: true,
      openAIProviderConfigured: false,
      prefixIdConfigured: false,
    },
  });

  beforeEach(() => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    localStorage.clear();
    defaultDMRStatusCache.clear();

    mockService = {
      updateConfig: vi.fn(),
      verifyDockerModelRunnerIntegration: vi.fn().mockResolvedValue(readyStatus()),
      setupDockerModelRunnerIntegration: vi.fn().mockResolvedValue(readyStatus()),
      getServiceStatus: vi.fn().mockResolvedValue(readyStatus()),
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
    defaultDMRStatusCache.clear();
    vi.clearAllMocks();
  });

  it('uses OpenAI setup message when verify reports configured', async () => {
    let latestHook: UseDockerModelRunnerResult | null = null;
    let message: string | null = null;

    const onMessage = (update: string | ((prev: string | null) => string | null) | null): void => {
      if (typeof update === 'function') {
        message = update(message);
        return;
      }
      message = update;
    };

    await act(async () => {
      root.render(
        <HookHarness
          config={config}
          status={runningStatus}
          onMessage={onMessage}
          onHookUpdate={(value) => {
            latestHook = value;
          }}
        />,
      );
    });

    await act(async () => {
      await Promise.resolve();
    });

    expect(latestHook).not.toBeNull();
    await act(async () => {
      await latestHook?.ensureIntegration({ force: true });
    });

    expect(message).toBe(DMR_SETUP_MESSAGES.openai_configured);
    expect(mockService.verifyDockerModelRunnerIntegration).toHaveBeenCalled();
    expect(mockService.setupDockerModelRunnerIntegration).not.toHaveBeenCalled();
  });

  it('runs verify immediately on startup (no fixed 5s delay)', async () => {
    let latestHook: UseDockerModelRunnerResult | null = null;

    await act(async () => {
      root.render(
        <HookHarness
          config={config}
          status={runningStatus}
          onMessage={vi.fn()}
          onHookUpdate={(value) => {
            latestHook = value;
          }}
        />,
      );
    });

    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(latestHook).not.toBeNull();
    expect(mockService.verifyDockerModelRunnerIntegration).toHaveBeenCalled();
    expect(mockService.setupDockerModelRunnerIntegration).not.toHaveBeenCalled();
  });

  it('switches to hard gate and runs setup when verify is unconfigured', async () => {
    mockService.verifyDockerModelRunnerIntegration = vi
      .fn()
      .mockResolvedValue(unconfiguredStatus());
    mockService.setupDockerModelRunnerIntegration = vi.fn().mockResolvedValue(readyStatus());
    let latestHook: UseDockerModelRunnerResult | null = null;

    await act(async () => {
      root.render(
        <HookHarness
          config={config}
          status={runningStatus}
          onMessage={vi.fn()}
          onHookUpdate={(value) => {
            latestHook = value;
          }}
        />,
      );
    });

    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(mockService.verifyDockerModelRunnerIntegration).toHaveBeenCalled();
    expect(mockService.setupDockerModelRunnerIntegration).toHaveBeenCalledTimes(1);
    if (!latestHook) {
      throw new Error('Expected hook value to be captured');
    }
    expect((latestHook as UseDockerModelRunnerResult | null)?.gateMode).toBe('none');
  });

  it('starts with soft gate when trusted cache exists and avoids setup when verify passes', async () => {
    const cachedStatus = readyStatus();
    defaultDMRStatusCache.set({
      status: cachedStatus,
      configSignature: createDMRConfigSignature(config),
      containerStateHint: 'running',
      checkedAt: Date.now(),
    });

    let resolveVerify: ((value: ServiceStatus) => void) | null = null;
    const verifyPromise = new Promise<ServiceStatus>((resolve) => {
      resolveVerify = resolve;
    });
    mockService.verifyDockerModelRunnerIntegration = vi.fn().mockReturnValue(verifyPromise);

    let latestHook: UseDockerModelRunnerResult | null = null;
    await act(async () => {
      root.render(
        <HookHarness
          config={config}
          status={runningStatus}
          onMessage={vi.fn()}
          onHookUpdate={(value) => {
            latestHook = value;
          }}
        />,
      );
    });

    if (!latestHook) {
      throw new Error('Expected hook value to be captured');
    }
    expect((latestHook as UseDockerModelRunnerResult | null)?.gateMode).toBe('soft');
    expect(
      (latestHook as UseDockerModelRunnerResult | null)?.dmrStatus?.integrationConfigured,
    ).toBe(true);

    await act(async () => {
      resolveVerify?.(readyStatus());
      await verifyPromise;
    });

    if (!latestHook) {
      throw new Error('Expected hook value to be captured');
    }
    expect((latestHook as UseDockerModelRunnerResult | null)?.gateMode).toBe('none');
    expect(mockService.setupDockerModelRunnerIntegration).not.toHaveBeenCalled();
  });

  it('retryIntegration refreshes auth and forces setup path when verify is unconfigured', async () => {
    mockService.verifyDockerModelRunnerIntegration = vi
      .fn()
      .mockResolvedValue(unconfiguredStatus());
    mockService.setupDockerModelRunnerIntegration = vi.fn().mockResolvedValue(readyStatus());
    let latestHook: UseDockerModelRunnerResult | null = null;

    await act(async () => {
      root.render(
        <HookHarness
          config={config}
          status={runningStatus}
          onMessage={vi.fn()}
          onHookUpdate={(value) => {
            latestHook = value;
          }}
        />,
      );
    });

    await act(async () => {
      await latestHook?.retryIntegration();
    });

    expect(mockService.ensureAuthToken).toHaveBeenCalledTimes(1);
    expect(mockService.setupDockerModelRunnerIntegration).toHaveBeenCalled();
  });

  it('clears cached status when container leaves running state', async () => {
    const signature = createDMRConfigSignature(config);
    defaultDMRStatusCache.set({
      status: readyStatus(),
      configSignature: signature,
      checkedAt: Date.now(),
      containerStateHint: 'running',
    });

    await act(async () => {
      root.render(
        <HookHarness
          config={config}
          status={runningStatus}
          onMessage={vi.fn()}
          onHookUpdate={() => {}}
        />,
      );
    });

    const stoppedStatus: ContainerStatus = {
      status: 'stopped',
      message: 'stopped',
      config,
    };
    await act(async () => {
      root.render(
        <HookHarness
          config={config}
          status={stoppedStatus}
          onMessage={vi.fn()}
          onHookUpdate={() => {}}
        />,
      );
    });

    expect(defaultDMRStatusCache.get(signature)).toBeNull();
  });

  it('does not rehydrate dmr status when container stops while verify is in flight', async () => {
    let resolveVerify: ((value: ServiceStatus) => void) | null = null;
    const verifyPromise = new Promise<ServiceStatus>((resolve) => {
      resolveVerify = resolve;
    });
    mockService.verifyDockerModelRunnerIntegration = vi.fn().mockReturnValue(verifyPromise);
    mockService.setupDockerModelRunnerIntegration = vi.fn().mockResolvedValue(readyStatus());

    let latestHook: UseDockerModelRunnerResult | null = null;
    await act(async () => {
      root.render(
        <HookHarness
          config={config}
          status={runningStatus}
          onMessage={vi.fn()}
          onHookUpdate={(value) => {
            latestHook = value;
          }}
        />,
      );
    });

    await act(async () => {
      await Promise.resolve();
    });

    const stoppedStatus: ContainerStatus = {
      status: 'stopped',
      message: 'stopped',
      config,
    };
    await act(async () => {
      root.render(
        <HookHarness
          config={config}
          status={stoppedStatus}
          onMessage={vi.fn()}
          onHookUpdate={(value) => {
            latestHook = value;
          }}
        />,
      );
    });

    expect((latestHook as UseDockerModelRunnerResult | null)?.dmrStatus).toBeNull();

    await act(async () => {
      resolveVerify?.(readyStatus());
      await verifyPromise;
    });

    expect((latestHook as UseDockerModelRunnerResult | null)?.dmrStatus).toBeNull();
  });

  it('does not rehydrate dmr status when container stops while setup is in flight', async () => {
    mockService.verifyDockerModelRunnerIntegration = vi
      .fn()
      .mockResolvedValue(unconfiguredStatus());
    let resolveSetup: ((value: ServiceStatus) => void) | null = null;
    const setupPromise = new Promise<ServiceStatus>((resolve) => {
      resolveSetup = resolve;
    });
    mockService.setupDockerModelRunnerIntegration = vi.fn().mockReturnValue(setupPromise);

    let latestHook: UseDockerModelRunnerResult | null = null;
    await act(async () => {
      root.render(
        <HookHarness
          config={config}
          status={runningStatus}
          onMessage={vi.fn()}
          onHookUpdate={(value) => {
            latestHook = value;
          }}
        />,
      );
    });

    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });

    const stoppedStatus: ContainerStatus = {
      status: 'stopped',
      message: 'stopped',
      config,
    };
    await act(async () => {
      root.render(
        <HookHarness
          config={config}
          status={stoppedStatus}
          onMessage={vi.fn()}
          onHookUpdate={(value) => {
            latestHook = value;
          }}
        />,
      );
    });

    expect((latestHook as UseDockerModelRunnerResult | null)?.dmrStatus).toBeNull();

    await act(async () => {
      resolveSetup?.(readyStatus());
      await setupPromise;
    });

    expect((latestHook as UseDockerModelRunnerResult | null)?.dmrStatus).toBeNull();
  });

  it('does not commit stale result when config signature changes while verify is in flight', async () => {
    let resolveVerify: ((value: ServiceStatus) => void) | null = null;
    const verifyPromise = new Promise<ServiceStatus>((resolve) => {
      resolveVerify = resolve;
    });
    mockService.verifyDockerModelRunnerIntegration = vi.fn().mockReturnValue(verifyPromise);

    let latestHook: UseDockerModelRunnerResult | null = null;
    await act(async () => {
      root.render(
        <HookHarness
          config={config}
          status={runningStatus}
          onMessage={vi.fn()}
          onHookUpdate={(value) => {
            latestHook = value;
          }}
        />,
      );
    });

    await act(async () => {
      await Promise.resolve();
    });

    const newConfig: ExtensionConfig = {
      ...config,
      provisioner: 'legacy-function',
    };
    await act(async () => {
      root.render(
        <HookHarness
          config={newConfig}
          status={runningStatus}
          onMessage={vi.fn()}
          onHookUpdate={(value) => {
            latestHook = value;
          }}
        />,
      );
    });

    await act(async () => {
      resolveVerify?.(readyStatus());
      await verifyPromise;
    });

    expect((latestHook as UseDockerModelRunnerResult | null)?.dmrStatus).toBeNull();
  });
});
