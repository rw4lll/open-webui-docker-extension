import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { DockerDesktopClient } from './dockerDesktopClient';
import { DockerMcpToolkitService } from './dockerMcpToolkitService';

describe('DockerMcpToolkitService', () => {
  let execMock: ReturnType<typeof vi.fn>;
  let listContainersMock: ReturnType<typeof vi.fn>;
  let client: DockerDesktopClient;

  beforeEach(() => {
    execMock = vi.fn();
    listContainersMock = vi.fn(async () => []);
    client = {
      docker: {
        cli: { exec: execMock },
        listContainers: listContainersMock,
      },
    } as unknown as DockerDesktopClient;
  });

  it('probes toolkit support and resolves manual instructions when available', async () => {
    execMock
      .mockResolvedValueOnce({ stdout: 'docker/mcp_gateway/v/test', stderr: '' }) // version
      .mockResolvedValueOnce({ stdout: '{"id":"default"}', stderr: '' }) // profile show default
      .mockResolvedValueOnce({
        stdout: '["docker","mcp","gateway","run","--profile","default"]',
        stderr: '',
      }); // manual instructions

    const service = new DockerMcpToolkitService({
      dockerClientProvider: () => client,
    });
    const result = await service.probe();

    expect(result.supported).toBe(true);
    expect(result.profileAvailable).toBe(true);
    expect(result.probeSource).toBe('manual-instructions');
    expect(result.profileId).toBe('default');
    expect(result.gatewayUrl).toBe('http://host.docker.internal:8812/mcp');
    expect(result.gatewayHealthUrl).toBe('http://host.docker.internal:8812/health');
    expect(result.manualInstructionsCommand).toEqual([
      'docker',
      'mcp',
      'gateway',
      'run',
      '--profile',
      'default',
    ]);
  });

  it('marks default profile as missing without failing toolkit support', async () => {
    execMock
      .mockResolvedValueOnce({ stdout: 'docker/mcp_gateway/v/test', stderr: '' })
      .mockRejectedValueOnce({ stderr: 'profile default not found' });

    const service = new DockerMcpToolkitService({
      dockerClientProvider: () => client,
    });
    const result = await service.probe();

    expect(result.supported).toBe(true);
    expect(result.profileAvailable).toBe(false);
    expect(result.unsupportedReason).toBe('default-profile-missing');
  });

  it('classifies Docker Desktop not running as unsupported', async () => {
    execMock.mockRejectedValueOnce({ stderr: 'Docker Desktop is not running' });

    const service = new DockerMcpToolkitService({
      dockerClientProvider: () => client,
    });
    const result = await service.probe();

    expect(result.supported).toBe(false);
    expect(result.profileAvailable).toBe(false);
    expect(result.unsupportedReason).toBe('docker-desktop-not-running');
  });

  it('returns cached probe results unless force is requested', async () => {
    execMock
      .mockResolvedValueOnce({ stdout: 'docker/mcp_gateway/v/test', stderr: '' })
      .mockResolvedValueOnce({ stdout: '{"id":"default"}', stderr: '' })
      .mockResolvedValueOnce({
        stdout: '["docker","mcp","gateway","run","--profile","default"]',
        stderr: '',
      })
      .mockResolvedValueOnce({ stdout: 'docker/mcp_gateway/v/test', stderr: '' })
      .mockResolvedValueOnce({ stdout: '{"id":"default"}', stderr: '' })
      .mockResolvedValueOnce({
        stdout: '["docker","mcp","gateway","run","--profile","default"]',
        stderr: '',
      });

    const service = new DockerMcpToolkitService({
      dockerClientProvider: () => client,
    });

    await service.probe();
    await service.probe();
    await service.probe({ force: true });

    // First + force probe execute commands; the middle call is served from cache.
    expect(execMock).toHaveBeenCalledTimes(6);
  });

  it('uses plain profile show syntax before flag variants', async () => {
    execMock.mockImplementation(async (_command: string, args: string[]) => {
      if (args.join(' ') === 'version') {
        return { stdout: 'docker/mcp_gateway/v/test', stderr: '' };
      }
      if (args.join(' ') === 'profile show default') {
        return { stdout: 'Name: default', stderr: '' };
      }
      if (args.join(' ') === 'client manual-instructions --json') {
        return {
          stdout: '["docker","mcp","gateway","run","--profile","default"]',
          stderr: '',
        };
      }
      throw new Error(`Unexpected command args: ${args.join(' ')}`);
    });

    const service = new DockerMcpToolkitService({
      dockerClientProvider: () => client,
    });
    const result = await service.probe();

    expect(result.supported).toBe(true);
    expect(result.profileAvailable).toBe(true);
    expect(result.unsupportedReason).toBeUndefined();
    expect(result.probeSource).toBe('manual-instructions');
    const executedArgStrings = execMock.mock.calls.map(([, args]) => (args as string[]).join(' '));
    expect(executedArgStrings).not.toContain('profile show default --format json');
    expect(executedArgStrings).not.toContain('profile show default --json');
  });

  it('creates gateway container when managed container is absent', async () => {
    execMock
      .mockResolvedValueOnce({ stdout: '[]', stderr: '' }) // server ls --json
      .mockResolvedValueOnce({ stdout: 'container-id', stderr: '' }); // docker run

    const service = new DockerMcpToolkitService({
      dockerClientProvider: () => client,
    });
    const status = await service.ensureGatewayContainerRunning();

    expect(status.running).toBe(true);
    expect(status.launched).toBe(true);
    expect(execMock).toHaveBeenCalledTimes(2);
    expect(execMock).toHaveBeenNthCalledWith(1, 'mcp', ['server', 'ls', '--json']);
    expect(execMock).toHaveBeenCalledWith(
      'run',
      expect.arrayContaining([
        '-d',
        '--name',
        'openwebui-extension-mcp-gateway',
        '-v',
        '/var/run/docker.sock:/var/run/docker.sock',
        'docker/mcp-gateway:v2',
        '--transport',
        'streaming',
        '--servers',
        'docker',
      ]),
    );
  });

  it('starts an existing managed gateway container', async () => {
    listContainersMock.mockResolvedValueOnce([
      {
        Id: 'gateway-id',
        Names: ['/openwebui-extension-mcp-gateway'],
        Image: 'docker/mcp-gateway:v2',
        State: 'exited',
        Status: 'Exited (0) 10 seconds ago',
        Labels: {
          'com.docker.extension.openwebui': 'true',
          'com.docker.extension.openwebui.role': 'mcp-gateway',
        },
      },
    ]);
    execMock.mockResolvedValueOnce({ stdout: '', stderr: '' });

    const service = new DockerMcpToolkitService({
      dockerClientProvider: () => client,
    });
    const status = await service.ensureGatewayContainerRunning();

    expect(status.running).toBe(true);
    expect(status.launched).toBe(true);
    expect(execMock).toHaveBeenCalledTimes(1);
    expect(execMock).toHaveBeenCalledWith('start', ['gateway-id']);
  });

  it('mirrors host-enabled server names when starting gateway container', async () => {
    execMock
      .mockResolvedValueOnce({
        stdout: JSON.stringify([{ name: 'context7' }, { name: 'docker' }]),
        stderr: '',
      })
      .mockResolvedValueOnce({ stdout: 'container-id', stderr: '' });

    const service = new DockerMcpToolkitService({
      dockerClientProvider: () => client,
    });
    const status = await service.ensureGatewayContainerRunning();

    expect(status.running).toBe(true);
    expect(status.launched).toBe(true);
    expect(execMock).toHaveBeenNthCalledWith(1, 'mcp', ['server', 'ls', '--json']);
    const runCallArgs = execMock.mock.calls[1]?.[1] as string[];
    expect(runCallArgs).toEqual(
      expect.arrayContaining([
        '--servers',
        'context7',
        '--servers',
        'docker',
      ]),
    );
  });

  it('removes managed gateway container on teardown', async () => {
    listContainersMock.mockResolvedValueOnce([
      {
        Id: 'gateway-id',
        Names: ['/openwebui-extension-mcp-gateway'],
        Image: 'docker/mcp-gateway:v2',
        State: 'running',
        Status: 'Up 2 minutes',
        Labels: {
          'com.docker.extension.openwebui': 'true',
          'com.docker.extension.openwebui.role': 'mcp-gateway',
        },
      },
    ]);
    execMock.mockResolvedValueOnce({ stdout: '', stderr: '' });

    const service = new DockerMcpToolkitService({
      dockerClientProvider: () => client,
    });
    await service.removeManagedGatewayContainer();

    expect(execMock).toHaveBeenCalledTimes(1);
    expect(execMock).toHaveBeenCalledWith('rm', ['-f', 'gateway-id']);
  });
});

