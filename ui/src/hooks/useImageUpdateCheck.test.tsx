import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { defaultImageUpdateCache } from '../services/imageUpdateCache';
import type { ContainerService } from '../services/containerService';
import type { ContainerStatus, ExtensionConfig, ImageUpdateCheckResult } from '../types';
import { useImageUpdateCheck } from './useImageUpdateCheck';

type UseImageUpdateCheckResult = ReturnType<typeof useImageUpdateCheck>;

interface HarnessProps {
  config: ExtensionConfig;
  status: ContainerStatus | null;
  service: ContainerService;
  pollIntervalMs?: number;
  onHookUpdate: (value: UseImageUpdateCheckResult) => void;
}

function HookHarness({ config, status, service, pollIntervalMs, onHookUpdate }: HarnessProps) {
  const value = useImageUpdateCheck(config, status, { pollIntervalMs }, service);
  onHookUpdate(value);
  return null;
}

function createResult(overrides: Partial<ImageUpdateCheckResult> = {}): ImageUpdateCheckResult {
  return {
    image: 'ghcr.io/open-webui/open-webui:main',
    supported: true,
    updateAvailable: false,
    checkedAt: Date.now(),
    ...overrides,
  };
}

describe('useImageUpdateCheck', () => {
  let container: HTMLDivElement;
  let root: Root;

  const config: ExtensionConfig = {
    image: 'ghcr.io/open-webui/open-webui:main',
    port: '8090',
    autoStart: true,
    provisioner: 'openai',
    enableDockerMcpToolkit: true,
  };
  const stoppedStatus: ContainerStatus = {
    status: 'stopped',
    message: 'stopped',
    config,
  };
  const runningStatus: ContainerStatus = {
    status: 'running',
    message: 'running',
    config,
  };

  beforeEach(() => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    localStorage.clear();
    defaultImageUpdateCache.clear();
  });

  afterEach(async () => {
    await act(async () => {
      root.unmount();
    });
    container.remove();
    localStorage.clear();
    defaultImageUpdateCache.clear();
    delete (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
    vi.useRealTimers();
    vi.clearAllMocks();
  });

  it('checks updates on initial running state', async () => {
    let latestHook: UseImageUpdateCheckResult | null = null;
    const checkMock = vi.fn().mockResolvedValue(createResult({ updateAvailable: true }));
    const service = { checkImageUpdateAvailability: checkMock } as unknown as ContainerService;

    await act(async () => {
      root.render(
        <HookHarness
          config={config}
          status={runningStatus}
          service={service}
          onHookUpdate={(value) => {
            latestHook = value;
          }}
        />,
      );
    });

    await act(async () => {
      await Promise.resolve();
    });

    expect(checkMock).toHaveBeenCalledTimes(1);
    expect((latestHook as UseImageUpdateCheckResult | null)?.imageUpdate?.updateAvailable).toBe(
      true,
    );
  });

  it('uses cached result when available', async () => {
    let latestHook: UseImageUpdateCheckResult | null = null;
    const firstCheck = vi.fn().mockResolvedValue(createResult({ updateAvailable: false }));
    const firstService = {
      checkImageUpdateAvailability: firstCheck,
    } as unknown as ContainerService;

    await act(async () => {
      root.render(
        <HookHarness
          config={config}
          status={stoppedStatus}
          service={firstService}
          onHookUpdate={(value) => {
            latestHook = value;
          }}
        />,
      );
    });

    await act(async () => {
      await Promise.resolve();
    });

    expect(firstCheck).toHaveBeenCalledTimes(1);

    await act(async () => {
      root.unmount();
    });
    root = createRoot(container);

    const secondCheck = vi.fn().mockResolvedValue(createResult({ updateAvailable: true }));
    const secondService = {
      checkImageUpdateAvailability: secondCheck,
    } as unknown as ContainerService;

    await act(async () => {
      root.render(
        <HookHarness
          config={config}
          status={stoppedStatus}
          service={secondService}
          onHookUpdate={(value) => {
            latestHook = value;
          }}
        />,
      );
    });

    await act(async () => {
      await Promise.resolve();
    });

    expect(secondCheck).not.toHaveBeenCalled();
    expect((latestHook as UseImageUpdateCheckResult | null)?.imageUpdate?.updateAvailable).toBe(
      false,
    );
  });

  it('skips service call for non-floating tags', async () => {
    let latestHook: UseImageUpdateCheckResult | null = null;
    const checkMock = vi.fn().mockResolvedValue(createResult());
    const service = { checkImageUpdateAvailability: checkMock } as unknown as ContainerService;

    await act(async () => {
      root.render(
        <HookHarness
          config={{ ...config, image: 'ghcr.io/open-webui/open-webui:0.5.0' }}
          status={runningStatus}
          service={service}
          onHookUpdate={(value) => {
            latestHook = value;
          }}
        />,
      );
    });

    await act(async () => {
      await Promise.resolve();
    });

    expect(checkMock).not.toHaveBeenCalled();
    expect((latestHook as UseImageUpdateCheckResult | null)?.imageUpdate?.supported).toBe(false);
  });

  it('formats thrown object errors into readable message', async () => {
    let latestHook: UseImageUpdateCheckResult | null = null;
    const checkMock = vi
      .fn()
      .mockRejectedValue({ stderr: 'template parsing error: template: :1: unclosed action' });
    const service = { checkImageUpdateAvailability: checkMock } as unknown as ContainerService;

    await act(async () => {
      root.render(
        <HookHarness
          config={config}
          status={runningStatus}
          service={service}
          onHookUpdate={(value) => {
            latestHook = value;
          }}
        />,
      );
    });

    await act(async () => {
      await Promise.resolve();
    });

    expect((latestHook as UseImageUpdateCheckResult | null)?.imageUpdate?.error).toContain(
      'template parsing error',
    );
    expect((latestHook as UseImageUpdateCheckResult | null)?.imageUpdate?.error).not.toContain(
      '[object Object]',
    );
  });

  it('supports force refresh and periodic polling while running', async () => {
    vi.useFakeTimers();

    let latestHook: UseImageUpdateCheckResult | null = null;
    const checkMock = vi.fn().mockResolvedValue(createResult());
    const service = { checkImageUpdateAvailability: checkMock } as unknown as ContainerService;

    await act(async () => {
      root.render(
        <HookHarness
          config={config}
          status={runningStatus}
          service={service}
          pollIntervalMs={1000}
          onHookUpdate={(value) => {
            latestHook = value;
          }}
        />,
      );
    });

    expect(checkMock).toHaveBeenCalledTimes(1);

    await act(async () => {
      await latestHook?.checkNow({ force: true });
    });
    expect(checkMock).toHaveBeenCalledTimes(2);

    defaultImageUpdateCache.clear();

    await act(async () => {
      vi.advanceTimersByTime(3000);
    });

    expect(checkMock.mock.calls.length).toBeGreaterThanOrEqual(3);
  });

  it('force refresh reruns after an in-flight stale check settles', async () => {
    let latestHook: UseImageUpdateCheckResult | null = null;
    let resolveInitial: ((value: ImageUpdateCheckResult) => void) | null = null;

    const initialPromise = new Promise<ImageUpdateCheckResult>((resolve) => {
      resolveInitial = resolve;
    });

    const checkMock = vi
      .fn()
      .mockImplementationOnce(() => initialPromise)
      .mockResolvedValueOnce(createResult({ updateAvailable: false }));
    const service = { checkImageUpdateAvailability: checkMock } as unknown as ContainerService;

    await act(async () => {
      root.render(
        <HookHarness
          config={config}
          status={runningStatus}
          service={service}
          onHookUpdate={(value) => {
            latestHook = value;
          }}
        />,
      );
    });

    expect(checkMock).toHaveBeenCalledTimes(1);

    await act(async () => {
      const forcedPromise = latestHook?.checkNow({ force: true });
      resolveInitial?.(createResult({ updateAvailable: true }));
      await forcedPromise;
    });

    expect(checkMock).toHaveBeenCalledTimes(2);
    expect((latestHook as UseImageUpdateCheckResult | null)?.imageUpdate?.updateAvailable).toBe(
      false,
    );
  });
});
