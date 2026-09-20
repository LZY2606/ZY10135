import type { DatabaseSync } from 'node:sqlite';
import { hashDatasetPayload } from '../shared/hash.ts';
import { newId } from '../shared/id.ts';
import type { Candidate, Contour, DatasetPayload } from '../shared/types.ts';

export interface ImportResult {
  datasetId: string;
  created: boolean;
  insertedCandidates: number;
  skippedCandidates: number;
}

/**
 * Import a segmenter payload. Idempotent by content hash: contours never
 * change. Candidate rows are append-only keyed by (run_id, ext_key), so an
 * auto re-run adds new candidates but never overwrites reviewed evidence.
 */
export function importDataset(db: DatabaseSync, payload: DatasetPayload): ImportResult {
  validatePayload(payload);
  const contentHash = hashDatasetPayload(payload);
  const existing = db
    .prepare('SELECT id FROM dataset WHERE content_hash = ?')
    .get(contentHash) as { id: string } | undefined;

  if (existing) {
    const counts = insertCandidates(db, existing.id, payload);
    return {
      datasetId: existing.id,
      created: false,
      insertedCandidates: counts.inserted,
      skippedCandidates: counts.skipped,
    };
  }

  const datasetId = newId('ds');
  const now = new Date().toISOString();
  db.prepare(
    `INSERT INTO dataset (id, name, frames, import_source, content_hash, imported_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
  ).run(datasetId, payload.name, payload.frames, payload.importSource, contentHash, now);

  const insertContour = db.prepare(
    `INSERT INTO contour (id, dataset_id, frame, external_id, cx, cy, area, boundary, meta)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  for (const c of payload.contours) {
    const id = c.id ?? newId('c');
    insertContour.run(
      id,
      datasetId,
      c.frame,
      c.externalId,
      c.cx,
      c.cy,
      c.area,
      JSON.stringify(c.boundary),
      c.meta ? JSON.stringify(c.meta) : null,
    );
  }

  const counts = insertCandidates(db, datasetId, payload);
  return {
    datasetId,
    created: true,
    insertedCandidates: counts.inserted,
    skippedCandidates: counts.skipped,
  };
}

function insertCandidates(
  db: DatabaseSync,
  datasetId: string,
  payload: DatasetPayload,
): { inserted: number; skipped: number } {
  const select = db.prepare(
    'SELECT 1 FROM candidate WHERE dataset_id = ? AND run_id = ? AND ext_key = ?',
  );
  const insert = db.prepare(
    `INSERT INTO candidate (id, dataset_id, run_id, ext_key, from_contour_id,
       to_contour_id, kind, score, raw, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  let inserted = 0;
  let skipped = 0;
  const now = new Date().toISOString();
  for (const cand of payload.candidates ?? []) {
    const extKey = cand.id ?? `${cand.runId}:${cand.kind}:${cand.fromContourId ?? '-'}->${cand.toContourId ?? '-'}`;
    if (select.get(datasetId, cand.runId, extKey)) {
      skipped++;
      continue;
    }
    insert.run(
      newId('cand'),
      datasetId,
      cand.runId,
      extKey,
      cand.fromContourId,
      cand.toContourId,
      cand.kind,
      cand.score,
      cand.raw === undefined ? null : JSON.stringify(cand.raw),
      now,
    );
    inserted++;
  }
  return { inserted, skipped };
}

function validatePayload(payload: DatasetPayload): void {
  if (!payload.name || !payload.importSource) {
    throw new Error('name 与 importSource 必填');
  }
  if (!Number.isInteger(payload.frames) || payload.frames <= 0) {
    throw new Error('frames 必须为正整数');
  }
  if (!Array.isArray(payload.contours) || payload.contours.length === 0) {
    throw new Error('contours 不能为空');
  }
  const seen = new Set<string>();
  for (const c of payload.contours) {
    const key = c.externalId;
    if (seen.has(key)) throw new Error(`externalId 重复: ${key}`);
    seen.add(key);
    if (c.frame < 0 || c.frame >= payload.frames) {
      throw new Error(`轮廓 ${key} 的帧号超出范围`);
    }
  }
}

export function listDatasets(db: DatabaseSync) {
  return db
    .prepare(
      `SELECT d.*, (SELECT COUNT(*) FROM contour c WHERE c.dataset_id = d.id) AS contour_count,
              (SELECT COUNT(*) FROM candidate ca WHERE ca.dataset_id = d.id) AS candidate_count
       FROM dataset d ORDER BY imported_at`,
    )
    .all();
}

export function getDataset(db: DatabaseSync, datasetId: string) {
  const row = db.prepare('SELECT * FROM dataset WHERE id = ?').get(datasetId);
  if (!row) return null;
  return row;
}

export function getContours(db: DatabaseSync, datasetId: string): Contour[] {
  const rows = db
    .prepare('SELECT * FROM contour WHERE dataset_id = ? ORDER BY frame, id')
    .all(datasetId) as any[];
  return rows.map((r) => ({
    id: r.id,
    frame: r.frame,
    externalId: r.external_id,
    cx: r.cx,
    cy: r.cy,
    area: r.area,
    boundary: JSON.parse(r.boundary),
    meta: r.meta ? JSON.parse(r.meta) : undefined,
  }));
}

export function getCandidates(db: DatabaseSync, datasetId: string): Candidate[] {
  const rows = db
    .prepare('SELECT * FROM candidate WHERE dataset_id = ? ORDER BY created_at, id')
    .all(datasetId) as any[];
  return rows.map((r) => ({
    id: r.id,
    runId: r.run_id,
    fromContourId: r.from_contour_id,
    toContourId: r.to_contour_id,
    kind: r.kind,
    score: r.score,
    raw: r.raw ? JSON.parse(r.raw) : undefined,
    createdAt: r.created_at,
  }));
}
