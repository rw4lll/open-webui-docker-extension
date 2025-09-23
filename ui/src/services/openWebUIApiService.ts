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
import { DockerModelRunnerOrchestrator } from './dockerModelRunnerOrchestrator';

const DOCKER_MODEL_RUNNER_FUNCTION_ID = 'docker_model_runner';

export class OpenWebUIApiService {
  private config: ExtensionConfig;
  private dmrConfig: DockerModelRunnerConfig;
  private readonly http: OpenWebUIHttpClient;
  private readonly functions: FunctionsClient;
  private readonly orchestrator: DockerModelRunnerOrchestrator;
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
    this.orchestrator = new DockerModelRunnerOrchestrator({
      http: this.http,
      functions: this.functions,
      dmrConfig: this.dmrConfig,
    });

    log.debug('OpenWebUIApiService initialized:', {
      apiBaseUrl: this.http.getApiBaseUrl(),
      externalPort: this.config.port,
      containerName: this.http.getContainerName(),
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
    this.orchestrator.resetConnectivityCache();
    log.debug('OpenWebUIApiService config updated - external port:', newConfig.port);
  }

  async isContainerHealthy(): Promise<boolean> {
    return this.http.isContainerHealthy();
  }

  async getFunctions(): Promise<OpenWebUIFunction[]> {
    return this.functions.listFunctions();
  }

  async isDMRFunctionInstalled(): Promise<boolean> {
    return this.functions.isFunctionInstalled(DOCKER_MODEL_RUNNER_FUNCTION_ID);
  }

  async getDMRFunctionStatus(): Promise<OpenWebUIFunction | null> {
    return this.functions.getFunctionById(DOCKER_MODEL_RUNNER_FUNCTION_ID);
  }

  async installDMRFunction(): Promise<FunctionInstallResult> {
    return this.orchestrator.installDMRFunction();
  }

  async ensureFunctionEnabled(id: string, desired: boolean): Promise<void> {
    await this.functions.ensureFunctionEnabled(id, desired);
  }

  async setupDockerModelRunnerIntegration(): Promise<ServiceStatus> {
    return this.orchestrator.setupIntegration();
  }

  async getServiceStatus(): Promise<ServiceStatus> {
    return this.orchestrator.getServiceStatus();
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
