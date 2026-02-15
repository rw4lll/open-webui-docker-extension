interface DockerCliErrorFields {
  message?: unknown;
  stderr?: unknown;
  stdout?: unknown;
  code?: unknown;
  cmd?: unknown;
}

export function isDockerCliError(value: unknown): value is DockerCliErrorFields {
  return Boolean(value) && typeof value === 'object';
}

export function getStderr(error: unknown): string | undefined {
  if (!isDockerCliError(error) || typeof error.stderr !== 'string') {
    return undefined;
  }
  const normalized = error.stderr.trim();
  return normalized.length > 0 ? normalized : undefined;
}

export function toErrorMessage(error: unknown): string {
  if (error instanceof Error && typeof error.message === 'string' && error.message.trim().length > 0) {
    return error.message.trim();
  }

  if (isDockerCliError(error)) {
    const parts: string[] = [];
    if (typeof error.message === 'string' && error.message.trim().length > 0) {
      parts.push(error.message.trim());
    }
    if (typeof error.stderr === 'string' && error.stderr.trim().length > 0) {
      parts.push(error.stderr.trim());
    }
    if (typeof error.stdout === 'string' && error.stdout.trim().length > 0) {
      parts.push(error.stdout.trim());
    }
    if (typeof error.code === 'number' && Number.isFinite(error.code) && error.code >= 0) {
      parts.push(`exit code ${error.code}`);
    }
    if (typeof error.cmd === 'string' && error.cmd.trim().length > 0) {
      parts.push(`command: ${error.cmd.trim()}`);
    }

    if (parts.length > 0) {
      return parts.join(' | ');
    }

    try {
      return JSON.stringify(error);
    } catch {
      return String(error);
    }
  }

  return String(error);
}
