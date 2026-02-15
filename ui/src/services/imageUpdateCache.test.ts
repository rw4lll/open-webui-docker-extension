import { afterEach, describe, expect, it, vi } from 'vitest';

import type { ImageUpdateCheckResult } from '../types';
import { ImageUpdateCache, createImageUpdateSignature } from './imageUpdateCache';
import { createInMemoryStorageAdapter } from './storage';

function buildResult(overrides: Partial<ImageUpdateCheckResult> = {}): ImageUpdateCheckResult {
  return {
    image: 'ghcr.io/open-webui/open-webui:main',
    supported: true,
    updateAvailable: false,
    checkedAt: Date.now(),
    ...overrides,
  };
}

describe('ImageUpdateCache', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('stores and retrieves entries for matching signatures', () => {
    const cache = new ImageUpdateCache(createInMemoryStorageAdapter(), 60_000);
    const signature = createImageUpdateSignature('ghcr.io/open-webui/open-webui:main');

    cache.set({
      result: buildResult(),
      imageSignature: signature,
      checkedAt: Date.now(),
    });

    const result = cache.get(signature);
    expect(result).not.toBeNull();
    expect(result?.imageSignature).toBe(signature);
    expect(result?.result.supported).toBe(true);
  });

  it('returns null for mismatched signature', () => {
    const cache = new ImageUpdateCache(createInMemoryStorageAdapter(), 60_000);
    const signature = createImageUpdateSignature('ghcr.io/open-webui/open-webui:main');

    cache.set({
      result: buildResult(),
      imageSignature: signature,
      checkedAt: Date.now(),
    });

    const mismatch = createImageUpdateSignature('ghcr.io/open-webui/open-webui:latest');
    expect(cache.get(mismatch)).toBeNull();
  });

  it('expires entries after ttl', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-01-01T00:00:00.000Z'));

    const cache = new ImageUpdateCache(createInMemoryStorageAdapter(), 1_000);
    const signature = createImageUpdateSignature('ghcr.io/open-webui/open-webui:main');

    cache.set({
      result: buildResult(),
      imageSignature: signature,
      checkedAt: Date.now(),
    });

    vi.advanceTimersByTime(1_500);
    expect(cache.get(signature)).toBeNull();
  });

  it('removes malformed payloads', () => {
    const storage = createInMemoryStorageAdapter();
    const cache = new ImageUpdateCache(storage, 60_000);
    const signature = createImageUpdateSignature('ghcr.io/open-webui/open-webui:main');

    storage.setItem(
      'openwebui-extension-image-update',
      JSON.stringify({
        result: { supported: true },
        checkedAt: Date.now(),
        imageSignature: signature,
      }),
    );

    expect(cache.get(signature)).toBeNull();
    expect(storage.getItem('openwebui-extension-image-update')).toBeNull();
  });

  it('clears entries explicitly', () => {
    const cache = new ImageUpdateCache(createInMemoryStorageAdapter(), 60_000);
    const signature = createImageUpdateSignature('ghcr.io/open-webui/open-webui:main');

    cache.set({
      result: buildResult(),
      imageSignature: signature,
      checkedAt: Date.now(),
    });
    cache.clear();

    expect(cache.get(signature)).toBeNull();
  });
});
