import { describe, it, expect, vi, beforeEach } from 'vitest';

import { createContainerService } from './containerService';
import type { DockerDesktopClient } from './dockerDesktopClient';
import type { DockerListedContainer } from '../types';

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
    const config = { image: 'example/image:1.0.0', port: '8090', autoStart: true };

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
    const config = { image: 'example/image:1.0.0', port: '8090', autoStart: true };

    await expect(service.createContainer(config)).rejects.toThrow('Failed to create container');

    listContainersMock.mockResolvedValueOnce([]).mockResolvedValueOnce([]).mockResolvedValue([]);

    await expect(service.createContainer(config)).resolves.toBeUndefined();

    const runCalls = execMock.mock.calls.filter(([command]) => command === 'run');
    expect(runCalls).toHaveLength(2);
  });

  it('configures restart policy based on autoStart flag', async () => {
    listContainersMock.mockResolvedValueOnce([]).mockResolvedValueOnce([]).mockResolvedValue([]);

    const service = createContainerService({ client });

    await service.createContainer({ image: 'example/image:1.0.0', port: '8090', autoStart: true });

    const autoRunArgs = execMock.mock.calls.find(
      ([command, args]) => command === 'run' && args.includes('unless-stopped'),
    )?.[1];
    expect(autoRunArgs).toBeTruthy();
    expect(autoRunArgs as string[]).toContain('--restart');

    execMock.mockClear();
    listContainersMock.mockResolvedValueOnce([]).mockResolvedValueOnce([]).mockResolvedValue([]);

    await service.createContainer({ image: 'example/image:1.0.0', port: '8091', autoStart: false });

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
    const config = { image: 'example/image:1.0.0', port: '8090', autoStart: true };

    await expect(service.createContainer(config)).rejects.toThrow(/Port 8090 is already in use/);
    expect(execMock).not.toHaveBeenCalled();
  });
});
