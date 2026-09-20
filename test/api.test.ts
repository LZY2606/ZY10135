import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Server } from 'node:http';
import { openDb } from '../src/server/db.ts';
import { createApiRouter } from '../src/server/api.ts';
import { loadFixture } from './helpers.ts';

process.env.LINEAGE_NO_SEED = '1';

let server: Server;
let base: string;

beforeAll(async () => {
  const app = createApiRouter(openDb(':memory:'));
  await new Promise<void>((resolve) => {
    server = app.listen(0, '127.0.0.1', () => {
      const addr = server.address();
      if (addr && typeof addr === 'object') base = `http://127.0.0.1:${addr.port}`;
      resolve();
    });
  });
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

const call = async (path: string, init?: RequestInit) => {
  const res = await fetch(`${base}${path}`, {
    headers: { 'content-type': 'application/json' },
    ...init,
  });
  const body = res.status === 204 ? null : await res.json();
  return { status: res.status, body };
};

describe('HTTP API', () => {
  it('imports a fixture idempotently and exposes provenance-rich candidates', async () => {
    const payload = loadFixture();
    const first = await call('/api/datasets/import', {
      method: 'POST',
      body: JSON.stringify(payload),
    });
    expect(first.status).toBe(201);
    const datasetId = first.body.datasetId;

    const second = await call('/api/datasets/import', {
      method: 'POST',
      body: JSON.stringify(payload),
    });
    expect(second.status).toBe(200);
    expect(second.body.datasetId).toBe(datasetId);

    const detail = await call(`/api/datasets/${datasetId}`);
    expect(detail.body.contours.length).toBe(payload.contours.length);
    expect(detail.body.candidates[0].runId).toMatch(/run-/);
    expect(detail.body.candidates[0].raw).toBeTruthy();
  });

  it('creates a hypothesis, validates, saves and publishes', async () => {
    const datasets = await call('/api/datasets');
    const datasetId = datasets.body[0].id;
    const detail = await call(`/api/datasets/${datasetId}`);
    const a0 = detail.body.contours.find((c: any) => c.externalId === 'f0#A');
    const a1 = detail.body.contours.find((c: any) => c.externalId === 'f1#A');
    const a2 = detail.body.contours.find((c: any) => c.externalId === 'f2#A');
    const b2 = detail.body.contours.find((c: any) => c.externalId === 'f2#B');

    const created = await call(`/api/datasets/${datasetId}/hypotheses`, {
      method: 'POST',
      body: JSON.stringify({ name: 'api', author: 'alice' }),
    });
    const hid = created.body.id;
    const draft = await call(`/api/hypotheses/${hid}/draft`);

    const badGraph = {
      edges: [
        { id: 'x1', fromId: a1.id, toId: a2.id, kind: 'continuation', source: 'manual', author: 'alice', createdAt: '' },
        { id: 'x2', fromId: a1.id, toId: b2.id, kind: 'continuation', source: 'manual', author: 'alice', createdAt: '' },
      ],
      occlusions: [],
      negations: [],
    };
    const check = await call(`/api/hypotheses/${hid}/check`, {
      method: 'POST',
      body: JSON.stringify({ graph: badGraph }),
    });
    expect(check.body.violations.map((v: any) => v.code)).toContain(
      'MULTI_CHILD_NON_DIVISION',
    );

    const goodGraph = {
      edges: [
        { id: 'x1', fromId: a0.id, toId: a1.id, kind: 'continuation', source: 'manual', author: 'alice', createdAt: '' },
      ],
      occlusions: [],
      negations: [],
    };
    const saved = await call(`/api/hypotheses/${hid}/draft`, {
      method: 'PUT',
      body: JSON.stringify({ graph: goodGraph, expectedRev: draft.body.rev, author: 'alice' }),
    });
    expect(saved.body.ok).toBe(true);

    const published = await call(`/api/hypotheses/${hid}/publish`, {
      method: 'POST',
      body: JSON.stringify({
        graph: goodGraph,
        expectedRev: saved.body.rev,
        author: 'alice',
        message: 'v1',
      }),
    });
    expect(published.status).toBe(201);
    expect(published.body.version.versionNo).toBe(1);

    // stale rev -> 409 on save
    const stale = await call(`/api/hypotheses/${hid}/draft`, {
      method: 'PUT',
      body: JSON.stringify({ graph: goodGraph, expectedRev: draft.body.rev, author: 'bob' }),
    });
    expect(stale.status).toBe(409);
  });

  it('seeds a demo dataset on first boot', async () => {
    // separate app instance with seeding enabled
    const { setDbInstance } = await import('../src/server/db.ts');
    setDbInstance(null);
    const old = process.env.LINEAGE_NO_SEED;
    delete process.env.LINEAGE_NO_SEED;
    const { seedDemo } = await import('../src/server/seed.ts');
    const db = openDb(':memory:');
    const result = seedDemo(db);
    expect(result).not.toBeNull();
    const hyps = db.prepare('SELECT * FROM hypothesis').all() as any[];
    expect(hyps.length).toBe(2);
    const published = hyps.find((h) => h.current_version_id);
    expect(published).toBeTruthy();
    process.env.LINEAGE_NO_SEED = old ?? '1';
  });
});
