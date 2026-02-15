import { afterEach, describe, expect, it, vi } from 'vitest';

import type { ServiceStatus } from '../types';
import { DMRStatusCache, createDMRConfigSignature } from './dmrStatusCache';
import { createInMemoryStorageAdapter } from './storage';

const readyStatus = (): ServiceStatus => ({
  containerRunning: true,
  functionInstalled: true,
  functionEnabled: true,
  dockerModelRunnerConnected: true,
  lastChecked: Date.now(),
  integrationConfigured: true,
  provisionerMode: 'openai',
});

describe('DMRStatusCache', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('stores and retrieves entries for matching signatures', () => {
    const cache = new DMRStatusCache(createInMemoryStorageAdapter(), 60_000);
    const signature = createDMRConfigSignature({
      image: 'ghcr.io/open-webui/open-webui:main',
      port: '8090',
      provisioner: 'openai',
    });

    cache.set({
      status: readyStatus(),
      configSignature: signature,
      containerStateHint: 'running',
      checkedAt: Date.now(),
    });

    const result = cache.get(signature);
    expect(result).not.toBeNull();
    expect(result?.configSignature).toBe(signature);
    expect(result?.status.dockerModelRunnerConnected).toBe(true);
  });

  it('ignores cache entries when signature does not match', () => {
    const cache = new DMRStatusCache(createInMemoryStorageAdapter(), 60_000);
    const signature = createDMRConfigSignature({
      image: 'ghcr.io/open-webui/open-webui:main',
      port: '8090',
      provisioner: 'openai',
    });

    cache.set({
      status: readyStatus(),
      configSignature: signature,
      checkedAt: Date.now(),
    });

    const mismatch = createDMRConfigSignature({
      image: 'ghcr.io/open-webui/open-webui:main',
      port: '8091',
      provisioner: 'openai',
    });
    expect(cache.get(mismatch)).toBeNull();
  });

  it('expires entries after ttl', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-01-01T00:00:00.000Z'));

    const cache = new DMRStatusCache(createInMemoryStorageAdapter(), 1_000);
    const signature = createDMRConfigSignature({
      image: 'img:tag',
      port: '8090',
      provisioner: 'legacy-function',
    });

    cache.set({
      status: readyStatus(),
      configSignature: signature,
      checkedAt: Date.now(),
    });

    vi.advanceTimersByTime(1_500);
    expect(cache.get(signature)).toBeNull();
  });

  it('clears entries explicitly', () => {
    const cache = new DMRStatusCache(createInMemoryStorageAdapter(), 60_000);
    const signature = createDMRConfigSignature({
      image: 'img:tag',
      port: '8090',
      provisioner: 'legacy-function',
    });

    cache.set({
      status: readyStatus(),
      configSignature: signature,
      checkedAt: Date.now(),
    });
    cache.clear();

    expect(cache.get(signature)).toBeNull();
  });
});
