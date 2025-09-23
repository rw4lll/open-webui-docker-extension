import dockerModelRunnerFunction from '../assets/docker_model_runner.py?raw';
import { log } from '../logger';
import type { DockerModelRunnerConfig, FunctionInstallResult, ServiceStatus } from '../types';
import { FunctionsClient } from './functionsClient';
import { OpenWebUIHttpClient } from './openWebUIHttpClient';

const DOCKER_MODEL_RUNNER_FUNCTION_ID = 'docker_model_runner';

interface DockerModelRunnerOrchestratorOptions {
  http: OpenWebUIHttpClient;
  functions: FunctionsClient;
  dmrConfig: DockerModelRunnerConfig;
}

export class DockerModelRunnerOrchestrator {
  private lastDMRConnectivityOkAt = 0;

  constructor(private readonly options: DockerModelRunnerOrchestratorOptions) {}

  async setupIntegration(): Promise<ServiceStatus> {
    const status: ServiceStatus = {
      containerRunning: false,
      functionInstalled: false,
      functionEnabled: false,
      dockerModelRunnerConnected: false,
      lastChecked: Date.now(),
    };

    try {
      log.info('Setting up Docker Model Runner integration...');

      status.containerRunning = await this.options.http.waitUntilOpenWebUIReady({
        timeoutMs: 15 * 60 * 1000,
      });
      if (!status.containerRunning) {
        log.warn('Open WebUI did not become ready within the timeout window');
        return status;
      }

      const installed = await this.options.functions.isFunctionInstalled(
        DOCKER_MODEL_RUNNER_FUNCTION_ID,
      );
      if (!installed) {
        const installResult = await this.installDMRFunction();
        status.functionInstalled = installResult.success;
        if (!status.functionInstalled) {
          log.error('Failed to install DMR function:', installResult.message);
          return status;
        }
      } else {
        status.functionInstalled = true;
      }

      const functionStatus = await this.options.functions.getFunctionById(
        DOCKER_MODEL_RUNNER_FUNCTION_ID,
      );
      status.functionEnabled = this.options.functions.isFunctionActive(functionStatus);

      if (!status.functionEnabled) {
        try {
          await this.options.functions.ensureFunctionEnabled(DOCKER_MODEL_RUNNER_FUNCTION_ID, true);
          const refreshedFn = await this.options.functions.getFunctionById(
            DOCKER_MODEL_RUNNER_FUNCTION_ID,
          );
          status.functionEnabled = this.options.functions.isFunctionActive(refreshedFn);
          log.debug('Docker Model Runner function enabled successfully');
        } catch (error) {
          log.error('Failed to enable DMR function:', error);
        }
      }

      status.dockerModelRunnerConnected = await this.testConnectivity();
      log.debug('Docker Model Runner integration setup complete:', status);
      return status;
    } catch (error) {
      log.error('Error during Docker Model Runner setup:', error);
      return status;
    }
  }

  resetConnectivityCache(): void {
    this.lastDMRConnectivityOkAt = 0;
  }

  async getServiceStatus(): Promise<ServiceStatus> {
    const status: ServiceStatus = {
      containerRunning: await this.options.http.isContainerHealthy(),
      functionInstalled: await this.options.functions.isFunctionInstalled(
        DOCKER_MODEL_RUNNER_FUNCTION_ID,
      ),
      functionEnabled: false,
      dockerModelRunnerConnected: false,
      lastChecked: Date.now(),
    };

    if (status.functionInstalled) {
      const functionStatus = await this.options.functions.getFunctionById(
        DOCKER_MODEL_RUNNER_FUNCTION_ID,
      );
      status.functionEnabled = this.options.functions.isFunctionActive(functionStatus);
      if (status.functionEnabled) {
        status.dockerModelRunnerConnected = await this.testConnectivity();
      }
    }

    return status;
  }

  async installDMRFunction(): Promise<FunctionInstallResult> {
    if (!dockerModelRunnerFunction || dockerModelRunnerFunction.trim().length === 0) {
      throw new Error('Bundled Docker Model Runner function content is empty');
    }
    if (
      !dockerModelRunnerFunction.includes('class Pipe') ||
      !dockerModelRunnerFunction.includes('docker_model_runner')
    ) {
      throw new Error('Bundled Docker Model Runner function is invalid');
    }

    return this.options.functions.installFunction({
      id: DOCKER_MODEL_RUNNER_FUNCTION_ID,
      name: 'Docker Model Runner',
      content: dockerModelRunnerFunction,
      meta: {
        description: 'Pipeline for interacting with Docker Model Runner models',
        author: 'Sergei Shitikov',
        version: '1.0.0',
        license: 'MIT',
      },
    });
  }

  private async testConnectivity(): Promise<boolean> {
    try {
      const { baseUrl, engineSuffix, retryCount, connectionTimeout, connectivityCacheMs } =
        this.options.dmrConfig;

      if (
        this.lastDMRConnectivityOkAt &&
        Date.now() - this.lastDMRConnectivityOkAt < connectivityCacheMs
      ) {
        return true;
      }

      const testUrl = `${baseUrl}${engineSuffix}/models`;
      const retryAttempts = Math.max(1, retryCount);
      const connectTimeoutSeconds = Math.max(1, Math.ceil(connectionTimeout));
      const maxTimeSeconds = Math.max(connectTimeoutSeconds + 2, connectTimeoutSeconds);

      try {
        await this.options.http.containerCurl({
          url: testUrl,
          method: 'GET',
          includeFailFlag: true,
          connectTimeoutSeconds,
          maxTimeSeconds,
          maxRetries: 1,
        });
        this.lastDMRConnectivityOkAt = Date.now();
        return true;
      } catch {
        // fall through
      }

      const result = await this.options.http.containerCurl({
        url: testUrl,
        includeFailFlag: true,
        connectTimeoutSeconds,
        maxTimeSeconds: Math.max(maxTimeSeconds * 2, maxTimeSeconds + 5),
        maxRetries: retryAttempts,
      });

      const ok = result.trim().length > 0;
      if (ok) {
        this.lastDMRConnectivityOkAt = Date.now();
        return true;
      }

      try {
        await this.options.http.execInContainer([
          'getent',
          'hosts',
          'model-runner.docker.internal',
        ]);
      } catch (dnsErr) {
        log.warn('DMR DNS resolution failed:', dnsErr);
      }

      return false;
    } catch (error) {
      log.warn('Docker Model Runner connectivity test failed:', error);
      return false;
    }
  }
}
