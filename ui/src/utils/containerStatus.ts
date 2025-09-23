import type { ContainerStatus, ExtensionConfig } from '../types';
import type { ContainerInspectionResult } from '../services/containerService';

export function deriveContainerStatus(
  inspection: ContainerInspectionResult | null | undefined,
  fallbackConfig: ExtensionConfig,
): ContainerStatus {
  if (!inspection || !inspection.exists) {
    return {
      status: 'not_found',
      message: 'Open WebUI container not found',
      config: fallbackConfig,
    };
  }

  return {
    status: inspection.state,
    message: `Container is ${inspection.state}`,
    config: inspection.config,
  };
}
