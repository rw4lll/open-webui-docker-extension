import {
  CONTAINER_NAME,
  CONTAINER_LABELS,
  VOLUME_NAMES,
  DEFAULT_PORT,
  DEFAULT_AUTO_START,
} from '../constants';
import { log } from '../logger';
import type { ExtensionConfig, ContainerState, DockerListedContainer } from '../types';
import { CONTAINER_STATES } from '../types';
import { getDDClient, type DockerDesktopClient } from './dockerDesktopClient';

const SERVICE_CONTAINER_NAME = CONTAINER_NAME;
const SERVICE_LABELS = CONTAINER_LABELS;

export interface ContainerInfo {
  id: string;
  name: string;
  image: string;
  state: ContainerState | string;
  status: string;
  ports: Array<{
    IP?: string;
    PrivatePort: number;
    PublicPort?: number;
    Type?: string;
  }>;
  created: number;
}

export interface ContainerInspectionResult {
  exists: boolean;
  state: ContainerState;
  config: ExtensionConfig;
}

export class ContainerService {
  private createInFlight: Promise<void> | null = null;

  constructor(private readonly clientProvider: () => DockerDesktopClient = getDDClient) {}

  private get client(): DockerDesktopClient {
    return this.clientProvider();
  }

  private buildRunArgs(config: ExtensionConfig): string[] {
    const pullAlways =
      typeof config.image === 'string' && /(:(main|latest))$/.test(config.image.trim());
    const labelArgs = Object.entries(SERVICE_LABELS).flatMap(([key, value]) => [
      '--label',
      `${key}=${value}`,
    ]);

    return [
      '-d',
      '--name',
      SERVICE_CONTAINER_NAME,
      ...(pullAlways ? ['--pull', 'always'] : []),
      '-p',
      `${config.port}:8080`,
      '-e',
      'ENV=dev',
      '-e',
      'WEBUI_AUTH=False',
      '-e',
      'ENABLE_VERSION_UPDATE_CHECK=False',
      '-v',
      `${VOLUME_NAMES.data}:/app/backend/data`,
      '-v',
      `${VOLUME_NAMES.cache}:/root/.cache`,
      '-v',
      `${VOLUME_NAMES.chroma}:/root/.cache/chroma`,
      '--restart',
      'unless-stopped',
      ...labelArgs,
      config.image,
    ];
  }

  async findContainer(): Promise<ContainerInfo | null> {
    const client = this.client;
    try {
      const containers = (await client.docker.listContainers({
        all: true,
        filters: {
          label: Object.entries(SERVICE_LABELS).map(([k, v]) => `${k}=${v}`),
        },
      })) as DockerListedContainer[];

      if (containers.length > 0) {
        return this.mapContainerInfo(containers[0]);
      }

      const allContainers = (await client.docker.listContainers({
        all: true,
      })) as DockerListedContainer[];
      for (const container of allContainers) {
        const names = container.Names || [container.Name] || [];
        const exact =
          names.some((n) => n === `/${SERVICE_CONTAINER_NAME}`) ||
          names.some((n) => n === SERVICE_CONTAINER_NAME);
        if (exact) {
          return this.mapContainerInfo(container);
        }
      }

      return null;
    } catch (error) {
      log.error('Error finding Open WebUI container:', error);
      return null;
    }
  }

  async createContainer(config: ExtensionConfig): Promise<void> {
    if (this.createInFlight) {
      return this.createInFlight;
    }

    const execution = this.createContainerInternal(config);
    this.createInFlight = execution.finally(() => {
      this.createInFlight = null;
    });
    return this.createInFlight;
  }

  private async createContainerInternal(config: ExtensionConfig): Promise<void> {
    const client = this.client;
    try {
      log.debug('Creating container with config:', config);

      const existing = await this.findContainer();
      if (existing) {
        log.debug('Found existing container:', existing);
        if (existing.state === 'running') {
          log.debug('Existing container already running; no action');
          return;
        }
        try {
          await client.docker.cli.exec('start', [existing.id]);
          log.debug('Started existing container');
          return;
        } catch (startErr) {
          log.warn('Failed to start existing container, will attempt recreate:', startErr);
          try {
            await client.docker.cli.exec('rm', ['-f', existing.id]);
          } catch (rmErr) {
            log.warn('Failed to remove existing container during recreate:', rmErr);
          }
        }
      }

      const conflict = await this.isHostPortInUse(config.port);
      if (conflict) {
        if (conflict.name && conflict.name.includes(SERVICE_CONTAINER_NAME)) {
          log.debug('Port in use by our container; attempting to start it');
          try {
            await client.docker.cli.exec('start', [conflict.id]);
            return;
          } catch (startConflictErr) {
            log.warn(
              'Failed to start conflicting existing container; removing and recreating:',
              startConflictErr,
            );
            try {
              await client.docker.cli.exec('rm', ['-f', conflict.id]);
            } catch (rmConflictErr) {
              log.warn('Failed to remove conflicting container:', rmConflictErr);
            }
          }
        } else {
          const shortId = conflict.id.substring(0, 12);
          throw new Error(
            `Port ${config.port} is already in use by container ${conflict.name} (${shortId}). Choose a different port in Settings.`,
          );
        }
      }

      try {
        if (typeof config.image === 'string' && /(:(main|latest))$/.test(config.image.trim())) {
          log.debug('Pulling fresh image before run:', config.image);
          await client.docker.cli.exec('pull', [config.image]);
        }
      } catch (pullError) {
        const stderr = (pullError as Error & { stderr?: string })?.stderr || '';
        log.warn(
          'Image pull failed (continuing with local cache / docker run may pull):',
          pullError,
        );
        if (/denied|unauthorized|authentication required/i.test(stderr)) {
          throw new Error(
            `Image pull denied by registry for ${config.image}. You may be rate-limited or not authorized. ` +
              `Try a non-latest pinned tag, authenticate to ghcr.io, or change the image in Settings.`,
          );
        }
      }

      const args = this.buildRunArgs(config);
      log.debug('Docker run command args:', args);

      const result = await client.docker.cli.exec('run', args);
      log.debug('Container creation result:', result);
    } catch (error) {
      const message = String(error);
      const stderr = (error as Error & { stderr?: string })?.stderr || '';
      if (/denied|unauthorized|authentication required/i.test(stderr)) {
        throw new Error(
          `Image pull/run denied by registry for ${config.image}. You may be rate-limited or not authorized. ` +
            `Authenticate to ghcr.io (docker login ghcr.io) or change the image in Settings.`,
        );
      }
      if (/No such image|not found/i.test(message)) {
        try {
          log.warn('Run failed due to image not found; retrying once after short delay...');
          await new Promise((res) => setTimeout(res, 1500));
          await client.docker.cli.exec('run', this.buildRunArgs(config));
          return;
        } catch (retryError) {
          log.error('Retry run after image pull also failed:', retryError);
          throw new Error(`Failed to create container after retry: ${retryError}`);
        }
      }
      if (/port is already allocated|address already in use|already in use/i.test(message)) {
        const conflict = await this.isHostPortInUse(config.port);
        if (conflict && conflict.name && conflict.name.includes(SERVICE_CONTAINER_NAME)) {
          log.warn(
            'Port allocation race detected; our container appears to be using the port. Treating as success.',
          );
          return;
        }
      }
      log.error('Failed to create container:', error);
      throw new Error(`Failed to create container: ${error}`);
    }
  }

  private async isHostPortInUse(hostPort: string): Promise<ContainerInfo | null> {
    const client = this.client;
    try {
      const allContainers = (await client.docker.listContainers({
        all: true,
      })) as DockerListedContainer[];
      for (const c of allContainers) {
        const ports = c.Ports || [];
        for (const p of ports) {
          if (p.PublicPort && String(p.PublicPort) === String(hostPort)) {
            return this.mapContainerInfo(c);
          }
        }
      }
      return null;
    } catch (error) {
      log.warn('Port conflict preflight failed:', error);
      return null;
    }
  }

  async startContainer(): Promise<void> {
    const container = await this.findContainer();
    if (!container) {
      throw new Error('Container not found');
    }

    if (container.state === 'running') {
      return;
    }

    const client = this.client;
    try {
      await client.docker.cli.exec('start', [container.id]);
    } catch (error) {
      log.error('Failed to start container:', error);
      throw new Error(`Failed to start container: ${error}`);
    }
  }

  async stopContainer(): Promise<void> {
    const container = await this.findContainer();
    if (!container) {
      throw new Error('Container not found');
    }

    if (
      container.state === 'exited' ||
      container.state === 'stopped' ||
      container.state === 'created'
    ) {
      return;
    }

    const client = this.client;
    try {
      if (container.state === 'paused') {
        try {
          await client.docker.cli.exec('unpause', [container.id]);
        } catch (unpauseError) {
          log.warn('Unpause before stop failed (continuing):', unpauseError);
        }
      }

      await client.docker.cli.exec('stop', [container.id]);
    } catch (error) {
      try {
        await new Promise((res) => setTimeout(res, 1500));
        await client.docker.cli.exec('kill', [container.id]);
      } catch (killError) {
        log.error('Failed to stop container (kill fallback also failed):', killError);
        throw new Error(`Failed to stop container: ${error}`);
      }
    }
  }

  async restartContainer(): Promise<void> {
    const container = await this.findContainer();
    if (!container) {
      throw new Error('Container not found');
    }

    const client = this.client;
    try {
      if (container.state === 'paused') {
        try {
          await client.docker.cli.exec('unpause', [container.id]);
        } catch (unpauseError) {
          log.warn('Unpause before restart failed (attempting restart anyway):', unpauseError);
        }
      }
      await client.docker.cli.exec('restart', [container.id]);
    } catch (error) {
      log.error('Failed to restart container:', error);
      throw new Error(`Failed to restart container: ${error}`);
    }
  }

  async removeContainer(): Promise<void> {
    const container = await this.findContainer();
    if (!container) {
      return;
    }

    const client = this.client;
    try {
      try {
        await this.stopContainer();
      } catch (stopError) {
        log.warn('Stop before remove failed (continuing with force remove):', stopError);
      }

      await client.docker.cli.exec('rm', ['-f', container.id]);
    } catch (error) {
      log.error('Failed to remove container:', error);
      throw new Error(`Failed to remove container: ${error}`);
    }
  }

  async recreateContainer(config: ExtensionConfig): Promise<void> {
    try {
      await this.removeContainer();
      await new Promise((resolve) => setTimeout(resolve, 1000));
      await this.createContainer(config);
    } catch (error) {
      log.error('Failed to recreate container:', error);
      throw new Error(`Failed to recreate container: ${error}`);
    }
  }

  async ensureRunning(config: ExtensionConfig): Promise<void> {
    await this.createContainer(config);
  }

  async containerExists(): Promise<boolean> {
    const container = await this.findContainer();
    return container !== null;
  }

  async getContainerStatus(): Promise<ContainerInspectionResult> {
    const container = await this.findContainer();

    if (!container) {
      return {
        exists: false,
        state: 'not_found',
        config: { image: '', port: '', autoStart: DEFAULT_AUTO_START },
      };
    }

    let actualPort = DEFAULT_PORT;
    if (container.ports && container.ports.length > 0) {
      const port = container.ports.find((p) => p.PrivatePort === 8080);
      if (port && port.PublicPort) {
        actualPort = port.PublicPort.toString();
      }
    }

    const isKnownState = CONTAINER_STATES.includes(container.state as ContainerState);
    const mappedState: ContainerState = isKnownState
      ? (container.state as ContainerState)
      : 'stopped';

    return {
      exists: true,
      state: mappedState,
      config: {
        image: container.image,
        port: actualPort,
        autoStart: DEFAULT_AUTO_START,
      },
    };
  }

  private mapContainerInfo(container: DockerListedContainer): ContainerInfo {
    return {
      id: container.Id,
      name: container.Names?.[0] || container.Name || '',
      image: container.Image,
      state: (container.State as ContainerState) || 'stopped',
      status: container.Status || '',
      ports: container.Ports || [],
      created: container.Created || 0,
    };
  }
}

export function createContainerService(options?: {
  client?: DockerDesktopClient;
  clientProvider?: () => DockerDesktopClient;
}): ContainerService {
  if (options?.clientProvider) {
    return new ContainerService(options.clientProvider);
  }
  if (options?.client) {
    const client = options.client;
    return new ContainerService(() => client);
  }
  return new ContainerService();
}
