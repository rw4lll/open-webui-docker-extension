// Shared constants for the Open WebUI Docker Extension

import type { ProvisionerMode } from './types';

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
export const DEFAULT_PROVISIONER = 'openai' as const;

export const PROVISIONER_LABEL_KEY = 'com.docker.extension.openwebui.provisioner';

export const PROVISIONER_LABELS: Record<ProvisionerMode, string> = {
  openai: 'OpenAI-compatible',
  'legacy-function': 'Legacy function',
};

export const PROVISIONER_CONFIG_LABELS: Record<ProvisionerMode, string> = {
  openai: 'OpenAI-compatible (default)',
  'legacy-function': 'Legacy Function (docker_model_runner.py)',
};

export const DMR_DEFAULTS = {
  baseUrl: 'http://model-runner.docker.internal',
  engineSuffix: '/engines/llama.cpp/v1',
  connectionTimeout: 30,
  retryCount: 2,
  modelCacheTtl: 300,
  connectivityCacheMs: 5 * 60 * 1000, // 5 minutes
} as const;

export const DMR_STATUS_CACHE_TTL_MS = 5 * 60 * 1000;
export const DMR_STATUS_VERIFY_CACHE_TTL_MS = 10 * 1000;
export const DMR_POLL_INTERVAL_NOT_READY_MS = 10 * 1000;
export const DMR_POLL_INTERVAL_READY_MS = 2 * 60 * 1000;
export const DMR_SETUP_COOLDOWN_MS = 30 * 1000;

export const IMAGE_UPDATE_CACHE_TTL_MS = 5 * 60 * 1000;
export const IMAGE_UPDATE_POLL_INTERVAL_MS = 5 * 60 * 1000;
export const IMAGE_UPDATE_FLOATING_TAG_REGEX = /:(main|latest)$/i;

export const CONTAINER_POLL_INTERVAL_TRANSIENT_MS = 5 * 1000;
export const CONTAINER_POLL_INTERVAL_RUNNING_MS = 15 * 1000;

export const OPENAI_PROVIDER_DEFAULTS = {
  baseUrl: `${DMR_DEFAULTS.baseUrl}${DMR_DEFAULTS.engineSuffix}`,
  apiKeyPlaceholder: 'not-required',
  prefixId: 'Docker Model Runner',
} as const;

export const DMR_GATE_TIMEOUT_MS = 60_000;

export const DMR_SETUP_MESSAGES = {
  legacy_installed_enabled: 'Container ready with Docker Model Runner legacy function integration',
  legacy_installed_disabled:
    'Container ready. Docker Model Runner legacy function is installed but not enabled.',
  legacy_not_installed: 'Container ready. Docker Model Runner legacy function is not installed.',
  openai_configured: 'Container ready with OpenAI-compatible Docker Model Runner integration',
  openai_not_configured:
    'Container ready. OpenAI-compatible Docker Model Runner integration needs attention.',
} as const;
