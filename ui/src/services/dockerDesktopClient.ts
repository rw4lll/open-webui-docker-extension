import { createDockerDesktopClient } from '@docker/extension-api-client';

export type DockerDesktopClient = ReturnType<typeof createDockerDesktopClient>;

let cachedClient: DockerDesktopClient | null = null;

// Centralized accessor for Docker Desktop client to provide clearer errors
export function getDDClient(): DockerDesktopClient {
  try {
    if (!cachedClient) {
      cachedClient = createDockerDesktopClient();
    }
    return cachedClient;
  } catch (_error) {
    // Helpful error for dev/browser environments outside Docker Desktop
    throw new Error(
      'Docker Desktop Extension API is not available. Run this UI inside Docker Desktop, or use the test mocks in Vitest.',
    );
  }
}
