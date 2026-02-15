import { afterEach, describe, expect, it, vi } from 'vitest';

import { createInMemoryStorageAdapter, type StorageAdapter } from './storage';
import { TypedStorageCache } from './typedStorageCache';

interface TestEntry {
  signature: string;
  checkedAt: number;
  value: string;
}

const STORAGE_KEY = 'typed-storage-cache-test';

function createCache(storage: StorageAdapter, ttlMs = 60_000): TypedStorageCache<TestEntry> {
  return new TypedStorageCache<TestEntry>(storage, {
    storageKey: STORAGE_KEY,
    ttlMs,
    normalizeEntry: (value: unknown) => {
      if (!value || typeof value !== 'object' || Array.isArray(value)) {
        return null;
      }
      const record = value as Record<string, unknown>;
      if (
        typeof record.signature !== 'string' ||
        typeof record.checkedAt !== 'number' ||
        typeof record.value !== 'string'
      ) {
        return null;
      }
      return {
        signature: record.signature,
        checkedAt: record.checkedAt,
        value: record.value,
      };
    },
    getCheckedAt: (entry) => entry.checkedAt,
    getSignature: (entry) => entry.signature,
    readErrorMessage: 'read failed',
    writeErrorMessage: 'write failed',
    clearErrorMessage: 'clear failed',
  });
}

describe('TypedStorageCache', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('stores and retrieves entries with matching signature', () => {
    const storage = createInMemoryStorageAdapter();
    const cache = createCache(storage);

    cache.set({
      signature: 'sig-a',
      checkedAt: Date.now(),
      value: 'ok',
    });

    expect(cache.get('sig-a')).toEqual({
      signature: 'sig-a',
      checkedAt: expect.any(Number),
      value: 'ok',
    });
  });

  it('expires entries after ttl', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-01-01T00:00:00.000Z'));

    const storage = createInMemoryStorageAdapter();
    const cache = createCache(storage, 1_000);

    cache.set({
      signature: 'sig-expire',
      checkedAt: Date.now(),
      value: 'stale',
    });

    vi.advanceTimersByTime(1_500);
    expect(cache.get('sig-expire')).toBeNull();
    expect(storage.getItem(STORAGE_KEY)).toBeNull();
  });

  it('removes malformed payloads', () => {
    const storage = createInMemoryStorageAdapter();
    const cache = createCache(storage);

    storage.setItem(STORAGE_KEY, JSON.stringify({ signature: 'sig', value: true }));
    expect(cache.get('sig')).toBeNull();
    expect(storage.getItem(STORAGE_KEY)).toBeNull();
  });

  it('can remove stale entries on signature mismatch', () => {
    const storage = createInMemoryStorageAdapter();
    const cache = new TypedStorageCache<TestEntry>(storage, {
      storageKey: STORAGE_KEY,
      ttlMs: 60_000,
      normalizeEntry: (value) => {
        if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
        const record = value as Record<string, unknown>;
        if (
          typeof record.signature !== 'string' ||
          typeof record.checkedAt !== 'number' ||
          typeof record.value !== 'string'
        ) {
          return null;
        }
        return {
          signature: record.signature,
          checkedAt: record.checkedAt,
          value: record.value,
        };
      },
      getCheckedAt: (entry) => entry.checkedAt,
      getSignature: (entry) => entry.signature,
      removeOnSignatureMismatch: true,
      readErrorMessage: 'read failed',
      writeErrorMessage: 'write failed',
      clearErrorMessage: 'clear failed',
    });

    cache.set({
      signature: 'sig-current',
      checkedAt: Date.now(),
      value: 'v',
    });

    expect(cache.get('sig-other')).toBeNull();
    expect(storage.getItem(STORAGE_KEY)).toBeNull();
  });

  it('handles storage adapter errors gracefully', () => {
    const throwingStorage: StorageAdapter = {
      getItem: () => {
        throw new Error('read error');
      },
      setItem: () => {
        throw new Error('write error');
      },
      removeItem: () => {
        throw new Error('remove error');
      },
    };
    const cache = createCache(throwingStorage);

    expect(cache.get('sig')).toBeNull();
    expect(() =>
      cache.set({
        signature: 'sig',
        checkedAt: Date.now(),
        value: 'v',
      }),
    ).not.toThrow();
    expect(() => cache.clear()).not.toThrow();
  });
});
