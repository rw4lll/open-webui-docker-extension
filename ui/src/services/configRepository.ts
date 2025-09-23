import { DEFAULT_IMAGE, DEFAULT_PORT, DEFAULT_AUTO_START } from '../constants';
import { log } from '../logger';
import type { ExtensionConfig } from '../types';
import { createLocalStorageAdapter, type StorageAdapter } from './storage';

const STORAGE_KEY = 'openwebui-extension-config';
const HISTORY_KEY = `${STORAGE_KEY}-history`;

const IMAGE_REGEX =
  /^(?:(?:[a-zA-Z0-9](?:[a-zA-Z0-9-]*[a-zA-Z0-9])?\.)*[a-zA-Z0-9](?:[a-zA-Z0-9-]*[a-zA-Z0-9])?(?::[0-9]+)?\/)?(?:[a-z0-9]+(?:[._-][a-z0-9]+)*\/)*[a-z0-9]+(?:[._-][a-z0-9]+)*(?::[a-zA-Z0-9][a-zA-Z0-9._-]*)?$/;

const DEFAULT_CONFIG: ExtensionConfig = {
  image: DEFAULT_IMAGE,
  port: DEFAULT_PORT,
  autoStart: DEFAULT_AUTO_START,
};

function normalizeImage(image: string): string {
  if (!image || typeof image !== 'string') {
    return DEFAULT_CONFIG.image;
  }

  const trimmed = image.trim();
  if (!trimmed) {
    return DEFAULT_CONFIG.image;
  }

  if (!trimmed.includes(':')) {
    return `${trimmed}:main`;
  }

  return trimmed;
}

function getPortValidationError(port: string): string | undefined {
  if (!/^\d+$/.test(port)) {
    return 'Port must be a valid number';
  }

  const portNum = Number(port);
  if (!Number.isInteger(portNum) || portNum < 1 || portNum > 65535) {
    return 'Port must be between 1 and 65535';
  }

  return undefined;
}

function normalizePort(port: unknown): string {
  if (typeof port !== 'string') {
    return DEFAULT_CONFIG.port;
  }

  const trimmed = port.trim();
  if (!trimmed) {
    return DEFAULT_CONFIG.port;
  }

  const error = getPortValidationError(trimmed);
  if (error) {
    return DEFAULT_CONFIG.port;
  }

  return Number(trimmed).toString();
}

function isValidImageName(image: string): boolean {
  return IMAGE_REGEX.test(image);
}

export class ConfigRepository {
  constructor(private readonly storage: StorageAdapter) {}

  loadConfig(): ExtensionConfig {
    try {
      const savedConfig = this.storage.getItem(STORAGE_KEY);
      if (savedConfig) {
        const parsed = JSON.parse(savedConfig) as ExtensionConfig;
        return this.validateAndNormalize(parsed);
      }
    } catch (error) {
      log.warn('Failed to load config from storage:', error);
    }

    return { ...DEFAULT_CONFIG };
  }

  saveConfig(config: ExtensionConfig): void {
    try {
      const normalizedConfig = this.validateAndNormalize(config);
      this.storage.setItem(STORAGE_KEY, JSON.stringify(normalizedConfig));
    } catch (error) {
      log.error('Failed to save config to storage:', error);
      throw new Error(`Failed to save configuration: ${error}`);
    }
  }

  resetConfig(): ExtensionConfig {
    try {
      this.storage.removeItem(STORAGE_KEY);
      return { ...DEFAULT_CONFIG };
    } catch (error) {
      log.error('Failed to reset config:', error);
      return { ...DEFAULT_CONFIG };
    }
  }

  validateAndNormalize(config: ExtensionConfig): ExtensionConfig {
    return {
      image: normalizeImage(config.image),
      port: normalizePort(config.port),
      autoStart: typeof config.autoStart === 'boolean' ? config.autoStart : DEFAULT_AUTO_START,
    };
  }

  validateConfig(config: ExtensionConfig): string[] {
    const errors: string[] = [];

    if (!config.image || typeof config.image !== 'string') {
      errors.push('Docker image is required');
    } else {
      const trimmed = config.image.trim();
      if (!trimmed) {
        errors.push('Docker image cannot be empty');
      } else if (trimmed.includes(' ')) {
        errors.push('Docker image cannot contain spaces');
      } else if (!isValidImageName(trimmed)) {
        errors.push('Docker image name is invalid');
      }
    }

    if (!config.port || typeof config.port !== 'string') {
      errors.push('Port is required');
    } else {
      const trimmed = config.port.trim();
      const error = getPortValidationError(trimmed);
      if (error) {
        errors.push(error);
      }
    }

    return errors;
  }

  configsEqual(config1: ExtensionConfig, config2: ExtensionConfig): boolean {
    return (
      config1.image === config2.image &&
      config1.port === config2.port &&
      config1.autoStart === config2.autoStart
    );
  }

  getDefaultConfig(): ExtensionConfig {
    return { ...DEFAULT_CONFIG };
  }

  isDefaultConfig(config: ExtensionConfig): boolean {
    return this.configsEqual(config, DEFAULT_CONFIG);
  }

  getConfigHistory(): ExtensionConfig[] {
    try {
      const history = this.storage.getItem(HISTORY_KEY);
      if (history) {
        return JSON.parse(history) as ExtensionConfig[];
      }
    } catch (error) {
      log.warn('Failed to load config history:', error);
    }

    return [];
  }

  saveConfigToHistory(config: ExtensionConfig): void {
    try {
      const history = this.getConfigHistory();
      const normalizedConfig = this.validateAndNormalize(config);

      if (history.length > 0 && this.configsEqual(history[0], normalizedConfig)) {
        return;
      }

      history.unshift(normalizedConfig);
      const trimmedHistory = history.slice(0, 10);

      this.storage.setItem(HISTORY_KEY, JSON.stringify(trimmedHistory));
    } catch (error) {
      log.warn('Failed to save config to history:', error);
    }
  }
}

export const defaultConfigRepository = new ConfigRepository(createLocalStorageAdapter());
