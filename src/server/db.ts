import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

let dbInstance: DatabaseSync | null = null;

export function openDb(path?: string): DatabaseSync {
  const dbPath = path ?? process.env.LINEAGE_DB ?? 'data/lineage.sqlite';
  if (dbPath !== ':memory:') mkdirSync(dirname(dbPath), { recursive: true });
  const db = new DatabaseSync(dbPath);
  db.exec('PRAGMA journal_mode = WAL;');
  db.exec('PRAGMA foreign_keys = ON;');
  migrate(db);
  return db;
}

export function getDb(): DatabaseSync {
  if (!dbInstance) dbInstance = openDb();
  return dbInstance;
}

export function setDbInstance(db: DatabaseSync | null): void {
  dbInstance = db;
}

function migrate(db: DatabaseSync): void {
  db.exec(`
  CREATE TABLE IF NOT EXISTS dataset (
    id            TEXT PRIMARY KEY,
    name          TEXT NOT NULL,
    frames        INTEGER NOT NULL,
    import_source TEXT NOT NULL,
    content_hash  TEXT NOT NULL UNIQUE,
    imported_at   TEXT NOT NULL,
    max_gap_frames INTEGER NOT NULL DEFAULT 3
  );

  CREATE TABLE IF NOT EXISTS contour (
    id          TEXT PRIMARY KEY,
    dataset_id  TEXT NOT NULL REFERENCES dataset(id) ON DELETE CASCADE,
    frame       INTEGER NOT NULL,
    external_id TEXT NOT NULL,
    cx          REAL NOT NULL,
    cy          REAL NOT NULL,
    area        REAL NOT NULL,
    boundary    TEXT NOT NULL,
    meta        TEXT,
    UNIQUE(dataset_id, external_id)
  );

  CREATE TABLE IF NOT EXISTS candidate (
    id               TEXT PRIMARY KEY,
    dataset_id       TEXT NOT NULL REFERENCES dataset(id) ON DELETE CASCADE,
    run_id           TEXT NOT NULL,
    ext_key          TEXT NOT NULL,
    from_contour_id  TEXT,
    to_contour_id    TEXT,
    kind             TEXT NOT NULL,
    score            REAL NOT NULL,
    raw              TEXT,
    created_at       TEXT NOT NULL,
    UNIQUE(dataset_id, run_id, ext_key)
  );

  CREATE TABLE IF NOT EXISTS hypothesis (
    id                 TEXT PRIMARY KEY,
    dataset_id         TEXT NOT NULL REFERENCES dataset(id) ON DELETE CASCADE,
    name               TEXT NOT NULL,
    parent_id          TEXT REFERENCES hypothesis(id),
    created_at         TEXT NOT NULL,
    archived           INTEGER NOT NULL DEFAULT 0,
    current_version_id TEXT
  );

  CREATE TABLE IF NOT EXISTS version (
    id              TEXT PRIMARY KEY,
    hypothesis_id   TEXT NOT NULL REFERENCES hypothesis(id) ON DELETE CASCADE,
    version_no      INTEGER NOT NULL,
    graph_json      TEXT NOT NULL,
    base_version_id TEXT REFERENCES version(id),
    author          TEXT NOT NULL,
    message         TEXT NOT NULL,
    published_at    TEXT NOT NULL,
    UNIQUE(hypothesis_id, version_no)
  );

  CREATE TABLE IF NOT EXISTS draft (
    hypothesis_id   TEXT PRIMARY KEY REFERENCES hypothesis(id) ON DELETE CASCADE,
    graph_json      TEXT NOT NULL,
    base_version_id TEXT NOT NULL,
    rev             INTEGER NOT NULL DEFAULT 1,
    updated_by      TEXT NOT NULL,
    updated_at      TEXT NOT NULL
  );
  `);
}
