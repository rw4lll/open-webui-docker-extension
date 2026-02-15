import { describe, expect, it, vi } from 'vitest';

import { DMR_DEFAULTS } from '../../constants';
import type { LegacyProvisionerDetails } from './types';
import { LegacyFunctionProvisioner } from './legacyFunctionProvisioner';

describe('LegacyFunctionProvisioner', () => {
  it('installs and enables legacy function during setup', async () => {
    const http = {
      waitUntilOpenWebUIReady: vi.fn().mockResolvedValue(true),
      isContainerHealthy: vi.fn().mockResolvedValue(true),
      containerCurl: vi.fn().mockResolvedValue('{"data":[]}'),
      execInContainer: vi.fn().mockResolvedValue(''),
    } as any;

    const functions = {
      isFunctionInstalled: vi.fn().mockResolvedValue(false),
      installFunction: vi.fn().mockResolvedValue({
        success: true,
        message: 'ok',
        functionId: 'docker_model_runner',
      }),
      getFunctionById: vi
        .fn()
        .mockResolvedValueOnce({ id: 'docker_model_runner', isActive: false, isGlobal: false })
        .mockResolvedValueOnce({ id: 'docker_model_runner', isActive: true, isGlobal: true }),
      isFunctionActive: vi.fn((fn) => Boolean(fn?.isActive)),
      ensureFunctionEnabled: vi.fn().mockResolvedValue(undefined),
      uninstallFunction: vi.fn().mockResolvedValue(true),
    } as any;

    const provisioner = new LegacyFunctionProvisioner({
      http,
      functions,
      dmrConfig: { ...DMR_DEFAULTS },
    });

    const status = await provisioner.setupIntegration();

    expect(status.mode).toBe('legacy-function');
    expect(status.integrationConfigured).toBe(true);
    expect(status.dockerModelRunnerConnected).toBe(true);
    expect((status.details as LegacyProvisionerDetails)?.functionInstalled).toBe(true);
    expect((status.details as LegacyProvisionerDetails)?.functionEnabled).toBe(true);
    expect(functions.installFunction).toHaveBeenCalledTimes(1);
    expect(functions.ensureFunctionEnabled).toHaveBeenCalledWith('docker_model_runner', true);
  });

  it('returns unconfigured status when Open WebUI is not ready', async () => {
    const http = {
      waitUntilOpenWebUIReady: vi.fn().mockResolvedValue(false),
      isContainerHealthy: vi.fn().mockResolvedValue(false),
      containerCurl: vi.fn(),
      execInContainer: vi.fn(),
    } as any;

    const functions = {
      isFunctionInstalled: vi.fn(),
      installFunction: vi.fn(),
      getFunctionById: vi.fn(),
      isFunctionActive: vi.fn(),
      ensureFunctionEnabled: vi.fn(),
      uninstallFunction: vi.fn(),
    } as any;

    const provisioner = new LegacyFunctionProvisioner({
      http,
      functions,
      dmrConfig: { ...DMR_DEFAULTS },
    });

    const status = await provisioner.setupIntegration();

    expect(status.containerRunning).toBe(false);
    expect(status.integrationConfigured).toBe(false);
    expect(status.dockerModelRunnerConnected).toBe(false);
  });

  it('exposes fast verify path for non-mutating status checks', async () => {
    const http = {
      waitUntilOpenWebUIReady: vi.fn().mockResolvedValue(true),
      isContainerHealthy: vi.fn().mockResolvedValue(true),
      containerCurl: vi.fn().mockResolvedValue('{"data":[]}'),
      execInContainer: vi.fn().mockResolvedValue(''),
    } as any;

    const functions = {
      isFunctionInstalled: vi.fn().mockResolvedValue(true),
      installFunction: vi.fn(),
      getFunctionById: vi
        .fn()
        .mockResolvedValue({ id: 'docker_model_runner', isActive: true, isGlobal: true }),
      isFunctionActive: vi.fn((fn) => Boolean(fn?.isActive)),
      ensureFunctionEnabled: vi.fn(),
      uninstallFunction: vi.fn(),
    } as any;

    const provisioner = new LegacyFunctionProvisioner({
      http,
      functions,
      dmrConfig: { ...DMR_DEFAULTS },
    });

    const status = await provisioner.verifyIntegration();
    expect(status.integrationConfigured).toBe(true);
    expect(functions.installFunction).not.toHaveBeenCalled();
    expect(functions.ensureFunctionEnabled).not.toHaveBeenCalled();
  });

  it('removes legacy function during inactive cleanup', async () => {
    const http = {
      waitUntilOpenWebUIReady: vi.fn().mockResolvedValue(true),
      isContainerHealthy: vi.fn().mockResolvedValue(true),
      containerCurl: vi.fn().mockResolvedValue(''),
      execInContainer: vi.fn().mockResolvedValue(''),
    } as any;

    const functions = {
      isFunctionInstalled: vi.fn(),
      installFunction: vi.fn(),
      getFunctionById: vi.fn(),
      isFunctionActive: vi.fn(),
      ensureFunctionEnabled: vi.fn(),
      uninstallFunction: vi.fn().mockResolvedValue(true),
    } as any;

    const provisioner = new LegacyFunctionProvisioner({
      http,
      functions,
      dmrConfig: { ...DMR_DEFAULTS },
    });

    await provisioner.cleanupInactiveArtifacts();

    expect(functions.uninstallFunction).toHaveBeenCalledWith('docker_model_runner', {
      throwOnError: true,
    });
  });
});
