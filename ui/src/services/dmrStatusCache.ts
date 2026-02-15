import { DMR_STATUS_CACHE_TTL_MS } from '../constants';
import type { ContainerState, ExtensionConfig, ServiceStatus } from '../types';
import { createLocalStorageAdapter, type StorageAdapter } from './storage';
import { isObject, TypedStorageCache } from './typedStorageCache';

const STORAGE_KEY = 'openwebui-extension-dmr-status';

export interface CachedDMRStatusEntry {
  status: ServiceStatus;
  checkedAt: number;
  configSignature: string;
  containerStateHint?: ContainerState;
}

interface CachedDMRStatusPayload {
  status: ServiceStatus;
  checkedAt: number;
  configSignature: string;
  containerStateHint?: ContainerState;
}

function isServiceStatusLike(value: unknown): value is ServiceStatus {
  if (!isObject(value)) {
    return false;
  }
  return (
    typeof value.containerRunning === 'boolean' &&
    typeof value.functionInstalled === 'boolean' &&
    typeof value.functionEnabled === 'boolean' &&
    typeof value.dockerModelRunnerConnected === 'boolean' &&
    typeof value.lastChecked === 'number'
  );
}

function normalizePayload(value: unknown): CachedDMRStatusPayload | null {
  if (!isObject(value) || !isServiceStatusLike(value.status)) {
    return null;
  }

  const checkedAt = Number(value.checkedAt);
  const configSignature = typeof value.configSignature === 'string' ? value.configSignature : '';
  if (!Number.isFinite(checkedAt) || checkedAt <= 0 || configSignature.trim().length === 0) {
    return null;
  }

  const stateHint = value.containerStateHint;
  const containerStateHint = typeof stateHint === 'string' ? (stateHint as ContainerState) : undefined;

  return {
    status: value.status,
    checkedAt,
    configSignature: configSignature.trim(),
    containerStateHint,
  };
}

export function createDMRConfigSignature(
  config: Pick<ExtensionConfig, 'image' | 'port' | 'provisioner'>,
): string {
  return `${config.image.trim()}|${config.port.trim()}|${config.provisioner}`;
}

export class DMRStatusCache {
  private readonly cache: TypedStorageCache<CachedDMRStatusEntry>;

  constructor(
    storage: StorageAdapter,
    ttlMs: number = DMR_STATUS_CACHE_TTL_MS,
  ) {
    this.cache = new TypedStorageCache<CachedDMRStatusEntry>(storage, {
      storageKey: STORAGE_KEY,
      ttlMs,
      normalizeEntry: normalizePayload,
      getCheckedAt: (entry) => entry.checkedAt,
      getSignature: (entry) => entry.configSignature,
      removeOnSignatureMismatch: true,
      readErrorMessage: 'Failed to read DMR status cache:',
      writeErrorMessage: 'Failed to write DMR status cache:',
      clearErrorMessage: 'Failed to clear DMR status cache:',
    });
  }

  get(configSignature: string): CachedDMRStatusEntry | null {
    return this.cache.get(configSignature);
  }

  set(entry: {
    status: ServiceStatus;
    configSignature: string;
    containerStateHint?: ContainerState;
    checkedAt?: number;
  }): void {
    const checkedAt = entry.checkedAt ?? Date.now();
    const payload: CachedDMRStatusPayload = {
      status: entry.status,
      checkedAt,
      configSignature: entry.configSignature.trim(),
      containerStateHint: entry.containerStateHint,
    };
    this.cache.set(payload);
  }

  clear(): void {
    this.cache.clear();
  }
}

export const defaultDMRStatusCache = new DMRStatusCache(createLocalStorageAdapter());
