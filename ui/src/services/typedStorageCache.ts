import { log } from '../logger';
import type { StorageAdapter } from './storage';

export interface TypedStorageCacheConfig<TEntry> {
  storageKey: string;
  ttlMs: number;
  normalizeEntry: (value: unknown) => TEntry | null;
  getCheckedAt: (entry: TEntry) => number;
  getSignature: (entry: TEntry) => string;
  normalizeLookupSignature?: (signature: string) => string;
  removeOnSignatureMismatch?: boolean;
  readErrorMessage: string;
  writeErrorMessage: string;
  clearErrorMessage: string;
}

export function isObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

export class TypedStorageCache<TEntry> {
  constructor(
    private readonly storage: StorageAdapter,
    private readonly config: TypedStorageCacheConfig<TEntry>,
  ) {}

  get(signature: string): TEntry | null {
    try {
      const raw = this.storage.getItem(this.config.storageKey);
      if (!raw) {
        return null;
      }

      const parsed = this.config.normalizeEntry(JSON.parse(raw));
      if (!parsed) {
        this.storage.removeItem(this.config.storageKey);
        return null;
      }

      if (Date.now() - this.config.getCheckedAt(parsed) > this.config.ttlMs) {
        this.storage.removeItem(this.config.storageKey);
        return null;
      }

      const normalizeLookupSignature = this.config.normalizeLookupSignature ?? ((v: string) => v);
      const expectedSignature = normalizeLookupSignature(signature);
      if (this.config.getSignature(parsed) !== expectedSignature) {
        if (this.config.removeOnSignatureMismatch) {
          this.storage.removeItem(this.config.storageKey);
        }
        return null;
      }

      return parsed;
    } catch (error) {
      log.warn(this.config.readErrorMessage, error);
      return null;
    }
  }

  set(entry: TEntry): void {
    try {
      this.storage.setItem(this.config.storageKey, JSON.stringify(entry));
    } catch (error) {
      log.warn(this.config.writeErrorMessage, error);
    }
  }

  clear(): void {
    try {
      this.storage.removeItem(this.config.storageKey);
    } catch (error) {
      log.warn(this.config.clearErrorMessage, error);
    }
  }
}
