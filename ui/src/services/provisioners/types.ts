import type {
  DockerModelRunnerConfig,
  ExtensionConfig,
  FunctionInstallResult,
  OpenWebUIFunction,
  ProvisionerMode,
  ServiceStatus,
  ServiceStatusDetails,
} from '../../types';
import type { FunctionsClient } from '../functionsClient';
import type { OpenWebUIHttpClient } from '../openWebUIHttpClient';

export interface ProvisionerContext {
  http: OpenWebUIHttpClient;
  functions: FunctionsClient;
  dmrConfig: DockerModelRunnerConfig;
  config: ExtensionConfig;
}

/** Known fields for legacy-function provisioner status details. */
export type LegacyProvisionerDetails = Pick<
  ServiceStatusDetails,
  'functionInstalled' | 'functionEnabled'
>;

/** Known fields for openai provisioner status details. */
export type OpenAIProvisionerDetails = Pick<
  ServiceStatusDetails,
  | 'modelsApiReachable'
  | 'modelsCount'
  | 'openAIProviderConfigured'
  | 'openAIProviderEndpointConfigured'
  | 'prefixIdConfigured'
  | 'prefixIdSupported'
  | 'prefixIdValue'
  | 'prefixIdMatchedIndexes'
>;

/** Known + forward-compatible fields carried by provisioner status. */
export type ProvisionerDetails = ServiceStatusDetails;

export interface ProvisionerStatus {
  mode: ProvisionerMode;
  containerRunning: boolean;
  integrationConfigured: boolean;
  dockerModelRunnerConnected: boolean;
  lastChecked: number;
  details?: ProvisionerDetails;
}

export interface DMRProvisioner {
  readonly mode: ProvisionerMode;
  setupIntegration(): Promise<ProvisionerStatus>;
  verifyIntegration(): Promise<ProvisionerStatus>;
  getServiceStatus(): Promise<ProvisionerStatus>;
  cleanupInactiveArtifacts(): Promise<void>;
  resetConnectivityCache(): void;
}

export interface LegacyFunctionProvisionerContract extends DMRProvisioner {
  installDMRFunction(): Promise<FunctionInstallResult>;
  isDMRFunctionInstalled(): Promise<boolean>;
  getDMRFunctionStatus(): Promise<OpenWebUIFunction | null>;
}

export function toServiceStatus(status: ProvisionerStatus): ServiceStatus {
  const details: ServiceStatusDetails = status.details ?? {};
  const hasFunctionInstalled = typeof details.functionInstalled === 'boolean';
  const hasFunctionEnabled = typeof details.functionEnabled === 'boolean';

  return {
    containerRunning: status.containerRunning,
    functionInstalled: hasFunctionInstalled
      ? Boolean(details.functionInstalled)
      : status.integrationConfigured,
    functionEnabled: hasFunctionEnabled
      ? Boolean(details.functionEnabled)
      : status.integrationConfigured,
    dockerModelRunnerConnected: status.dockerModelRunnerConnected,
    lastChecked: status.lastChecked,
    integrationConfigured: status.integrationConfigured,
    provisionerMode: status.mode,
    details,
  };
}
