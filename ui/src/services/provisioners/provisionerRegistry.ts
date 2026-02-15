import type { ProvisionerMode } from '../../types';
import type { LegacyFunctionProvisionerContract, DMRProvisioner } from './types';

interface ProvisionerRegistryOptions {
  legacyProvisioner: LegacyFunctionProvisionerContract;
  openAIProvisioner: DMRProvisioner;
}

export class ProvisionerRegistry {
  constructor(private readonly options: ProvisionerRegistryOptions) {}

  resolve(mode: ProvisionerMode): DMRProvisioner {
    switch (mode) {
      case 'legacy-function':
        return this.options.legacyProvisioner;
      case 'openai':
        return this.options.openAIProvisioner;
      default: {
        const exhaustiveMode: never = mode;
        throw new Error(`Unsupported provisioner mode: ${exhaustiveMode}`);
      }
    }
  }

  getLegacyProvisioner(): LegacyFunctionProvisionerContract {
    return this.options.legacyProvisioner;
  }

  resetAllConnectivityCaches(): void {
    this.options.legacyProvisioner.resetConnectivityCache();
    this.options.openAIProvisioner.resetConnectivityCache();
  }
}
