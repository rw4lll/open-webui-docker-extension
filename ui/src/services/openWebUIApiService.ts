import { DMR_DEFAULTS, CONTAINER_NAME } from '../constants';
import { log } from '../logger';
import type {
  ExtensionConfig,
  OpenWebUIFunction,
  FunctionInstallResult,
  DockerModelRunnerConfig,
  ServiceStatus,
} from '../types';
import { defaultAuthTokenStore, type AuthTokenStore } from './authTokenStore';
import { FunctionsClient } from './functionsClient';
import { OpenWebUIHttpClient, type HttpRequestOptions } from './openWebUIHttpClient';
import {
  LegacyFunctionProvisioner,
  OpenAIEnvProvisioner,
  ProvisionerRegistry,
  toServiceStatus,
} from './provisioners';
import { buildBackoffDelays, retryWithBackoff } from '../utils/retry';

export class OpenWebUIApiService {
  private config: ExtensionConfig;
  private dmrConfig: DockerModelRunnerConfig;
  private readonly http: OpenWebUIHttpClient;
  private readonly functions: FunctionsClient;
  private readonly legacyProvisioner: LegacyFunctionProvisioner;
  private readonly openAIProvisioner: OpenAIEnvProvisioner;
  private readonly provisionerRegistry: ProvisionerRegistry;
  private readonly functionsCacheTtlMs: number;

  constructor(
    config: ExtensionConfig,
    dmrConfig?: Partial<DockerModelRunnerConfig>,
    options?: { authTokenStore?: AuthTokenStore },
  ) {
    this.config = config;
    this.dmrConfig = { ...DMR_DEFAULTS, ...dmrConfig };
    const authTokenStore = options?.authTokenStore ?? defaultAuthTokenStore;

    this.http = new OpenWebUIHttpClient({
      config,
      retryCount: this.dmrConfig.retryCount,
      authTokenStore,
      containerName: CONTAINER_NAME,
    });

    this.functionsCacheTtlMs = Math.max(60 * 1000, Math.floor(this.dmrConfig.modelCacheTtl) * 1000);
    this.functions = new FunctionsClient(this.http, this.functionsCacheTtlMs);
    this.legacyProvisioner = new LegacyFunctionProvisioner({
      http: this.http,
      functions: this.functions,
      dmrConfig: this.dmrConfig,
    });
    this.openAIProvisioner = new OpenAIEnvProvisioner({
      http: this.http,
      dmrConfig: this.dmrConfig,
    });
    this.provisionerRegistry = new ProvisionerRegistry({
      legacyProvisioner: this.legacyProvisioner,
      openAIProvisioner: this.openAIProvisioner,
    });

    log.debug('OpenWebUIApiService initialized:', {
      apiBaseUrl: this.http.getApiBaseUrl(),
      externalPort: this.config.port,
      containerName: this.http.getContainerName(),
      provisioner: this.config.provisioner,
      dmrConfig: this.dmrConfig,
      retryDelays: this.http.getRetryDelays(),
      functionsCacheTtlMs: this.functionsCacheTtlMs,
    });
  }

  setAuthToken(token?: string): void {
    this.http.setAuthToken(token);
  }

  async ensureAuthToken(): Promise<boolean> {
    return this.http.ensureAuthToken();
  }

  updateConfig(newConfig: ExtensionConfig): void {
    this.config = newConfig;
    this.http.updateConfig(newConfig);
    this.functions.clearCache();
    this.provisionerRegistry.resetAllConnectivityCaches();
    log.debug('OpenWebUIApiService config updated:', {
      externalPort: newConfig.port,
      provisioner: newConfig.provisioner,
    });
  }

  async isContainerHealthy(): Promise<boolean> {
    return this.http.isContainerHealthy();
  }

  async getFunctions(): Promise<OpenWebUIFunction[]> {
    return this.functions.listFunctions();
  }

  async isDMRFunctionInstalled(): Promise<boolean> {
    return this.legacyProvisioner.isDMRFunctionInstalled();
  }

  async getDMRFunctionStatus(): Promise<OpenWebUIFunction | null> {
    return this.legacyProvisioner.getDMRFunctionStatus();
  }

  async installDMRFunction(): Promise<FunctionInstallResult> {
    return this.legacyProvisioner.installDMRFunction();
  }

  async ensureFunctionEnabled(id: string, desired: boolean): Promise<void> {
    await this.functions.ensureFunctionEnabled(id, desired);
  }

  async setupDockerModelRunnerIntegration(): Promise<ServiceStatus> {
    const provisioner = this.provisionerRegistry.resolve(this.config.provisioner);
    const status = await provisioner.setupIntegration();

    if (status.integrationConfigured) {
      try {
        await this.cleanupInactiveArtifactsWithRetry();
      } catch (error) {
        log.warn('Failed to cleanup inactive provisioner artifacts:', error);
      }
    } else {
      log.debug(
        'Skipping inactive provisioner cleanup: active provisioner setup did not configure integration successfully',
      );
    }

    return toServiceStatus(status);
  }

  async verifyDockerModelRunnerIntegration(): Promise<ServiceStatus> {
    const provisioner = this.provisionerRegistry.resolve(this.config.provisioner);
    const status = await provisioner.verifyIntegration();
    return toServiceStatus(status);
  }

  async getServiceStatus(): Promise<ServiceStatus> {
    return this.verifyDockerModelRunnerIntegration();
  }

  private async cleanupInactiveArtifactsWithRetry(): Promise<void> {
    const delays = buildBackoffDelays({
      initialDelayMs: 1_000,
      maxDelayMs: 8_000,
      maxAttempts: 4,
      factor: 2,
    });

    await retryWithBackoff(
      async () => {
        if (this.config.provisioner === 'openai') {
          await this.legacyProvisioner.cleanupInactiveArtifacts();
        } else {
          await this.openAIProvisioner.cleanupInactiveArtifacts();
        }
      },
      {
        maxAttempts: delays.length + 1,
        delays,
        errorFactory: (lastError, attempts) =>
          new Error(`Inactive provisioner cleanup failed after ${attempts} attempts`, {
            cause: lastError,
          }),
      },
    );
  }

  // ===== Internal helpers exposed for tests =====
  private httpRequest(options: HttpRequestOptions): Promise<string> {
    return this.http.request(options);
  }

  private async execInContainer(args: string[], maxRetries?: number): Promise<string> {
    return this.http.execInContainer(args, maxRetries);
  }

  private async containerCurl(options: {
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
  }): Promise<string> {
    return this.http.containerCurl(options);
  }
}
