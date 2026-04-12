import { MCP_TOOLKIT_STATUS_CACHE_TTL_MS } from '../constants';
import type { ContainerState, DockerMcpToolkitStatus, ExtensionConfig } from '../types';
import { createLocalStorageAdapter, type StorageAdapter } from './storage';
import { isObject, TypedStorageCache } from './typedStorageCache';

const STORAGE_KEY = 'openwebui-extension-mcp-toolkit-status';

export interface CachedMcpToolkitStatusEntry {
  status: DockerMcpToolkitStatus;
  checkedAt: number;
  configSignature: string;
  containerStateHint?: ContainerState;
}

interface CachedMcpToolkitStatusPayload {
  status: DockerMcpToolkitStatus;
  checkedAt: number;
  configSignature: string;
  containerStateHint?: ContainerState;
}

function isMcpToolkitStatusLike(value: unknown): value is DockerMcpToolkitStatus {
  if (!isObject(value)) {
    return false;
  }
  return (
    typeof value.enabled === 'boolean' &&
    typeof value.containerRunning === 'boolean' &&
    typeof value.supported === 'boolean' &&
    typeof value.profileAvailable === 'boolean' &&
    typeof value.gatewayReachable === 'boolean' &&
    typeof value.openWebUIToolServerConfigured === 'boolean' &&
    typeof value.integrationConfigured === 'boolean' &&
    typeof value.lastChecked === 'number'
  );
}

function normalizePayload(value: unknown): CachedMcpToolkitStatusPayload | null {
  if (!isObject(value) || !isMcpToolkitStatusLike(value.status)) {
    return null;
  }

  const checkedAt = Number(value.checkedAt);
  const configSignature = typeof value.configSignature === 'string' ? value.configSignature : '';
  if (!Number.isFinite(checkedAt) || checkedAt <= 0 || configSignature.trim().length === 0) {
    return null;
  }

  const stateHint = value.containerStateHint;
  const containerStateHint =
    typeof stateHint === 'string' ? (stateHint as ContainerState) : undefined;

  return {
    status: value.status,
    checkedAt,
    configSignature: configSignature.trim(),
    containerStateHint,
  };
}

export function createMcpToolkitConfigSignature(
  config: Pick<ExtensionConfig, 'image' | 'port' | 'enableDockerMcpToolkit'>,
): string {
  return `${config.image.trim()}|${config.port.trim()}|${config.enableDockerMcpToolkit}`;
}

export class McpToolkitStatusCache {
  private readonly cache: TypedStorageCache<CachedMcpToolkitStatusEntry>;

  constructor(storage: StorageAdapter, ttlMs: number = MCP_TOOLKIT_STATUS_CACHE_TTL_MS) {
    this.cache = new TypedStorageCache<CachedMcpToolkitStatusEntry>(storage, {
      storageKey: STORAGE_KEY,
      ttlMs,
      normalizeEntry: normalizePayload,
      getCheckedAt: (entry) => entry.checkedAt,
      getSignature: (entry) => entry.configSignature,
      removeOnSignatureMismatch: true,
      readErrorMessage: 'Failed to read MCP Toolkit status cache:',
      writeErrorMessage: 'Failed to write MCP Toolkit status cache:',
      clearErrorMessage: 'Failed to clear MCP Toolkit status cache:',
    });
  }

  get(configSignature: string): CachedMcpToolkitStatusEntry | null {
    return this.cache.get(configSignature);
  }

  set(entry: {
    status: DockerMcpToolkitStatus;
    configSignature: string;
    containerStateHint?: ContainerState;
    checkedAt?: number;
  }): void {
    const checkedAt = entry.checkedAt ?? Date.now();
    const payload: CachedMcpToolkitStatusPayload = {
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

export const defaultMcpToolkitStatusCache = new McpToolkitStatusCache(createLocalStorageAdapter());

