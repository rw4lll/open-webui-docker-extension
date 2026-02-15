import { DMR_STATUS_VERIFY_CACHE_TTL_MS, OPENAI_PROVIDER_DEFAULTS } from '../../constants';
import { log } from '../../logger';
import type { DockerModelRunnerConfig } from '../../types';
import type { OpenWebUIHttpClient } from '../openWebUIHttpClient';
import { testConnectivityWithCache } from './connectivityTest';
import type { DMRProvisioner, ProvisionerStatus } from './types';

interface OpenAIEnvProvisionerOptions {
  http: OpenWebUIHttpClient;
  dmrConfig: DockerModelRunnerConfig;
}

interface ModelsApiCheckResult {
  reachable: boolean;
  modelsCount?: number;
}

interface OpenAIAdminConfigResponse {
  ENABLE_OPENAI_API?: boolean;
  OPENAI_API_BASE_URLS: string[];
  OPENAI_API_KEYS: string[];
  OPENAI_API_CONFIGS: Record<string, Record<string, unknown>>;
}

interface PrefixConfigStatus {
  supported: boolean;
  endpointConfigured: boolean;
  configured: boolean;
  matchedIndexes: number[];
}

export class OpenAIEnvProvisioner implements DMRProvisioner {
  readonly mode = 'openai' as const;
  private lastDMRConnectivityOkAt = 0;
  private verifyStatusCache?: { value: ProvisionerStatus; cachedAt: number };
  private openAIConfigCache?: { value: OpenAIAdminConfigResponse | null; cachedAt: number };
  private modelsApiCache?: { value: ModelsApiCheckResult; cachedAt: number };

  constructor(private readonly options: OpenAIEnvProvisionerOptions) {}

  resetConnectivityCache(): void {
    this.lastDMRConnectivityOkAt = 0;
    this.verifyStatusCache = undefined;
    this.openAIConfigCache = undefined;
    this.modelsApiCache = undefined;
  }

  async setupIntegration(): Promise<ProvisionerStatus> {
    const status = this.createStatus();
    this.verifyStatusCache = undefined;

    try {
      log.info('Setting up OpenAI-compatible Docker Model Runner integration...');

      status.containerRunning = await this.options.http.waitUntilOpenWebUIReady({
        timeoutMs: 15 * 60 * 1000,
      });
      if (!status.containerRunning) {
        log.warn('Open WebUI did not become ready within the timeout window');
        return status;
      }

      const prefixStatus = await this.ensurePrefixIdConfigured();
      const modelsApi = await this.checkModelsApi();
      const providerConfigured =
        prefixStatus.supported && prefixStatus.endpointConfigured && prefixStatus.configured;
      status.integrationConfigured = modelsApi.reachable && providerConfigured;
      status.details = {
        modelsApiReachable: modelsApi.reachable,
        modelsCount: modelsApi.modelsCount ?? 0,
        openAIProviderConfigured: providerConfigured,
        openAIProviderEndpointConfigured: prefixStatus.endpointConfigured,
        prefixIdConfigured: prefixStatus.configured,
        prefixIdSupported: prefixStatus.supported,
        prefixIdValue: OPENAI_PROVIDER_DEFAULTS.prefixId,
        prefixIdMatchedIndexes: prefixStatus.matchedIndexes,
      };
      if (prefixStatus.supported && !prefixStatus.endpointConfigured) {
        log.warn('OpenAI provider endpoint is not configured for Docker Model Runner');
      }
      if (prefixStatus.supported && !prefixStatus.configured) {
        log.warn('OpenAI provider prefix_id is not configured for Docker Model Runner endpoint');
      }

      status.dockerModelRunnerConnected = await this.testConnectivity();
      this.setCachedVerifyStatus(status);
      return status;
    } catch (error) {
      log.error('Error during OpenAI-compatible integration setup:', error);
      this.setCachedVerifyStatus(status);
      return status;
    }
  }

  async verifyIntegration(): Promise<ProvisionerStatus> {
    const cached = this.getCachedVerifyStatus();
    if (cached) {
      return cached;
    }

    const status = this.createStatus();

    try {
      status.containerRunning = await this.options.http.isContainerHealthy();
      if (!status.containerRunning) {
        this.setCachedVerifyStatus(status);
        return status;
      }

      const prefixStatus = await this.getPrefixIdStatus({ useCache: true });
      const modelsApi = await this.checkModelsApi({ useCache: true });
      const providerConfigured =
        prefixStatus.supported && prefixStatus.endpointConfigured && prefixStatus.configured;
      status.integrationConfigured = modelsApi.reachable && providerConfigured;
      status.details = {
        modelsApiReachable: modelsApi.reachable,
        modelsCount: modelsApi.modelsCount ?? 0,
        openAIProviderConfigured: providerConfigured,
        openAIProviderEndpointConfigured: prefixStatus.endpointConfigured,
        prefixIdConfigured: prefixStatus.configured,
        prefixIdSupported: prefixStatus.supported,
        prefixIdValue: OPENAI_PROVIDER_DEFAULTS.prefixId,
        prefixIdMatchedIndexes: prefixStatus.matchedIndexes,
      };
      status.dockerModelRunnerConnected = await this.testConnectivity();
    } catch (error) {
      log.warn('Failed to fetch OpenAI-compatible provisioner status:', error);
    }

    this.setCachedVerifyStatus(status);
    return status;
  }

  async getServiceStatus(): Promise<ProvisionerStatus> {
    return this.verifyIntegration();
  }

  async cleanupInactiveArtifacts(): Promise<void> {
    const config = await this.fetchOpenAIConfig({ useCache: false });
    if (!config) {
      throw new Error('Unable to fetch OpenAI config for cleanup');
    }

    const matchedIndexes = this.getDmrEndpointIndexes(config);
    if (matchedIndexes.length === 0) {
      return;
    }

    const removeSet = new Set(matchedIndexes);
    const nextBaseUrls = config.OPENAI_API_BASE_URLS.filter((_, idx) => !removeSet.has(idx));
    const nextApiKeys = config.OPENAI_API_KEYS.filter((_, idx) => !removeSet.has(idx));
    const nextApiConfigs = this.reindexOpenAIConfigs(config, removeSet);

    const updated = await this.updateOpenAIConfig({
      ...config,
      OPENAI_API_BASE_URLS: nextBaseUrls,
      OPENAI_API_KEYS: nextApiKeys,
      OPENAI_API_CONFIGS: nextApiConfigs,
    });
    if (!updated) {
      throw new Error('Failed to deregister OpenAI DMR provider entries');
    }
    this.verifyStatusCache = undefined;
  }

  private createStatus(): ProvisionerStatus {
    return {
      mode: this.mode,
      containerRunning: false,
      integrationConfigured: false,
      dockerModelRunnerConnected: false,
      lastChecked: Date.now(),
      details: {
        modelsApiReachable: false,
        modelsCount: 0,
        openAIProviderConfigured: false,
        openAIProviderEndpointConfigured: false,
        prefixIdConfigured: false,
        prefixIdSupported: false,
        prefixIdValue: OPENAI_PROVIDER_DEFAULTS.prefixId,
        prefixIdMatchedIndexes: [],
      },
    };
  }

  private async checkModelsApi(
    options: { useCache?: boolean } = {},
  ): Promise<ModelsApiCheckResult> {
    if (options.useCache) {
      const cached = this.modelsApiCache;
      if (cached && Date.now() - cached.cachedAt < DMR_STATUS_VERIFY_CACHE_TTL_MS) {
        return cached.value;
      }
    }

    try {
      const apiBase = this.options.http.getApiBaseUrl().replace(/\/api\/v1$/, '');
      const responseText = await this.options.http.request({
        url: `${apiBase}/api/models`,
        method: 'GET',
        headers: { 'Content-Type': 'application/json' },
        includeAuth: true,
        timeoutMs: 10_000,
        maxRetries: 2,
      });

      const parsed = JSON.parse(responseText) as unknown;
      if (Array.isArray(parsed)) {
        const result = { reachable: true, modelsCount: parsed.length };
        if (options.useCache) {
          this.modelsApiCache = { value: result, cachedAt: Date.now() };
        }
        return result;
      }
      if (parsed && typeof parsed === 'object') {
        const record = parsed as Record<string, unknown>;
        if (Array.isArray(record.data)) {
          const result = { reachable: true, modelsCount: record.data.length };
          if (options.useCache) {
            this.modelsApiCache = { value: result, cachedAt: Date.now() };
          }
          return result;
        }
      }

      const result = { reachable: true, modelsCount: 0 };
      if (options.useCache) {
        this.modelsApiCache = { value: result, cachedAt: Date.now() };
      }
      return result;
    } catch (error) {
      log.warn('Open WebUI /api/models verification failed:', error);
      const result = { reachable: false };
      if (options.useCache) {
        this.modelsApiCache = { value: result, cachedAt: Date.now() };
      }
      return result;
    }
  }

  private getApiOrigin(): string {
    return this.options.http.getApiBaseUrl().replace(/\/api\/v1$/, '');
  }

  private normalizeUrl(url: string): string {
    return url.trim().replace(/\/+$/, '');
  }

  private getOpenAIConfigGetEndpoints(): string[] {
    const apiBase = this.options.http.getApiBaseUrl();
    const origin = this.getApiOrigin();
    return Array.from(
      new Set([
        `${origin}/openai/config`,
        `${origin}/openai/api/v1/config`,
        `${apiBase}/openai/config`,
        `${origin}/api/v1/openai/config`,
      ]),
    );
  }

  private getOpenAIConfigUpdateEndpoints(): string[] {
    const apiBase = this.options.http.getApiBaseUrl();
    const origin = this.getApiOrigin();
    return Array.from(
      new Set([
        `${origin}/openai/config/update`,
        `${origin}/openai/api/v1/config/update`,
        `${apiBase}/openai/config/update`,
        `${origin}/api/v1/openai/config/update`,
      ]),
    );
  }

  private normalizeOpenAIConfig(raw: unknown): OpenAIAdminConfigResponse | null {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
      return null;
    }

    const record = raw as Record<string, unknown>;
    const baseUrls = Array.isArray(record.OPENAI_API_BASE_URLS)
      ? record.OPENAI_API_BASE_URLS.filter((url): url is string => typeof url === 'string').map(
          (url) => url.trim(),
        )
      : [];
    const apiKeys = Array.isArray(record.OPENAI_API_KEYS)
      ? record.OPENAI_API_KEYS.filter((key): key is string => typeof key === 'string').map((key) =>
          key.trim(),
        )
      : [];

    const apiConfigsRaw =
      record.OPENAI_API_CONFIGS && typeof record.OPENAI_API_CONFIGS === 'object'
        ? (record.OPENAI_API_CONFIGS as Record<string, unknown>)
        : {};

    const apiConfigs: Record<string, Record<string, unknown>> = {};
    for (const [key, value] of Object.entries(apiConfigsRaw)) {
      if (value && typeof value === 'object' && !Array.isArray(value)) {
        apiConfigs[key] = { ...(value as Record<string, unknown>) };
      }
    }

    return {
      ENABLE_OPENAI_API:
        typeof record.ENABLE_OPENAI_API === 'boolean' ? record.ENABLE_OPENAI_API : undefined,
      OPENAI_API_BASE_URLS: baseUrls,
      OPENAI_API_KEYS: apiKeys,
      OPENAI_API_CONFIGS: apiConfigs,
    };
  }

  private async fetchOpenAIConfig(
    options: { useCache?: boolean } = {},
  ): Promise<OpenAIAdminConfigResponse | null> {
    if (options.useCache) {
      const cached = this.openAIConfigCache;
      if (cached && Date.now() - cached.cachedAt < DMR_STATUS_VERIFY_CACHE_TTL_MS) {
        return cached.value;
      }
    }

    for (const url of this.getOpenAIConfigGetEndpoints()) {
      try {
        const responseText = await this.options.http.request({
          url,
          method: 'GET',
          headers: { 'Content-Type': 'application/json' },
          includeAuth: true,
          timeoutMs: 10_000,
          maxRetries: 2,
        });
        if (responseText.trim().startsWith('<')) {
          throw new Error('Endpoint returned HTML instead of JSON');
        }
        const parsed = JSON.parse(responseText) as unknown;
        const normalized = this.normalizeOpenAIConfig(parsed);
        if (normalized) {
          if (options.useCache) {
            this.openAIConfigCache = { value: normalized, cachedAt: Date.now() };
          }
          return normalized;
        }
      } catch (error) {
        log.debug('OpenAI config endpoint unavailable:', { url, error });
      }
    }
    return null;
  }

  private async updateOpenAIConfig(
    payload: OpenAIAdminConfigResponse,
  ): Promise<OpenAIAdminConfigResponse | null> {
    for (const url of this.getOpenAIConfigUpdateEndpoints()) {
      try {
        const responseText = await this.options.http.request({
          url,
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            ENABLE_OPENAI_API: payload.ENABLE_OPENAI_API ?? true,
            OPENAI_API_BASE_URLS: payload.OPENAI_API_BASE_URLS,
            OPENAI_API_KEYS: payload.OPENAI_API_KEYS,
            OPENAI_API_CONFIGS: payload.OPENAI_API_CONFIGS,
          }),
          includeAuth: true,
          timeoutMs: 10_000,
          maxRetries: 2,
        });
        if (responseText.trim().startsWith('<')) {
          throw new Error('Endpoint returned HTML instead of JSON');
        }
        const parsed = JSON.parse(responseText) as unknown;
        const normalized = this.normalizeOpenAIConfig(parsed);
        if (normalized) {
          this.openAIConfigCache = { value: normalized, cachedAt: Date.now() };
          this.modelsApiCache = undefined;
          this.verifyStatusCache = undefined;
          return normalized;
        }
      } catch (error) {
        log.debug('OpenAI config update endpoint unavailable:', { url, error });
      }
    }
    return null;
  }

  private getDmrEndpointIndexes(config: OpenAIAdminConfigResponse): number[] {
    const targetBaseUrl = this.getTargetBaseUrl();
    return config.OPENAI_API_BASE_URLS.flatMap((url, idx) =>
      this.normalizeUrl(url) === targetBaseUrl ? [idx] : [],
    );
  }

  private getTargetBaseUrl(): string {
    return this.normalizeUrl(
      `${this.options.dmrConfig.baseUrl}${this.options.dmrConfig.engineSuffix}`,
    );
  }

  private padApiKeys(apiKeys: string[], requiredLength: number, fillValue: string): string[] {
    const nextApiKeys = [...apiKeys];
    while (nextApiKeys.length < requiredLength) {
      nextApiKeys.push(fillValue);
    }
    return nextApiKeys;
  }

  private hasConfiguredPrefix(
    config: OpenAIAdminConfigResponse,
    matchedIndexes: number[],
  ): boolean {
    if (matchedIndexes.length === 0) {
      return false;
    }

    return matchedIndexes.every((idx) => {
      const key = String(idx);
      const legacyKey = config.OPENAI_API_BASE_URLS[idx];
      const existingConfig = config.OPENAI_API_CONFIGS[key] ?? config.OPENAI_API_CONFIGS[legacyKey];
      return existingConfig?.prefix_id === OPENAI_PROVIDER_DEFAULTS.prefixId;
    });
  }

  private reindexOpenAIConfigs(
    config: OpenAIAdminConfigResponse,
    removeSet: Set<number>,
  ): Record<string, Record<string, unknown>> {
    const nextConfigs: Record<string, Record<string, unknown>> = {};
    let nextIndex = 0;
    for (
      let currentIndex = 0;
      currentIndex < config.OPENAI_API_BASE_URLS.length;
      currentIndex += 1
    ) {
      if (removeSet.has(currentIndex)) {
        continue;
      }

      const key = String(currentIndex);
      const legacyKey = config.OPENAI_API_BASE_URLS[currentIndex];
      const existingConfig = config.OPENAI_API_CONFIGS[key] ?? config.OPENAI_API_CONFIGS[legacyKey];
      if (existingConfig && Object.keys(existingConfig).length > 0) {
        nextConfigs[String(nextIndex)] = { ...existingConfig };
      }
      nextIndex += 1;
    }

    return nextConfigs;
  }

  private async getPrefixIdStatus(
    options: { useCache?: boolean } = {},
  ): Promise<PrefixConfigStatus> {
    const config = await this.fetchOpenAIConfig({ useCache: options.useCache });
    if (!config) {
      return { supported: false, endpointConfigured: false, configured: false, matchedIndexes: [] };
    }

    const matchedIndexes = this.getDmrEndpointIndexes(config);
    return {
      supported: true,
      endpointConfigured: matchedIndexes.length > 0,
      configured: this.hasConfiguredPrefix(config, matchedIndexes),
      matchedIndexes,
    };
  }

  private async ensurePrefixIdConfigured(): Promise<PrefixConfigStatus> {
    const config = await this.fetchOpenAIConfig({ useCache: false });
    if (!config) {
      return { supported: false, endpointConfigured: false, configured: false, matchedIndexes: [] };
    }

    const nextBaseUrls = [...config.OPENAI_API_BASE_URLS];
    let nextApiKeys = this.padApiKeys(
      config.OPENAI_API_KEYS,
      nextBaseUrls.length,
      OPENAI_PROVIDER_DEFAULTS.apiKeyPlaceholder,
    );
    const nextApiConfigs = { ...config.OPENAI_API_CONFIGS };
    const targetBaseUrl = this.getTargetBaseUrl();
    let matchedIndexes = this.getDmrEndpointIndexes({
      ...config,
      OPENAI_API_BASE_URLS: nextBaseUrls,
    });
    let changed = false;

    if (nextApiKeys.length !== config.OPENAI_API_KEYS.length) {
      changed = true;
    }

    if (matchedIndexes.length === 0) {
      nextBaseUrls.push(targetBaseUrl);
      nextApiKeys = this.padApiKeys(
        [...nextApiKeys, OPENAI_PROVIDER_DEFAULTS.apiKeyPlaceholder],
        nextBaseUrls.length,
        OPENAI_PROVIDER_DEFAULTS.apiKeyPlaceholder,
      );
      matchedIndexes = [nextBaseUrls.length - 1];
      changed = true;
    }

    for (const idx of matchedIndexes) {
      const key = String(idx);
      const legacyKey = nextBaseUrls[idx];
      const existingConfig = nextApiConfigs[key] ?? nextApiConfigs[legacyKey] ?? {};
      if (existingConfig.prefix_id !== OPENAI_PROVIDER_DEFAULTS.prefixId) {
        nextApiConfigs[key] = {
          ...existingConfig,
          prefix_id: OPENAI_PROVIDER_DEFAULTS.prefixId,
        };
        changed = true;
      }
    }

    const enableOpenAI = config.ENABLE_OPENAI_API === true;
    const desiredEnableOpenAI = true;
    if (enableOpenAI !== desiredEnableOpenAI) {
      changed = true;
    }

    const preparedConfig: OpenAIAdminConfigResponse = {
      ...config,
      ENABLE_OPENAI_API: desiredEnableOpenAI,
      OPENAI_API_BASE_URLS: nextBaseUrls,
      OPENAI_API_KEYS: nextApiKeys,
      OPENAI_API_CONFIGS: nextApiConfigs,
    };

    if (!changed) {
      return {
        supported: true,
        endpointConfigured: matchedIndexes.length > 0,
        configured: this.hasConfiguredPrefix(preparedConfig, matchedIndexes),
        matchedIndexes,
      };
    }

    const updatedConfig = await this.updateOpenAIConfig(preparedConfig);
    if (!updatedConfig) {
      return {
        supported: true,
        endpointConfigured: matchedIndexes.length > 0,
        configured: false,
        matchedIndexes,
      };
    }

    const updatedIndexes = this.getDmrEndpointIndexes(updatedConfig);
    return {
      supported: true,
      endpointConfigured: updatedIndexes.length > 0,
      configured: this.hasConfiguredPrefix(updatedConfig, updatedIndexes),
      matchedIndexes: updatedIndexes,
    };
  }

  private getCachedVerifyStatus(): ProvisionerStatus | null {
    const cached = this.verifyStatusCache;
    if (!cached) {
      return null;
    }
    if (Date.now() - cached.cachedAt > DMR_STATUS_VERIFY_CACHE_TTL_MS) {
      this.verifyStatusCache = undefined;
      return null;
    }
    return this.cloneStatus(cached.value);
  }

  private setCachedVerifyStatus(status: ProvisionerStatus): void {
    this.verifyStatusCache = {
      value: this.cloneStatus(status),
      cachedAt: Date.now(),
    };
  }

  private cloneStatus(status: ProvisionerStatus): ProvisionerStatus {
    return {
      ...status,
      details: status.details ? { ...status.details } : undefined,
    };
  }

  private async testConnectivity(): Promise<boolean> {
    return testConnectivityWithCache({
      dmrConfig: this.options.dmrConfig,
      containerCurl: (opts) => this.options.http.containerCurl(opts),
      cache: {
        getLastOkAt: () => this.lastDMRConnectivityOkAt,
        setLastOkAt: (timestamp) => {
          this.lastDMRConnectivityOkAt = timestamp;
        },
      },
    });
  }
}
