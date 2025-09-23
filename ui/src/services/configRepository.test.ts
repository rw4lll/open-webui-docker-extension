import { describe, it, expect, beforeEach } from 'vitest';

import { ConfigRepository } from './configRepository';
import { createInMemoryStorageAdapter } from './storage';

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
    });
    expect(cfg.image.endsWith(':main')).toBe(true);
  });

  it('validates port range and warns for <1024', () => {
    const errors = repository.validateConfig({ image: 'img:tag', port: '0', autoStart: true });
    expect(errors.some((e) => e.includes('between 1 and 65535'))).toBe(true);
  });

  it('saves and loads config', () => {
    const cfg = { image: 'img:tag', port: '8090', autoStart: false };
    repository.saveConfig(cfg);
    const loaded = repository.loadConfig();
    expect(loaded.image).toBe('img:tag');
    expect(loaded.port).toBe('8090');
  });
});
