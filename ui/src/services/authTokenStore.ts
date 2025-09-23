import { log } from '../logger';
import { createLocalStorageAdapter, type StorageAdapter } from './storage';

const TOKEN_KEY = 'openwebui-extension-token';
const DEFAULT_TTL_MS = 24 * 60 * 60 * 1000; // 24h

interface StoredTokenPayload {
  token: string;
  expiresAt?: number;
}

export class AuthTokenStore {
  constructor(
    private readonly storage: StorageAdapter,
    private readonly fallbackTtlMs: number = DEFAULT_TTL_MS,
  ) {}

  getToken(): string | undefined {
    try {
      const raw = this.storage.getItem(TOKEN_KEY);
      if (!raw) {
        return undefined;
      }

      const parsed = JSON.parse(raw) as StoredTokenPayload;
      if (parsed.expiresAt && Date.now() > parsed.expiresAt) {
        this.storage.removeItem(TOKEN_KEY);
        return undefined;
      }

      return typeof parsed.token === 'string' && parsed.token.trim().length > 0
        ? parsed.token
        : undefined;
    } catch (error) {
      log.warn('Failed to load auth token:', error);
      return undefined;
    }
  }

  setToken(token: string, ttlMs?: number, explicitExpiryMs?: number): void {
    try {
      const ttl =
        typeof explicitExpiryMs === 'number'
          ? explicitExpiryMs
          : typeof ttlMs === 'number'
            ? ttlMs
            : this.fallbackTtlMs;
      const payload: StoredTokenPayload = {
        token,
        expiresAt: Date.now() + Math.max(0, ttl),
      };
      this.storage.setItem(TOKEN_KEY, JSON.stringify(payload));
    } catch (error) {
      log.warn('Failed to save auth token:', error);
    }
  }

  clearToken(): void {
    try {
      this.storage.removeItem(TOKEN_KEY);
    } catch (error) {
      log.warn('Failed to clear auth token:', error);
    }
  }
}

export const defaultAuthTokenStore = new AuthTokenStore(createLocalStorageAdapter());
