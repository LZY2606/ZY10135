import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDb } from '../src/server/db.ts';
import { getCandidates, importDataset } from '../src/server/repo-datasets.ts';
import {
  createHypothesis,
  getDraft,
  getHeadGraph,
  listVersions,
  publishDraft,
  saveDraft,
} from '../src/server/repo-hypotheses.ts';
import {
  graphWith,
  loadFixture,
  makeDb,
  makeEdge,
  publishGraph,
  setupDataset,
} from './helpers.ts';

describe('idempotent import by dataset hash', () => {
  it('re-importing identical contours returns the same dataset', () => {
    const db = makeDb();
    const payload = loadFixture();
    const first = importDataset(db, payload);
    const second = importDataset(db, structuredClone(payload));
    expect(second.created).toBe(false);
    expect(second.datasetId).toBe(first.datasetId);
    expect(getCandidates(db, first.datasetId)).toHaveLength(payload.candidates!.length);
  });

  it('an auto re-run only appends new candidates and keeps provenance', () => {
    const db = makeDb();
    const first = importDataset(db, loadFixture('demo-t0.json'));
    const before = getCandidates(db, first.datasetId).length;
    const rerun = importDataset(db, loadFixture('demo-t1-rerun.json'));
    expect(rerun.datasetId).toBe(first.datasetId);
    expect(rerun.skippedCandidates).toBe(1);
    expect(rerun.insertedCandidates).toBe(2);
    const candidates = getCandidates(db, first.datasetId);
    expect(candidates).toHaveLength(before + 2);
    const newRun = candidates.filter((c) => c.runId === 'run-1820');
    expect(newRun).toHaveLength(2);
    expect(newRun[0].raw).toBeTruthy();
  });
});

describe('hypothesis publishing', () => {
  it('publishes a clean graph as an immutable version and advances the head', () => {
    const s = setupDataset();
    const a0 = s.contoursById.get('c_a0')!;
    const a1 = s.contoursById.get('c_a1')!;
    const graph = graphWith(makeEdge(a0, a1));
    const result = publishGraph(s, graph);
    expect(result.status).toBe('published');
    expect(result.version?.versionNo).toBe(1);
    const head = getHeadGraph(s.db, s.hypothesisId);
    expect(head.versionId).toBe(result.version?.id);
    expect(head.graph.edges).toHaveLength(1);
    expect(listVersions(s.db, s.hypothesisId)).toHaveLength(1);
  });

  it('refuses to publish a graph violating invariants', () => {
    const s = setupDataset();
    const a1 = s.contoursById.get('c_a1')!;
    const a2 = s.contoursById.get('c_a2')!;
    const b2 = s.contoursById.get('c_b2')!;
    const bad = graphWith(makeEdge(a1, a2), makeEdge(a1, b2));
    let thrown: any;
    try {
      publishGraph(s, bad);
    } catch (err) {
      thrown = err;
    }
    expect(thrown?.message).toBe('GRAPH_VIOLATIONS');
    expect(thrown.violations.length).toBeGreaterThan(0);
    // no version row was written, head stays unpublished
    expect(listVersions(s.db, s.hypothesisId)).toHaveLength(0);
  });

  it('rejects a stale draft save so a later save cannot eat earlier links', () => {
    const s = setupDataset();
    const draft = getDraft(s.db, s.hypothesisId)!;
    const a0 = s.contoursById.get('c_a0')!;
    const a1 = s.contoursById.get('c_a1')!;
    const first = saveDraft(
      s.db,
      s.hypothesisId,
      graphWith(makeEdge(a0, a1)),
      draft.rev,
      'alice',
    );
    expect(first.ok).toBe(true);
    const stale = saveDraft(
      s.db,
      s.hypothesisId,
      graphWith(),
      draft.rev, // bob uses the old rev
      'bob',
    );
    expect(stale.ok).toBe(false);
    const current = getDraft(s.db, s.hypothesisId);
    expect(current!.graph.edges).toHaveLength(1); // alice's link survived
  });

  it('is crash-atomic: version row and head pointer commit together', () => {
    const dir = mkdtempSync(join(tmpdir(), 'lineage-'));
    try {
      const dbPath = join(dir, 'data.sqlite');
      process.env.LINEAGE_NO_SEED = '1';
      const db = openDb(dbPath);
      const imported = importDataset(db, loadFixture());
      const hypId = createHypothesis(db, imported.datasetId, 'x', 't');
      const a0 = db
        .prepare("SELECT id FROM contour WHERE external_id='f0#A'")
        .get() as { id: string };
      const a1 = db
        .prepare("SELECT id FROM contour WHERE external_id='f1#A'")
        .get() as { id: string };
      const contours = new Map(
        (db.prepare('SELECT * FROM contour').all() as any[]).map((r) => [
          r.id,
          {
            id: r.id,
            frame: r.frame,
            externalId: r.external_id,
            cx: r.cx,
            cy: r.cy,
            area: r.area,
            boundary: JSON.parse(r.boundary),
          },
        ]),
      );
      const ctx = { contours, options: { maxGapFrames: 3 } };
      const draft = getDraft(db, hypId)!;
      saveDraft(db, hypId, graphWith(makeEdge(a0.id, a1.id)), draft.rev, 't');
      const draft2 = getDraft(db, hypId)!;
      publishDraft(db, hypId, draft2.graph, draft2.rev, 't', 'v1', ctx);
      db.close();

      // Simulate crash + reopen: WAL replays committed transaction only.
      const reopened = openDb(dbPath);
      const versions = reopened
        .prepare('SELECT * FROM version WHERE hypothesis_id = ?')
        .all(hypId);
      const head = reopened
        .prepare('SELECT current_version_id FROM hypothesis WHERE id = ?')
        .get(hypId) as { current_version_id: string | null };
      expect(versions).toHaveLength(1);
      expect(head.current_version_id).toBe(versions[0].id);
      const graph = getHeadGraph(reopened, hypId);
      expect(graph.graph.edges).toHaveLength(1);
      reopened.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

afterEach(() => {
  process.env.LINEAGE_NO_SEED = '1';
});
