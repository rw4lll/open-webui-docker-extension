import {
  DOCKER_MCP_TOOLKIT_GATEWAY_CONTAINER_IMAGE,
  DOCKER_MCP_TOOLKIT_GATEWAY_CONTAINER_LABELS,
  DOCKER_MCP_TOOLKIT_GATEWAY_CONTAINER_NAME,
  DOCKER_MCP_TOOLKIT_GATEWAY_DEFAULT_SERVER,
  DOCKER_MCP_TOOLKIT_GATEWAY_HEALTH_PATH,
  DOCKER_MCP_TOOLKIT_GATEWAY_HOST,
  DOCKER_MCP_TOOLKIT_GATEWAY_PATH,
  DOCKER_MCP_TOOLKIT_GATEWAY_PORT,
  DOCKER_MCP_TOOLKIT_PROFILE_ID,
} from '../constants';
import { log } from '../logger';
import type {
  DockerListedContainer,
  DockerMcpToolkitProbeSource,
  DockerMcpToolkitUnsupportedReason,
} from '../types';
import { getStderr, toErrorMessage } from '../utils/dockerCliError';
import { getDDClient, type DockerDesktopClient } from './dockerDesktopClient';

const PROBE_CACHE_TTL_MS = 15_000;

interface DockerMcpGatewayContainerInfo {
  id: string;
  name: string;
  state: string;
  image: string;
  status: string;
  labels: Record<string, string>;
}

interface DockerMcpServerListEntry {
  name?: unknown;
}

export interface DockerMcpToolkitProbeResult {
  supported: boolean;
  profileAvailable: boolean;
  profileId: string;
  gatewayUrl: string;
  gatewayHealthUrl: string;
  authType: 'none';
  probeSource: DockerMcpToolkitProbeSource;
  manualInstructionsCommand?: string[];
  unsupportedReason?: DockerMcpToolkitUnsupportedReason;
  diagnostics?: string;
}

interface DockerMcpToolkitServiceOptions {
  dockerClientProvider?: () => DockerDesktopClient;
  profileId?: string;
}

export interface DockerMcpGatewayRuntimeStatus {
  launched: boolean;
  running: boolean;
  diagnostics?: string;
}

export class DockerMcpToolkitService {
  private readonly dockerClientProvider: () => DockerDesktopClient;
  private readonly profileId: string;
  private cachedProbe?: { value: DockerMcpToolkitProbeResult; checkedAt: number };

  constructor(options: DockerMcpToolkitServiceOptions = {}) {
    this.dockerClientProvider = options.dockerClientProvider ?? getDDClient;
    this.profileId = options.profileId ?? DOCKER_MCP_TOOLKIT_PROFILE_ID;
  }

  clearCache(): void {
    this.cachedProbe = undefined;
  }

  async removeManagedGatewayContainer(): Promise<void> {
    const container = await this.findGatewayContainer();
    if (!container) {
      return;
    }

    try {
      await this.dockerClientProvider().docker.cli.exec('rm', ['-f', container.id]);
    } catch (error) {
      const diagnostics = this.toDiagnostics(error);
      if (this.isContainerMissingError(diagnostics)) {
        return;
      }
      log.warn('Failed to remove managed Docker MCP gateway container', {
        containerId: container.id,
        diagnostics,
      });
    }
  }

  async ensureGatewayContainerRunning(
    options: { port?: number; forceRestart?: boolean } = {},
  ): Promise<DockerMcpGatewayRuntimeStatus> {
    const { port = DOCKER_MCP_TOOLKIT_GATEWAY_PORT, forceRestart = false } = options;
    if (forceRestart) {
      await this.removeManagedGatewayContainer();
    }

    const existing = await this.findGatewayContainer();
    if (existing && existing.state === 'running') {
      return { launched: false, running: true, diagnostics: existing.status };
    }

    const client = this.dockerClientProvider();

    if (existing) {
      try {
        await client.docker.cli.exec('start', [existing.id]);
        return { launched: true, running: true };
      } catch (error) {
        const diagnostics = this.toDiagnostics(error);
        log.warn('Failed to start managed Docker MCP gateway container; recreating', {
          containerId: existing.id,
          diagnostics,
        });
        try {
          await client.docker.cli.exec('rm', ['-f', existing.id]);
        } catch (removeError) {
          const removeDiagnostics = this.toDiagnostics(removeError);
          return {
            launched: false,
            running: false,
            diagnostics: `${diagnostics} | cleanup failed: ${removeDiagnostics}`,
          };
        }
      }
    }

    const serverNames = await this.resolveHostEnabledServerNames();

    try {
      await client.docker.cli.exec('run', this.buildGatewayContainerRunArgs(port, serverNames));
      log.info('Started managed Docker MCP gateway container', {
        containerName: DOCKER_MCP_TOOLKIT_GATEWAY_CONTAINER_NAME,
        image: DOCKER_MCP_TOOLKIT_GATEWAY_CONTAINER_IMAGE,
        port,
        servers: serverNames,
      });
      return { launched: true, running: true };
    } catch (error) {
      const diagnostics = this.toDiagnostics(error);
      if (this.isNameConflictError(diagnostics)) {
        try {
          await client.docker.cli.exec('rm', ['-f', DOCKER_MCP_TOOLKIT_GATEWAY_CONTAINER_NAME]);
          await client.docker.cli.exec('run', this.buildGatewayContainerRunArgs(port, serverNames));
          return { launched: true, running: true };
        } catch (retryError) {
          return {
            launched: false,
            running: false,
            diagnostics: `${diagnostics} | retry failed: ${this.toDiagnostics(retryError)}`,
          };
        }
      }
      return {
        launched: false,
        running: false,
        diagnostics,
      };
    }
  }

  async probe(options: { force?: boolean } = {}): Promise<DockerMcpToolkitProbeResult> {
    if (!options.force && this.cachedProbe) {
      const ageMs = Date.now() - this.cachedProbe.checkedAt;
      if (ageMs < PROBE_CACHE_TTL_MS) {
        return this.cloneProbeResult(this.cachedProbe.value);
      }
    }

    const { gatewayUrl, gatewayHealthUrl } = this.buildDeterministicGatewayUrls();
    const result: DockerMcpToolkitProbeResult = {
      supported: false,
      profileAvailable: false,
      profileId: this.profileId,
      gatewayUrl,
      gatewayHealthUrl,
      authType: 'none',
      probeSource: 'deterministic',
    };

    try {
      await this.execMcpCommand(['version']);
      result.supported = true;
    } catch (error) {
      const diagnostics = this.toDiagnostics(error);
      result.unsupportedReason = this.classifyUnsupportedReason(diagnostics);
      result.diagnostics = diagnostics;
      this.setCachedProbe(result);
      return this.cloneProbeResult(result);
    }

    const profileProbe = await this.probeProfileAvailability();
    if (!profileProbe.available) {
      const diagnostics = profileProbe.diagnostics ?? '';
      result.profileAvailable = false;
      result.diagnostics = diagnostics || undefined;

      if (this.isProfileMissingError(diagnostics)) {
        result.supported = true;
        result.unsupportedReason = 'default-profile-missing';
      } else {
        const unsupportedReason = this.classifyUnsupportedReason(diagnostics);
        result.unsupportedReason = unsupportedReason;
        // If Docker MCP version command succeeded, treat unknown profile probe errors
        // as non-fatal and let the caller show diagnostics/retry.
        result.supported = unsupportedReason === 'unknown' ? true : false;
      }

      this.setCachedProbe(result);
      return this.cloneProbeResult(result);
    }
    result.profileAvailable = true;

    const manualInstructions = await this.resolveManualInstructions().catch((error) => {
      log.debug('Docker MCP manual-instructions unavailable; using deterministic gateway URL', error);
      return undefined;
    });

    if (manualInstructions && manualInstructions.length > 0) {
      result.manualInstructionsCommand = manualInstructions;
      result.probeSource = 'manual-instructions';
      const profileFromManual = this.extractProfileFromCommand(manualInstructions);
      if (profileFromManual) {
        result.profileId = profileFromManual;
      }
    }

    this.setCachedProbe(result);
    return this.cloneProbeResult(result);
  }

  private async execMcpCommand(args: string[]): Promise<{ stdout: string; stderr: string }> {
    const client = this.dockerClientProvider();
    const output = await client.docker.cli.exec('mcp', args);
    return {
      stdout: String(output.stdout ?? ''),
      stderr: String(output.stderr ?? ''),
    };
  }

  private async resolveManualInstructions(): Promise<string[] | undefined> {
    const candidates: string[][] = [
      ['client', 'manual-instructions', '--json'],
      ['client', 'manual-instructions'],
      ['profile', 'manual-instructions', this.profileId, '--format', 'json'],
      ['profile', 'manual-instructions', this.profileId, '--json'],
      ['profile', 'manual-instructions', this.profileId],
    ];

    for (const args of candidates) {
      try {
        const output = await this.execMcpCommand(args);
        const parsed = this.parseCommandArray(output.stdout);
        if (parsed.length > 0 && this.isGatewayRunCommand(parsed)) {
          return parsed;
        }
      } catch (error) {
        log.debug('Docker MCP manual-instructions candidate failed', { args, error });
      }
    }

    return undefined;
  }

  private parseCommandArray(raw: string): string[] {
    const trimmed = raw.trim();
    if (trimmed.length === 0) {
      return [];
    }

    try {
      const parsed = JSON.parse(trimmed) as unknown;
      if (Array.isArray(parsed)) {
        return parsed.filter((entry): entry is string => typeof entry === 'string');
      }
      if (
        parsed &&
        typeof parsed === 'object' &&
        'command' in parsed &&
        Array.isArray((parsed as Record<string, unknown>)['command'])
      ) {
        return ((parsed as Record<string, unknown>)['command'] as unknown[]).filter(
          (entry): entry is string => typeof entry === 'string',
        );
      }
      if (
        parsed &&
        typeof parsed === 'object' &&
        'command' in parsed &&
        typeof (parsed as Record<string, unknown>)['command'] === 'string'
      ) {
        return this.tokenizeShellCommand((parsed as Record<string, unknown>)['command'] as string);
      }
      if (typeof parsed === 'string') {
        return this.tokenizeShellCommand(parsed);
      }
      return [];
    } catch {
      return this.extractCommandFromPlainText(trimmed);
    }
  }

  private extractProfileFromCommand(command: string[]): string | null {
    for (let index = 0; index < command.length; index += 1) {
      if (command[index] === '--profile' && index + 1 < command.length) {
        return command[index + 1];
      }
    }
    return null;
  }

  private isGatewayRunCommand(command: string[]): boolean {
    const normalized = command.map((token) => token.toLowerCase());
    const gatewayIndex = normalized.indexOf('gateway');
    if (gatewayIndex < 0) {
      return false;
    }
    return normalized.indexOf('run', gatewayIndex + 1) >= 0;
  }

  private async probeProfileAvailability(): Promise<{ available: boolean; diagnostics?: string }> {
    const candidates: string[][] = [
      ['profile', 'show', this.profileId],
      ['profile', 'show', this.profileId, '--format', 'json'],
      ['profile', 'show', this.profileId, '--json'],
    ];

    let lastDiagnostics = '';
    for (const args of candidates) {
      try {
        await this.execMcpCommand(args);
        return { available: true };
      } catch (error) {
        const diagnostics = this.toDiagnostics(error);
        lastDiagnostics = diagnostics;

        // Profile missing is deterministic; no need to try more variants.
        if (this.isProfileMissingError(diagnostics)) {
          return { available: false, diagnostics };
        }

        // CLI transport/feature failures are deterministic as well.
        const unsupportedReason = this.classifyUnsupportedReason(diagnostics);
        if (unsupportedReason !== 'unknown') {
          return { available: false, diagnostics };
        }

        if (!this.isCommandShapeError(diagnostics)) {
          return { available: false, diagnostics };
        }

        log.debug('Docker MCP profile probe candidate failed, trying fallback syntax', {
          args,
          diagnostics,
        });
      }
    }

    return { available: false, diagnostics: lastDiagnostics };
  }

  private isCommandShapeError(diagnostics: string): boolean {
    return /unknown flag|usage:\s+docker mcp|unknown shorthand flag|accepts \d+ arg\(s\)/i.test(
      diagnostics,
    );
  }

  private extractCommandFromPlainText(text: string): string[] {
    const lines = text
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => line.length > 0);

    if (lines.length === 0) {
      return [];
    }

    const dockerLine = lines.find((line) => /^docker(\s|$)/i.test(line)) ?? lines[0];
    if (!/^docker(\s|$)/i.test(dockerLine)) {
      return [];
    }

    return this.tokenizeShellCommand(dockerLine);
  }

  private tokenizeShellCommand(command: string): string[] {
    const tokens: string[] = [];
    const tokenRegex = /"([^"\\]*(?:\\.[^"\\]*)*)"|'([^'\\]*(?:\\.[^'\\]*)*)'|([^\s]+)/g;
    let match: RegExpExecArray | null = null;

    while (true) {
      match = tokenRegex.exec(command);
      if (!match) {
        break;
      }
      const value = match[1] ?? match[2] ?? match[3] ?? '';
      if (value.length > 0) {
        tokens.push(value.replace(/\\(["'])/g, '$1'));
      }
    }

    return tokens;
  }

  private buildGatewayContainerRunArgs(port: number, serverNames: string[]): string[] {
    const labelArgs = Object.entries(DOCKER_MCP_TOOLKIT_GATEWAY_CONTAINER_LABELS).flatMap(
      ([key, value]) => ['--label', `${key}=${value}`],
    );
    const effectiveServers =
      serverNames.length > 0 ? Array.from(new Set(serverNames)) : [DOCKER_MCP_TOOLKIT_GATEWAY_DEFAULT_SERVER];
    const serverArgs = effectiveServers.flatMap((server) => ['--servers', server]);

    return [
      '-d',
      '--name',
      DOCKER_MCP_TOOLKIT_GATEWAY_CONTAINER_NAME,
      '--restart',
      'unless-stopped',
      '-p',
      `${port}:${port}`,
      ...labelArgs,
      '-v',
      '/var/run/docker.sock:/var/run/docker.sock',
      DOCKER_MCP_TOOLKIT_GATEWAY_CONTAINER_IMAGE,
      '--transport',
      'streaming',
      '--port',
      String(port),
      ...serverArgs,
    ];
  }

  private async resolveHostEnabledServerNames(): Promise<string[]> {
    try {
      const output = await this.execMcpCommand(['server', 'ls', '--json']);
      const parsed = JSON.parse(output.stdout) as unknown;
      if (!Array.isArray(parsed)) {
        return [];
      }
      return parsed
        .filter(
          (entry): entry is DockerMcpServerListEntry => Boolean(entry) && typeof entry === 'object',
        )
        .map((entry) => (typeof entry.name === 'string' ? entry.name.trim() : ''))
        .filter((name) => name.length > 0);
    } catch (error) {
      log.warn('Failed to enumerate host-enabled Docker MCP servers; using default server fallback', {
        diagnostics: this.toDiagnostics(error),
      });
      return [];
    }
  }

  private async findGatewayContainer(): Promise<DockerMcpGatewayContainerInfo | null> {
    const client = this.dockerClientProvider();
    try {
      const labels = Object.entries(DOCKER_MCP_TOOLKIT_GATEWAY_CONTAINER_LABELS).map(
        ([key, value]) => `${key}=${value}`,
      );
      const labeled = (await client.docker.listContainers({
        all: true,
        filters: { label: labels },
      })) as DockerListedContainer[];
      if (labeled.length > 0) {
        return this.mapGatewayContainerInfo(labeled[0]);
      }

      const named = (await client.docker.listContainers({
        all: true,
        filters: { name: [DOCKER_MCP_TOOLKIT_GATEWAY_CONTAINER_NAME] },
      })) as DockerListedContainer[];

      for (const container of named) {
        const names =
          Array.isArray(container.Names) && container.Names.length > 0
            ? container.Names
            : container.Name
              ? [container.Name]
              : [];
        const matches = names.some(
          (name) =>
            name === DOCKER_MCP_TOOLKIT_GATEWAY_CONTAINER_NAME ||
            name === `/${DOCKER_MCP_TOOLKIT_GATEWAY_CONTAINER_NAME}`,
        );
        if (matches) {
          return this.mapGatewayContainerInfo(container);
        }
      }
    } catch (error) {
      log.warn('Failed to inspect Docker MCP gateway container state', {
        diagnostics: this.toDiagnostics(error),
      });
    }

    return null;
  }

  private mapGatewayContainerInfo(container: DockerListedContainer): DockerMcpGatewayContainerInfo {
    return {
      id: container.Id,
      name: container.Names?.[0] || container.Name || '',
      state: String(container.State ?? ''),
      image: String(container.Image ?? ''),
      status: String(container.Status ?? ''),
      labels: container.Labels || {},
    };
  }

  private isNameConflictError(diagnostics: string): boolean {
    return /container name .* is already in use|Conflict\./i.test(diagnostics);
  }

  private isContainerMissingError(diagnostics: string): boolean {
    return /No such container|not found/i.test(diagnostics);
  }

  private buildDeterministicGatewayUrls(): { gatewayUrl: string; gatewayHealthUrl: string } {
    const origin = `http://${DOCKER_MCP_TOOLKIT_GATEWAY_HOST}:${DOCKER_MCP_TOOLKIT_GATEWAY_PORT}`;
    return {
      gatewayUrl: `${origin}${DOCKER_MCP_TOOLKIT_GATEWAY_PATH}`,
      gatewayHealthUrl: `${origin}${DOCKER_MCP_TOOLKIT_GATEWAY_HEALTH_PATH}`,
    };
  }

  private isProfileMissingError(diagnostics: string): boolean {
    return /profile .*not found|working set .*not found|not found/i.test(diagnostics);
  }

  private classifyUnsupportedReason(diagnostics: string): DockerMcpToolkitUnsupportedReason {
    if (/docker desktop is not running/i.test(diagnostics)) {
      return 'docker-desktop-not-running';
    }
    if (/not a docker command|unknown command ['"]?mcp['"]?/i.test(diagnostics)) {
      return 'mcp-cli-unavailable';
    }
    if (/mcp toolkit.*disabled|feature .*disabled|enable .*mcp/i.test(diagnostics)) {
      return 'toolkit-disabled';
    }
    return 'unknown';
  }

  private toDiagnostics(error: unknown): string {
    const parts = [toErrorMessage(error), getStderr(error) ?? '']
      .map((value) => value.trim())
      .filter((value) => value.length > 0);
    return parts.join(' | ');
  }

  private setCachedProbe(result: DockerMcpToolkitProbeResult): void {
    this.cachedProbe = {
      value: this.cloneProbeResult(result),
      checkedAt: Date.now(),
    };
  }

  private cloneProbeResult(result: DockerMcpToolkitProbeResult): DockerMcpToolkitProbeResult {
    return {
      ...result,
      manualInstructionsCommand: result.manualInstructionsCommand
        ? [...result.manualInstructionsCommand]
        : undefined,
    };
  }
}

