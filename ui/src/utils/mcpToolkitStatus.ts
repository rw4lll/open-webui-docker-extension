import type { DockerMcpToolkitStatus } from '../types';

export function isDockerMcpToolkitReady(status: DockerMcpToolkitStatus | null | undefined): boolean {
  if (!status) {
    return false;
  }
  if (!status.enabled) {
    return status.integrationConfigured;
  }
  return status.containerRunning && status.integrationConfigured;
}
