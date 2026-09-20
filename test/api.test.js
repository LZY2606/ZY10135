import { describe, it, expect, beforeAll } from 'vitest';
import { createServer } from 'node:http';
import { openDatabase, importDataset, frameOfMap } from '../server/db.js';
import { createApp } from '../server/api.js';
import { validateGraph } from '../server/graph.js';
import { loadFixture } from '../server/seed.js';
import { DEFAULT_MAX_OCCLUSION_GAP } from '../server/config.js';

let base, db, hash;

const edge = (from_uid, to_uid, kind = 'continuation', extra = {}) =>
  ({ from_uid, to_uid, kind, gap: 1, occluded: 0, ...extra });

async function json(response) { return response.json(); }

beforeAll(async () => {
  db = openDatabase(':memory:');
  hash = importDataset(db, loadFixture()).dataset_hash;
  const server = createServer(createApp(db));
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${server.address().port}`;
});

const api = (path, options = {}) => fetch(`${base}${path}`, {
  headers: { 'content-type': 'application/json' },
  ...options,
  body: options.body ? JSON.stringify(options.body) : undefined,
});

async function newHypothesis(name) {
  const res = await api(`/api/datasets/${hash}/hypotheses`, { method: 'POST', body: { name } });
  return (await res.json()).hypothesis_id;
}

async function publish(hid, edits, extra = {}) {
  return api(`/api/hypotheses/${hid}/publish`, {
    method: 'POST',
    body: { edits, ...extra },
  });
}

describe('publish API', () => {
  it('publishes sequential edits against the current head', async () => {
    const hid = await newHypothesis('seq');
    await publish(hid, [{ op: 'upsertEdge', edge: edge('f0_b', 'f1_b') }]);
    const snap = await json(await api(`/api/hypotheses/${hid}/snapshot`));
    const res = await publish(hid,
      [{ op: 'upsertEdge', edge: edge('f1_b', 'f2_b') }],
      { base_version: snap.version.version_id, note: 'add chain' });
    expect(res.status).toBe(200);
    expect((await res.json()).seq).toBe(2);
  });

  it('returns 409 with a minimal affected subgraph on stale base', async () => {
    const hid = await newHypothesis('conflict');
    await publish(hid, [{ op: 'upsertEdge', edge: edge('f0_b', 'f1_b') }]);
    const v1 = (await json(await api(`/api/hypotheses/${hid}`))).versions[0].version_id;

    // Concurrent editor wins the race on top of v1.
    await publish(hid, [{ op: 'upsertEdge', edge: edge('f1_b', 'f2_b') }], { base_version: v1 });

    // Late save based on v1 touches the same contour f1_b.
    const conflict = await publish(hid, [
      { op: 'deleteEdge', from_uid: 'f1_b', to_uid: 'f2_b' },
      { op: 'upsertEdge', edge: edge('f1_b', 'f2_a2') },
    ], { base_version: v1 });

    expect(conflict.status).toBe(409);
    const body = await conflict.json();
    expect(body.error).toBe('VERSION_CONFLICT');
    expect(body.current_head).not.toBe(v1);
    expect(body.minimal_subgraph.contours).toEqual(expect.arrayContaining(['f1_b', 'f2_b']));
    expect(body.resolutions).toEqual(['rebase', 'fork']);
  });

  it('rebase mode replays the late edits onto the newer head', async () => {
    const hid = await newHypothesis('rebase');
    await publish(hid, [{ op: 'upsertEdge', edge: edge('f0_b', 'f1_b') }]);
    const v1 = (await json(await api(`/api/hypotheses/${hid}`))).versions[0].version_id;

    const concurrent = await publish(hid,
      [{ op: 'upsertEdge', edge: edge('f4_b', 'f5_b') }], { base_version: v1 });
    const concurrentBody = await concurrent.json();

    const res = await publish(hid,
      [{ op: 'upsertEdge', edge: edge('f2_b', 'f3_b') }],
      { base_version: v1, mode: 'rebase' });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.rebased_from).toBe(concurrentBody.version_id);

    const snap = await json(await api(`/api/hypotheses/${hid}/snapshot`));
    expect(snap.edges.some((e) => e.from_uid === 'f2_b' && e.to_uid === 'f3_b')).toBe(true);
    expect(snap.edges.some((e) => e.from_uid === 'f4_b' && e.to_uid === 'f5_b')).toBe(true);
  });

  it('fork mode preserves both competing lineages as parallel hypotheses', async () => {
    const hid = await newHypothesis('fork-base');
    await publish(hid, [{ op: 'upsertEdge', edge: edge('f0_b', 'f1_b') }]);
    const v1 = (await json(await api(`/api/hypotheses/${hid}`))).versions[0].version_id;
    await publish(hid, [{ op: 'upsertEdge', edge: edge('f1_b', 'f2_b') }], { base_version: v1 });

    const res = await publish(hid,
      [{ op: 'upsertEdge', edge: edge('f4_b', 'f5_b') }],
      { base_version: v1, mode: 'fork', note: 'keep both' });
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.hypothesis_id).not.toBe(hid);
    const forked = await json(await api(`/api/hypotheses/${body.hypothesis_id}/snapshot`));
    expect(forked.edges.some((e) => e.from_uid === 'f1_b' && e.to_uid === 'f2_b')).toBe(true);
    expect(forked.edges.some((e) => e.from_uid === 'f4_b' && e.to_uid === 'f5_b')).toBe(true);
  });

  it('rejects invalid graphs (time reversal) with 422 and identifies the subgraph', async () => {
    const hid = await newHypothesis('invalid');
    const res = await publish(hid, [{ op: 'upsertEdge', edge: edge('f2_b', 'f0_b') }]);
    expect(res.status).toBe(422);
    const body = await res.json();
    expect(body.errors.some((e) => e.code === 'TIME_REVERSAL')).toBe(true);
    expect(body.affected.contours).toEqual(expect.arrayContaining(['f0_b', 'f2_b']));
  });

  it('re-import adds new candidates without touching existing ones', async () => {
    const payload = loadFixture();
    payload.candidates = [...payload.candidates, {
      id: 'late-candidate', from_uid: 'f0_a', to_uid: 'f1_a', from_frame: 0, to_frame: 1,
      score: 0.5, kind: 'continuation', source: 'tracker-rerun',
    }];
    const res = await api('/api/datasets/import', { method: 'POST', body: payload });
    const body = await res.json();
    expect(body.already_existed).toBe(true);
    expect(body.inserted_candidates).toBe(1);
  });

  it('validates publication graphs through the server frame map (division mother cannot continue)', async () => {
    const hid = await newHypothesis('division-rule');
    const res = await publish(hid, [
      { op: 'upsertEdge', edge: edge('f1_a', 'f2_a1', 'division') },
      { op: 'upsertEdge', edge: edge('f1_a', 'f2_a2', 'division') },
      { op: 'upsertEdge', edge: edge('f1_a', 'f2_b') },
    ]);
    expect(res.status).toBe(422);
    const body = await res.json();
    expect(body.errors.some((e) => e.code === 'MOTHER_CONTINUES_AFTER_DIVISION')).toBe(true);
  });
});
