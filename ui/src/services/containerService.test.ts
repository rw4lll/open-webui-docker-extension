import { describe, it, expect, vi, beforeEach } from 'vitest';

import { createContainerService } from './containerService';
import type { DockerDesktopClient } from './dockerDesktopClient';
import type { DockerListedContainer } from '../types';

const LOCAL_DIGEST = 'sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const REMOTE_DIGEST = 'sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';

describe('ContainerService', () => {
  let execMock: ReturnType<typeof vi.fn>;
  let listContainersMock: ReturnType<typeof vi.fn>;
  let client: DockerDesktopClient;

  beforeEach(() => {
    execMock = vi.fn().mockResolvedValue({ stdout: '', stderr: '' });
    listContainersMock = vi.fn().mockResolvedValue([] as DockerListedContainer[]);

    client = {
      docker: {
        cli: { exec: execMock },
        listContainers: listContainersMock,
      },
    } as unknown as DockerDesktopClient;
  });

  it('deduplicates concurrent createContainer calls', async () => {
    listContainersMock.mockResolvedValueOnce([]).mockResolvedValueOnce([]).mockResolvedValue([]);

    const service = createContainerService({ client });
    const config = {
      image: 'example/image:1.0.0',
      port: '8090',
      autoStart: true,
      provisioner: 'openai' as const,
    };

    const first = service.createContainer(config);
    const second = service.createContainer(config);

    await Promise.all([first, second]);

    expect(execMock.mock.calls.filter(([command]) => command === 'run')).toHaveLength(1);

    const runArgs = execMock.mock.calls.find(([command]) => command === 'run')?.[1];
    expect(runArgs).toBeTruthy();
    expect(runArgs as string[]).toContain('--restart');
    expect(runArgs as string[]).toContain('unless-stopped');
  });

  it('allows retry after a failed createContainer', async () => {
    listContainersMock.mockResolvedValueOnce([]).mockResolvedValueOnce([]).mockResolvedValue([]);

    const failure = new Error('boom');
    execMock.mockRejectedValueOnce(failure).mockResolvedValueOnce({ stdout: '', stderr: '' });

    const service = createContainerService({ client });
    const config = {
      image: 'example/image:1.0.0',
      port: '8090',
      autoStart: true,
      provisioner: 'openai' as const,
    };

    await expect(service.createContainer(config)).rejects.toThrow('Failed to create container');

    listContainersMock.mockResolvedValueOnce([]).mockResolvedValueOnce([]).mockResolvedValue([]);

    await expect(service.createContainer(config)).resolves.toBeUndefined();

    const runCalls = execMock.mock.calls.filter(([command]) => command === 'run');
    expect(runCalls).toHaveLength(2);
  });

  it('configures restart policy based on autoStart flag', async () => {
    listContainersMock.mockResolvedValueOnce([]).mockResolvedValueOnce([]).mockResolvedValue([]);

    const service = createContainerService({ client });

    await service.createContainer({
      image: 'example/image:1.0.0',
      port: '8090',
      autoStart: true,
      provisioner: 'openai',
    });

    const autoRunArgs = execMock.mock.calls.find(
      ([command, args]) => command === 'run' && args.includes('unless-stopped'),
    )?.[1];
    expect(autoRunArgs).toBeTruthy();
    expect(autoRunArgs as string[]).toContain('--restart');

    execMock.mockClear();
    listContainersMock.mockResolvedValueOnce([]).mockResolvedValueOnce([]).mockResolvedValue([]);

    await service.createContainer({
      image: 'example/image:1.0.0',
      port: '8091',
      autoStart: false,
      provisioner: 'openai',
    });

    const manualRunArgs = execMock.mock.calls.find(
      ([command, args]) => command === 'run' && args.includes('--restart'),
    )?.[1];
    expect(manualRunArgs).toBeTruthy();
    expect(manualRunArgs as string[]).toContain('no');
  });

  it('throws descriptive error when port conflict is not from our container', async () => {
    const conflictContainer: DockerListedContainer = {
      Id: 'abc123456789',
      Names: ['/other-service'],
      Image: 'conflict/image:latest',
      State: 'running',
      Status: 'Up',
      Ports: [
        {
          PrivatePort: 8080,
          PublicPort: 8090,
          Type: 'tcp',
        },
      ],
      Created: Date.now(),
    } as DockerListedContainer;

    listContainersMock
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([conflictContainer]);

    const service = createContainerService({ client });
    const config = {
      image: 'example/image:1.0.0',
      port: '8090',
      autoStart: true,
      provisioner: 'openai' as const,
    };

    await expect(service.createContainer(config)).rejects.toThrow(/Port 8090 is already in use/);
    expect(execMock).not.toHaveBeenCalled();
  });

  it('recreates container when start fails due to missing volume', async () => {
    const existingContainer: DockerListedContainer = {
      Id: 'existing123',
      Names: ['/openwebui-extension-service'],
      Image: 'ghcr.io/open-webui/open-webui:main',
      State: 'exited',
      Status: 'Exited (1) 2 hours ago',
      Labels: {
        'com.docker.extension.openwebui': 'true',
        'com.docker.extension.openwebui.role': 'service',
        'com.docker.extension.openwebui.provisioner': 'openai',
      },
      Ports: [],
      Created: Date.now(),
    } as DockerListedContainer;

    listContainersMock.mockResolvedValueOnce([existingContainer]).mockResolvedValueOnce([]);

    execMock.mockImplementation(async (command) => {
      if (command === 'start') {
        throw new Error(
          'failed to mount local volume: mount open-webui-docker-extension-data: no such volume',
        );
      }
      return { stdout: '', stderr: '' };
    });

    const service = createContainerService({ client });
    await expect(
      service.createContainer({
        image: 'example/image:1.0.0',
        port: '8090',
        autoStart: true,
        provisioner: 'openai',
      }),
    ).resolves.toBeUndefined();

    expect(execMock).toHaveBeenCalledWith('start', ['existing123']);
    expect(execMock).toHaveBeenCalledWith('rm', ['-f', 'existing123']);
    expect(execMock.mock.calls.some(([command]) => command === 'run')).toBe(true);
  });

  it('recovers when existing container is removed during start/recreate flow', async () => {
    const existingContainer: DockerListedContainer = {
      Id: 'vanished123',
      Names: ['/openwebui-extension-service'],
      Image: 'ghcr.io/open-webui/open-webui:main',
      State: 'exited',
      Status: 'Exited (0) 10 seconds ago',
      Labels: {
        'com.docker.extension.openwebui': 'true',
        'com.docker.extension.openwebui.role': 'service',
        'com.docker.extension.openwebui.provisioner': 'openai',
      },
      Ports: [],
      Created: Date.now(),
    } as DockerListedContainer;

    listContainersMock.mockResolvedValueOnce([existingContainer]).mockResolvedValueOnce([]);

    execMock.mockImplementation(async (command) => {
      if (command === 'start') {
        throw new Error('Error response from daemon: No such container: vanished123');
      }
      if (command === 'rm') {
        throw new Error('Error response from daemon: No such container: vanished123');
      }
      return { stdout: '', stderr: '' };
    });

    const service = createContainerService({ client });
    await expect(
      service.createContainer({
        image: 'example/image:1.0.0',
        port: '8090',
        autoStart: true,
        provisioner: 'openai',
      }),
    ).resolves.toBeUndefined();

    expect(execMock).toHaveBeenCalledWith('start', ['vanished123']);
    expect(execMock).toHaveBeenCalledWith('rm', ['-f', 'vanished123']);
    expect(execMock.mock.calls.some(([command]) => command === 'run')).toBe(true);
  });

  it('continues container creation when floating-tag pre-pull hits transient network errors', async () => {
    listContainersMock
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([]);

    execMock.mockImplementation(async (command, args) => {
      if (command === 'pull' && args[0] === 'ghcr.io/open-webui/open-webui:main') {
        throw { stderr: 'Get "https://ghcr.io/v2/": dial tcp: i/o timeout' };
      }
      return { stdout: '', stderr: '' };
    });

    const service = createContainerService({ client });
    await expect(
      service.createContainer({
        image: 'ghcr.io/open-webui/open-webui:main',
        port: '8090',
        autoStart: true,
        provisioner: 'openai',
      }),
    ).resolves.toBeUndefined();

    expect(execMock).toHaveBeenCalledWith('pull', ['ghcr.io/open-webui/open-webui:main']);
    const runArgs = execMock.mock.calls.find(([command]) => command === 'run')?.[1] as
      | string[]
      | undefined;
    expect(runArgs).toBeTruthy();
    expect(runArgs).toContain('--pull');
    expect(runArgs).toContain('always');
  });

  it('injects OpenAI provider env vars only for openai provisioner', async () => {
    listContainersMock.mockResolvedValueOnce([]).mockResolvedValueOnce([]).mockResolvedValue([]);

    const service = createContainerService({ client });
    await service.createContainer({
      image: 'example/image:1.0.0',
      port: '8090',
      autoStart: true,
      provisioner: 'openai',
    });

    const openAIRunArgs = execMock.mock.calls.find(([command]) => command === 'run')?.[1] as
      | string[]
      | undefined;
    expect(openAIRunArgs).toBeTruthy();
    expect(openAIRunArgs).toContain(
      'OPENAI_API_BASE_URLS=http://model-runner.docker.internal/engines/llama.cpp/v1',
    );
    expect(openAIRunArgs).toContain('OPENAI_API_KEYS=not-required');
    expect(openAIRunArgs).toContain('com.docker.extension.openwebui.provisioner=openai');

    execMock.mockClear();
    listContainersMock.mockResolvedValueOnce([]).mockResolvedValueOnce([]).mockResolvedValue([]);

    await service.createContainer({
      image: 'example/image:1.0.0',
      port: '8091',
      autoStart: true,
      provisioner: 'legacy-function',
    });

    const legacyRunArgs = execMock.mock.calls.find(([command]) => command === 'run')?.[1] as
      | string[]
      | undefined;
    expect(legacyRunArgs).toBeTruthy();
    expect(legacyRunArgs?.some((arg) => arg.includes('OPENAI_API_BASE_URLS='))).toBe(false);
    expect(legacyRunArgs?.some((arg) => arg.includes('OPENAI_API_KEYS='))).toBe(false);
    expect(legacyRunArgs).toContain('com.docker.extension.openwebui.provisioner=legacy-function');
  });

  it('returns unsupported update check result for pinned tags', async () => {
    const service = createContainerService({ client });

    const result = await service.checkImageUpdateAvailability(
      'ghcr.io/open-webui/open-webui:0.5.0',
    );

    expect(result.supported).toBe(false);
    expect(result.updateAvailable).toBe(false);
    expect(execMock).not.toHaveBeenCalled();
  });

  it('uses buildx imagetools digest as primary comparison source', async () => {
    execMock.mockImplementation(async (command, args) => {
      if (command === 'image' && args[0] === 'inspect') {
        return {
          stdout: JSON.stringify([
            {
              RepoDigests: [`ghcr.io/open-webui/open-webui@${LOCAL_DIGEST}`],
              Descriptor: {
                mediaType: 'application/vnd.oci.image.index.v1+json',
                digest: LOCAL_DIGEST,
              },
            },
          ]),
          stderr: '',
        };
      }
      if (command === 'buildx' && args[0] === 'imagetools' && args[1] === 'inspect') {
        return {
          stdout: `Name: ghcr.io/open-webui/open-webui:main\nDigest: ${LOCAL_DIGEST}\n`,
          stderr: '',
        };
      }
      return { stdout: '', stderr: '' };
    });

    const service = createContainerService({ client });
    const result = await service.checkImageUpdateAvailability('ghcr.io/open-webui/open-webui:main');

    expect(result.supported).toBe(true);
    expect(result.updateAvailable).toBe(false);
    expect(result.localDigest).toBe(LOCAL_DIGEST);
    expect(result.remoteDigest).toBe(LOCAL_DIGEST);
  });

  it('reports update available when buildx imagetools digest differs', async () => {
    execMock.mockImplementation(async (command, args) => {
      if (command === 'image' && args[0] === 'inspect') {
        return {
          stdout: JSON.stringify([
            {
              RepoDigests: [`ghcr.io/open-webui/open-webui@${LOCAL_DIGEST}`],
              Descriptor: {
                mediaType: 'application/vnd.oci.image.index.v1+json',
                digest: LOCAL_DIGEST,
              },
            },
          ]),
          stderr: '',
        };
      }
      if (command === 'buildx' && args[0] === 'imagetools' && args[1] === 'inspect') {
        return {
          stdout: `Name: ghcr.io/open-webui/open-webui:main\nDigest: ${REMOTE_DIGEST}\n`,
          stderr: '',
        };
      }
      return { stdout: '', stderr: '' };
    });

    const service = createContainerService({ client });
    const result = await service.checkImageUpdateAvailability('ghcr.io/open-webui/open-webui:main');

    expect(result.supported).toBe(true);
    expect(result.updateAvailable).toBe(true);
    expect(result.localDigest).toBe(LOCAL_DIGEST);
    expect(result.remoteDigest).toBe(REMOTE_DIGEST);
  });

  it('handles missing local floating-tag image without crashing update checks', async () => {
    execMock.mockImplementation(async (command, args) => {
      if (command === 'image' && args[0] === 'inspect') {
        throw new Error(
          'Error response from daemon: No such image: ghcr.io/open-webui/open-webui:main',
        );
      }
      if (command === 'buildx' && args[0] === 'imagetools' && args[1] === 'inspect') {
        return {
          stdout: `Name: ghcr.io/open-webui/open-webui:main\nDigest: ${REMOTE_DIGEST}\n`,
          stderr: '',
        };
      }
      return { stdout: '', stderr: '' };
    });

    const service = createContainerService({ client });
    const result = await service.checkImageUpdateAvailability('ghcr.io/open-webui/open-webui:main');

    expect(result.supported).toBe(true);
    expect(result.updateAvailable).toBe(false);
    expect(result.remoteDigest).toBe(REMOTE_DIGEST);
    expect(result.error).toContain('Local image digest is unavailable');
  });

  it('skips update notice when remote tag digest cannot be determined', async () => {
    execMock.mockImplementation(async (command, args) => {
      if (command === 'image' && args[0] === 'inspect') {
        return {
          stdout: JSON.stringify([
            {
              RepoDigests: [`ghcr.io/open-webui/open-webui@${LOCAL_DIGEST}`],
              Descriptor: {
                mediaType: 'application/vnd.oci.image.index.v1+json',
                digest: LOCAL_DIGEST,
              },
            },
          ]),
          stderr: '',
        };
      }
      if (command === 'buildx' && args[0] === 'imagetools' && args[1] === 'inspect') {
        throw { stderr: 'command "buildx imagetools inspect" unavailable' };
      }
      if (command === 'manifest' && args[0] === 'inspect') {
        throw { stderr: 'manifest inspect failed' };
      }
      return { stdout: '', stderr: '' };
    });

    const service = createContainerService({ client });
    const result = await service.checkImageUpdateAvailability('ghcr.io/open-webui/open-webui:main');

    expect(result.supported).toBe(true);
    expect(result.updateAvailable).toBe(false);
    expect(result.localDigest).toBe(LOCAL_DIGEST);
    expect(result.error).toContain('Unable to determine remote tag digest');
    expect(
      execMock.mock.calls.some(
        ([command, args]) => command === 'manifest' && args[0] === 'inspect',
      ),
    ).toBe(true);
  });

  it('uses manifest inspect fallback when buildx imagetools inspect fails', async () => {
    execMock.mockImplementation(async (command, args) => {
      if (command === 'image' && args[0] === 'inspect') {
        return {
          stdout: JSON.stringify([
            {
              RepoDigests: [`ghcr.io/open-webui/open-webui@${LOCAL_DIGEST}`],
              Descriptor: {
                mediaType: 'application/vnd.oci.image.index.v1+json',
                digest: LOCAL_DIGEST,
              },
            },
          ]),
          stderr: '',
        };
      }
      if (command === 'buildx' && args[0] === 'imagetools' && args[1] === 'inspect') {
        throw { stderr: 'buildx not available' };
      }
      if (command === 'manifest' && args[0] === 'inspect') {
        return {
          stdout: JSON.stringify({
            Ref: 'ghcr.io/open-webui/open-webui:main',
            Descriptor: {
              mediaType: 'application/vnd.docker.distribution.manifest.list.v2+json',
              digest: REMOTE_DIGEST,
              size: 1234,
            },
          }),
          stderr: '',
        };
      }
      return { stdout: '', stderr: '' };
    });

    const service = createContainerService({ client });
    const result = await service.checkImageUpdateAvailability('ghcr.io/open-webui/open-webui:main');

    expect(result.supported).toBe(true);
    expect(result.updateAvailable).toBe(true);
    expect(result.localDigest).toBe(LOCAL_DIGEST);
    expect(result.remoteDigest).toBe(REMOTE_DIGEST);
    expect(
      execMock.mock.calls.some(
        ([command, args]) => command === 'manifest' && args[0] === 'inspect',
      ),
    ).toBe(true);
  });

  it('returns readable error when local digest lookup fails with docker object error', async () => {
    execMock.mockImplementation(async (command, args) => {
      if (command === 'image' && args[0] === 'inspect') {
        throw {
          code: 64,
          stderr: 'template parsing error: template: :1: unclosed action',
          cmd: 'docker image inspect',
        };
      }
      return { stdout: '', stderr: '' };
    });

    const service = createContainerService({ client });
    const result = await service.checkImageUpdateAvailability('ghcr.io/open-webui/open-webui:main');

    expect(result.supported).toBe(true);
    expect(result.updateAvailable).toBe(false);
    expect(result.error).toContain('template parsing error');
    expect(result.error).not.toContain('[object Object]');
  });

  it('pullImage executes docker pull for provided image', async () => {
    const service = createContainerService({ client });
    await service.pullImage('ghcr.io/open-webui/open-webui:main');

    expect(execMock).toHaveBeenCalledWith('pull', ['ghcr.io/open-webui/open-webui:main']);
  });

  describe('needsProvisionerReconciliation', () => {
    it('returns false when no container exists', async () => {
      listContainersMock.mockResolvedValue([]);
      const service = createContainerService({ client });
      const result = await service.needsProvisionerReconciliation({
        image: 'img:tag',
        port: '8090',
        autoStart: true,
        provisioner: 'openai',
      });
      expect(result).toBe(false);
    });

    it('returns true when container has no provisioner label (old version)', async () => {
      const oldContainer: DockerListedContainer = {
        Id: 'old123',
        Names: ['/openwebui-extension-service'],
        Image: 'ghcr.io/open-webui/open-webui:main',
        State: 'exited',
        Status: 'Exited (0)',
        Labels: {
          'com.docker.extension.openwebui': 'true',
          'com.docker.extension.openwebui.role': 'service',
          // No provisioner label — simulates the old extension version.
        },
        Ports: [],
        Created: Date.now(),
      };
      listContainersMock.mockResolvedValue([oldContainer]);

      const service = createContainerService({ client });
      const result = await service.needsProvisionerReconciliation({
        image: 'ghcr.io/open-webui/open-webui:main',
        port: '8090',
        autoStart: true,
        provisioner: 'openai',
      });
      expect(result).toBe(true);
    });

    it('returns true when container provisioner label mismatches config', async () => {
      const container: DockerListedContainer = {
        Id: 'mismatch123',
        Names: ['/openwebui-extension-service'],
        Image: 'ghcr.io/open-webui/open-webui:main',
        State: 'running',
        Status: 'Up',
        Labels: {
          'com.docker.extension.openwebui': 'true',
          'com.docker.extension.openwebui.role': 'service',
          'com.docker.extension.openwebui.provisioner': 'legacy-function',
        },
        Ports: [],
        Created: Date.now(),
      };
      listContainersMock.mockResolvedValue([container]);

      const service = createContainerService({ client });
      const result = await service.needsProvisionerReconciliation({
        image: 'ghcr.io/open-webui/open-webui:main',
        port: '8090',
        autoStart: true,
        provisioner: 'openai',
      });
      expect(result).toBe(true);
    });

    it('returns false when container provisioner label matches config', async () => {
      const container: DockerListedContainer = {
        Id: 'match123',
        Names: ['/openwebui-extension-service'],
        Image: 'ghcr.io/open-webui/open-webui:main',
        State: 'running',
        Status: 'Up',
        Labels: {
          'com.docker.extension.openwebui': 'true',
          'com.docker.extension.openwebui.role': 'service',
          'com.docker.extension.openwebui.provisioner': 'openai',
        },
        Ports: [],
        Created: Date.now(),
      };
      listContainersMock.mockResolvedValue([container]);

      const service = createContainerService({ client });
      const result = await service.needsProvisionerReconciliation({
        image: 'ghcr.io/open-webui/open-webui:main',
        port: '8090',
        autoStart: true,
        provisioner: 'openai',
      });
      expect(result).toBe(false);
    });
  });

  describe('createContainerInternal – provisioner reconciliation', () => {
    it('removes and recreates container when provisioner label is missing', async () => {
      const oldContainer: DockerListedContainer = {
        Id: 'old-no-label',
        Names: ['/openwebui-extension-service'],
        Image: 'ghcr.io/open-webui/open-webui:main',
        State: 'exited',
        Status: 'Exited (0)',
        Labels: {
          'com.docker.extension.openwebui': 'true',
          'com.docker.extension.openwebui.role': 'service',
        },
        Ports: [],
        Created: Date.now(),
      };

      listContainersMock
        .mockResolvedValueOnce([oldContainer]) // findContainer in createContainerInternal
        .mockResolvedValueOnce([]); // isHostPortInUse

      const service = createContainerService({ client });
      await service.createContainer({
        image: 'ghcr.io/open-webui/open-webui:main',
        port: '8090',
        autoStart: true,
        provisioner: 'openai',
      });

      // Should have removed the old container.
      expect(execMock).toHaveBeenCalledWith('rm', ['-f', 'old-no-label']);
      // Should NOT have tried to start the old container.
      expect(execMock).not.toHaveBeenCalledWith('start', ['old-no-label']);
      // Should have created a new container via docker run.
      expect(execMock.mock.calls.some(([cmd]) => cmd === 'run')).toBe(true);
    });

    it('removes running container with stale provisioner label and recreates', async () => {
      const staleContainer: DockerListedContainer = {
        Id: 'stale-running',
        Names: ['/openwebui-extension-service'],
        Image: 'ghcr.io/open-webui/open-webui:main',
        State: 'running',
        Status: 'Up 2 hours',
        Labels: {
          'com.docker.extension.openwebui': 'true',
          'com.docker.extension.openwebui.role': 'service',
          'com.docker.extension.openwebui.provisioner': 'legacy-function',
        },
        Ports: [{ PrivatePort: 8080, PublicPort: 8090 }],
        Created: Date.now(),
      };

      listContainersMock
        .mockResolvedValueOnce([staleContainer]) // findContainer in createContainerInternal
        .mockResolvedValueOnce([]); // isHostPortInUse

      const service = createContainerService({ client });
      await service.createContainer({
        image: 'ghcr.io/open-webui/open-webui:main',
        port: '8090',
        autoStart: true,
        provisioner: 'openai',
      });

      // Should have stopped and removed the stale container.
      expect(execMock).toHaveBeenCalledWith('stop', ['stale-running']);
      expect(execMock).toHaveBeenCalledWith('rm', ['-f', 'stale-running']);
      // Should have created a new container.
      expect(execMock.mock.calls.some(([cmd]) => cmd === 'run')).toBe(true);
    });

    it('starts existing container normally when provisioner label matches', async () => {
      const matchingContainer: DockerListedContainer = {
        Id: 'matching-stopped',
        Names: ['/openwebui-extension-service'],
        Image: 'ghcr.io/open-webui/open-webui:main',
        State: 'exited',
        Status: 'Exited (0)',
        Labels: {
          'com.docker.extension.openwebui': 'true',
          'com.docker.extension.openwebui.role': 'service',
          'com.docker.extension.openwebui.provisioner': 'openai',
        },
        Ports: [],
        Created: Date.now(),
      };

      listContainersMock.mockResolvedValue([matchingContainer]);

      const service = createContainerService({ client });
      await service.createContainer({
        image: 'ghcr.io/open-webui/open-webui:main',
        port: '8090',
        autoStart: true,
        provisioner: 'openai',
      });

      // Should have started the existing container without removing it.
      expect(execMock).toHaveBeenCalledWith('start', ['matching-stopped']);
      expect(execMock).not.toHaveBeenCalledWith('rm', ['-f', 'matching-stopped']);
      expect(execMock.mock.calls.some(([cmd]) => cmd === 'run')).toBe(false);
    });
  });
});
