import { describe, it, expect, beforeEach } from 'vitest';
import {
  openDatabase, importDataset, createHypothesis, headVersion, getVersionSnapshot,
  publishVersion, frameOfMap, recordEvidence,
} from '../server/db.js';
import { validateGraph } from '../server/graph.js';
import { loadFixture } from '../server/seed.js';
import { DEFAULT_MAX_OCCLUSION_GAP } from '../server/config.js';

function memDb() {
  const db = openDatabase(':memory:');
  return db;
}

function importFixture(db, mutate = null) {
  const payload = loadFixture();
  if (mutate) mutate(payload);
  return importDataset(db, payload, payload.dataset_hash ?? null);
}

describe('dataset import', () => {
  it('is idempotent on dataset hash and only adds new candidates', () => {
    const db = memDb();
    const first = importFixture(db);
    expect(first.already_existed).toBe(false);
    const second = importFixture(db);
    expect(second.dataset_hash).toBe(first.dataset_hash);
    expect(second.already_existed).toBe(true);
    expect(second.inserted_candidates).toBe(0);

    const more = {
      ...loadFixture(),
      candidates: [
        ...loadFixture().candidates,
        { id: 'brand-new-1', from_uid: 'f0_a', to_uid: 'f1_b', from_frame: 0, to_frame: 1, score: 0.01, kind: 'continuation', source: 'rerun-v2' },
      ],
    };
    const rerun = importDataset(db, more, more.dataset_hash ?? null);
    expect(rerun.inserted_candidates).toBe(1);
    const count = db.prepare('SELECT COUNT(*) AS n FROM candidates WHERE dataset_hash = ?').get(first.dataset_hash).n;
    expect(count).toBe(loadFixture().candidates.length + 1);
  });

  it('stores the full raw contour record and boundary', () => {
    const db = memDb();
    const { dataset_hash } = importFixture(db);
    const row = db.prepare('SELECT raw_json, boundary_json FROM contours WHERE dataset_hash = ? AND contour_uid = ?')
      .get(dataset_hash, 'f0_a');
    const raw = JSON.parse(row.raw_json);
    expect(raw.source).toBe('seg-v1');
    expect(raw.boundary).toHaveLength(4);
    expect(JSON.parse(row.boundary_json)).toHaveLength(4);
  });

  it('never overwrites reviewed evidence on re-import', () => {
    const db = memDb();
    const { dataset_hash } = importFixture(db);
    const candidateId = db.prepare('SELECT candidate_id FROM candidates LIMIT 1').get().candidate_id;
    recordEvidence(db, dataset_hash, { candidateId, verdict: 'rejected', reason: 'manual no' });
    importDataset(db, loadFixture(), null);
    const ev = db.prepare('SELECT * FROM reviewed_evidence WHERE candidate_id = ?').get(candidateId);
    expect(ev.verdict).toBe('rejected');
    expect(ev.reason).toBe('manual no');
  });
});

describe('publishing', () => {
  let db, hash;
  beforeEach(() => {
    db = memDb();
    hash = importFixture(db).dataset_hash;
  });

  const validate = (s) => validateGraph({ ...s, frameOf: frameOfMap(db, hash), maxOcclusionGap: DEFAULT_MAX_OCCLUSION_GAP });

  it('publishes the seeded baseline as one version with full snapshot', () => {
    const hid = createHypothesis(db, hash, 'h');
    const edges = [
      { from_uid: 'f0_b', to_uid: 'f1_b', kind: 'continuation', gap: 1, occluded: 0 },
      { from_uid: 'f1_b', to_uid: 'f2_b', kind: 'continuation', gap: 1, occluded: 0 },
    ];
    const v1 = publishVersion(db, { hypothesisId: hid, edges, occlusions: [], baseVersion: null, validate });
    const head = headVersion(db, hid);
    expect(head.version_id).toBe(v1.version_id);
    expect(getVersionSnapshot(db, v1.version_id).edges).toHaveLength(2);
  });

  it('refuses a graph that violates invariants (mother continues after division)', () => {
    const hid = createHypothesis(db, hash, 'h');
    const edges = [
      { from_uid: 'f1_a', to_uid: 'f2_a1', kind: 'division', gap: 1, occluded: 0 },
      { from_uid: 'f1_a', to_uid: 'f2_a2', kind: 'division', gap: 1, occluded: 0 },
      { from_uid: 'f1_a', to_uid: 'f2_b', kind: 'continuation', gap: 1, occluded: 0 },
    ];
    expect(() => publishVersion(db, { hypothesisId: hid, edges, occlusions: [], validate })).toThrow(/INVARIANT/);
    expect(headVersion(db, hid)).toBeNull();
  });

  it('commits header and snapshot atomically: throwing inside the transaction leaves the old head', () => {
    const hid = createHypothesis(db, hash, 'h');
    const good = [{ from_uid: 'f0_b', to_uid: 'f1_b', kind: 'continuation', gap: 1, occluded: 0 }];
    publishVersion(db, { hypothesisId: hid, edges: good, occlusions: [], validate });
    const oldHead = headVersion(db, hid).version_id;

    const tx = db.transaction(() => {
      db.prepare('INSERT INTO versions (version_id, hypothesis_id, seq) VALUES (?,?,?)')
        .run('ver_bad', hid, 99);
      throw new Error('simulated crash');
    });
    expect(() => tx()).toThrow(/simulated/);

    expect(headVersion(db, hid).version_id).toBe(oldHead);
    expect(db.prepare('SELECT COUNT(*) AS n FROM versions WHERE version_id = ?').get('ver_bad').n).toBe(0);
    expect(db.prepare('SELECT COUNT(*) AS n FROM version_edges WHERE version_id = ?').get('ver_bad').n).toBe(0);
  });

  it('stores each version as an independent full snapshot (history never mutates)', () => {
    const hid = createHypothesis(db, hash, 'h');
    const v1 = publishVersion(db, {
      hypothesisId: hid,
      edges: [{ from_uid: 'f0_b', to_uid: 'f1_b', kind: 'continuation', gap: 1, occluded: 0 }],
      occlusions: [], validate,
    });
    publishVersion(db, {
      hypothesisId: hid, parentVersion: v1.version_id,
      edges: [
        { from_uid: 'f0_b', to_uid: 'f1_b', kind: 'continuation', gap: 1, occluded: 0 },
        { from_uid: 'f1_b', to_uid: 'f2_b', kind: 'continuation', gap: 1, occluded: 0 },
      ],
      occlusions: [], validate,
    });
    expect(getVersionSnapshot(db, v1.version_id).edges).toHaveLength(1);
  });
});
