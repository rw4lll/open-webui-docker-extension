import type { Dispatch, SetStateAction } from 'react';
import { useCallback, useEffect, useState } from 'react';

import { defaultConfigRepository } from '../services/configRepository';
import type { ConfigRepository } from '../services/configRepository';
import { ExtensionConfig } from '../types';

interface UseExtensionConfigResult {
  config: ExtensionConfig;
  setConfig: Dispatch<SetStateAction<ExtensionConfig>>;
  reloadConfig: () => void;
  persistConfig: (config: ExtensionConfig) => ExtensionConfig;
  resetToDefaults: () => ExtensionConfig;
  validateConfig: (config: ExtensionConfig) => string[];
  configsEqual: (a: ExtensionConfig, b: ExtensionConfig) => boolean;
}

export function useExtensionConfig(
  repository: ConfigRepository = defaultConfigRepository,
): UseExtensionConfigResult {
  const [config, setConfig] = useState<ExtensionConfig>(repository.loadConfig());

  const reloadConfig = useCallback(() => {
    const stored = repository.loadConfig();
    setConfig(stored);
  }, [repository]);

  useEffect(() => {
    reloadConfig();
  }, [reloadConfig]);

  const persistConfig = useCallback(
    (nextConfig: ExtensionConfig) => {
      const normalized = repository.validateAndNormalize(nextConfig);
      repository.saveConfig(normalized);
      repository.saveConfigToHistory(normalized);
      setConfig(normalized);
      return normalized;
    },
    [repository],
  );

  const resetToDefaults = useCallback(() => {
    const defaults = repository.resetConfig();
    setConfig(defaults);
    return defaults;
  }, [repository]);

  const validateConfig = useCallback(
    (candidate: ExtensionConfig) => {
      return repository.validateConfig(candidate);
    },
    [repository],
  );

  const configsEqual = useCallback(
    (a: ExtensionConfig, b: ExtensionConfig) => {
      return repository.configsEqual(a, b);
    },
    [repository],
  );

  return {
    config,
    setConfig,
    reloadConfig,
    persistConfig,
    resetToDefaults,
    validateConfig,
    configsEqual,
  };
}
