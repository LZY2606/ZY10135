import { defineConfig } from 'vitest/config';
import { createApiMiddleware } from './src/server/api.ts';

// Node 22.5+ / 26 ships node:sqlite; older Vite resolvers do not know it and
// strip the "node:" prefix, so externalize it explicitly in every pipeline.
function externalizeNodeSqlite() {
  return {
    name: 'externalize-node-sqlite',
    enforce: 'pre' as const,
    resolveId(source: string) {
      if (source === 'node:sqlite' || source === 'sqlite') {
        return { id: 'node:sqlite', external: true };
      }
      return null;
    },
  };
}

export default defineConfig({
  plugins: [
    externalizeNodeSqlite(),
    {
      name: 'lineage-api',
      configureServer(server) {
        server.middlewares.use(createApiMiddleware());
      },
      configurePreviewServer(server) {
        server.middlewares.use(createApiMiddleware());
      },
    },
  ],
  ssr: {
    external: ['node:sqlite'],
  },
  optimizeDeps: {
    exclude: ['node:sqlite'],
  },
  server: {
    host: '127.0.0.1',
    port: 5335,
    strictPort: true,
  },
  preview: {
    host: '127.0.0.1',
    port: 5335,
    strictPort: true,
  },
  test: {
    environment: 'node',
    include: ['test/**/*.test.ts'],
    pool: 'forks',
    server: {
      deps: {
        external: [/node:sqlite/, /^node:/],
      },
    },
  },
});
