import { log } from '../logger';
import type { ExtensionConfig } from '../types';
import { retryWithBackoff, buildBackoffDelays } from '../utils/retry';
import { getDDClient, type DockerDesktopClient } from './dockerDesktopClient';
import type { AuthTokenStore } from './authTokenStore';

export interface HttpRequestOptions {
  url: string;
  method?: 'GET' | 'POST' | 'PUT' | 'DELETE' | 'PATCH';
  headers?: Record<string, string>;
  body?: string;
  timeoutMs?: number;
  userAgent?: string;
  maxRetries?: number;
  includeAuth?: boolean;
}

interface CurlOptions {
  url: string;
  method?: 'GET' | 'POST' | 'PUT' | 'DELETE' | 'PATCH';
  headers?: Record<string, string>;
  data?: string;
  followRedirects?: boolean;
  userAgent?: string;
  connectTimeoutSeconds?: number;
  maxTimeSeconds?: number;
  includeFailFlag?: boolean;
  maxRetries?: number;
}

interface WaitUntilReadyOptions {
  timeoutMs?: number;
  initialDelayMs?: number;
  maxDelayMs?: number;
}

interface OpenWebUIHttpClientOptions {
  config: ExtensionConfig;
  retryCount: number;
  authTokenStore: AuthTokenStore;
  containerName: string;
  dockerClientProvider?: () => DockerDesktopClient;
}

export class OpenWebUIHttpClient {
  private config: ExtensionConfig;
  private apiBaseUrl: string;
  private readonly retryDelays: number[];
  private authToken?: string;
  private authTokenLoaded = false;

  constructor(private readonly options: OpenWebUIHttpClientOptions) {
    this.config = options.config;
    this.apiBaseUrl = this.buildApiBaseUrl(this.config.port);
    this.retryDelays = buildBackoffDelays({
      initialDelayMs: 1000,
      maxDelayMs: 16000,
      maxAttempts: Math.max(1, Math.floor(options.retryCount)),
    });
  }

  updateConfig(config: ExtensionConfig): void {
    this.config = config;
    this.apiBaseUrl = this.buildApiBaseUrl(config.port);
    log.debug('OpenWebUIHttpClient config updated - external port:', config.port);
  }

  setAuthToken(token?: string): void {
    const trimmed = (token || '').trim();
    this.authToken = trimmed.length > 0 ? trimmed : undefined;
    this.authTokenLoaded = true;
  }

  async ensureAuthToken(): Promise<boolean> {
    if (!this.authTokenLoaded) {
      const stored = this.options.authTokenStore.getToken();
      if (stored) {
        this.authToken = stored;
      }
      this.authTokenLoaded = true;
    }

    if (this.authToken && this.authToken.trim().length > 0) {
      return true;
    }

    try {
      const url = this.buildSigninUrl();
      const payload = JSON.stringify({ email: '', password: '' });
      const responseText = await this.request({
        url,
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: payload,
        timeoutMs: 10000,
        maxRetries: 2,
        includeAuth: false,
      });

      const json = JSON.parse(responseText) as { token?: string; exp?: number };
      const token = typeof json?.token === 'string' ? json.token : undefined;
      if (token) {
        this.setAuthToken(token);
        const ttlMs =
          typeof json?.exp === 'number' ? Math.max(0, json.exp * 1000 - Date.now()) : undefined;
        this.options.authTokenStore.setToken(token, ttlMs);
        log.debug('Auth token obtained and cached');
        return true;
      }

      log.warn('Signin succeeded but token missing in response');
      return false;
    } catch (error) {
      log.warn('Failed to auto-obtain auth token:', error);
      return false;
    }
  }

  async request(options: HttpRequestOptions): Promise<string> {
    const {
      url,
      method = 'GET',
      headers = {},
      body,
      timeoutMs = 10000,
      userAgent,
      maxRetries: maxRetriesOption,
      includeAuth = false,
    } = options;

    const maxRetries = Math.max(1, maxRetriesOption ?? this.retryDelays.length);

    return retryWithBackoff(
      async () => {
        const controller = new AbortController();
        const abortTimer = setTimeout(() => controller.abort(), timeoutMs);

        try {
          const finalHeaders: Record<string, string> = { ...headers };
          if (userAgent) {
            finalHeaders['User-Agent'] = userAgent;
          }

          if (includeAuth) {
            if (!this.authTokenLoaded) {
              await this.ensureAuthToken();
            }
            if (this.authToken) {
              finalHeaders['Authorization'] = `Bearer ${this.authToken}`;
            } else {
              delete finalHeaders['Authorization'];
            }
          }

          const response = await fetch(url, {
            method,
            headers: finalHeaders,
            body,
            signal: controller.signal,
          } as RequestInit);

          if (response.status === 401 && includeAuth) {
            const refreshed = await this.handleUnauthorized();
            if (!refreshed) {
              const text = await response.text().catch(() => '');
              throw new Error(`HTTP 401 Unauthorized - ${text}`);
            }

            const retryController = new AbortController();
            const retryAbortTimer = setTimeout(() => retryController.abort(), timeoutMs);
            try {
              const retryHeaders: Record<string, string> = { ...finalHeaders };
              retryHeaders['Authorization'] = this.authToken ? `Bearer ${this.authToken}` : '';
              const retryResponse = await fetch(url, {
                method,
                headers: retryHeaders,
                body,
                signal: retryController.signal,
              } as RequestInit);
              if (!retryResponse.ok) {
                const retryText = await retryResponse.text().catch(() => '');
                throw new Error(
                  `HTTP ${retryResponse.status} ${retryResponse.statusText} - ${retryText}`,
                );
              }
              return await retryResponse.text();
            } finally {
              clearTimeout(retryAbortTimer);
            }
          }

          if (!response.ok) {
            const text = await response.text().catch(() => '');
            throw new Error(`HTTP ${response.status} ${response.statusText} - ${text}`);
          }

          return await response.text();
        } finally {
          clearTimeout(abortTimer);
        }
      },
      {
        maxAttempts: maxRetries,
        delays: this.retryDelays,
        errorFactory: (lastError) =>
          new Error(
            `Request failed after ${maxRetries} attempts: ${String(
              (lastError as Error)?.message || lastError,
            )}`,
          ),
      },
    );
  }

  async execInContainer(args: string[], maxRetries?: number): Promise<string> {
    const client = this.getDockerClient();
    const attempts = Math.max(1, maxRetries ?? this.retryDelays.length);

    return retryWithBackoff(
      async () => {
        const result = await client.docker.cli.exec('exec', [this.options.containerName, ...args]);
        return result.stdout || '';
      },
      {
        maxAttempts: attempts,
        delays: this.retryDelays,
        errorFactory: (lastError) =>
          new Error(
            `execInContainer failed after ${attempts} attempts: ${
              lastError instanceof Error ? lastError.message : String(lastError)
            }`,
          ),
      },
    );
  }

  async containerCurl(options: CurlOptions): Promise<string> {
    const {
      url,
      method = 'GET',
      headers = {},
      data,
      followRedirects,
      userAgent,
      connectTimeoutSeconds,
      maxTimeSeconds,
      includeFailFlag,
      maxRetries,
    } = options;

    const args: string[] = ['curl', '-s'];
    if (includeFailFlag) args.push('-f');
    if (followRedirects) args.push('-L');
    if (userAgent) args.push('--user-agent', userAgent);
    if (typeof maxTimeSeconds === 'number') args.push('--max-time', String(maxTimeSeconds));
    if (typeof connectTimeoutSeconds === 'number')
      args.push('--connect-timeout', String(connectTimeoutSeconds));
    if (method && method.toUpperCase() !== 'GET') args.push('-X', method.toUpperCase());

    for (const [key, value] of Object.entries(headers)) {
      args.push('-H', `${key}: ${value}`);
    }

    if (typeof data === 'string') {
      args.push('-d', data);
    }

    args.push(url);
    const attempts = Math.max(1, maxRetries ?? this.retryDelays.length);
    return this.execInContainer(args, attempts);
  }

  async isContainerHealthy(): Promise<boolean> {
    const healthUrl = `http://localhost:${this.config.port}/health`;
    const rootUrl = `http://localhost:${this.config.port}/`;
    const attempts = Math.max(1, this.retryDelays.length);

    try {
      await retryWithBackoff(
        async (attempt) => {
          const attemptNumber = attempt + 1;
          try {
            log.debug(`Health check attempt ${attemptNumber} at: ${healthUrl}`);
            const result = await this.request({
              url: healthUrl,
              timeoutMs: 7000,
              maxRetries: 1,
              includeAuth: false,
            });
            if (result && result.trim().length > 0) {
              return;
            }
          } catch (error) {
            log.debug('Health endpoint failed:', error);
          }

          try {
            log.debug(`Fallback root check attempt ${attemptNumber} at: ${rootUrl}`);
            const responseText = await this.request({
              url: rootUrl,
              timeoutMs: 5000,
              maxRetries: 1,
              includeAuth: false,
            });
            if (responseText.trim().length > 0) {
              return;
            }
          } catch (fallbackError) {
            log.debug('Root fallback failed:', fallbackError);
          }

          throw new Error('Health checks not ready');
        },
        {
          maxAttempts: attempts,
          delays: this.retryDelays,
          errorFactory: (lastError) =>
            lastError instanceof Error ? lastError : new Error(String(lastError)),
        },
      );
      return true;
    } catch {
      return false;
    }
  }

  async waitUntilOpenWebUIReady(options?: WaitUntilReadyOptions): Promise<boolean> {
    const timeoutMs = options?.timeoutMs ?? 15 * 60 * 1000;
    const start = Date.now();
    const delays = buildBackoffDelays({
      initialDelayMs: options?.initialDelayMs ?? 2000,
      maxDelayMs: options?.maxDelayMs ?? 30000,
      maxCumulativeDelayMs: timeoutMs,
    });
    const maxAttempts = Math.max(1, delays.length + 1);

    try {
      await retryWithBackoff(
        async () => {
          if (Date.now() - start >= timeoutMs) {
            throw new Error('Timed out waiting for Open WebUI readiness');
          }
          const apiReady = await this.ensureAuthToken();
          if (!apiReady) {
            throw new Error('Open WebUI API not ready yet');
          }
        },
        {
          maxAttempts,
          delays,
          errorFactory: (lastError) =>
            lastError instanceof Error ? lastError : new Error(String(lastError)),
        },
      );
      return true;
    } catch {
      return false;
    }
  }

  getRetryDelays(): number[] {
    return [...this.retryDelays];
  }

  getConfig(): ExtensionConfig {
    return this.config;
  }

  getApiBaseUrl(): string {
    return this.apiBaseUrl;
  }

  getContainerName(): string {
    return this.options.containerName;
  }

  private getDockerClient(): DockerDesktopClient {
    return (this.options.dockerClientProvider ?? getDDClient)();
  }

  private buildApiBaseUrl(port: string): string {
    return `http://localhost:${port}/api/v1`;
  }

  private buildSigninUrl(): string {
    return `http://localhost:${this.config.port}/api/v1/auths/signin`;
  }

  private hasAuthorizationHeader(headers: Record<string, string>): boolean {
    return Object.keys(headers).some((h) => h.toLowerCase() === 'authorization');
  }

  private async handleUnauthorized(): Promise<boolean> {
    if (!this.authTokenLoaded || !this.authToken) {
      return this.ensureAuthToken();
    }

    this.options.authTokenStore.clearToken();
    this.authToken = undefined;
    this.authTokenLoaded = false;
    return this.ensureAuthToken();
  }
}
