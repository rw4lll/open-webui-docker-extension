import {
  DOCKER_MCP_TOOLKIT_GATEWAY_PATH,
  DOCKER_MCP_TOOLKIT_SERVER_ID,
  DOCKER_MCP_TOOLKIT_SERVER_NAME,
} from '../constants';
import { log } from '../logger';
import type { DockerMcpToolkitStatus, ExtensionConfig } from '../types';
import { toErrorMessage } from '../utils/dockerCliError';
import {
  DockerMcpToolkitService,
  type DockerMcpToolkitProbeResult,
} from './dockerMcpToolkitService';
import type { OpenWebUIHttpClient } from './openWebUIHttpClient';

interface OpenWebUIMcpToolkitProvisionerOptions {
  http: OpenWebUIHttpClient;
  config: ExtensionConfig;
  toolkitService?: DockerMcpToolkitService;
}

interface ToolServerConnection {
  type?: string;
  url?: string;
  path?: string;
  auth_type?: string;
  headers?: Record<string, string> | string | null;
  key?: string | null;
  config?: Record<string, unknown>;
  info?: Record<string, unknown>;
  [key: string]: unknown;
}

interface ToolServersConfigPayload {
  TOOL_SERVER_CONNECTIONS: ToolServerConnection[];
}

interface AccessGrant {
  principal_type: 'user' | 'group';
  principal_id: string;
  permission: 'read' | 'write';
}

const MANAGED_ACCESS_GRANTS_DEFAULT: AccessGrant[] = [
  {
    principal_type: 'user',
    principal_id: '*',
    permission: 'read',
  },
  {
    principal_type: 'user',
    principal_id: '*',
    permission: 'write',
  },
];

const MANAGED_LEGACY_SERVER_IDS = new Set(['DOCKER', 'docker']);
const FUNCTION_NAME_FILTER_LIST_WORKAROUND = ',';

export class OpenWebUIMcpToolkitProvisioner {
  private config: ExtensionConfig;
  private readonly http: OpenWebUIHttpClient;
  private readonly toolkitService: DockerMcpToolkitService;

  constructor(options: OpenWebUIMcpToolkitProvisionerOptions) {
    this.config = options.config;
    this.http = options.http;
    this.toolkitService = options.toolkitService ?? new DockerMcpToolkitService();
  }

  updateConfig(config: ExtensionConfig): void {
    this.config = config;
  }

  clearCaches(): void {
    this.toolkitService.clearCache();
  }

  async removeManagedGatewayContainer(): Promise<void> {
    await this.toolkitService.removeManagedGatewayContainer();
  }

  async verifyIntegration(): Promise<DockerMcpToolkitStatus> {
    const status = this.createBaseStatus();

    try {
      status.containerRunning = await this.http.isContainerHealthy();
      if (!status.containerRunning) {
        status.message = 'Open WebUI container is not running.';
        return status;
      }

      const probe = await this.toolkitService.probe();
      this.applyProbe(status, probe);

      const toolServers = await this.fetchToolServerConnections();
      const managedConnection = this.findManagedConnection(toolServers, probe.gatewayUrl);
      status.openWebUIToolServerConfigured = managedConnection
        ? this.matchesManagedConnection(managedConnection, probe.gatewayUrl)
        : false;

      if (!status.enabled) {
        await this.toolkitService.removeManagedGatewayContainer();
        status.integrationConfigured = !status.openWebUIToolServerConfigured;
        status.message = status.openWebUIToolServerConfigured
          ? 'Docker MCP Toolkit integration is disabled but still provisioned.'
          : 'Docker MCP Toolkit integration is disabled.';
        return status;
      }

      if (!status.supported) {
        status.integrationConfigured = false;
        status.message = this.unsupportedMessage(status);
        return status;
      }

      status.gatewayReachable = await this.checkGatewayReachable(
        probe.gatewayHealthUrl,
        probe.gatewayUrl,
      );
      status.integrationConfigured = status.gatewayReachable && status.openWebUIToolServerConfigured;
      status.message = status.integrationConfigured
        ? 'Docker MCP Toolkit integration is configured.'
        : this.unreadyMessage(status);

      return status;
    } catch (error) {
      status.integrationConfigured = false;
      status.message = `Failed to verify Docker MCP Toolkit integration: ${toErrorMessage(error)}`;
      status.details = {
        ...(status.details ?? {}),
        diagnostics: status.message,
      };
      return status;
    }
  }

  async setupIntegration(): Promise<DockerMcpToolkitStatus> {
    const status = this.createBaseStatus();

    try {
      status.containerRunning = await this.http.waitUntilOpenWebUIReady({
        timeoutMs: 15 * 60 * 1000,
      });
      if (!status.containerRunning) {
        status.message = 'Open WebUI did not become ready in time.';
        return status;
      }

      const probe = await this.toolkitService.probe({ force: true });
      this.applyProbe(status, probe);

      const existingConnections = await this.fetchToolServerConnections();
      const existingManaged = existingConnections.filter((connection) =>
        this.isManagedConnection(connection, probe.gatewayUrl),
      );

      if (!status.enabled) {
        if (existingManaged.length > 0) {
          const filtered = existingConnections.filter(
            (connection) => !this.isManagedConnection(connection, probe.gatewayUrl),
          );
          await this.persistToolServerConnections(filtered);
          log.info('Removed Docker MCP Toolkit tool server from Open WebUI config');
        }
        await this.toolkitService.removeManagedGatewayContainer();
        return this.verifyIntegration();
      }

      if (!status.supported) {
        status.integrationConfigured = false;
        status.message = this.unsupportedMessage(status);
        log.warn('Docker MCP Toolkit setup skipped:', status.message, status.details);
        return status;
      }

      status.gatewayReachable = await this.checkGatewayReachable(
        probe.gatewayHealthUrl,
        probe.gatewayUrl,
      );
      if (!status.gatewayReachable) {
        log.warn(
          'Docker MCP Toolkit gateway health probe failed, continuing with Open WebUI verify',
          {
            gatewayHealthUrl: probe.gatewayHealthUrl,
            gatewayUrl: probe.gatewayUrl,
            profileId: probe.profileId,
          },
        );
      }

      const desiredConnection = this.createDesiredConnection(probe, existingManaged[0]);

      try {
        await this.verifyToolServerConnection(desiredConnection);
        status.gatewayReachable = true;
      } catch (error) {
        const verifyError = toErrorMessage(error);
        status.integrationConfigured = false;
        status.message = `Open WebUI cannot verify Docker MCP Toolkit server: ${verifyError}`;
        status.details = {
          ...(status.details ?? {}),
          unsupportedReason: status.gatewayReachable ? 'openwebui-unsupported' : 'gateway-unreachable',
          openWebUIVerifyError: verifyError,
        };
        log.warn(status.message, status.details);
        return status;
      }

      const remaining = existingConnections.filter(
        (connection) => !this.isManagedConnection(connection, probe.gatewayUrl),
      );
      const nextConnections = [...remaining, desiredConnection];
      const shouldPersist =
        existingManaged.length !== 1 || !this.matchesManagedConnection(existingManaged[0], probe.gatewayUrl);

      if (shouldPersist) {
        await this.persistToolServerConnections(nextConnections);
        log.info('Provisioned Docker MCP Toolkit server in Open WebUI', {
          gatewayUrl: probe.gatewayUrl,
          profileId: probe.profileId,
        });
      }

      return this.verifyIntegration();
    } catch (error) {
      status.integrationConfigured = false;
      status.message = `Failed to set up Docker MCP Toolkit integration: ${toErrorMessage(error)}`;
      status.details = {
        ...(status.details ?? {}),
        diagnostics: status.message,
      };
      return status;
    }
  }

  private createBaseStatus(): DockerMcpToolkitStatus {
    return {
      enabled: this.config.enableDockerMcpToolkit,
      containerRunning: false,
      supported: false,
      profileAvailable: false,
      gatewayReachable: false,
      openWebUIToolServerConfigured: false,
      integrationConfigured: false,
      lastChecked: Date.now(),
      details: {},
    };
  }

  private applyProbe(status: DockerMcpToolkitStatus, probe: DockerMcpToolkitProbeResult): void {
    status.supported = probe.supported;
    status.profileAvailable = probe.profileAvailable;
    status.gatewayUrl = probe.gatewayUrl;
    status.details = {
      ...(status.details ?? {}),
      profileId: probe.profileId,
      probeSource: probe.probeSource,
      unsupportedReason: probe.unsupportedReason,
      diagnostics: probe.diagnostics,
    };
  }

  private async fetchToolServerConnections(): Promise<ToolServerConnection[]> {
    const responseText = await this.http.request({
      url: `${this.http.getApiBaseUrl()}/configs/tool_servers`,
      method: 'GET',
      headers: { 'Content-Type': 'application/json' },
      includeAuth: true,
      timeoutMs: 10_000,
      maxRetries: 2,
    });

    const parsed = JSON.parse(responseText) as Partial<ToolServersConfigPayload>;
    if (!parsed || !Array.isArray(parsed.TOOL_SERVER_CONNECTIONS)) {
      return [];
    }

    return parsed.TOOL_SERVER_CONNECTIONS.filter(
      (entry): entry is ToolServerConnection =>
        Boolean(entry) && typeof entry === 'object' && !Array.isArray(entry),
    );
  }

  private async persistToolServerConnections(connections: ToolServerConnection[]): Promise<void> {
    const payload: ToolServersConfigPayload = {
      TOOL_SERVER_CONNECTIONS: connections,
    };
    await this.http.request({
      url: `${this.http.getApiBaseUrl()}/configs/tool_servers`,
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
      includeAuth: true,
      timeoutMs: 15_000,
      maxRetries: 2,
    });
  }

  private async verifyToolServerConnection(connection: ToolServerConnection): Promise<void> {
    await this.http.request({
      url: `${this.http.getApiBaseUrl()}/configs/tool_servers/verify`,
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(connection),
      includeAuth: true,
      timeoutMs: 20_000,
      maxRetries: 1,
    });
  }

  private findManagedConnection(
    connections: ToolServerConnection[],
    gatewayUrl: string,
  ): ToolServerConnection | null {
    return connections.find((connection) => this.isManagedConnection(connection, gatewayUrl)) ?? null;
  }

  private isManagedConnection(connection: ToolServerConnection, gatewayUrl: string): boolean {
    if ((connection.type ?? 'openapi') !== 'mcp') {
      return false;
    }

    if (this.isCanonicalManagedConnection(connection)) {
      return true;
    }

    return this.isLegacyManagedConnection(connection, gatewayUrl);
  }

  private isCanonicalManagedConnection(connection: ToolServerConnection): boolean {
    const info = connection.info;
    if (!info || typeof info !== 'object') {
      return false;
    }

    return info['id'] === DOCKER_MCP_TOOLKIT_SERVER_ID;
  }

  private isLegacyManagedConnection(connection: ToolServerConnection, gatewayUrl: string): boolean {
    const info = connection.info;
    const id = info && typeof info === 'object' ? info['id'] : undefined;
    const name = info && typeof info === 'object' ? info['name'] : undefined;
    const isKnownLegacyId = typeof id === 'string' && MANAGED_LEGACY_SERVER_IDS.has(id);
    const isKnownLegacyName =
      typeof name === 'string' && /docker\s+mcp(\s+toolkit)?/i.test(name.trim());

    if (!isKnownLegacyId && !isKnownLegacyName) {
      return false;
    }

    return this.matchesGatewayTarget(connection.url, gatewayUrl);
  }

  private matchesManagedConnection(connection: ToolServerConnection, gatewayUrl: string): boolean {
    if (!this.isManagedConnection(connection, gatewayUrl)) {
      return false;
    }
    if (!this.matchesGatewayTarget(connection.url, gatewayUrl)) {
      return false;
    }
    if ((connection.auth_type ?? 'none') !== 'none') {
      return false;
    }
    const cfg = connection.config ?? {};
    if (cfg['enable'] !== true) {
      return false;
    }
    if (!this.hasRequiredAccessGrants(cfg['access_grants'])) {
      return false;
    }
    return this.hasRequiredFunctionNameFilterList(cfg['function_name_filter_list']);
  }

  private createDesiredConnection(
    probe: DockerMcpToolkitProbeResult,
    existing: ToolServerConnection | undefined,
  ): ToolServerConnection {
    const existingConfig = existing?.config && typeof existing.config === 'object' ? existing.config : {};
    const accessGrants = this.resolveManagedAccessGrants(existingConfig['access_grants']);
    const functionNameFilterList = this.resolveFunctionNameFilterList(
      existingConfig['function_name_filter_list'],
    );

    return {
      type: 'mcp',
      url: probe.gatewayUrl,
      path: DOCKER_MCP_TOOLKIT_GATEWAY_PATH,
      auth_type: 'none',
      headers: {},
      key: null,
      config: {
        ...existingConfig,
        enable: true,
        function_name_filter_list: functionNameFilterList,
        access_grants: accessGrants,
      },
      info: {
        ...(existing?.info ?? {}),
        id: DOCKER_MCP_TOOLKIT_SERVER_ID,
        name: DOCKER_MCP_TOOLKIT_SERVER_NAME,
        description: 'Docker Desktop MCP Toolkit gateway connection',
      },
    };
  }

  private resolveManagedAccessGrants(raw: unknown): AccessGrant[] {
    const normalized = this.normalizeAccessGrants(raw);
    if (normalized.length === 0) {
      return MANAGED_ACCESS_GRANTS_DEFAULT.map((grant) => ({ ...grant }));
    }

    const next = [...normalized];
    if (!this.hasGrant(next, 'read')) {
      next.push({ principal_type: 'user', principal_id: '*', permission: 'read' });
    }
    if (!this.hasGrant(next, 'write')) {
      next.push({ principal_type: 'user', principal_id: '*', permission: 'write' });
    }
    return next;
  }

  private hasRequiredAccessGrants(raw: unknown): boolean {
    const grants = this.normalizeAccessGrants(raw);
    return this.hasGrant(grants, 'read') && this.hasGrant(grants, 'write');
  }

  private resolveFunctionNameFilterList(raw: unknown): string {
    if (typeof raw !== 'string') {
      return FUNCTION_NAME_FILTER_LIST_WORKAROUND;
    }
    const trimmed = raw.trim();
    return trimmed.length > 0 ? trimmed : FUNCTION_NAME_FILTER_LIST_WORKAROUND;
  }

  private hasRequiredFunctionNameFilterList(raw: unknown): boolean {
    return typeof raw === 'string' && raw.trim().length > 0;
  }

  private hasGrant(grants: AccessGrant[], permission: 'read' | 'write'): boolean {
    return grants.some(
      (grant) =>
        grant.permission === permission &&
        grant.principal_type === 'user' &&
        grant.principal_id === '*',
    );
  }

  private normalizeAccessGrants(raw: unknown): AccessGrant[] {
    if (!Array.isArray(raw)) {
      return [];
    }
    return raw
      .filter((grant): grant is Record<string, unknown> => Boolean(grant) && typeof grant === 'object')
      .map((grant) => ({
        principal_type:
          grant['principal_type'] === 'group'
            ? 'group'
            : grant['principal_type'] === 'user'
              ? 'user'
              : null,
        principal_id: typeof grant['principal_id'] === 'string' ? grant['principal_id'] : null,
        permission:
          grant['permission'] === 'write'
            ? 'write'
            : grant['permission'] === 'read'
              ? 'read'
              : null,
      }))
      .filter(
        (
          grant,
        ): grant is { principal_type: 'user' | 'group'; principal_id: string; permission: 'read' | 'write' } =>
          Boolean(grant.principal_type && grant.principal_id && grant.permission),
      );
  }

  private matchesGatewayTarget(candidate: unknown, gatewayUrl: string): boolean {
    if (typeof candidate !== 'string') {
      return false;
    }

    const normalizedCandidate = candidate.trim();
    if (!normalizedCandidate) {
      return false;
    }

    if (normalizedCandidate === gatewayUrl) {
      return true;
    }

    try {
      const candidateUrl = new URL(normalizedCandidate);
      const expectedUrl = new URL(gatewayUrl);
      const candidatePort = candidateUrl.port || (candidateUrl.protocol === 'https:' ? '443' : '80');
      const expectedPort = expectedUrl.port || (expectedUrl.protocol === 'https:' ? '443' : '80');
      return (
        candidateUrl.protocol === expectedUrl.protocol &&
        candidateUrl.hostname === expectedUrl.hostname &&
        candidatePort === expectedPort &&
        candidateUrl.pathname.replace(/\/+$/, '') === expectedUrl.pathname.replace(/\/+$/, '')
      );
    } catch {
      return false;
    }
  }

  private async checkGatewayReachable(healthUrl: string, gatewayUrl?: string): Promise<boolean> {
    const probeOnce = async (): Promise<boolean> => {
      try {
        await this.http.containerCurl({
          url: healthUrl,
          method: 'GET',
          includeFailFlag: true,
          connectTimeoutSeconds: 3,
          maxTimeSeconds: 5,
          maxRetries: 1,
        });
        return true;
      } catch (error) {
        const diagnostics = toErrorMessage(error);
        log.debug('Docker MCP Toolkit gateway health probe failed', { healthUrl, diagnostics });

        if (!gatewayUrl) {
          return false;
        }

        try {
          // Fallback probe: do not require 2xx so versions without /health still pass
          // when the streamable MCP endpoint is reachable.
          await this.http.containerCurl({
            url: gatewayUrl,
            method: 'GET',
            includeFailFlag: false,
            connectTimeoutSeconds: 3,
            maxTimeSeconds: 5,
            maxRetries: 1,
          });
          return true;
        } catch (fallbackError) {
          log.debug('Docker MCP Toolkit gateway endpoint probe failed', {
            gatewayUrl,
            diagnostics: toErrorMessage(fallbackError),
          });
          return false;
        }
      }
    };

    if (await probeOnce()) {
      return true;
    }

    const launch = await this.toolkitService.ensureGatewayContainerRunning();
    if (!launch.running) {
      log.warn('Docker MCP Toolkit gateway container is not running', {
        diagnostics: launch.diagnostics,
      });
      return false;
    }

    const retries = launch.launched ? 5 : 2;
    for (let attempt = 0; attempt < retries; attempt += 1) {
      if (launch.launched || attempt > 0) {
        await new Promise((resolve) => setTimeout(resolve, 1_000));
      }
      if (await probeOnce()) {
        return true;
      }
    }
    return false;
  }

  private unsupportedMessage(status: DockerMcpToolkitStatus): string {
    const reason = status.details?.unsupportedReason;
    if (reason === 'docker-desktop-not-running') {
      return 'Docker Desktop is not running.';
    }
    if (reason === 'mcp-cli-unavailable') {
      return 'Docker MCP Toolkit CLI is unavailable.';
    }
    if (reason === 'toolkit-disabled') {
      return 'Docker MCP Toolkit appears to be disabled.';
    }
    if (reason === 'default-profile-missing') {
      return 'Docker MCP Toolkit default profile is missing.';
    }
    return 'Docker MCP Toolkit support is unavailable.';
  }

  private unreadyMessage(status: DockerMcpToolkitStatus): string {
    if (!status.openWebUIToolServerConfigured) {
      return 'Open WebUI does not have the Docker MCP Toolkit server configured.';
    }
    if (!status.gatewayReachable) {
      return 'Docker MCP Toolkit gateway is not reachable.';
    }
    return 'Docker MCP Toolkit integration is not ready.';
  }
}

