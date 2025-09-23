import path from 'node:path';
import { fileURLToPath } from 'node:url';

import react from '@vitejs/plugin-react-swc';
import { defineConfig, configDefaults } from 'vitest/config';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const dockerClientMock = path.resolve(__dirname, 'test/mocks/docker-client.ts');

// https://vitejs.dev/config/
export default defineConfig(() => ({
  plugins: [react()],
  base: './',
  build: {
    outDir: 'build',
  },
  server: {
    port: 3000,
    strictPort: true,
  },
  resolve: {
    alias: process.env.VITEST
      ? {
          '@docker/extension-api-client': dockerClientMock,
        }
      : undefined,
  },
  test: {
    environment: 'jsdom',
    globals: true,
    setupFiles: ['./test/setup-env.ts'],
    coverage: { provider: 'v8', reporter: ['text', 'json-summary'] },
    exclude: [...configDefaults.exclude, 'build/**'],
  },
}));
