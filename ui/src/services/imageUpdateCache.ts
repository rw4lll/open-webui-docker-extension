import { IMAGE_UPDATE_CACHE_TTL_MS } from '../constants';
import type { ImageUpdateCheckResult } from '../types';
import { createLocalStorageAdapter, type StorageAdapter } from './storage';
import { isObject, TypedStorageCache } from './typedStorageCache';

const STORAGE_KEY = 'openwebui-extension-image-update';

interface CachedImageUpdatePayload {
  result: ImageUpdateCheckResult;
  checkedAt: number;
  imageSignature: string;
}

export interface CachedImageUpdateEntry {
  result: ImageUpdateCheckResult;
  checkedAt: number;
  imageSignature: string;
}

function isImageUpdateResultLike(value: unknown): value is ImageUpdateCheckResult {
  if (!isObject(value)) {
    return false;
  }

  return (
    typeof value.image === 'string' &&
    typeof value.supported === 'boolean' &&
    typeof value.updateAvailable === 'boolean' &&
    typeof value.checkedAt === 'number'
  );
}

function normalizePayload(value: unknown): CachedImageUpdatePayload | null {
  if (!isObject(value) || !isImageUpdateResultLike(value.result)) {
    return null;
  }

  const checkedAt = Number(value.checkedAt);
  const imageSignature =
    typeof value.imageSignature === 'string' ? value.imageSignature.trim() : '';
  if (!Number.isFinite(checkedAt) || checkedAt <= 0 || imageSignature.length === 0) {
    return null;
  }

  return {
    result: value.result,
    checkedAt,
    imageSignature,
  };
}

export function createImageUpdateSignature(image: string): string {
  return image.trim();
}

export class ImageUpdateCache {
  private readonly cache: TypedStorageCache<CachedImageUpdateEntry>;

  constructor(storage: StorageAdapter, ttlMs: number = IMAGE_UPDATE_CACHE_TTL_MS) {
    this.cache = new TypedStorageCache<CachedImageUpdateEntry>(storage, {
      storageKey: STORAGE_KEY,
      ttlMs,
      normalizeEntry: normalizePayload,
      getCheckedAt: (entry) => entry.checkedAt,
      getSignature: (entry) => entry.imageSignature,
      normalizeLookupSignature: (signature) => signature.trim(),
      readErrorMessage: 'Failed to read image update cache:',
      writeErrorMessage: 'Failed to write image update cache:',
      clearErrorMessage: 'Failed to clear image update cache:',
    });
  }

  get(imageSignature: string): CachedImageUpdateEntry | null {
    return this.cache.get(imageSignature);
  }

  set(entry: { result: ImageUpdateCheckResult; imageSignature: string; checkedAt?: number }): void {
    const checkedAt = entry.checkedAt ?? Date.now();
    const payload: CachedImageUpdatePayload = {
      result: entry.result,
      checkedAt,
      imageSignature: entry.imageSignature.trim(),
    };
    this.cache.set(payload);
  }

  clear(): void {
    this.cache.clear();
  }
}

export const defaultImageUpdateCache = new ImageUpdateCache(createLocalStorageAdapter());
