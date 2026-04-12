import {
  CONTAINER_NAME,
  CONTAINER_LABELS,
  VOLUME_NAMES,
  DEFAULT_PORT,
  DEFAULT_AUTO_START,
  DEFAULT_ENABLE_DOCKER_MCP_TOOLKIT,
  DEFAULT_PROVISIONER,
  OPENAI_PROVIDER_DEFAULTS,
  PROVISIONER_LABEL_KEY,
  IMAGE_UPDATE_FLOATING_TAG_REGEX,
} from '../constants';
import { log } from '../logger';
import type {
  ExtensionConfig,
  ContainerState,
  DockerListedContainer,
  ImageUpdateCheckResult,
  ProvisionerMode,
} from '../types';
import { CONTAINER_STATES } from '../types';
import { getStderr, toErrorMessage } from '../utils/dockerCliError';
import { getDDClient, type DockerDesktopClient } from './dockerDesktopClient';
import { createLocalStorageAdapter, type StorageAdapter } from './storage';

const SERVICE_CONTAINER_NAME = CONTAINER_NAME;
const SERVICE_LABELS = CONTAINER_LABELS;
const SHA256_DIGEST_REGEX = /\bsha256:[a-f0-9]{64}\b/i;
const WEBUI_SECRET_KEY_STORAGE_KEY = 'openwebui-extension-webui-secret-key';
const WEBUI_SECRET_KEY_LENGTH_BYTES = 32;

function generateWebUISecretKey(): string {
  const randomBytes = new Uint8Array(WEBUI_SECRET_KEY_LENGTH_BYTES);
  const cryptoObj = (globalThis as { crypto?: Crypto }).crypto;
  if (cryptoObj?.getRandomValues) {
    cryptoObj.getRandomValues(randomBytes);
  } else {
    for (let index = 0; index < randomBytes.length; index += 1) {
      randomBytes[index] = Math.floor(Math.random() * 256);
    }
  }

  return Array.from(randomBytes)
    .map((value) => value.toString(16).padStart(2, '0'))
    .join('');
}

function resolvePersistentWebUISecretKey(storage: StorageAdapter = createLocalStorageAdapter()): string {
  try {
    const existing = storage.getItem(WEBUI_SECRET_KEY_STORAGE_KEY);
    if (existing && existing.trim().length >= WEBUI_SECRET_KEY_LENGTH_BYTES * 2) {
      return existing.trim();
    }
  } catch (error) {
    log.warn('Failed reading persisted WEBUI_SECRET_KEY; generating a new key.', error);
  }

  const generated = generateWebUISecretKey();
  try {
    storage.setItem(WEBUI_SECRET_KEY_STORAGE_KEY, generated);
  } catch (error) {
    log.warn('Failed persisting WEBUI_SECRET_KEY; using in-memory value for this session.', error);
  }
  return generated;
}

function isFloatingImageTag(image: string | null | undefined): boolean {
  return typeof image === 'string' && IMAGE_UPDATE_FLOATING_TAG_REGEX.test(image.trim());
}

function extractDigestFromRepoDigest(repoDigest: string): string | null {
  if (typeof repoDigest !== 'string' || repoDigest.trim().length === 0) {
    return null;
  }

  const atIndex = repoDigest.lastIndexOf('@');
  if (atIndex < 0) {
    return null;
  }

  const digest = repoDigest.slice(atIndex + 1).trim();
  return SHA256_DIGEST_REGEX.test(digest) ? digest.toLowerCase() : null;
}

function extractDigestFromBuildxInspectOutput(output: string): string | null {
  if (!output) {
    return null;
  }

  const match = output.match(/^\s*Digest:\s*(sha256:[a-f0-9]{64})\s*$/im);
  if (!match) {
    return null;
  }

  return match[1].toLowerCase();
}

function extractDigestFromManifestInspectOutput(output: string): string | null {
  if (!output || output.trim().length === 0) {
    return null;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(output);
  } catch {
    return null;
  }

  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    if (Array.isArray(parsed)) {
      for (const entry of parsed) {
        if (!entry || typeof entry !== 'object') {
          continue;
        }
        const descriptor = (entry as Record<string, unknown>).Descriptor;
        if (descriptor && typeof descriptor === 'object') {
          const digest = (descriptor as Record<string, unknown>).digest;
          if (typeof digest === 'string') {
            const normalized = digest.trim().toLowerCase();
            if (SHA256_DIGEST_REGEX.test(normalized)) {
              return normalized;
            }
          }
        }

        const digest = (entry as Record<string, unknown>).Digest;
        if (typeof digest === 'string') {
          const normalized = digest.trim().toLowerCase();
          if (SHA256_DIGEST_REGEX.test(normalized)) {
            return normalized;
          }
        }
      }
    }
    return null;
  }

  const obj = parsed as Record<string, unknown>;
  const descriptor = obj.Descriptor;
  if (descriptor && typeof descriptor === 'object') {
    const digest = (descriptor as Record<string, unknown>).digest;
    if (typeof digest === 'string') {
      const normalized = digest.trim().toLowerCase();
      if (SHA256_DIGEST_REGEX.test(normalized)) {
        return normalized;
      }
    }
  }

  const topLevelDigest = obj.Digest;
  if (typeof topLevelDigest === 'string') {
    const normalized = topLevelDigest.trim().toLowerCase();
    if (SHA256_DIGEST_REGEX.test(normalized)) {
      return normalized;
    }
  }

  return null;
}

interface LocalImageDigestInfo {
  repoDigests: string[];
  descriptorDigest?: string;
}

function extractLocalImageDigestInfo(payload: unknown): LocalImageDigestInfo {
  const repoDigests = extractRepoDigestsFromInspectPayload(payload)
    .map((value) => extractDigestFromRepoDigest(String(value)))
    .filter((digest): digest is string => Boolean(digest));

  let descriptorDigest: string | undefined;

  if (Array.isArray(payload) && payload.length > 0) {
    const first = payload[0];
    if (first && typeof first === 'object') {
      const descriptor = (first as { Descriptor?: unknown }).Descriptor;
      if (descriptor && typeof descriptor === 'object') {
        const rawDigest = (descriptor as { digest?: unknown }).digest;
        if (typeof rawDigest === 'string') {
          const normalized = rawDigest.trim().toLowerCase();
          if (SHA256_DIGEST_REGEX.test(normalized)) {
            descriptorDigest = normalized;
          }
        }
      }
    }
  }

  return {
    repoDigests: Array.from(new Set(repoDigests)),
    descriptorDigest,
  };
}

function extractRepoDigestsFromInspectPayload(payload: unknown): string[] {
  if (!Array.isArray(payload)) {
    return [];
  }

  const repoDigests: string[] = [];
  for (const entry of payload) {
    if (!entry || typeof entry !== 'object') {
      continue;
    }
    const digests = (entry as { RepoDigests?: unknown }).RepoDigests;
    if (!Array.isArray(digests)) {
      continue;
    }
    for (const value of digests) {
      if (typeof value === 'string') {
        repoDigests.push(value);
      }
    }
  }

  return repoDigests;
}

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
  labels?: Record<string, string>;
  created: number;
}

export interface ContainerInspectionResult {
  exists: boolean;
  state: ContainerState;
  config: ExtensionConfig;
}

export class ContainerService {
  private createInFlight: Promise<void> | null = null;
  private readonly webUISecretKey: string;

  constructor(
    private readonly clientProvider: () => DockerDesktopClient = getDDClient,
    private readonly webUISecretKeyProvider: () => string = () => resolvePersistentWebUISecretKey(),
  ) {
    this.webUISecretKey = this.webUISecretKeyProvider();
  }

  private get client(): DockerDesktopClient {
    return this.clientProvider();
  }

  private buildRunArgs(config: ExtensionConfig): string[] {
    const pullAlways = isFloatingImageTag(config.image);
    const labels = {
      ...SERVICE_LABELS,
      [PROVISIONER_LABEL_KEY]: config.provisioner,
    } satisfies Record<string, string>;
    const labelArgs = Object.entries(labels).flatMap(([key, value]) => [
      '--label',
      `${key}=${value}`,
    ]);

    const restartPolicy = config.autoStart ? 'unless-stopped' : 'no';
    const envArgs = [
      '-e',
      'ENV=dev',
      '-e',
      'WEBUI_AUTH=False',
      '-e',
      `WEBUI_SECRET_KEY=${this.webUISecretKey}`,
      '-e',
      'ENABLE_VERSION_UPDATE_CHECK=False',
    ];

    if (config.provisioner === 'openai') {
      envArgs.push(
        '-e',
        `OPENAI_API_BASE_URLS=${OPENAI_PROVIDER_DEFAULTS.baseUrl}`,
        '-e',
        `OPENAI_API_KEYS=${OPENAI_PROVIDER_DEFAULTS.apiKeyPlaceholder}`,
      );
    }

    return [
      '-d',
      '--name',
      SERVICE_CONTAINER_NAME,
      ...(pullAlways ? ['--pull', 'always'] : []),
      '-p',
      `${config.port}:8080`,
      ...envArgs,
      '-v',
      `${VOLUME_NAMES.data}:/app/backend/data`,
      '-v',
      `${VOLUME_NAMES.cache}:/root/.cache`,
      '-v',
      `${VOLUME_NAMES.chroma}:/root/.cache/chroma`,
      '--restart',
      restartPolicy,
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

      const namedContainers = (await client.docker.listContainers({
        all: true,
        filters: {
          name: [SERVICE_CONTAINER_NAME],
        },
      })) as DockerListedContainer[];
      for (const container of namedContainers) {
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

        // Defense-in-depth: if the existing container was created by an older
        // extension version (no provisioner label) or with a different
        // provisioner, remove it so we can recreate with the correct config.
        const provisionerLabel = existing.labels?.[PROVISIONER_LABEL_KEY];
        const provisionerStale =
          provisionerLabel === undefined ||
          provisionerLabel === null ||
          provisionerLabel === '' ||
          provisionerLabel !== config.provisioner;

        if (provisionerStale) {
          log.info(
            'Existing container has stale/missing provisioner label; removing for recreation',
            {
              containerLabel: provisionerLabel ?? '<missing>',
              configProvisioner: config.provisioner,
            },
          );
          try {
            if (existing.state === 'running') {
              await client.docker.cli.exec('stop', [existing.id]);
            }
            await client.docker.cli.exec('rm', ['-f', existing.id]);
          } catch (rmErr) {
            log.warn('Failed to remove stale container; will attempt creation anyway:', rmErr);
          }
          // Fall through to create a fresh container below.
        } else {
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
        if (isFloatingImageTag(config.image)) {
          log.debug('Pulling fresh image before run:', config.image);
          await client.docker.cli.exec('pull', [config.image]);
        }
      } catch (pullError) {
        const stderr = getStderr(pullError) ?? '';
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
      const stderr = getStderr(error) ?? '';
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

  async pullImage(image: string): Promise<void> {
    const trimmedImage = image.trim();
    if (!trimmedImage) {
      throw new Error('Docker image is required for pull');
    }

    const client = this.client;
    try {
      await client.docker.cli.exec('pull', [trimmedImage]);
    } catch (error) {
      const stderr = getStderr(error) ?? '';
      if (/denied|unauthorized|authentication required/i.test(stderr)) {
        throw new Error(
          `Image pull denied by registry for ${trimmedImage}. Authenticate to registry or use a pinned tag.`,
        );
      }
      throw new Error(`Failed to pull image ${trimmedImage}: ${toErrorMessage(error)}`);
    }
  }

  async checkImageUpdateAvailability(image: string): Promise<ImageUpdateCheckResult> {
    const trimmedImage = image.trim();
    const checkedAt = Date.now();

    if (!trimmedImage) {
      return {
        image: '',
        supported: false,
        updateAvailable: false,
        checkedAt,
        error: 'Docker image is empty.',
      };
    }

    if (!isFloatingImageTag(trimmedImage)) {
      return {
        image: trimmedImage,
        supported: false,
        updateAvailable: false,
        checkedAt,
      };
    }

    try {
      const localInfo = await this.getLocalImageDigestInfo(trimmedImage);
      const comparableLocalDigests = new Set(
        localInfo.descriptorDigest
          ? [...localInfo.repoDigests, localInfo.descriptorDigest]
          : localInfo.repoDigests,
      );
      const localPrimaryDigest = localInfo.repoDigests[0] ?? localInfo.descriptorDigest;

      const remoteTagDigest = await this.getRemoteTagDigest(trimmedImage);
      if (remoteTagDigest) {
        if (comparableLocalDigests.size === 0) {
          return {
            image: trimmedImage,
            supported: true,
            updateAvailable: false,
            checkedAt,
            remoteDigest: remoteTagDigest,
            error: 'Local image digest is unavailable. Start or pull the image first.',
          };
        }

        const matchesTagDigest = comparableLocalDigests.has(remoteTagDigest);
        return {
          image: trimmedImage,
          supported: true,
          updateAvailable: !matchesTagDigest,
          checkedAt,
          localDigest: localPrimaryDigest,
          remoteDigest: remoteTagDigest,
        };
      }
      return {
        image: trimmedImage,
        supported: true,
        updateAvailable: false,
        checkedAt,
        localDigest: localPrimaryDigest,
        error: 'Unable to determine remote tag digest. Skipping update notice.',
      };
    } catch (error) {
      const stderr = getStderr(error) ?? '';
      const errorText = `${stderr} ${toErrorMessage(error)}`;
      if (/denied|unauthorized|authentication required/i.test(errorText)) {
        return {
          image: trimmedImage,
          supported: true,
          updateAvailable: false,
          checkedAt,
          error: 'Registry authentication required to check updates for this image.',
        };
      }

      if (/toomanyrequests|rate limit|429/i.test(errorText)) {
        return {
          image: trimmedImage,
          supported: true,
          updateAvailable: false,
          checkedAt,
          error: 'Registry rate limit reached while checking image updates.',
        };
      }

      log.warn('Failed to check image update availability:', error);
      return {
        image: trimmedImage,
        supported: true,
        updateAvailable: false,
        checkedAt,
        error: `Failed to check image updates: ${toErrorMessage(error)}. Skipping update notice.`,
      };
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
        throw new Error(
          `Failed to stop container: ${toErrorMessage(error)}; ` +
            `kill fallback also failed: ${toErrorMessage(killError)}`,
        );
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
        config: {
          image: '',
          port: '',
          autoStart: DEFAULT_AUTO_START,
          provisioner: DEFAULT_PROVISIONER,
          enableDockerMcpToolkit: DEFAULT_ENABLE_DOCKER_MCP_TOOLKIT,
        },
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

    const provisioner = this.resolveProvisionerFromLabels(container.labels);

    return {
      exists: true,
      state: mappedState,
      config: {
        image: container.image,
        port: actualPort,
        autoStart: DEFAULT_AUTO_START,
        provisioner,
        enableDockerMcpToolkit: DEFAULT_ENABLE_DOCKER_MCP_TOOLKIT,
      },
    };
  }

  /**
   * Returns `true` when the existing container was created with a different
   * provisioner (or no provisioner label at all, indicating an old-version
   * container) compared to `config.provisioner`.
   *
   * Use this to decide whether the container needs recreation on start.
   */
  async needsProvisionerReconciliation(config: ExtensionConfig): Promise<boolean> {
    const container = await this.findContainer();
    if (!container) {
      return false;
    }

    const labels = container.labels ?? {};
    const labelValue = labels[PROVISIONER_LABEL_KEY];

    // Old container without the provisioner label → always needs reconciliation.
    if (labelValue === undefined || labelValue === null || labelValue === '') {
      return true;
    }

    // Explicit mismatch between container label and desired config.
    return labelValue !== config.provisioner;
  }

  private resolveProvisionerFromLabels(labels?: Record<string, string>): ProvisionerMode {
    const raw = labels?.[PROVISIONER_LABEL_KEY];
    return raw === 'legacy-function' ? 'legacy-function' : DEFAULT_PROVISIONER;
  }

  private async getLocalImageDigestInfo(image: string): Promise<LocalImageDigestInfo> {
    const client = this.client;

    try {
      const result = await client.docker.cli.exec('image', ['inspect', image]);
      const stdout = String(result.stdout ?? '').trim();
      if (!stdout) {
        return { repoDigests: [] };
      }

      let parsed: unknown;
      try {
        parsed = JSON.parse(stdout);
      } catch (parseError) {
        throw new Error(`Invalid docker image inspect JSON: ${toErrorMessage(parseError)}`);
      }

      return extractLocalImageDigestInfo(parsed);
    } catch (error) {
      const rawMessage = `${toErrorMessage(error)} ${getStderr(error) ?? ''}`;
      if (/No such image|not found/i.test(rawMessage)) {
        return { repoDigests: [] };
      }
      throw error;
    }
  }

  private async getRemoteTagDigest(image: string): Promise<string | null> {
    const client = this.client;

    try {
      const result = await client.docker.cli.exec('buildx', ['imagetools', 'inspect', image]);
      const digest = extractDigestFromBuildxInspectOutput(String(result.stdout ?? ''));
      if (digest) {
        return digest;
      }
    } catch (error) {
      log.debug('docker buildx imagetools inspect failed; trying manifest-based fallback', {
        image,
        error: toErrorMessage(error),
      });
    }

    try {
      const result = await client.docker.cli.exec('manifest', ['inspect', '--verbose', image]);
      const digest = extractDigestFromManifestInspectOutput(String(result.stdout ?? ''));
      if (digest) {
        log.debug('Resolved remote digest via manifest inspect fallback', { image, digest });
        return digest;
      }
    } catch (manifestError) {
      log.debug('docker manifest inspect fallback failed', {
        image,
        error: toErrorMessage(manifestError),
      });
    }

    return null;
  }

  private mapContainerInfo(container: DockerListedContainer): ContainerInfo {
    return {
      id: container.Id,
      name: container.Names?.[0] || container.Name || '',
      image: container.Image,
      state: (container.State as ContainerState) || 'stopped',
      status: container.Status || '',
      ports: container.Ports || [],
      labels: container.Labels || {},
      created: container.Created || 0,
    };
  }
}

export function createContainerService(options?: {
  client?: DockerDesktopClient;
  clientProvider?: () => DockerDesktopClient;
  webUISecretKeyProvider?: () => string;
}): ContainerService {
  if (options?.clientProvider) {
    return new ContainerService(options.clientProvider, options.webUISecretKeyProvider);
  }
  if (options?.client) {
    const client = options.client;
    return new ContainerService(() => client, options.webUISecretKeyProvider);
  }
  return new ContainerService(undefined, options?.webUISecretKeyProvider);
}
