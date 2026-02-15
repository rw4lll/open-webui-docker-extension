import { log } from '../../logger';
import type { DockerModelRunnerConfig } from '../../types';

export interface ContainerCurlOptions {
  url: string;
  method?: 'GET' | 'POST' | 'PUT' | 'DELETE' | 'PATCH';
  includeFailFlag?: boolean;
  connectTimeoutSeconds: number;
  maxTimeSeconds: number;
  maxRetries?: number;
}

export interface TestDMRConnectivityParams {
  dmrConfig: DockerModelRunnerConfig;
  containerCurl: (opts: ContainerCurlOptions) => Promise<string>;
  /** Optional callback when connectivity fails; e.g. legacy DNS diagnostic (getent). */
  onFailure?: () => void | Promise<void>;
}

export interface ConnectivityCacheState {
  getLastOkAt: () => number;
  setLastOkAt: (timestamp: number) => void;
}

export interface TestDMRConnectivityWithCacheParams extends TestDMRConnectivityParams {
  cache: ConnectivityCacheState;
}

/**
 * Tests Docker Model Runner connectivity from inside the Open WebUI container.
 * Uses in-container curl with retries. Caller is responsible for caching (lastOkAt).
 */
export async function testDMRConnectivity(params: TestDMRConnectivityParams): Promise<boolean> {
  try {
    const { baseUrl, engineSuffix, retryCount, connectionTimeout } = params.dmrConfig;
    const testUrl = `${baseUrl}${engineSuffix}/models`;
    const retryAttempts = Math.max(1, retryCount);
    const connectTimeoutSeconds = Math.max(1, Math.ceil(connectionTimeout));
    const maxTimeSeconds = connectTimeoutSeconds + 2;

    try {
      await params.containerCurl({
        url: testUrl,
        method: 'GET',
        includeFailFlag: true,
        connectTimeoutSeconds,
        maxTimeSeconds,
        maxRetries: 1,
      });
      return true;
    } catch {
      // fall through
    }

    const result = await params.containerCurl({
      url: testUrl,
      includeFailFlag: true,
      connectTimeoutSeconds,
      maxTimeSeconds: Math.max(maxTimeSeconds * 2, maxTimeSeconds + 5),
      maxRetries: retryAttempts,
    });

    const ok = result.trim().length > 0;
    if (ok) {
      return true;
    }

    if (params.onFailure) {
      await params.onFailure();
    }

    return false;
  } catch (error) {
    if (params.onFailure) {
      try {
        await params.onFailure();
      } catch {
        // ignore onFailure callback errors
      }
    }
    log.warn('Docker Model Runner connectivity test failed:', error);
    return false;
  }
}

export async function testConnectivityWithCache(
  params: TestDMRConnectivityWithCacheParams,
): Promise<boolean> {
  const { connectivityCacheMs } = params.dmrConfig;
  const lastOkAt = params.cache.getLastOkAt();

  if (lastOkAt && Date.now() - lastOkAt < connectivityCacheMs) {
    return true;
  }

  const ok = await testDMRConnectivity(params);
  if (ok) {
    params.cache.setLastOkAt(Date.now());
  }
  return ok;
}
