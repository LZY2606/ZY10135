import { createServer as createViteServer } from 'vite';
import { pathToFileURL } from 'node:url';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { existsSync, mkdirSync } from 'node:fs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = resolve(__dirname, '..');
const dataDir = resolve(root, 'data');
if (!existsSync(dataDir)) mkdirSync(dataDir, { recursive: true });

const host = process.argv.includes('--host')
  ? process.argv[process.argv.indexOf('--host') + 1]
  : '127.0.0.1';
const portArgIndex = process.argv.indexOf('--port');
const port = portArgIndex !== -1 ? Number(process.argv[portArgIndex + 1]) : 5335;
const strictPort = process.argv.includes('--strictPort');

const dbUrl = new URL('./db.js', pathToFileURL(__dirname.endsWith('/') ? __dirname : __dirname + '/'));
const { openDatabase } = await import(dbUrl.href);
const { createApp } = await import(new URL('./api.js', dbUrl).href);
const { seedFixture } = await import(new URL('./seed.js', dbUrl).href);

const dbPath = process.env.LINEAGE_DB_PATH
  ? resolve(process.env.LINEAGE_DB_PATH)
  : resolve(dataDir, 'lineage.sqlite');
const db = openDatabase(dbPath);
seedFixture(db);
const api = createApp(db);

const vite = await createViteServer({
  root,
  configFile: resolve(root, 'vite.config.js'),
  server: {
    host,
    port,
    strictPort,
    middlewareMode: false,
  },
  plugins: [
    {
      name: 'lineage-api',
      configureServer(server) {
        server.middlewares.use(api);
      },
    },
  ],
});

await vite.listen();
vite.printUrls();
