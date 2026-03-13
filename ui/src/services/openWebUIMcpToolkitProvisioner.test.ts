import { beforeEach, describe, expect, it, vi } from 'vitest';

import { DOCKER_MCP_TOOLKIT_SERVER_ID } from '../constants';
import type { ExtensionConfig } from '../types';
import type { DockerMcpToolkitProbeResult } from './dockerMcpToolkitService';
import { OpenWebUIMcpToolkitProvisioner } from './openWebUIMcpToolkitProvisioner';
import type { OpenWebUIHttpClient } from './openWebUIHttpClient';

interface HttpRequestLike {
  url: string;
  method?: string;
  body?: string;
}

type HttpLike = Pick<
  OpenWebUIHttpClient,
  'isContainerHealthy' | 'waitUntilOpenWebUIReady' | 'request' | 'containerCurl' | 'getApiBaseUrl'
>;

const baseConfig: ExtensionConfig = {
  image: 'ghcr.io/open-webui/open-webui:main',
  port: '8090',
  autoStart: true,
  provisioner: 'openai',
  enableDockerMcpToolkit: true,
};

const probeResult: DockerMcpToolkitProbeResult = {
  supported: true,
  profileAvailable: true,
  profileId: 'default',
  gatewayUrl: 'http://host.docker.internal:8812/mcp',
  gatewayHealthUrl: 'http://host.docker.internal:8812/health',
  authType: 'none',
  probeSource: 'deterministic',
};

describe('OpenWebUIMcpToolkitProvisioner', () => {
  let toolServers: Array<Record<string, unknown>>;
  let httpMock: HttpLike;
  let toolkitServiceMock: {
    probe: ReturnType<typeof vi.fn>;
    clearCache: ReturnType<typeof vi.fn>;
    removeManagedGatewayContainer: ReturnType<typeof vi.fn>;
    ensureGatewayContainerRunning: ReturnType<typeof vi.fn>;
  };
  let requestCalls: HttpRequestLike[];

  beforeEach(() => {
    toolServers = [];
    requestCalls = [];

    httpMock = {
      isContainerHealthy: vi.fn(async () => true),
      waitUntilOpenWebUIReady: vi.fn(async () => true),
      getApiBaseUrl: vi.fn(() => 'http://localhost:8090/api/v1'),
      containerCurl: vi.fn(async () => 'ok'),
      request: vi.fn(async (request: HttpRequestLike) => {
        requestCalls.push(request);
        const method = (request.method ?? 'GET').toUpperCase();
        const path = request.url;

        if (path.endsWith('/configs/tool_servers') && method === 'GET') {
          return JSON.stringify({ TOOL_SERVER_CONNECTIONS: toolServers });
        }

        if (path.endsWith('/configs/tool_servers/verify') && method === 'POST') {
          return JSON.stringify({ ok: true });
        }

        if (path.endsWith('/configs/tool_servers') && method === 'POST') {
          const parsed = JSON.parse(request.body ?? '{}') as {
            TOOL_SERVER_CONNECTIONS?: Array<Record<string, unknown>>;
          };
          toolServers = Array.isArray(parsed.TOOL_SERVER_CONNECTIONS)
            ? parsed.TOOL_SERVER_CONNECTIONS
            : [];
          return JSON.stringify({ TOOL_SERVER_CONNECTIONS: toolServers });
        }

        throw new Error(`Unexpected request: ${method} ${path}`);
      }),
    };

    toolkitServiceMock = {
      probe: vi.fn(async () => probeResult),
      clearCache: vi.fn(),
      removeManagedGatewayContainer: vi.fn(async () => undefined),
      ensureGatewayContainerRunning: vi.fn(async () => ({ launched: false, running: true })),
    };
  });

  it('provisions managed MCP tool server when enabled', async () => {
    const provisioner = new OpenWebUIMcpToolkitProvisioner({
      http: httpMock as OpenWebUIHttpClient,
      config: baseConfig,
      toolkitService: toolkitServiceMock as any,
    });

    const status = await provisioner.setupIntegration();

    expect(status.integrationConfigured).toBe(true);
    expect(status.openWebUIToolServerConfigured).toBe(true);
    expect(status.enabled).toBe(true);
    expect(toolServers).toHaveLength(1);
    expect(toolServers[0]?.type).toBe('mcp');
    expect((toolServers[0]?.info as Record<string, unknown>)?.id).toBe(DOCKER_MCP_TOOLKIT_SERVER_ID);
    expect(toolServers[0]?.auth_type).toBe('none');
    expect((toolServers[0] as Record<string, unknown>)?.key).toBeNull();
    expect((toolServers[0]?.config as Record<string, unknown>)?.function_name_filter_list).toBe(',');
    const accessGrants = (
      (toolServers[0]?.config as Record<string, unknown>)?.access_grants as
        | Array<Record<string, unknown>>
        | undefined
    ) ?? [];
    expect(
      accessGrants.some(
        (grant) =>
          grant.principal_type === 'user' &&
          grant.principal_id === '*' &&
          grant.permission === 'read',
      ),
    ).toBe(true);
    expect(
      accessGrants.some(
        (grant) =>
          grant.principal_type === 'user' &&
          grant.principal_id === '*' &&
          grant.permission === 'write',
      ),
    ).toBe(true);

    const persistCalls = requestCalls.filter(
      (call) => call.url.endsWith('/configs/tool_servers') && (call.method ?? 'GET') === 'POST',
    );
    expect(persistCalls).toHaveLength(1);
  });

  it('removes managed MCP tool server when feature is disabled', async () => {
    toolServers = [
      {
        type: 'mcp',
        url: probeResult.gatewayUrl,
        auth_type: 'none',
        config: { enable: true, access_grants: [] },
        info: { id: DOCKER_MCP_TOOLKIT_SERVER_ID, name: 'Docker MCP Toolkit' },
      },
      {
        type: 'openapi',
        url: 'http://example.com/openapi.json',
        auth_type: 'none',
        info: { id: 'unmanaged' },
      },
    ];

    const provisioner = new OpenWebUIMcpToolkitProvisioner({
      http: httpMock as OpenWebUIHttpClient,
      config: { ...baseConfig, enableDockerMcpToolkit: false },
      toolkitService: toolkitServiceMock as any,
    });

    const status = await provisioner.setupIntegration();

    expect(status.enabled).toBe(false);
    expect(status.integrationConfigured).toBe(true);
    expect(toolServers).toHaveLength(1);
    expect((toolServers[0]?.info as Record<string, unknown>)?.id).toBe('unmanaged');
    expect(toolkitServiceMock.removeManagedGatewayContainer).toHaveBeenCalled();
  });

  it('keeps tool server config idempotent when already configured', async () => {
    toolServers = [
      {
        type: 'mcp',
        url: probeResult.gatewayUrl,
        path: '/mcp',
        auth_type: 'none',
        headers: {},
        key: '',
        config: {
          enable: true,
          function_name_filter_list: ',',
          access_grants: [
            { principal_type: 'user', principal_id: '*', permission: 'read' },
            { principal_type: 'user', principal_id: '*', permission: 'write' },
          ],
        },
        info: { id: DOCKER_MCP_TOOLKIT_SERVER_ID, name: 'Docker MCP Toolkit' },
      },
    ];

    const provisioner = new OpenWebUIMcpToolkitProvisioner({
      http: httpMock as OpenWebUIHttpClient,
      config: baseConfig,
      toolkitService: toolkitServiceMock as any,
    });

    const status = await provisioner.setupIntegration();

    expect(status.integrationConfigured).toBe(true);

    const persistCalls = requestCalls.filter(
      (call) => call.url.endsWith('/configs/tool_servers') && (call.method ?? 'GET') === 'POST',
    );
    expect(persistCalls).toHaveLength(0);
  });

  it('adopts legacy Docker MCP entry and normalizes auth/filter config', async () => {
    toolServers = [
      {
        type: 'mcp',
        url: probeResult.gatewayUrl,
        path: 'openapi.json',
        auth_type: 'bearer',
        headers: null,
        key: '',
        config: {
          enable: true,
          function_name_filter_list: '',
          access_grants: [{ principal_type: 'user', principal_id: '*', permission: 'read' }],
        },
        info: { id: 'DOCKER', name: 'Docker MCP' },
      },
    ];

    const provisioner = new OpenWebUIMcpToolkitProvisioner({
      http: httpMock as OpenWebUIHttpClient,
      config: baseConfig,
      toolkitService: toolkitServiceMock as any,
    });

    const status = await provisioner.setupIntegration();
    expect(status.integrationConfigured).toBe(true);
    expect(toolServers).toHaveLength(1);
    expect((toolServers[0]?.info as Record<string, unknown>)?.id).toBe(DOCKER_MCP_TOOLKIT_SERVER_ID);
    expect(toolServers[0]?.auth_type).toBe('none');
    expect((toolServers[0] as Record<string, unknown>)?.key).toBeNull();
    expect((toolServers[0]?.config as Record<string, unknown>)?.function_name_filter_list).toBe(',');
    const accessGrants = (
      (toolServers[0]?.config as Record<string, unknown>)?.access_grants as
        | Array<Record<string, unknown>>
        | undefined
    ) ?? [];
    expect(
      accessGrants.some(
        (grant) =>
          grant.principal_type === 'user' &&
          grant.principal_id === '*' &&
          grant.permission === 'read',
      ),
    ).toBe(true);
    expect(
      accessGrants.some(
        (grant) =>
          grant.principal_type === 'user' &&
          grant.principal_id === '*' &&
          grant.permission === 'write',
      ),
    ).toBe(true);
  });

  it('repairs managed server when access grants are missing', async () => {
    toolServers = [
      {
        type: 'mcp',
        url: probeResult.gatewayUrl,
        path: '/mcp',
        auth_type: 'none',
        headers: {},
        key: '',
        config: { enable: true, access_grants: [] },
        info: { id: DOCKER_MCP_TOOLKIT_SERVER_ID, name: 'Docker MCP Toolkit' },
      },
    ];

    const provisioner = new OpenWebUIMcpToolkitProvisioner({
      http: httpMock as OpenWebUIHttpClient,
      config: baseConfig,
      toolkitService: toolkitServiceMock as any,
    });

    const status = await provisioner.setupIntegration();
    expect(status.integrationConfigured).toBe(true);

    const persistCalls = requestCalls.filter(
      (call) => call.url.endsWith('/configs/tool_servers') && (call.method ?? 'GET') === 'POST',
    );
    expect(persistCalls).toHaveLength(1);

    const accessGrants = (
      (toolServers[0]?.config as Record<string, unknown>)?.access_grants as
        | Array<Record<string, unknown>>
        | undefined
    ) ?? [];
    expect(
      accessGrants.some(
        (grant) =>
          grant.principal_type === 'user' &&
          grant.principal_id === '*' &&
          grant.permission === 'read',
      ),
    ).toBe(true);
    expect(
      accessGrants.some(
        (grant) =>
          grant.principal_type === 'user' &&
          grant.principal_id === '*' &&
          grant.permission === 'write',
      ),
    ).toBe(true);
  });

  it('continues setup when health endpoint fails but verify succeeds', async () => {
    httpMock.containerCurl = vi
      .fn()
      // health endpoint may fail on some gateway versions
      .mockRejectedValueOnce({ stderr: 'HTTP 404' })
      // direct mcp endpoint probe succeeds without fail-on-status
      .mockResolvedValueOnce('not found');

    const provisioner = new OpenWebUIMcpToolkitProvisioner({
      http: httpMock as OpenWebUIHttpClient,
      config: baseConfig,
      toolkitService: toolkitServiceMock as any,
    });

    const status = await provisioner.setupIntegration();
    expect(status.integrationConfigured).toBe(true);
    expect(status.gatewayReachable).toBe(true);
    expect(status.openWebUIToolServerConfigured).toBe(true);
  });

  it('returns gateway-unreachable when gateway container cannot start', async () => {
    httpMock.containerCurl = vi.fn(async () => {
      throw new Error('connection refused');
    });
    const requestBase = httpMock.request;
    httpMock.request = vi.fn(async (request: HttpRequestLike) => {
      if (request.url.endsWith('/configs/tool_servers/verify')) {
        throw new Error('verify failed');
      }
      return requestBase(request as any);
    });
    toolkitServiceMock.ensureGatewayContainerRunning = vi.fn(async () => ({
      launched: false,
      running: false,
      diagnostics: 'gateway start failed',
    }));

    const provisioner = new OpenWebUIMcpToolkitProvisioner({
      http: httpMock as OpenWebUIHttpClient,
      config: baseConfig,
      toolkitService: toolkitServiceMock as any,
    });

    const status = await provisioner.setupIntegration();
    expect(status.integrationConfigured).toBe(false);
    expect(status.details?.unsupportedReason).toBe('gateway-unreachable');
    expect(status.details?.openWebUIVerifyError).toContain('verify failed');
  });
});

