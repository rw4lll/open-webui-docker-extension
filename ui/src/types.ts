// Types for Open WebUI Docker Extension

export const CONTAINER_STATES = [
  'running',
  'exited',
  'stopped',
  'not_found',
  'created',
  'paused',
  'restarting',
] as const;

export type ContainerState = (typeof CONTAINER_STATES)[number];

export interface ExtensionConfig {
  image: string;
  port: string;
  autoStart: boolean;
}

export interface ContainerStatus {
  status: ContainerState;
  message: string;
  config: ExtensionConfig;
}

// Docker Model Runner Integration Types
export interface FunctionConfigState {
  isActive?: boolean | null;
  isGlobal?: boolean | null;
  enabled?: boolean | null;
}

export interface OpenWebUIFunction {
  id: string;
  name: string;
  type: 'manifold' | 'pipe' | 'filter';
  content?: string;
  meta?: Record<string, unknown> | null;
  isActive?: boolean;
  isGlobal?: boolean;
  config?: FunctionConfigState | null;
  /** Raw response payload for debugging/backwards compatibility. */
  raw?: Record<string, unknown>;
}

export interface FunctionInstallResult {
  success: boolean;
  message: string;
  functionId: string;
}

export interface DockerModelRunnerConfig {
  baseUrl: string;
  engineSuffix: string;
  connectionTimeout: number;
  retryCount: number;
  modelCacheTtl: number;
  connectivityCacheMs: number;
}

export interface ServiceStatus {
  containerRunning: boolean;
  functionInstalled: boolean;
  functionEnabled: boolean;
  dockerModelRunnerConnected: boolean;
  lastChecked: number;
}

// Minimal typed shape for Docker listContainers entries
export interface DockerListedContainer {
  Id: string;
  Names?: string[];
  Name?: string;
  Image: string;
  State: string;
  Status?: string;
  Ports?: Array<{
    IP?: string;
    PrivatePort: number;
    PublicPort?: number;
    Type?: string;
  }>;
  Created?: number;
}
