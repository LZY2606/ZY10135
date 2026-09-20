import { defineConfig } from 'vite';

export default defineConfig({
  root: '.',
  server: {
    host: '127.0.0.1',
    port: 5335,
    strictPort: true,
  },
  test: {
    environment: 'node',
    include: ['test/**/*.test.js'],
  },
});
