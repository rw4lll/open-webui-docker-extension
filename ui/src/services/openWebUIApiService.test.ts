import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { OpenWebUIApiService } from './openWebUIApiService';
import { AuthTokenStore } from './authTokenStore';
import { createInMemoryStorageAdapter } from './storage';

// Mock Docker Desktop client (virtual module to avoid real resolution)
vi.mock('@docker/extension-api-client', () => ({
  createDockerDesktopClient: () => ({
    docker: {
      cli: {
        exec: vi.fn(async () => ({ stdout: '', stderr: '' })),
      },
    },
  }),
}));

const originalFetch = global.fetch as any;

describe('OpenWebUIApiService auth', () => {
  let tokenStore: AuthTokenStore;

  beforeEach(() => {
    tokenStore = new AuthTokenStore(createInMemoryStorageAdapter());
    (global.fetch as any) = vi.fn(async (url: string, init?: RequestInit) => {
      if (String(url).includes('/auths/signin')) {
        return {
          ok: true,
          status: 200,
          statusText: 'OK',
          text: async () =>
            JSON.stringify({ token: 'tkn123', exp: Math.floor(Date.now() / 1000) + 3600 }),
        } as any;
      }
      return {
        ok: true,
        status: 200,
        statusText: 'OK',
        text: async () => JSON.stringify({ headers: init?.headers }),
      } as any;
    });
    localStorage.clear();
  });

  afterEach(() => {
    (global.fetch as any) = originalFetch;
  });

  it('obtains token on demand and caches it', async () => {
    const svc = new OpenWebUIApiService(
      { image: 'img:tag', port: '8090', autoStart: true, provisioner: 'openai' },
      undefined,
      { authTokenStore: tokenStore },
    );
    await svc.ensureAuthToken();
    const stored = tokenStore.getToken();
    expect(stored).toBe('tkn123');
  });
});

describe('OpenWebUIApiService httpRequest 401 handling', () => {
  const originalFetch = global.fetch as any;
  afterEach(() => {
    (global.fetch as any) = originalFetch;
    localStorage.clear();
  });

  it('refreshes token on 401 and retries once', async () => {
    const tokenStore = new AuthTokenStore(createInMemoryStorageAdapter());
    const svc = new OpenWebUIApiService(
      { image: 'img:main', port: '8090', autoStart: true, provisioner: 'legacy-function' },
      undefined,
      { authTokenStore: tokenStore },
    );
    svc.setAuthToken('stale-token');

    const fetchMock = vi
      .fn()
      // first call -> protected endpoint returns 401
      .mockResolvedValueOnce({
        ok: false,
        status: 401,
        statusText: 'Unauthorized',
        text: async () => '',
      })
      // sign-in call -> returns refreshed token
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        statusText: 'OK',
        text: async () =>
          JSON.stringify({ token: 'refreshed-token', exp: Math.floor(Date.now() / 1000) + 3600 }),
      })
      // retry call -> success (after token refresh)
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        statusText: 'OK',
        text: async () => JSON.stringify({ ok: true }),
      });
    (global.fetch as any) = fetchMock;

    const result = await (svc as any).httpRequest({
      url: 'http://localhost:8090/api/v1/functions/export',
      includeAuth: true,
    });
    expect(result).toContain('ok');
    const authHeaders = fetchMock.mock.calls
      .map(([, rawOptions]) => rawOptions as Record<string, unknown> | undefined)
      .map((opts) => opts?.headers as Record<string, string> | Headers | undefined)
      .map((headersValue) => {
        if (headersValue instanceof Headers) {
          return (
            headersValue.get('Authorization') ?? headersValue.get('authorization') ?? undefined
          );
        }
        return headersValue?.['Authorization'] ?? headersValue?.['authorization'];
      })
      .filter((value): value is string => Boolean(value));
    expect(authHeaders).toContain('Bearer refreshed-token');
  });
});

describe('OpenWebUIApiService ensureFunctionEnabled idempotency', () => {
  const originalFetch = global.fetch as any;
  afterEach(() => {
    (global.fetch as any) = originalFetch;
    localStorage.clear();
  });

  it('does not toggle when already enabled', async () => {
    const tokenStore = new AuthTokenStore(createInMemoryStorageAdapter());
    const svc = new OpenWebUIApiService(
      { image: 'img:tag', port: '8090', autoStart: true, provisioner: 'legacy-function' },
      undefined,
      { authTokenStore: tokenStore },
    );
    svc.setAuthToken('token');
    const DOCKER_MODEL_RUNNER_FUNCTION_ID = 'docker_model_runner';

    const fetchMock = vi
      .fn()
      // getFunctions -> returns enabled
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        statusText: 'OK',
        text: async () =>
          JSON.stringify([
            { id: DOCKER_MODEL_RUNNER_FUNCTION_ID, is_active: true, is_global: true },
          ]),
      });
    (global.fetch as any) = fetchMock;

    await (svc as any).ensureFunctionEnabled(DOCKER_MODEL_RUNNER_FUNCTION_ID, true);

    // Only one fetch call for export, no toggle
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(String(fetchMock.mock.calls[0][0])).toContain('/functions/export');
  });

  it('enables locally and globally when disabled', async () => {
    const tokenStore = new AuthTokenStore(createInMemoryStorageAdapter());
    const svc = new OpenWebUIApiService(
      { image: 'img:tag', port: '8090', autoStart: true, provisioner: 'legacy-function' },
      undefined,
      { authTokenStore: tokenStore },
    );
    svc.setAuthToken('token');
    const DOCKER_MODEL_RUNNER_FUNCTION_ID = 'docker_model_runner';

    const fetchMock = vi
      .fn()
      // getFunctions (first) -> disabled
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        statusText: 'OK',
        text: async () =>
          JSON.stringify([
            { id: DOCKER_MODEL_RUNNER_FUNCTION_ID, is_active: false, is_global: false },
          ]),
      })
      // toggle local -> returns ok
      .mockResolvedValueOnce({ ok: true, status: 200, statusText: 'OK', text: async () => '' })
      // getFunctions (after local toggle) -> local enabled, global still false
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        statusText: 'OK',
        text: async () =>
          JSON.stringify([
            { id: DOCKER_MODEL_RUNNER_FUNCTION_ID, is_active: true, is_global: false },
          ]),
      })
      // toggle global -> returns ok
      .mockResolvedValueOnce({ ok: true, status: 200, statusText: 'OK', text: async () => '' })
      // getFunctions (after global toggle) -> both enabled
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        statusText: 'OK',
        text: async () =>
          JSON.stringify([
            { id: DOCKER_MODEL_RUNNER_FUNCTION_ID, is_active: true, is_global: true },
          ]),
      });
    (global.fetch as any) = fetchMock;

    await (svc as any).ensureFunctionEnabled(DOCKER_MODEL_RUNNER_FUNCTION_ID, true);

    expect(fetchMock).toHaveBeenCalledTimes(5);
    const toggleLocalUrl = String(fetchMock.mock.calls[1][0]);
    expect(toggleLocalUrl).toContain(`/functions/id/${DOCKER_MODEL_RUNNER_FUNCTION_ID}/toggle`);
    expect(toggleLocalUrl).not.toContain('/global');
    const toggleGlobalUrl = String(fetchMock.mock.calls[3][0]);
    expect(toggleGlobalUrl).toContain(
      `/functions/id/${DOCKER_MODEL_RUNNER_FUNCTION_ID}/toggle/global`,
    );
  });

  it('enables local flag when only global is active', async () => {
    const tokenStore = new AuthTokenStore(createInMemoryStorageAdapter());
    const svc = new OpenWebUIApiService(
      { image: 'img:tag', port: '8090', autoStart: true, provisioner: 'legacy-function' },
      undefined,
      { authTokenStore: tokenStore },
    );
    svc.setAuthToken('token');
    const DOCKER_MODEL_RUNNER_FUNCTION_ID = 'docker_model_runner';

    const fetchMock = vi
      .fn()
      // getFunctions -> global true but local false
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        statusText: 'OK',
        text: async () =>
          JSON.stringify([
            { id: DOCKER_MODEL_RUNNER_FUNCTION_ID, is_active: false, is_global: true },
          ]),
      })
      // toggle local -> returns ok
      .mockResolvedValueOnce({ ok: true, status: 200, statusText: 'OK', text: async () => '' })
      // getFunctions -> both flags true
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        statusText: 'OK',
        text: async () =>
          JSON.stringify([
            { id: DOCKER_MODEL_RUNNER_FUNCTION_ID, is_active: true, is_global: true },
          ]),
      });
    (global.fetch as any) = fetchMock;

    await (svc as any).ensureFunctionEnabled(DOCKER_MODEL_RUNNER_FUNCTION_ID, true);

    expect(fetchMock).toHaveBeenCalledTimes(3);
    const toggleLocalUrl = String(fetchMock.mock.calls[1][0]);
    expect(toggleLocalUrl).toContain(`/functions/id/${DOCKER_MODEL_RUNNER_FUNCTION_ID}/toggle`);
    expect(toggleLocalUrl).not.toContain('/global');
  });
});

describe('OpenWebUIApiService provisioner delegation', () => {
  it('uses verify path without mutating setup side effects', async () => {
    const tokenStore = new AuthTokenStore(createInMemoryStorageAdapter());
    const svc = new OpenWebUIApiService(
      { image: 'img:tag', port: '8090', autoStart: true, provisioner: 'openai' },
      undefined,
      { authTokenStore: tokenStore },
    );

    const verifyIntegration = vi.fn().mockResolvedValue({
      mode: 'openai',
      containerRunning: true,
      integrationConfigured: true,
      dockerModelRunnerConnected: true,
      lastChecked: Date.now(),
      details: { modelsApiReachable: true, modelsCount: 2 },
    });
    const setupIntegration = vi.fn().mockResolvedValue({
      mode: 'openai',
      containerRunning: true,
      integrationConfigured: true,
      dockerModelRunnerConnected: true,
      lastChecked: Date.now(),
      details: { modelsApiReachable: true, modelsCount: 2 },
    });
    const legacyCleanup = vi.fn().mockResolvedValue(undefined);
    const openAICleanup = vi.fn().mockResolvedValue(undefined);

    (svc as any).provisionerRegistry = {
      resolve: vi.fn().mockReturnValue({
        verifyIntegration,
        setupIntegration,
        getServiceStatus: verifyIntegration,
      }),
      resetAllConnectivityCaches: vi.fn(),
    };
    (svc as any).legacyProvisioner = { cleanupInactiveArtifacts: legacyCleanup };
    (svc as any).openAIProvisioner = { cleanupInactiveArtifacts: openAICleanup };

    const result = await svc.verifyDockerModelRunnerIntegration();
    expect(result.integrationConfigured).toBe(true);
    expect(verifyIntegration).toHaveBeenCalledTimes(1);
    expect(setupIntegration).not.toHaveBeenCalled();
    expect(legacyCleanup).not.toHaveBeenCalled();
    expect(openAICleanup).not.toHaveBeenCalled();
  });

  it('maps provisioner status into ServiceStatus', async () => {
    const tokenStore = new AuthTokenStore(createInMemoryStorageAdapter());
    const svc = new OpenWebUIApiService(
      { image: 'img:tag', port: '8090', autoStart: true, provisioner: 'openai' },
      undefined,
      { authTokenStore: tokenStore },
    );

    const setupIntegration = vi.fn().mockResolvedValue({
      mode: 'openai',
      containerRunning: true,
      integrationConfigured: true,
      dockerModelRunnerConnected: true,
      lastChecked: Date.now(),
      details: { modelsApiReachable: true, modelsCount: 3 },
    });
    const verifyIntegration = vi.fn().mockResolvedValue({
      mode: 'openai',
      containerRunning: true,
      integrationConfigured: false,
      dockerModelRunnerConnected: false,
      lastChecked: Date.now(),
      details: { modelsApiReachable: false, modelsCount: 0 },
    });

    (svc as any).provisionerRegistry = {
      resolve: vi.fn().mockReturnValue({
        setupIntegration,
        verifyIntegration,
        getServiceStatus: verifyIntegration,
      }),
      resetAllConnectivityCaches: vi.fn(),
    };
    (svc as any).legacyProvisioner = {
      cleanupInactiveArtifacts: vi.fn().mockResolvedValue(undefined),
    };
    (svc as any).openAIProvisioner = {
      cleanupInactiveArtifacts: vi.fn().mockResolvedValue(undefined),
    };

    const setupStatus = await svc.setupDockerModelRunnerIntegration();
    expect(setupStatus.provisionerMode).toBe('openai');
    expect(setupStatus.integrationConfigured).toBe(true);
    expect(setupStatus.functionInstalled).toBe(true);
    expect(setupStatus.functionEnabled).toBe(true);
    expect(setupStatus.details?.modelsCount).toBe(3);

    const status = await svc.getServiceStatus();
    expect(status.provisionerMode).toBe('openai');
    expect(status.integrationConfigured).toBe(false);
    expect(status.functionInstalled).toBe(false);
    expect(status.functionEnabled).toBe(false);
    expect(verifyIntegration).toHaveBeenCalledTimes(1);
  });

  it('cleans up legacy artifacts when openai provisioner is active', async () => {
    const tokenStore = new AuthTokenStore(createInMemoryStorageAdapter());
    const svc = new OpenWebUIApiService(
      { image: 'img:tag', port: '8090', autoStart: true, provisioner: 'openai' },
      undefined,
      { authTokenStore: tokenStore },
    );

    const setupIntegration = vi.fn().mockResolvedValue({
      mode: 'openai',
      containerRunning: true,
      integrationConfigured: true,
      dockerModelRunnerConnected: true,
      lastChecked: Date.now(),
      details: {},
    });
    const legacyCleanup = vi.fn().mockResolvedValue(undefined);
    const openAICleanup = vi.fn().mockResolvedValue(undefined);

    (svc as any).provisionerRegistry = {
      resolve: vi.fn().mockReturnValue({
        setupIntegration,
        verifyIntegration: vi.fn(),
        getServiceStatus: vi.fn(),
      }),
      resetAllConnectivityCaches: vi.fn(),
    };
    (svc as any).legacyProvisioner = {
      cleanupInactiveArtifacts: legacyCleanup,
    };
    (svc as any).openAIProvisioner = {
      cleanupInactiveArtifacts: openAICleanup,
    };

    await svc.setupDockerModelRunnerIntegration();

    expect(legacyCleanup).toHaveBeenCalledTimes(1);
    expect(openAICleanup).not.toHaveBeenCalled();
  });

  it('cleans up openai artifacts when legacy provisioner is active', async () => {
    const tokenStore = new AuthTokenStore(createInMemoryStorageAdapter());
    const svc = new OpenWebUIApiService(
      { image: 'img:tag', port: '8090', autoStart: true, provisioner: 'legacy-function' },
      undefined,
      { authTokenStore: tokenStore },
    );

    const setupIntegration = vi.fn().mockResolvedValue({
      mode: 'legacy-function',
      containerRunning: true,
      integrationConfigured: true,
      dockerModelRunnerConnected: true,
      lastChecked: Date.now(),
      details: { functionInstalled: true, functionEnabled: true },
    });
    const legacyCleanup = vi.fn().mockResolvedValue(undefined);
    const openAICleanup = vi.fn().mockResolvedValue(undefined);

    (svc as any).provisionerRegistry = {
      resolve: vi.fn().mockReturnValue({
        setupIntegration,
        verifyIntegration: vi.fn(),
        getServiceStatus: vi.fn(),
      }),
      resetAllConnectivityCaches: vi.fn(),
    };
    (svc as any).legacyProvisioner = {
      cleanupInactiveArtifacts: legacyCleanup,
    };
    (svc as any).openAIProvisioner = {
      cleanupInactiveArtifacts: openAICleanup,
    };

    await svc.setupDockerModelRunnerIntegration();

    expect(openAICleanup).toHaveBeenCalledTimes(1);
    expect(legacyCleanup).not.toHaveBeenCalled();
  });

  it('skips cleanup when setup returns integrationConfigured=false', async () => {
    const tokenStore = new AuthTokenStore(createInMemoryStorageAdapter());
    const svc = new OpenWebUIApiService(
      { image: 'img:tag', port: '8090', autoStart: true, provisioner: 'openai' },
      undefined,
      { authTokenStore: tokenStore },
    );

    const setupIntegration = vi.fn().mockResolvedValue({
      mode: 'openai',
      containerRunning: true,
      integrationConfigured: false,
      dockerModelRunnerConnected: false,
      lastChecked: Date.now(),
      details: { modelsApiReachable: false, openAIProviderConfigured: false },
    });
    const legacyCleanup = vi.fn().mockResolvedValue(undefined);
    const openAICleanup = vi.fn().mockResolvedValue(undefined);

    (svc as any).provisionerRegistry = {
      resolve: vi.fn().mockReturnValue({
        setupIntegration,
        verifyIntegration: vi.fn(),
        getServiceStatus: vi.fn(),
      }),
      resetAllConnectivityCaches: vi.fn(),
    };
    (svc as any).legacyProvisioner = {
      cleanupInactiveArtifacts: legacyCleanup,
    };
    (svc as any).openAIProvisioner = {
      cleanupInactiveArtifacts: openAICleanup,
    };

    const result = await svc.setupDockerModelRunnerIntegration();

    expect(result.integrationConfigured).toBe(false);
    expect(legacyCleanup).not.toHaveBeenCalled();
    expect(openAICleanup).not.toHaveBeenCalled();
  });

  it('skips cleanup when legacy provisioner setup returns integrationConfigured=false', async () => {
    const tokenStore = new AuthTokenStore(createInMemoryStorageAdapter());
    const svc = new OpenWebUIApiService(
      { image: 'img:tag', port: '8090', autoStart: true, provisioner: 'legacy-function' },
      undefined,
      { authTokenStore: tokenStore },
    );

    const setupIntegration = vi.fn().mockResolvedValue({
      mode: 'legacy-function',
      containerRunning: true,
      integrationConfigured: false,
      dockerModelRunnerConnected: false,
      lastChecked: Date.now(),
      details: { functionInstalled: false, functionEnabled: false },
    });
    const legacyCleanup = vi.fn().mockResolvedValue(undefined);
    const openAICleanup = vi.fn().mockResolvedValue(undefined);

    (svc as any).provisionerRegistry = {
      resolve: vi.fn().mockReturnValue({
        setupIntegration,
        verifyIntegration: vi.fn(),
        getServiceStatus: vi.fn(),
      }),
      resetAllConnectivityCaches: vi.fn(),
    };
    (svc as any).legacyProvisioner = {
      cleanupInactiveArtifacts: legacyCleanup,
    };
    (svc as any).openAIProvisioner = {
      cleanupInactiveArtifacts: openAICleanup,
    };

    const result = await svc.setupDockerModelRunnerIntegration();

    expect(result.integrationConfigured).toBe(false);
    expect(legacyCleanup).not.toHaveBeenCalled();
    expect(openAICleanup).not.toHaveBeenCalled();
  });
});
