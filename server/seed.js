import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { importDataset, listHypotheses, createHypothesis, headVersion, publishVersion } from './db.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

export function loadFixture() {
  const path = resolve(__dirname, '..', 'fixtures', 'tiny-lineage.json');
  return JSON.parse(readFileSync(path, 'utf8'));
}

/** Idempotently import the fixture and publish a seeded baseline hypothesis. */
export function seedFixture(db) {
  const payload = loadFixture();
  const imported = importDataset(db, payload, payload.dataset_hash ?? null);
  const hash = imported.dataset_hash;

  const existing = listHypotheses(db, hash);
  if (existing.length === 0) {
    const hypothesisId = createHypothesis(db, hash, 'baseline (seeded)');
    const edges = [
      edge('f0_a', 'f1_a'), edge('f1_a', 'f2_a1', 'division'), edge('f1_a', 'f2_a2', 'division'),
      edge('f0_b', 'f1_b'), edge('f1_b', 'f2_b'), edge('f2_b', 'f3_b'),
      edge('f3_b', 'f4_b'), edge('f4_b', 'f5_b'),
      edge('f0_c', 'f1_c'), edge('f1_c', 'f2_c'),
      { ...edge('f2_c', 'f4_c'), gap: 2, occluded: 1 },
      edge('f4_c', 'f5_c'),
      edge('f2_a1', 'f3_a1'), edge('f2_a2', 'f3_a2'),
      edge('f3_a1', 'f4_a1'), edge('f3_a2', 'f4_a2'),
      edge('f4_a1', 'f5_a1'), edge('f4_a2', 'f5_a2'),
    ];
    const occlusions = [{ occl_uid: 'f2_c', frame_start: 3, frame_end: 3, note: 'transient overlap with debris' }];
    publishVersion(db, {
      hypothesisId, edges, occlusions,
      baseVersion: null, parentVersion: null,
      note: 'seeded baseline: A divides at frame 2, C occluded one frame',
    });
  }

  // A parallel hypothesis kept open on purpose: alternative continuation of A's daughter.
  const alternatives = listHypotheses(db, hash).filter((h) => h.name === 'alternative track A2');
  if (alternatives.length === 0) {
    const branchId = createHypothesis(db, hash, 'alternative track A2');
    const mergeEdge = (from_uid, to_uid) =>
      ({ from_uid, to_uid, kind: 'merge', gap: 1, occluded: 0, origin: 'manual', created_by: 'seed' });
    const edges = [
      edge('f0_a', 'f1_a'), edge('f1_a', 'f2_a1', 'division'), edge('f1_a', 'f2_a2', 'division'),
      edge('f2_a1', 'f3_a1'), edge('f2_a2', 'f3_a2'),
      edge('f3_a1', 'f4_a1'), edge('f3_a2', 'f4_a2'),
      mergeEdge('f4_a1', 'f5_a2'), mergeEdge('f4_a2', 'f5_a2'),
    ];
    publishVersion(db, {
      hypothesisId: branchId, edges, occlusions: [],
      baseVersion: null, parentVersion: null,
      note: 'competing lineage: the two daughters merge into f5_a2 (parallel hypothesis retained)',
    });
  }

  return { hash };
}

function edge(from_uid, to_uid, kind = 'continuation') {
  return { from_uid, to_uid, kind, gap: 1, occluded: 0, origin: 'manual', created_by: 'seed' };
}
