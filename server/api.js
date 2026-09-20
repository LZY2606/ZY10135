import express from 'express';
import {
  importDataset, frameOfMap, createHypothesis, getHypothesis, headVersion,
  getVersionSnapshot, publishVersion, listVersions, listHypotheses,
  recordEvidence, getDataset, listDatasets,
} from './db.js';
import { validateGraph, applyEdits, affectedSubgraph, conflictFocus, normalizeEdge } from './graph.js';
import { DEFAULT_MAX_OCCLUSION_GAP, envInt } from './config.js';

const MAX_OCCLUSION_GAP = envInt('MAX_OCCLUSION_GAP', DEFAULT_MAX_OCCLUSION_GAP);

export function createApp(db) {
  const app = express();
  app.use(express.json({ limit: '20mb' }));

  // ---- datasets ----
  app.get('/api/datasets', (req, res) => res.json(listDatasets(db)));

  app.post('/api/datasets/import', (req, res) => {
    const payload = req.body;
    if (!payload || !Array.isArray(payload.frames)) {
      return res.status(400).json({ error: 'payload must contain frames[]' });
    }
    try {
      const result = importDataset(db, payload, payload.dataset_hash ?? null);
      res.json(result);
    } catch (error) {
      res.status(500).json({ error: error.message });
    }
  });

  app.get('/api/datasets/:hash', (req, res) => {
    const dataset = getDataset(db, req.params.hash);
    if (!dataset) return res.status(404).json({ error: 'dataset not found' });
    const candidates = db.prepare('SELECT candidate_id,from_uid,to_uid,from_frame,to_frame,score,kind,source FROM candidates WHERE dataset_hash = ? ORDER BY from_frame,to_frame')
      .all(req.params.hash);
    const evidence = db.prepare('SELECT candidate_id,from_uid,to_uid,verdict,reason,reviewer,created_at FROM reviewed_evidence WHERE dataset_hash = ?')
      .all(req.params.hash);
    res.json({ ...dataset, candidates, evidence, hypotheses: listHypotheses(db, req.params.hash) });
  });

  app.get('/api/contours/:hash/:uid/raw', (req, res) => {
    const row = db.prepare('SELECT raw_json, boundary_json FROM contours WHERE dataset_hash = ? AND contour_uid = ?')
      .get(req.params.hash, req.params.uid);
    if (!row) return res.status(404).json({ error: 'contour not found' });
    res.type('application/json').send(row.raw_json);
  });

  // ---- evidence (manual accept/reject is never overwritten by auto re-runs) ----
  app.post('/api/datasets/:hash/evidence', (req, res) => {
    const { candidate_id, from_uid, to_uid, verdict, reason } = req.body ?? {};
    if (!['accepted', 'rejected'].includes(verdict)) {
      return res.status(400).json({ error: 'verdict must be accepted|rejected' });
    }
    recordEvidence(db, req.params.hash, { candidateId: candidate_id ?? null, fromUid: from_uid ?? null, toUid: to_uid ?? null, verdict, reason });
    res.json({ ok: true });
  });

  // ---- hypotheses ----
  app.post('/api/datasets/:hash/hypotheses', (req, res) => {
    const { name, parent_id = null } = req.body ?? {};
    const id = createHypothesis(db, req.params.hash, name ?? 'untitled', parent_id);
    res.json({ hypothesis_id: id });
  });

  app.get('/api/hypotheses/:id', (req, res) => {
    const hypothesis = getHypothesis(db, req.params.id);
    if (!hypothesis) return res.status(404).json({ error: 'hypothesis not found' });
    res.json({
      ...hypothesis,
      head: headVersion(db, req.params.id),
      versions: listVersions(db, req.params.id),
    });
  });

  app.get('/api/hypotheses/:id/snapshot', (req, res) => {
    const hypothesis = getHypothesis(db, req.params.id);
    if (!hypothesis) return res.status(404).json({ error: 'hypothesis not found' });
    const head = headVersion(db, req.params.id);
    if (!head) return res.json({ version: null, edges: [], occlusions: [] });
    const snapshot = getVersionSnapshot(db, head.version_id);
    res.json({ version: head, ...snapshot });
  });

  // Derive a new parallel hypothesis branching from an existing version.
  app.post('/api/hypotheses/:id/fork', (req, res) => {
    const source = getHypothesis(db, req.params.id);
    if (!source) return res.status(404).json({ error: 'hypothesis not found' });
    const sourceVersionId = req.body?.version_id ?? headVersion(db, req.params.id)?.version_id;
    const name = req.body?.name ?? `${source.name} (branch)`;
    if (!sourceVersionId) return res.status(400).json({ error: 'no version to fork from' });
    const snapshot = getVersionSnapshot(db, sourceVersionId);

    const tx = db.transaction(() => {
      const id = createHypothesis(db, source.dataset_hash, name, req.params.id);
      const published = publishVersion(db, {
        hypothesisId: id,
        edges: snapshot.edges,
        occlusions: snapshot.occlusions,
        baseVersion: sourceVersionId,
        parentVersion: null,
        note: `forked from ${sourceVersionId}`,
      });
      return { hypothesis_id: id, ...published };
    });
    res.json(tx());
  });

  /**
   * Publish edits against a base version.
   * body: { base_version, edits:[...], note?, mode?:'strict'|'rebase'|'fork' }
   * - strict: stale base => 409 with the minimal affected subgraph
   * - rebase: replay edits on the current head, then validate+publish
   * - fork:   keep both lines; create a new hypothesis carrying the result
   */
  app.post('/api/hypotheses/:id/publish', (req, res) => {
    const hypothesis = getHypothesis(db, req.params.id);
    if (!hypothesis) return res.status(404).json({ error: 'hypothesis not found' });
    const { edits = [], note = null, mode = 'strict' } = req.body ?? {};
    const requestedBase = req.body?.base_version ?? null;

    const head = headVersion(db, req.params.id);
    const currentHeadId = head?.version_id ?? null;
    const baseId = requestedBase ?? currentHeadId;
    const baseSnapshot = baseId ? getVersionSnapshot(db, baseId) : { edges: [], occlusions: [] };
    const frameOf = frameOfMap(db, hypothesis.dataset_hash);

    let working = applyEdits(baseSnapshot, normalizeEdits(edits));
    let validation = validateGraph({
      edges: working.edges, occlusions: working.occlusions, frameOf,
      maxOcclusionGap: MAX_OCCLUSION_GAP,
    });
    if (!validation.ok) {
      return res.status(422).json({
        error: 'GRAPH_INVARIANT_VIOLATION',
        errors: validation.errors,
        affected: affectedSubgraph(working.edges, working.occlusions, normalizeEdits(edits)),
      });
    }

    const stale = Boolean(currentHeadId && baseId && currentHeadId !== baseId);
    if (stale && mode === 'strict') {
      const serverSnapshot = getVersionSnapshot(db, currentHeadId);
      const baseSnapForDiff = baseId ? getVersionSnapshot(db, baseId) : { edges: [], occlusions: [] };
      const serverEdits = inferEdits(baseSnapForDiff, serverSnapshot);
      const focus = conflictFocus(normalizeEdits(edits), serverEdits, serverSnapshot.edges);
      return res.status(409).json({
        error: 'VERSION_CONFLICT',
        message: 'Another version was published after your base; your save would silently overwrite it.',
        base_version: baseId,
        current_head: currentHeadId,
        server_versions: listVersions(db, req.params.id),
        minimal_subgraph: focus
          ? affectedSubgraph(serverSnapshot.edges, serverSnapshot.occlusions, serverEdits)
          : affectedSubgraph(serverSnapshot.edges, serverSnapshot.occlusions, normalizeEdits(edits)),
        incoming: affectedSubgraph(working.edges, working.occlusions, normalizeEdits(edits)),
        resolutions: ['rebase', 'fork'],
      });
    }

    if (stale && mode === 'rebase') {
      const serverSnapshot = getVersionSnapshot(db, currentHeadId);
      working = applyEdits(serverSnapshot, normalizeEdits(edits));
      validation = validateGraph({
        edges: working.edges, occlusions: working.occlusions, frameOf,
        maxOcclusionGap: MAX_OCCLUSION_GAP,
      });
      if (!validation.ok) {
        return res.status(422).json({
          error: 'GRAPH_INVARIANT_VIOLATION_AFTER_REBASE',
          errors: validation.errors,
          affected: affectedSubgraph(working.edges, working.occlusions, normalizeEdits(edits)),
        });
      }
      const published = publishVersion(db, {
        hypothesisId: req.params.id,
        edges: working.edges,
        occlusions: working.occlusions,
        baseVersion: currentHeadId,
        parentVersion: currentHeadId,
        note,
      });
      return res.json({ ...published, rebased_from: currentHeadId, stale_base: baseId });
    }

    if (stale && mode === 'fork') {
      const serverSnapshot = getVersionSnapshot(db, currentHeadId);
      const forked = applyEdits(serverSnapshot, normalizeEdits(edits));
      validation = validateGraph({
        edges: forked.edges, occlusions: forked.occlusions, frameOf,
        maxOcclusionGap: MAX_OCCLUSION_GAP,
      });
      if (!validation.ok) {
        return res.status(422).json({
          error: 'GRAPH_INVARIANT_VIOLATION_IN_FORK',
          errors: validation.errors,
        });
      }
      const tx = db.transaction(() => {
        const branchId = createHypothesis(db, hypothesis.dataset_hash, `${hypothesis.name} (conflict branch)`, req.params.id);
        const published = publishVersion(db, {
          hypothesisId: branchId,
          edges: forked.edges,
          occlusions: forked.occlusions,
          baseVersion: currentHeadId,
          parentVersion: null,
          note: note ?? `conflict fork while ${currentHeadId} was head`,
        });
        return { hypothesis_id: branchId, ...published };
      });
      return res.status(201).json(tx());
    }

    const published = publishVersion(db, {
      hypothesisId: req.params.id,
      edges: working.edges,
      occlusions: working.occlusions,
      baseVersion: baseId,
      parentVersion: currentHeadId,
      note,
    });
    res.json(published);
  });

  // ---- raw version audit ----
  app.get('/api/versions/:versionId', (req, res) => {
    const version = db.prepare('SELECT * FROM versions WHERE version_id = ?').get(req.params.versionId);
    if (!version) return res.status(404).json({ error: 'version not found' });
    res.json({ ...version, ...getVersionSnapshot(db, version.version_id) });
  });

  app.use((err, req, res, next) => {
    if (err?.code === 'GRAPH_INVARIANT_VIOLATION') {
      return res.status(422).json({ error: err.code, errors: err.errors });
    }
    res.status(500).json({ error: err?.message ?? 'internal error' });
  });

  return app;
}

function normalizeEdits(edits) {
  return (edits ?? []).map((edit) => {
    if (edit.op === 'upsertEdge') return { ...edit, edge: normalizeEdge(edit.edge) };
    return edit;
  });
}

/** Reconstruct pseudo-edits between two snapshots for conflict focus calculation. */
function inferEdits(before, after) {
  const key = (e) => `${e.from_uid}|${e.to_uid}`;
  const beforeMap = new Map(before.edges.map((e) => [key(e), e]));
  const afterMap = new Map(after.edges.map((e) => [key(e), e]));
  const edits = [];
  for (const [k, e] of afterMap) {
    if (!beforeMap.has(k) || beforeMap.get(k).kind !== e.kind) {
      edits.push({ op: 'upsertEdge', edge: e });
    }
  }
  for (const [k] of beforeMap) {
    if (!afterMap.has(k)) {
      const [from_uid, to_uid] = k.split('|');
      edits.push({ op: 'deleteEdge', from_uid, to_uid });
    }
  }
  for (const occ of after.occlusions) {
    if (!before.occlusions.some((o) => o.occl_uid === occ.occl_uid && o.frame_start === occ.frame_start && o.frame_end === occ.frame_end)) {
      edits.push({ op: 'addOcclusion', occlusion: occ });
    }
  }
  return edits;
}
