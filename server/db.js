import Database from 'better-sqlite3';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import crypto from 'node:crypto';

const __dirname = dirname(fileURLToPath(import.meta.url));

let migrationSql = '';
try {
  migrationSql = readFileSync(join(__dirname, 'schema.sql'), 'utf8');
} catch {
  migrationSql = null;
}

export function openDatabase(path) {
  const db = new Database(path);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  db.pragma('busy_timeout = 5000');
  if (migrationSql) db.exec(migrationSql);
  return db;
}

export function sha256Json(payload) {
  return crypto.createHash('sha256').update(JSON.stringify(payload)).digest('hex');
}

export function newId(prefix) {
  return `${prefix}_${crypto.randomBytes(8).toString('hex')}`;
}

/**
 * Idempotent dataset import keyed on dataset_hash.
 * Re-importing the same hash returns the existing row and only inserts
 * genuinely new external candidates; reviewed evidence and human work are
 * never touched.
 *
 * payload shape:
 * {
 *   name?, frame_count?, width?, height?,
 *   frames: [ {frame, contours: [
 *       {uid, center:{x,y}, area, boundary:[...], source?, ...extra} ]} ],
 *   candidates?: [ {from_uid,to_uid,from_frame,to_frame,score,kind,source?} ],
 *   dataset_hash?   // optional explicit hash; otherwise computed over payload
 * }
 */
export function importDataset(db, payload, explicitHash = null) {
  const hash = explicitHash ?? payload.dataset_hash ?? sha256Json(payload);
  const existing = db.prepare('SELECT dataset_hash, name FROM datasets WHERE dataset_hash = ?').get(hash);

  const tx = db.transaction(() => {
    let insertedContours = 0;
    let insertedCandidates = 0;

    if (!existing) {
      const frameCount = payload.frame_count ??
        Math.max(0, ...payload.frames.map((f) => f.frame)) + 1;
      db.prepare(`INSERT INTO datasets (dataset_hash, name, frame_count, width, height, raw_payload, frames_json)
                  VALUES (?,?,?,?,?,?,?)`).run(
        hash,
        payload.name ?? hash.slice(0, 8),
        frameCount,
        payload.width ?? null,
        payload.height ?? null,
        JSON.stringify(payload),
        JSON.stringify(payload.frames),
      );

      const insContour = db.prepare(`INSERT INTO contours
        (dataset_hash, contour_uid, frame, center_x, center_y, area, boundary_json, source, raw_json)
        VALUES (?,?,?,?,?,?,?,?,?)`);
      for (const frame of payload.frames) {
        for (const c of frame.contours) {
          const center = c.center ?? {};
          insContour.run(
            hash, c.uid, frame.frame,
            center.x ?? null, center.y ?? null,
            c.area ?? null,
            JSON.stringify(c.boundary ?? []),
            c.source ?? null,
            JSON.stringify(c),
          );
          insertedContours += 1;
        }
      }
    }

    const insCandidate = db.prepare(`INSERT OR IGNORE INTO candidates
      (candidate_id, dataset_hash, from_uid, to_uid, from_frame, to_frame, score, kind, source, raw_json)
      VALUES (?,?,?,?,?,?,?,?,?,?)`);

    for (const cand of payload.candidates ?? []) {
      const externalKey = cand.id ?? `${cand.from_uid}->${cand.to_uid}:${cand.kind ?? 'continuation'}:${cand.source ?? 'ext'}`;
      const candidateId = `${hash}#${externalKey}`;
      const info = insCandidate.run(
        candidateId, hash,
        cand.from_uid, cand.to_uid,
        cand.from_frame, cand.to_frame,
        cand.score ?? null,
        cand.kind ?? 'continuation',
        cand.source ?? null,
        JSON.stringify(cand),
      );
      if (info.changes > 0) insertedCandidates += 1;
    }

    return {
      dataset_hash: hash,
      already_existed: Boolean(existing),
      inserted_contours: insertedContours,
      inserted_candidates: insertedCandidates,
    };
  });

  return tx();
}

export function frameOfMap(db, datasetHash) {
  const rows = db.prepare('SELECT contour_uid, frame FROM contours WHERE dataset_hash = ?').all(datasetHash);
  return new Map(rows.map((r) => [r.contour_uid, r.frame]));
}

export function createHypothesis(db, datasetHash, name, parentId = null) {
  const id = newId('hyp');
  db.prepare('INSERT INTO hypotheses (hypothesis_id, dataset_hash, name, parent_id) VALUES (?,?,?,?)')
    .run(id, datasetHash, name, parentId);
  return id;
}

export function getHypothesis(db, hypothesisId) {
  return db.prepare('SELECT * FROM hypotheses WHERE hypothesis_id = ?').get(hypothesisId);
}

export function headVersion(db, hypothesisId) {
  const row = db.prepare(`SELECT v.* FROM hypothesis_heads h
                          JOIN versions v ON v.version_id = h.version_id
                          WHERE h.hypothesis_id = ?`).get(hypothesisId);
  return row ?? null;
}

export function getVersionSnapshot(db, versionId) {
  const edges = db.prepare('SELECT from_uid,to_uid,kind,gap,occluded,origin,created_by FROM version_edges WHERE version_id = ?')
    .all(versionId).map((e) => ({ ...e, occluded: e.occluded ? 1 : 0 }));
  const occlusions = db.prepare('SELECT occl_uid,frame_start,frame_end,note FROM version_occlusions WHERE version_id = ?')
    .all(versionId);
  return { edges, occlusions };
}

/**
 * Publish a new version as ONE atomic transaction:
 * snapshot rows, version header and head pointer are inserted together,
 * so a crash can never leave edges committed under a header still pointing
 * at the previous graph (SQLite rollback journal/WAL guarantees all-or-nothing).
 */
export function publishVersion(db, {
  hypothesisId,
  edges,
  occlusions,
  baseVersion,
  parentVersion,
  note = null,
  validate = null,
  frameOf = null,
  maxOcclusionGap = 3,
}) {
  if (validate) {
    const result = validate({ edges, occlusions, frameOf, maxOcclusionGap });
    if (!result.ok) {
      const error = new Error('GRAPH_INVARIANT_VIOLATION');
      error.code = 'GRAPH_INVARIANT_VIOLATION';
      error.errors = result.errors;
      throw error;
    }
  }

  const tx = db.transaction(() => {
    const maxSeq = db.prepare('SELECT COALESCE(MAX(seq), 0) AS s FROM versions WHERE hypothesis_id = ?')
      .get(hypothesisId).s;
    const seq = maxSeq + 1;
    const versionId = newId('ver');

    const insVersion = db.prepare(`INSERT INTO versions
      (version_id, hypothesis_id, seq, parent_version, base_version, note, edge_count, occlusion_count)
      VALUES (?,?,?,?,?,?,?,?)`);
    const insEdge = db.prepare(`INSERT INTO version_edges
      (version_id, from_uid, to_uid, kind, gap, occluded, origin, created_by)
      VALUES (?,?,?,?,?,?,?,?)`);
    const insOcc = db.prepare(`INSERT INTO version_occlusions
      (version_id, occl_uid, frame_start, frame_end, note) VALUES (?,?,?,?,?)`);
    const upsertHead = db.prepare(`INSERT INTO hypothesis_heads (hypothesis_id, version_id)
      VALUES (?,?) ON CONFLICT(hypothesis_id) DO UPDATE SET version_id = excluded.version_id`);
    const insLog = db.prepare(`INSERT INTO publish_log
      (hypothesis_id, version_id, parent_version, base_version, seq, note)
      VALUES (?,?,?,?,?,?)`);

    insVersion.run(versionId, hypothesisId, seq, parentVersion ?? null, baseVersion ?? null,
      note, edges.length, occlusions.length);
    for (const e of edges) {
      insEdge.run(versionId, e.from_uid, e.to_uid, e.kind, e.gap ?? 1, e.occluded ? 1 : 0,
        e.origin ?? 'manual', e.created_by ?? 'local');
    }
    for (const o of occlusions) {
      insOcc.run(versionId, o.occl_uid, o.frame_start, o.frame_end, o.note ?? null);
    }
    upsertHead.run(hypothesisId, versionId);
    insLog.run(hypothesisId, versionId, parentVersion ?? null, baseVersion ?? null, seq, note);
    return { version_id: versionId, seq };
  });

  return tx();
}

export function listVersions(db, hypothesisId) {
  return db.prepare('SELECT version_id,seq,parent_version,base_version,note,published_at,edge_count,occlusion_count FROM versions WHERE hypothesis_id = ? ORDER BY seq')
    .all(hypothesisId);
}

export function listHypotheses(db, datasetHash) {
  return db.prepare(`SELECT h.*, v.seq AS head_seq, h2.version_id AS head_version
                     FROM hypotheses h
                     LEFT JOIN hypothesis_heads h2 ON h2.hypothesis_id = h.hypothesis_id
                     LEFT JOIN versions v ON v.version_id = h2.version_id
                     WHERE h.dataset_hash = ? ORDER BY h.created_at`).all(datasetHash);
}

export function recordEvidence(db, datasetHash, { candidateId = null, fromUid = null, toUid = null, verdict, reason = null, reviewer = 'local' }) {
  db.prepare(`INSERT INTO reviewed_evidence (dataset_hash, candidate_id, from_uid, to_uid, verdict, reason, reviewer)
              VALUES (?,?,?,?,?,?,?)
              ON CONFLICT DO UPDATE SET verdict = excluded.verdict, reason = excluded.reason, reviewer = excluded.reviewer, created_at = datetime('now')`)
    .run(datasetHash, candidateId, fromUid, toUid, verdict, reason, reviewer);
}

export function getDataset(db, hash) {
  const row = db.prepare('SELECT * FROM datasets WHERE dataset_hash = ?').get(hash);
  if (!row) return null;
  return { ...row, frames: JSON.parse(row.frames_json) };
}

export function listDatasets(db) {
  return db.prepare('SELECT dataset_hash,name,frame_count,created_at FROM datasets ORDER BY created_at').all();
}
