import { describe, it, expect, beforeEach } from 'vitest';

import { ConfigRepository } from './configRepository';
import { createInMemoryStorageAdapter, type StorageAdapter } from './storage';

describe('ConfigRepository', () => {
  let repository: ConfigRepository;

  beforeEach(() => {
    repository = new ConfigRepository(createInMemoryStorageAdapter());
  });

  it('normalizes image by adding :main if missing', () => {
    const cfg = repository.validateAndNormalize({
      image: 'ghcr.io/open-webui/open-webui',
      port: '8090',
      autoStart: true,
      provisioner: 'openai',
      enableDockerMcpToolkit: true,
    });
    expect(cfg.image.endsWith(':main')).toBe(true);
  });

  it('validates port range and warns for <1024', () => {
    const errors = repository.validateConfig({
      image: 'img:tag',
      port: '0',
      autoStart: true,
      provisioner: 'openai',
      enableDockerMcpToolkit: true,
    });
    expect(errors.some((e) => e.includes('between 1 and 65535'))).toBe(true);
  });

  it('saves and loads config', () => {
    const cfg = {
      image: 'img:tag',
      port: '8090',
      autoStart: false,
      provisioner: 'legacy-function' as const,
      enableDockerMcpToolkit: true,
    };
    repository.saveConfig(cfg);
    const loaded = repository.loadConfig();
    expect(loaded.image).toBe('img:tag');
    expect(loaded.port).toBe('8090');
    expect(loaded.provisioner).toBe('legacy-function');
    expect(loaded.enableDockerMcpToolkit).toBe(true);
  });
});

describe('ConfigRepository – upgrade migration', () => {
  const CONFIG_KEY = 'openwebui-extension-config';
  const MIGRATION_KEY = 'openwebui-extension-config-migration-version';

  /**
   * Simulate an old-version localStorage by writing a raw config JSON
   * directly (the way the old code would have persisted it) and ensuring
   * the migration marker does NOT exist.
   */
  function seedOldConfig(storage: StorageAdapter, raw: Record<string, unknown>): void {
    storage.setItem(CONFIG_KEY, JSON.stringify(raw));
    // Ensure no migration marker — simulates pre-v0.2 state.
    storage.removeItem(MIGRATION_KEY);
  }

  it('migrates config without provisioner field to openai on first load', () => {
    const storage = createInMemoryStorageAdapter();
    // Old version stored {image, port, autoStart} with NO provisioner field.
    seedOldConfig(storage, {
      image: 'ghcr.io/open-webui/open-webui:main',
      port: '8090',
      autoStart: true,
    });

    const repo = new ConfigRepository(storage);
    const loaded = repo.loadConfig();

    expect(loaded.provisioner).toBe('openai');
    // Other fields should be preserved.
    expect(loaded.image).toBe('ghcr.io/open-webui/open-webui:main');
    expect(loaded.port).toBe('8090');
    expect(loaded.autoStart).toBe(true);
    expect(loaded.enableDockerMcpToolkit).toBe(true);
  });

  it('migrates config with legacy-function provisioner to openai on first load', () => {
    const storage = createInMemoryStorageAdapter();
    // Hypothetical case: stored config explicitly has legacy-function.
    seedOldConfig(storage, {
      image: 'ghcr.io/open-webui/open-webui:main',
      port: '9000',
      autoStart: false,
      provisioner: 'legacy-function',
    });

    const repo = new ConfigRepository(storage);
    const loaded = repo.loadConfig();

    expect(loaded.provisioner).toBe('openai');
    expect(loaded.port).toBe('9000');
    expect(loaded.autoStart).toBe(false);
    expect(loaded.enableDockerMcpToolkit).toBe(true);
  });

  it('does not re-migrate after migration marker is set', () => {
    const storage = createInMemoryStorageAdapter();
    seedOldConfig(storage, {
      image: 'ghcr.io/open-webui/open-webui:main',
      port: '8090',
      autoStart: true,
    });

    const repo = new ConfigRepository(storage);
    // First load triggers migration.
    const first = repo.loadConfig();
    expect(first.provisioner).toBe('openai');

    // Manually revert provisioner to legacy-function and save —
    // simulates user explicitly choosing it in the new UI.
    repo.saveConfig({
      ...first,
      provisioner: 'legacy-function',
      enableDockerMcpToolkit: false,
    });

    // Second load should NOT re-migrate because migration marker is set.
    const second = repo.loadConfig();
    expect(second.provisioner).toBe('legacy-function');
    expect(second.enableDockerMcpToolkit).toBe(false);
  });

  it('preserves openai provisioner from existing new-version config', () => {
    const storage = createInMemoryStorageAdapter();
    // Already a new-version config with openai and migration marker set.
    storage.setItem(
      CONFIG_KEY,
      JSON.stringify({
        image: 'ghcr.io/open-webui/open-webui:main',
        port: '8090',
        autoStart: true,
        provisioner: 'openai',
        enableDockerMcpToolkit: false,
      }),
    );
    storage.setItem(MIGRATION_KEY, '2');

    const repo = new ConfigRepository(storage);
    const loaded = repo.loadConfig();

    expect(loaded.provisioner).toBe('openai');
    expect(loaded.enableDockerMcpToolkit).toBe(false);
  });

  it('sets migration marker on fresh install (no stored config)', () => {
    const storage = createInMemoryStorageAdapter();
    const repo = new ConfigRepository(storage);
    const loaded = repo.loadConfig();

    expect(loaded.provisioner).toBe('openai');
    expect(loaded.enableDockerMcpToolkit).toBe(true);
    // Migration marker should be set, so future saves of legacy-function
    // would NOT be migrated.
    expect(storage.getItem(MIGRATION_KEY)).toBe('2');
  });

  it('persists migrated config to storage during migration', () => {
    const storage = createInMemoryStorageAdapter();
    seedOldConfig(storage, {
      image: 'custom/image:v1',
      port: '3000',
      autoStart: true,
    });

    const repo = new ConfigRepository(storage);
    repo.loadConfig();

    // Verify the migrated config was persisted back to storage.
    const raw = JSON.parse(storage.getItem(CONFIG_KEY)!) as Record<string, unknown>;
    expect(raw.provisioner).toBe('openai');
    expect(raw.enableDockerMcpToolkit).toBe(true);
    expect(raw.image).toBe('custom/image:v1');
  });

  it('preserves enableDockerMcpToolkit when explicitly set in stored config', () => {
    const storage = createInMemoryStorageAdapter();
    storage.setItem(
      CONFIG_KEY,
      JSON.stringify({
        image: 'ghcr.io/open-webui/open-webui:main',
        port: '8090',
        autoStart: true,
        provisioner: 'openai',
        enableDockerMcpToolkit: false,
      }),
    );
    storage.setItem(MIGRATION_KEY, '2');

    const repo = new ConfigRepository(storage);
    const loaded = repo.loadConfig();
    expect(loaded.enableDockerMcpToolkit).toBe(false);
  });
});
