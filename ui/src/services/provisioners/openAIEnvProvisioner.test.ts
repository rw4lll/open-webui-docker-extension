import { describe, expect, it, vi } from 'vitest';

import { DMR_DEFAULTS } from '../../constants';
import type { OpenAIProvisionerDetails } from './types';
import { OpenAIEnvProvisioner } from './openAIEnvProvisioner';

describe('OpenAIEnvProvisioner', () => {
  it('configures prefix_id and marks integration configured when /api/models is reachable', async () => {
    const configUrl = 'http://localhost:8090/api/v1/openai/config';
    const updateUrl = 'http://localhost:8090/api/v1/openai/config/update';
    const modelsUrl = 'http://localhost:8090/api/models';

    const http = {
      waitUntilOpenWebUIReady: vi.fn().mockResolvedValue(true),
      isContainerHealthy: vi.fn().mockResolvedValue(true),
      request: vi.fn(async (options: { url: string }) => {
        if (options.url === configUrl) {
          return JSON.stringify({
            ENABLE_OPENAI_API: true,
            OPENAI_API_BASE_URLS: ['http://model-runner.docker.internal/engines/llama.cpp/v1'],
            OPENAI_API_KEYS: ['not-required'],
            OPENAI_API_CONFIGS: {},
          });
        }

        if (options.url === updateUrl) {
          return JSON.stringify({
            ENABLE_OPENAI_API: true,
            OPENAI_API_BASE_URLS: ['http://model-runner.docker.internal/engines/llama.cpp/v1'],
            OPENAI_API_KEYS: ['not-required'],
            OPENAI_API_CONFIGS: {
              '0': {
                prefix_id: 'Docker Model Runner',
              },
            },
          });
        }

        if (options.url === modelsUrl) {
          return JSON.stringify([{ id: 'llama3.2' }]);
        }

        throw new Error(`Unexpected URL: ${options.url}`);
      }),
      containerCurl: vi.fn().mockResolvedValue('{"data":[{"id":"llama3.2"}]}'),
      getApiBaseUrl: vi.fn().mockReturnValue('http://localhost:8090/api/v1'),
    } as any;

    const provisioner = new OpenAIEnvProvisioner({
      http,
      dmrConfig: { ...DMR_DEFAULTS },
    });

    const status = await provisioner.setupIntegration();

    expect(status.mode).toBe('openai');
    expect(status.containerRunning).toBe(true);
    expect(status.integrationConfigured).toBe(true);
    expect(status.dockerModelRunnerConnected).toBe(true);
    const details = status.details as OpenAIProvisionerDetails;
    expect(details?.modelsApiReachable).toBe(true);
    expect(details?.modelsCount).toBe(1);
    expect(details?.openAIProviderConfigured).toBe(true);
    expect(details?.prefixIdConfigured).toBe(true);

    const updateCall = http.request.mock.calls.find(
      ([arg]: [{ url: string }]) => arg.url === updateUrl,
    )?.[0];
    expect(updateCall).toBeTruthy();
    expect(updateCall.body).toContain('"prefix_id":"Docker Model Runner"');
  });

  it('registers DMR OpenAI provider when missing from Open WebUI config', async () => {
    const configUrl = 'http://localhost:8090/api/v1/openai/config';
    const updateUrl = 'http://localhost:8090/api/v1/openai/config/update';
    const modelsUrl = 'http://localhost:8090/api/models';

    const http = {
      waitUntilOpenWebUIReady: vi.fn().mockResolvedValue(true),
      isContainerHealthy: vi.fn().mockResolvedValue(true),
      request: vi.fn(async (options: { url: string }) => {
        if (options.url === configUrl) {
          return JSON.stringify({
            ENABLE_OPENAI_API: false,
            OPENAI_API_BASE_URLS: ['https://api.openai.com/v1'],
            OPENAI_API_KEYS: ['sk-live'],
            OPENAI_API_CONFIGS: {
              '0': {
                prefix_id: 'OpenAI',
              },
            },
          });
        }

        if (options.url === updateUrl) {
          return JSON.stringify({
            ENABLE_OPENAI_API: true,
            OPENAI_API_BASE_URLS: [
              'https://api.openai.com/v1',
              'http://model-runner.docker.internal/engines/llama.cpp/v1',
            ],
            OPENAI_API_KEYS: ['sk-live', 'not-required'],
            OPENAI_API_CONFIGS: {
              '0': {
                prefix_id: 'OpenAI',
              },
              '1': {
                prefix_id: 'Docker Model Runner',
              },
            },
          });
        }

        if (options.url === modelsUrl) {
          return JSON.stringify([{ id: 'llama3.2' }]);
        }

        throw new Error(`Unexpected URL: ${options.url}`);
      }),
      containerCurl: vi.fn().mockResolvedValue('{"data":[{"id":"llama3.2"}]}'),
      getApiBaseUrl: vi.fn().mockReturnValue('http://localhost:8090/api/v1'),
    } as any;

    const provisioner = new OpenAIEnvProvisioner({
      http,
      dmrConfig: { ...DMR_DEFAULTS },
    });

    const status = await provisioner.setupIntegration();
    expect(status.integrationConfigured).toBe(true);
    const details2 = status.details as OpenAIProvisionerDetails;
    expect(details2?.openAIProviderConfigured).toBe(true);
    expect(details2?.prefixIdConfigured).toBe(true);

    const updateCall = http.request.mock.calls.find(
      ([arg]: [{ url: string }]) => arg.url === updateUrl,
    )?.[0];
    expect(updateCall).toBeTruthy();
    expect(updateCall.body).toContain(
      '"OPENAI_API_BASE_URLS":["https://api.openai.com/v1","http://model-runner.docker.internal/engines/llama.cpp/v1"]',
    );
    expect(updateCall.body).toContain('"ENABLE_OPENAI_API":true');
    expect(updateCall.body).toContain('"prefix_id":"Docker Model Runner"');
  });

  it('marks integration unconfigured when /api/models check fails', async () => {
    const configUrl = 'http://localhost:8090/api/v1/openai/config';
    const modelsUrl = 'http://localhost:8090/api/models';

    const http = {
      waitUntilOpenWebUIReady: vi.fn().mockResolvedValue(true),
      isContainerHealthy: vi.fn().mockResolvedValue(true),
      request: vi.fn(async (options: { url: string }) => {
        if (options.url === configUrl) {
          return JSON.stringify({
            ENABLE_OPENAI_API: true,
            OPENAI_API_BASE_URLS: ['http://model-runner.docker.internal/engines/llama.cpp/v1'],
            OPENAI_API_KEYS: ['not-required'],
            OPENAI_API_CONFIGS: {
              '0': {
                prefix_id: 'Docker Model Runner',
              },
            },
          });
        }
        if (options.url === modelsUrl) {
          throw new Error('models unavailable');
        }
        throw new Error(`Unexpected URL: ${options.url}`);
      }),
      containerCurl: vi.fn().mockResolvedValue('{"data":[{"id":"llama3.2"}]}'),
      getApiBaseUrl: vi.fn().mockReturnValue('http://localhost:8090/api/v1'),
    } as any;

    const provisioner = new OpenAIEnvProvisioner({
      http,
      dmrConfig: { ...DMR_DEFAULTS },
    });

    const status = await provisioner.getServiceStatus();

    expect(status.containerRunning).toBe(true);
    expect(status.integrationConfigured).toBe(false);
    expect(status.dockerModelRunnerConnected).toBe(true);
    const details3 = status.details as OpenAIProvisionerDetails;
    expect(details3?.modelsApiReachable).toBe(false);
    expect(details3?.prefixIdConfigured).toBe(true);
  });

  it('uses short-lived verify cache for repeated fast status checks', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-01-01T00:00:00.000Z'));

    const configUrl = 'http://localhost:8090/api/v1/openai/config';
    const modelsUrl = 'http://localhost:8090/api/models';
    const http = {
      waitUntilOpenWebUIReady: vi.fn().mockResolvedValue(true),
      isContainerHealthy: vi.fn().mockResolvedValue(true),
      request: vi.fn(async (options: { url: string }) => {
        if (options.url === configUrl) {
          return JSON.stringify({
            ENABLE_OPENAI_API: true,
            OPENAI_API_BASE_URLS: ['http://model-runner.docker.internal/engines/llama.cpp/v1'],
            OPENAI_API_KEYS: ['not-required'],
            OPENAI_API_CONFIGS: {
              '0': {
                prefix_id: 'Docker Model Runner',
              },
            },
          });
        }
        if (options.url === modelsUrl) {
          return JSON.stringify([{ id: 'llama3.2' }]);
        }
        throw new Error(`Unexpected URL: ${options.url}`);
      }),
      containerCurl: vi.fn().mockResolvedValue('{"data":[{"id":"llama3.2"}]}'),
      getApiBaseUrl: vi.fn().mockReturnValue('http://localhost:8090/api/v1'),
    } as any;

    const provisioner = new OpenAIEnvProvisioner({
      http,
      dmrConfig: { ...DMR_DEFAULTS },
    });

    await provisioner.verifyIntegration();
    const firstRequestCount = http.request.mock.calls.length;
    await provisioner.verifyIntegration();

    expect(http.isContainerHealthy).toHaveBeenCalledTimes(1);
    expect(http.request.mock.calls.length).toBe(firstRequestCount);

    vi.advanceTimersByTime(11_000);
    await provisioner.verifyIntegration();
    expect(http.isContainerHealthy).toHaveBeenCalledTimes(2);
    expect(http.request.mock.calls.length).toBeGreaterThan(firstRequestCount);

    vi.useRealTimers();
  });

  it('deregisters DMR OpenAI provider entries during inactive cleanup', async () => {
    const configUrl = 'http://localhost:8090/api/v1/openai/config';
    const updateUrl = 'http://localhost:8090/api/v1/openai/config/update';

    const http = {
      waitUntilOpenWebUIReady: vi.fn().mockResolvedValue(true),
      isContainerHealthy: vi.fn().mockResolvedValue(true),
      request: vi.fn(async (options: { url: string }) => {
        if (options.url === configUrl) {
          return JSON.stringify({
            ENABLE_OPENAI_API: true,
            OPENAI_API_BASE_URLS: [
              'http://model-runner.docker.internal/engines/llama.cpp/v1',
              'https://api.openai.com/v1',
            ],
            OPENAI_API_KEYS: ['not-required', 'sk-live'],
            OPENAI_API_CONFIGS: {
              '0': { prefix_id: 'Docker Model Runner' },
              '1': { prefix_id: 'OpenAI' },
            },
          });
        }

        if (options.url === updateUrl) {
          return JSON.stringify({
            ENABLE_OPENAI_API: true,
            OPENAI_API_BASE_URLS: ['https://api.openai.com/v1'],
            OPENAI_API_KEYS: ['sk-live'],
            OPENAI_API_CONFIGS: {
              '0': { prefix_id: 'OpenAI' },
            },
          });
        }

        throw new Error(`Unexpected URL: ${options.url}`);
      }),
      containerCurl: vi.fn().mockResolvedValue(''),
      getApiBaseUrl: vi.fn().mockReturnValue('http://localhost:8090/api/v1'),
    } as any;

    const provisioner = new OpenAIEnvProvisioner({
      http,
      dmrConfig: { ...DMR_DEFAULTS },
    });

    await provisioner.cleanupInactiveArtifacts();

    const updateCall = http.request.mock.calls.find(
      ([arg]: [{ url: string }]) => arg.url === updateUrl,
    )?.[0];
    expect(updateCall).toBeTruthy();
    expect(updateCall.body).toContain('"OPENAI_API_BASE_URLS":["https://api.openai.com/v1"]');
    expect(updateCall.body).not.toContain('model-runner.docker.internal');
  });
});
