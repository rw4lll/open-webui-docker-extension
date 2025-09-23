// Shared constants for the Open WebUI Docker Extension

export const CONTAINER_NAME = 'openwebui-extension-service';

export const CONTAINER_LABELS = {
  'com.docker.extension.openwebui': 'true',
  'com.docker.extension.openwebui.role': 'service',
} as const;

export const VOLUME_NAMES = {
  data: 'open-webui-docker-extension-data',
  cache: 'open-webui-docker-extension-cache',
  chroma: 'open-webui-docker-extension-chroma',
} as const;

export const DEFAULT_IMAGE = 'ghcr.io/open-webui/open-webui:main';
export const DEFAULT_PORT = '8090';
export const DEFAULT_AUTO_START = true;

export const DMR_DEFAULTS = {
  baseUrl: 'http://model-runner.docker.internal',
  engineSuffix: '/engines/llama.cpp/v1',
  connectionTimeout: 30,
  retryCount: 2,
  modelCacheTtl: 300,
  connectivityCacheMs: 5 * 60 * 1000, // 5 minutes
} as const;

export const DMR_GATE_TIMEOUT_MS = 60_000;

export const DMR_SETUP_MESSAGES = {
  installed_enabled: 'Container ready with Docker Model Runner integration',
  installed_disabled: 'Container ready. Docker Model Runner function installed but not enabled.',
  not_installed: 'Container ready. Docker Model Runner function is not installed.',
} as const;
