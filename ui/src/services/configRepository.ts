import {
  DEFAULT_AUTO_START,
  DEFAULT_ENABLE_DOCKER_MCP_TOOLKIT,
  DEFAULT_IMAGE,
  DEFAULT_PORT,
  DEFAULT_PROVISIONER,
} from '../constants';
import { log } from '../logger';
import type { ExtensionConfig, ProvisionerMode } from '../types';
import { createLocalStorageAdapter, type StorageAdapter } from './storage';

const STORAGE_KEY = 'openwebui-extension-config';
const HISTORY_KEY = `${STORAGE_KEY}-history`;
const MIGRATION_VERSION_KEY = `${STORAGE_KEY}-migration-version`;

/**
 * Current migration schema version. Bump this when adding new migrations.
 * v1: Migrate default provisioner from legacy-function → openai.
 * v2: Add `enableDockerMcpToolkit` toggle with default true.
 */
const CURRENT_MIGRATION_VERSION = 2;

const IMAGE_REGEX =
  /^(?:(?:[a-zA-Z0-9](?:[a-zA-Z0-9-]*[a-zA-Z0-9])?\.)*[a-zA-Z0-9](?:[a-zA-Z0-9-]*[a-zA-Z0-9])?(?::[0-9]+)?\/)?(?:[a-z0-9]+(?:[._-][a-z0-9]+)*\/)*[a-z0-9]+(?:[._-][a-z0-9]+)*(?::[a-zA-Z0-9][a-zA-Z0-9._-]*)?$/;

const DEFAULT_CONFIG: ExtensionConfig = {
  image: DEFAULT_IMAGE,
  port: DEFAULT_PORT,
  autoStart: DEFAULT_AUTO_START,
  provisioner: DEFAULT_PROVISIONER,
  enableDockerMcpToolkit: DEFAULT_ENABLE_DOCKER_MCP_TOOLKIT,
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

function normalizeProvisioner(mode: unknown): ProvisionerMode {
  return mode === 'legacy-function' ? 'legacy-function' : DEFAULT_PROVISIONER;
}

function normalizeDockerMcpToolkitToggle(value: unknown): boolean {
  return typeof value === 'boolean' ? value : DEFAULT_ENABLE_DOCKER_MCP_TOOLKIT;
}

export class ConfigRepository {
  constructor(private readonly storage: StorageAdapter) {}

  loadConfig(): ExtensionConfig {
    try {
      const savedConfig = this.storage.getItem(STORAGE_KEY);
      if (savedConfig) {
        const raw = JSON.parse(savedConfig) as Partial<ExtensionConfig>;
        const normalized = this.validateAndNormalize(raw as ExtensionConfig);
        return this.applyMigrations(normalized, raw);
      }
    } catch (error) {
      log.warn('Failed to load config from storage:', error);
    }

    // Fresh install — mark all migrations as complete so they don't run later.
    this.setMigrationVersion(CURRENT_MIGRATION_VERSION);
    return { ...DEFAULT_CONFIG };
  }

  saveConfig(config: ExtensionConfig): void {
    try {
      const normalizedConfig = this.validateAndNormalize(config);
      this.storage.setItem(STORAGE_KEY, JSON.stringify(normalizedConfig));
      // Mark migrations as applied: any config persisted by the current code
      // version must not be re-migrated on the next load.
      this.setMigrationVersion(CURRENT_MIGRATION_VERSION);
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
      provisioner: normalizeProvisioner(config.provisioner),
      enableDockerMcpToolkit: normalizeDockerMcpToolkitToggle(config.enableDockerMcpToolkit),
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

    if (!config.provisioner || typeof config.provisioner !== 'string') {
      errors.push('Provisioner mode is required');
    } else if (!['openai', 'legacy-function'].includes(config.provisioner)) {
      errors.push('Provisioner mode must be either openai or legacy-function');
    }

    return errors;
  }

  configsEqual(config1: ExtensionConfig, config2: ExtensionConfig): boolean {
    return (
      config1.image === config2.image &&
      config1.port === config2.port &&
      config1.autoStart === config2.autoStart &&
      config1.provisioner === config2.provisioner &&
      config1.enableDockerMcpToolkit === config2.enableDockerMcpToolkit
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

  /**
   * Run any pending config migrations on the loaded config.
   *
   * `raw` is the un-normalized JSON that was stored, so we can inspect the
   * original provisioner value (which may be absent in old schemas).
   */
  private applyMigrations(
    normalized: ExtensionConfig,
    raw: Partial<ExtensionConfig>,
  ): ExtensionConfig {
    const storedVersion = this.getMigrationVersion();

    // Already up-to-date — nothing to do.
    if (storedVersion >= CURRENT_MIGRATION_VERSION) {
      return normalized;
    }

    let migrated = { ...normalized };

    if (storedVersion < 1) {
      migrated = this.migrationV1(migrated, raw);
    }
    if (storedVersion < 2) {
      migrated = this.migrationV2(migrated, raw);
    }

    // Persist the migrated config and bump the version marker.
    try {
      this.saveConfig(migrated);
      this.setMigrationVersion(CURRENT_MIGRATION_VERSION);
    } catch (error) {
      log.warn('Failed to persist migrated config:', error);
    }

    return migrated;
  }

  /**
   * Migration v1 — switch the default provisioner from legacy-function to openai.
   *
   * In the old extension version, `legacy-function` was the only provisioner and
   * was either stored explicitly or absent from the config object.  Both cases
   * indicate an upgrade from the old default and should resolve to `openai`.
   */
  private migrationV1(config: ExtensionConfig, raw: Partial<ExtensionConfig>): ExtensionConfig {
    const storedProvisioner = raw.provisioner;

    if (storedProvisioner === 'legacy-function' || storedProvisioner === undefined) {
      log.info(
        `Config migration v1: provisioner "${String(storedProvisioner)}" → "${DEFAULT_PROVISIONER}" (new default)`,
      );
      return { ...config, provisioner: DEFAULT_PROVISIONER };
    }

    return config;
  }

  /**
   * Migration v2 — add docker MCP Toolkit toggle with default enabled.
   */
  private migrationV2(config: ExtensionConfig, raw: Partial<ExtensionConfig>): ExtensionConfig {
    if (typeof raw.enableDockerMcpToolkit !== 'boolean') {
      log.info(
        `Config migration v2: enableDockerMcpToolkit "${String(raw.enableDockerMcpToolkit)}" → "${String(DEFAULT_ENABLE_DOCKER_MCP_TOOLKIT)}"`,
      );
      return {
        ...config,
        enableDockerMcpToolkit: DEFAULT_ENABLE_DOCKER_MCP_TOOLKIT,
      };
    }

    return config;
  }

  private getMigrationVersion(): number {
    try {
      const raw = this.storage.getItem(MIGRATION_VERSION_KEY);
      if (raw !== null) {
        const parsed = Number(raw);
        return Number.isFinite(parsed) ? parsed : 0;
      }
    } catch {
      // Ignore read errors; treat as version 0.
    }
    return 0;
  }

  private setMigrationVersion(version: number): void {
    try {
      this.storage.setItem(MIGRATION_VERSION_KEY, String(version));
    } catch {
      log.warn('Failed to persist config migration version');
    }
  }
}

export const defaultConfigRepository = new ConfigRepository(createLocalStorageAdapter());
