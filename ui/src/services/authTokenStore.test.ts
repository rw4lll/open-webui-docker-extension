import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

import { AuthTokenStore } from './authTokenStore';
import { createInMemoryStorageAdapter } from './storage';

describe('AuthTokenStore', () => {
  let store: AuthTokenStore;

  beforeEach(() => {
    store = new AuthTokenStore(createInMemoryStorageAdapter());
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('sets, retrieves, and clears tokens honoring TTL', () => {
    store.setToken('abc', 100);
    expect(store.getToken()).toBe('abc');
    store.clearToken();
    expect(store.getToken()).toBeUndefined();
  });

  it('expires tokens when TTL passes', () => {
    vi.useFakeTimers();
    store.setToken('xyz', 50);
    vi.advanceTimersByTime(60);
    expect(store.getToken()).toBeUndefined();
  });
});
