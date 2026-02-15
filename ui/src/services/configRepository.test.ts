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
      provisioner: 'openai',
    });
    expect(cfg.image.endsWith(':main')).toBe(true);
  });

  it('validates port range and warns for <1024', () => {
    const errors = repository.validateConfig({
      image: 'img:tag',
      port: '0',
      autoStart: true,
      provisioner: 'openai',
    });
    expect(errors.some((e) => e.includes('between 1 and 65535'))).toBe(true);
  });

  it('saves and loads config', () => {
    const cfg = {
      image: 'img:tag',
      port: '8090',
      autoStart: false,
      provisioner: 'legacy-function' as const,
    };
    repository.saveConfig(cfg);
    const loaded = repository.loadConfig();
    expect(loaded.image).toBe('img:tag');
    expect(loaded.port).toBe('8090');
    expect(loaded.provisioner).toBe('legacy-function');
  });
});
