PRAGMA foreign_keys = ON;

-- ---- Imported datasets (pixel segmentation is external; we store its outputs verbatim) ----
CREATE TABLE IF NOT EXISTS datasets (
  dataset_hash  TEXT PRIMARY KEY,
  name          TEXT NOT NULL,
  frame_count   INTEGER NOT NULL,
  width         INTEGER,
  height        INTEGER,
  created_at    TEXT NOT NULL DEFAULT (datetime('now')),
  raw_payload   TEXT NOT NULL,           -- the exact JSON document that was imported
  frames_json   TEXT NOT NULL            -- canonical frame summary for quick display
);

CREATE TABLE IF NOT EXISTS contours (
  dataset_hash  TEXT NOT NULL REFERENCES datasets(dataset_hash) ON DELETE CASCADE,
  contour_uid   TEXT NOT NULL,           -- stable external id, unique within dataset
  frame         INTEGER NOT NULL,
  center_x      REAL,
  center_y      REAL,
  area          REAL,
  boundary_json TEXT NOT NULL,           -- simplified boundary as supplied externally
  source        TEXT,                    -- external segmenter/program id or name
  raw_json      TEXT NOT NULL,           -- complete original record
  PRIMARY KEY (dataset_hash, contour_uid)
);
CREATE INDEX IF NOT EXISTS idx_contours_frame ON contours(dataset_hash, frame);

-- ---- External auto-tracking candidates; never overwritten by human review ----
CREATE TABLE IF NOT EXISTS candidates (
  candidate_id  TEXT PRIMARY KEY,        -- dataset_hash + '#' + external candidate key
  dataset_hash  TEXT NOT NULL REFERENCES datasets(dataset_hash) ON DELETE CASCADE,
  from_uid      TEXT NOT NULL,
  to_uid        TEXT NOT NULL,
  from_frame    INTEGER NOT NULL,
  to_frame      INTEGER NOT NULL,
  score         REAL,
  kind          TEXT NOT NULL DEFAULT 'continuation', -- continuation | division | merge
  source        TEXT,
  raw_json      TEXT NOT NULL,
  imported_at   TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_candidates
  ON candidates(dataset_hash, from_uid, to_uid, kind, COALESCE(source, ''));
CREATE INDEX IF NOT EXISTS idx_candidates_edges ON candidates(dataset_hash, from_uid, to_uid);

-- ---- Reviewed evidence lives outside hypothesis snapshots; re-import can only add candidates ----
CREATE TABLE IF NOT EXISTS reviewed_evidence (
  dataset_hash  TEXT NOT NULL REFERENCES datasets(dataset_hash) ON DELETE CASCADE,
  candidate_id  TEXT REFERENCES candidates(candidate_id) ON DELETE SET NULL,
  from_uid      TEXT,
  to_uid        TEXT,
  verdict       TEXT NOT NULL CHECK (verdict IN ('accepted', 'rejected')),
  reason        TEXT,
  reviewer      TEXT NOT NULL DEFAULT 'local',
  created_at    TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_reviewed_evidence
  ON reviewed_evidence(dataset_hash, COALESCE(candidate_id, ''), from_uid, to_uid);

-- ---- Hypotheses (competing hypotheses may coexist as parallel branches) ----
CREATE TABLE IF NOT EXISTS hypotheses (
  hypothesis_id TEXT PRIMARY KEY,
  dataset_hash  TEXT NOT NULL REFERENCES datasets(dataset_hash) ON DELETE CASCADE,
  name          TEXT NOT NULL,
  parent_id     TEXT REFERENCES hypotheses(hypothesis_id) ON DELETE SET NULL,
  created_at    TEXT NOT NULL DEFAULT (datetime('now'))
);

-- ---- Version headers; graph snapshot rows are written inside the SAME transaction ----
CREATE TABLE IF NOT EXISTS versions (
  version_id    TEXT PRIMARY KEY,
  hypothesis_id TEXT NOT NULL REFERENCES hypotheses(hypothesis_id) ON DELETE CASCADE,
  seq           INTEGER NOT NULL,
  parent_version TEXT REFERENCES versions(version_id) DEFERRABLE INITIALLY DEFERRED,
  base_version  TEXT,                     -- version the client diff was computed against
  head_after    INTEGER NOT NULL DEFAULT 1,
  published_at  TEXT NOT NULL DEFAULT (datetime('now')),
  note          TEXT,
  edge_count    INTEGER NOT NULL DEFAULT 0,
  occlusion_count INTEGER NOT NULL DEFAULT 0,
  UNIQUE (hypothesis_id, seq)
);
CREATE INDEX IF NOT EXISTS idx_versions_hyp ON versions(hypothesis_id, seq DESC);

-- The current pointer is a separate table so the header + pointer commit together.
CREATE TABLE IF NOT EXISTS hypothesis_heads (
  hypothesis_id TEXT PRIMARY KEY REFERENCES hypotheses(hypothesis_id) ON DELETE CASCADE,
  version_id    TEXT NOT NULL REFERENCES versions(version_id) DEFERRABLE INITIALLY DEFERRED
);

-- Full snapshot of published edges per version.
CREATE TABLE IF NOT EXISTS version_edges (
  version_id  TEXT NOT NULL REFERENCES versions(version_id) ON DELETE CASCADE,
  from_uid    TEXT NOT NULL,
  to_uid      TEXT NOT NULL,
  kind        TEXT NOT NULL CHECK (kind IN ('continuation', 'division', 'merge')),
  gap         INTEGER NOT NULL DEFAULT 1,
  occluded    INTEGER NOT NULL DEFAULT 0,
  origin      TEXT NOT NULL DEFAULT 'manual', -- manual | candidate:<id>
  created_by  TEXT NOT NULL DEFAULT 'local',
  PRIMARY KEY (version_id, from_uid, to_uid)
);
CREATE INDEX IF NOT EXISTS idx_vedges_to ON version_edges(version_id, to_uid);
CREATE INDEX IF NOT EXISTS idx_vedges_from ON version_edges(version_id, from_uid);

-- Occlusion intervals: a track may legitimately have no contour for a bounded span.
CREATE TABLE IF NOT EXISTS version_occlusions (
  version_id    TEXT NOT NULL REFERENCES versions(version_id) ON DELETE CASCADE,
  occl_uid      TEXT NOT NULL,           -- track anchor: the contour before the gap
  frame_start   INTEGER NOT NULL,       -- first missing frame
  frame_end     INTEGER NOT NULL,        -- last missing frame (inclusive)
  note          TEXT,
  PRIMARY KEY (version_id, occl_uid, frame_start, frame_end)
);

-- Append-only audit trail of every successful publication.
CREATE TABLE IF NOT EXISTS publish_log (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  hypothesis_id TEXT NOT NULL,
  version_id    TEXT NOT NULL,
  parent_version TEXT,
  base_version  TEXT,
  seq           INTEGER NOT NULL,
  note          TEXT,
  published_at  TEXT NOT NULL DEFAULT (datetime('now'))
);
