import dockerModelRunnerFunction from '../../assets/docker_model_runner.py?raw';
import { log } from '../../logger';
import type {
  DockerModelRunnerConfig,
  FunctionInstallResult,
  OpenWebUIFunction,
} from '../../types';
import type { FunctionsClient } from '../functionsClient';
import type { OpenWebUIHttpClient } from '../openWebUIHttpClient';
import { testConnectivityWithCache } from './connectivityTest';
import type {
  LegacyFunctionProvisionerContract,
  LegacyProvisionerDetails,
  ProvisionerStatus,
} from './types';

const DOCKER_MODEL_RUNNER_FUNCTION_ID = 'docker_model_runner';

interface LegacyFunctionProvisionerOptions {
  http: OpenWebUIHttpClient;
  functions: FunctionsClient;
  dmrConfig: DockerModelRunnerConfig;
}

export class LegacyFunctionProvisioner implements LegacyFunctionProvisionerContract {
  readonly mode = 'legacy-function' as const;
  private lastDMRConnectivityOkAt = 0;

  constructor(private readonly options: LegacyFunctionProvisionerOptions) {}

  resetConnectivityCache(): void {
    this.lastDMRConnectivityOkAt = 0;
  }

  async cleanupInactiveArtifacts(): Promise<void> {
    const removed = await this.options.functions.uninstallFunction(DOCKER_MODEL_RUNNER_FUNCTION_ID, {
      throwOnError: true,
    });
    if (!removed) {
      throw new Error('Legacy function cleanup did not remove docker_model_runner');
    }
  }

  async setupIntegration(): Promise<ProvisionerStatus> {
    const status = this.createStatus();
    status.details = {
      functionInstalled: false,
      functionEnabled: false,
    } as LegacyProvisionerDetails;

    try {
      log.info('Setting up Docker Model Runner legacy function integration...');

      status.containerRunning = await this.options.http.waitUntilOpenWebUIReady({
        timeoutMs: 15 * 60 * 1000,
      });
      if (!status.containerRunning) {
        log.warn('Open WebUI did not become ready within the timeout window');
        return this.withIntegrationConfigured(status);
      }

      const installed = await this.options.functions.isFunctionInstalled(DOCKER_MODEL_RUNNER_FUNCTION_ID);
      if (!installed) {
        const installResult = await this.installDMRFunction();
        status.details.functionInstalled = installResult.success;
        if (!installResult.success) {
          log.error('Failed to install DMR function:', installResult.message);
          return this.withIntegrationConfigured(status);
        }
      } else {
        status.details.functionInstalled = true;
      }

      const functionStatus = await this.options.functions.getFunctionById(DOCKER_MODEL_RUNNER_FUNCTION_ID);
      status.details.functionEnabled = this.options.functions.isFunctionActive(functionStatus);

      if (!status.details.functionEnabled) {
        try {
          await this.options.functions.ensureFunctionEnabled(DOCKER_MODEL_RUNNER_FUNCTION_ID, true);
          const refreshedFn = await this.options.functions.getFunctionById(DOCKER_MODEL_RUNNER_FUNCTION_ID);
          status.details.functionEnabled = this.options.functions.isFunctionActive(refreshedFn);
          log.debug('Docker Model Runner function enabled successfully');
        } catch (error) {
          log.error('Failed to enable DMR function:', error);
        }
      }

      status.dockerModelRunnerConnected = await this.testConnectivity();
      return this.withIntegrationConfigured(status);
    } catch (error) {
      log.error('Error during Docker Model Runner legacy setup:', error);
      return this.withIntegrationConfigured(status);
    }
  }

  async verifyIntegration(): Promise<ProvisionerStatus> {
    const status = this.createStatus();
    status.details = {
      functionInstalled: false,
      functionEnabled: false,
    } as LegacyProvisionerDetails;

    try {
      status.containerRunning = await this.options.http.isContainerHealthy();
      if (!status.containerRunning) {
        return this.withIntegrationConfigured(status);
      }

      status.details.functionInstalled = await this.options.functions.isFunctionInstalled(
        DOCKER_MODEL_RUNNER_FUNCTION_ID,
      );
      if (status.details.functionInstalled) {
        const functionStatus = await this.options.functions.getFunctionById(DOCKER_MODEL_RUNNER_FUNCTION_ID);
        status.details.functionEnabled = this.options.functions.isFunctionActive(functionStatus);
        if (status.details.functionEnabled) {
          status.dockerModelRunnerConnected = await this.testConnectivity();
        }
      }
    } catch (error) {
      log.warn('Failed to fetch legacy function provisioner status:', error);
    }

    return this.withIntegrationConfigured(status);
  }

  async getServiceStatus(): Promise<ProvisionerStatus> {
    return this.verifyIntegration();
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

  async isDMRFunctionInstalled(): Promise<boolean> {
    return this.options.functions.isFunctionInstalled(DOCKER_MODEL_RUNNER_FUNCTION_ID);
  }

  async getDMRFunctionStatus(): Promise<OpenWebUIFunction | null> {
    return this.options.functions.getFunctionById(DOCKER_MODEL_RUNNER_FUNCTION_ID);
  }

  private createStatus(): ProvisionerStatus {
    return {
      mode: this.mode,
      containerRunning: false,
      integrationConfigured: false,
      dockerModelRunnerConnected: false,
      lastChecked: Date.now(),
    };
  }

  private withIntegrationConfigured(status: ProvisionerStatus): ProvisionerStatus {
    const details = (status.details ?? {}) as LegacyProvisionerDetails;
    status.integrationConfigured = Boolean(details.functionInstalled && details.functionEnabled);
    return status;
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
      onFailure: async () => {
        try {
          await this.options.http.execInContainer([
            'getent',
            'hosts',
            'model-runner.docker.internal',
          ]);
        } catch (dnsErr) {
          log.warn('DMR DNS resolution failed:', dnsErr);
        }
      },
    });
  }
}
