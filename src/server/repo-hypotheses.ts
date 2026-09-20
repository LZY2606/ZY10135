import type { DatabaseSync } from 'node:sqlite';
import { newId } from '../shared/id.ts';
import { checkGraph, type GraphContext } from '../shared/graph.ts';
import { mergeGraphs, type MergeResult } from '../shared/merge.ts';
import type { GraphData } from '../shared/types.ts';

export const EMPTY_GRAPH: GraphData = { edges: [], occlusions: [], negations: [] };

export interface VersionRow {
  id: string;
  hypothesisId: string;
  versionNo: number;
  graph: GraphData;
  baseVersionId: string | null;
  author: string;
  message: string;
  publishedAt: string;
}

export interface HypothesisSummary {
  id: string;
  datasetId: string;
  name: string;
  parentId: string | null;
  createdAt: string;
  archived: boolean;
  currentVersionId: string | null;
  currentVersionNo: number | null;
  hasDraft: boolean;
  draftRev: number | null;
}

export function listHypotheses(db: DatabaseSync, datasetId: string): HypothesisSummary[] {
  const rows = db
    .prepare(
      `SELECT h.*, v.version_no AS current_version_no, d.rev AS draft_rev
       FROM hypothesis h
       LEFT JOIN version v ON v.id = h.current_version_id
       LEFT JOIN draft d ON d.hypothesis_id = h.id
       WHERE h.dataset_id = ? AND h.archived = 0
       ORDER BY h.created_at`,
    )
    .all(datasetId) as any[];
  return rows.map((r) => ({
    id: r.id,
    datasetId: r.dataset_id,
    name: r.name,
    parentId: r.parent_id,
    createdAt: r.created_at,
    archived: Boolean(r.archived),
    currentVersionId: r.current_version_id,
    currentVersionNo: r.current_version_no ?? null,
    hasDraft: Boolean(r.draft_rev),
    draftRev: r.draft_rev ?? null,
  }));
}

export function createHypothesis(
  db: DatabaseSync,
  datasetId: string,
  name: string,
  author: string,
  parentId: string | null = null,
): string {
  const id = newId('hyp');
  db.prepare(
    `INSERT INTO hypothesis (id, dataset_id, name, parent_id, created_at, current_version_id)
     VALUES (?, ?, ?, ?, ?, NULL)`,
  ).run(id, datasetId, name, parentId, new Date().toISOString());
  db.prepare(
    `INSERT INTO draft (hypothesis_id, graph_json, base_version_id, rev, updated_by, updated_at)
     VALUES (?, ?, ?, 1, ?, ?)`,
  ).run(id, JSON.stringify(EMPTY_GRAPH), '', author, new Date().toISOString());
  return id;
}

export function getDraft(db: DatabaseSync, hypothesisId: string) {
  const row = db
    .prepare('SELECT * FROM draft WHERE hypothesis_id = ?')
    .get(hypothesisId) as any;
  if (!row) return null;
  return {
    hypothesisId: row.hypothesis_id,
    graph: JSON.parse(row.graph_json) as GraphData,
    baseVersionId: (row.base_version_id || null) as string | null,
    rev: row.rev as number,
    updatedBy: row.updated_by,
    updatedAt: row.updated_at,
  };
}

export function getHeadGraph(
  db: DatabaseSync,
  hypothesisId: string,
): { graph: GraphData; versionId: string | null } {
  const row = db
    .prepare('SELECT current_version_id FROM hypothesis WHERE id = ?')
    .get(hypothesisId) as { current_version_id: string | null } | undefined;
  if (!row || !row.current_version_id) {
    return { graph: EMPTY_GRAPH, versionId: null };
  }
  const v = db
    .prepare('SELECT graph_json FROM version WHERE id = ?')
    .get(row.current_version_id) as { graph_json: string };
  return { graph: JSON.parse(v.graph_json), versionId: row.current_version_id };
}

export function getBaseGraph(db: DatabaseSync, baseVersionId: string | null): GraphData {
  if (!baseVersionId) return EMPTY_GRAPH;
  const row = db
    .prepare('SELECT graph_json FROM version WHERE id = ?')
    .get(baseVersionId) as { graph_json: string } | undefined;
  return row ? JSON.parse(row.graph_json) : EMPTY_GRAPH;
}

export interface SaveDraftResult {
  ok: boolean;
  rev?: number;
  currentRev?: number;
}

/**
 * Optimistic-concurrency draft save: a stale expected rev is rejected so a
 * later save can never silently swallow an earlier editor's links.
 */
export function saveDraft(
  db: DatabaseSync,
  hypothesisId: string,
  graph: GraphData,
  expectedRev: number,
  author: string,
): SaveDraftResult {
  const current = getDraft(db, hypothesisId);
  if (!current) throw new Error('草稿不存在');
  if (current.rev !== expectedRev) {
    return { ok: false, currentRev: current.rev };
  }
  const now = new Date().toISOString();
  db.prepare(
    `UPDATE draft SET graph_json = ?, rev = rev + 1, updated_by = ?, updated_at = ?
     WHERE hypothesis_id = ?`,
  ).run(JSON.stringify(graph), author, now, hypothesisId);
  return { ok: true, rev: current.rev + 1 };
}

export interface PublishResult {
  status: 'published' | 'conflict';
  version?: VersionRow;
  merge?: MergeResult;
}

/**
 * Publish a draft as an immutable version. When the head advanced since the
 * draft opened, a three-way merge decides: clean merge publishes on the same
 * hypothesis; any conflict refuses the write and returns the minimal affected
 * subgraph for the conflict page.
 */
export function publishDraft(
  db: DatabaseSync,
  hypothesisId: string,
  graph: GraphData,
  expectedRev: number,
  author: string,
  message: string,
  ctx: GraphContext,
): PublishResult {
  const draft = getDraft(db, hypothesisId);
  if (!draft) throw new Error('草稿不存在');
  if (draft.rev !== expectedRev) {
    const head = getHeadGraph(db, hypothesisId);
    const merge = mergeGraphs(getBaseGraph(db, draft.baseVersionId), graph, head.graph, ctx);
    return { status: 'conflict', merge };
  }

  const head = getHeadGraph(db, hypothesisId);
  if (head.versionId && head.versionId !== draft.baseVersionId) {
    const merge = mergeGraphs(
      getBaseGraph(db, draft.baseVersionId),
      graph,
      head.graph,
      ctx,
    );
    if (merge.conflicts.length > 0) return { status: 'conflict', merge };
    return commitVersion(
      db,
      hypothesisId,
      merge.merged,
      head.versionId,
      author,
      message,
      true,
      ctx,
    );
  }

  return commitVersion(db, hypothesisId, graph, head.versionId, author, message, false, ctx);
}

/**
 * Atomically write the version row, flip the hypothesis head pointer and
 * rebind the draft inside ONE transaction. WAL + a single transaction make it
 * crash-atomic: edges and the version head can never diverge.
 */
function commitVersion(
  db: DatabaseSync,
  hypothesisId: string,
  graph: GraphData,
  baseVersionId: string | null,
  author: string,
  message: string,
  merged: boolean,
  ctx: GraphContext,
): PublishResult {
  const violations = checkGraph(graph, ctx);
  if (violations.length > 0) {
    const err = new Error('GRAPH_VIOLATIONS');
    (err as any).violations = violations;
    throw err;
  }

  const nextNoRow = db
    .prepare(
      'SELECT COALESCE(MAX(version_no), 0) + 1 AS next_no FROM version WHERE hypothesis_id = ?',
    )
    .get(hypothesisId) as { next_no: number };
  const versionId = newId('ver');
  const now = new Date().toISOString();

  db.exec('BEGIN IMMEDIATE');
  try {
    db.prepare(
      `INSERT INTO version (id, hypothesis_id, version_no, graph_json, base_version_id,
         author, message, published_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      versionId,
      hypothesisId,
      nextNoRow.next_no,
      JSON.stringify(graph),
      baseVersionId,
      author,
      merged ? `${message}（三路合并后发布）` : message,
      now,
    );
    db.prepare('UPDATE hypothesis SET current_version_id = ? WHERE id = ?').run(
      versionId,
      hypothesisId,
    );
    db.prepare(
      `UPDATE draft SET graph_json = ?, base_version_id = ?, rev = rev + 1,
         updated_by = ?, updated_at = ? WHERE hypothesis_id = ?`,
    ).run(JSON.stringify(graph), versionId, author, now, hypothesisId);
    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }

  return {
    status: 'published',
    version: {
      id: versionId,
      hypothesisId,
      versionNo: nextNoRow.next_no,
      graph,
      baseVersionId,
      author,
      message,
      publishedAt: now,
    },
  };
}

export function listVersions(db: DatabaseSync, hypothesisId: string): VersionRow[] {
  const rows = db
    .prepare('SELECT * FROM version WHERE hypothesis_id = ? ORDER BY version_no')
    .all(hypothesisId) as any[];
  return rows.map((r) => ({
    id: r.id,
    hypothesisId: r.hypothesis_id,
    versionNo: r.version_no,
    graph: JSON.parse(r.graph_json),
    baseVersionId: r.base_version_id,
    author: r.author,
    message: r.message,
    publishedAt: r.published_at,
  }));
}

export function getVersion(db: DatabaseSync, versionId: string): VersionRow | null {
  const r = db.prepare('SELECT * FROM version WHERE id = ?').get(versionId) as any;
  if (!r) return null;
  return {
    id: r.id,
    hypothesisId: r.hypothesis_id,
    versionNo: r.version_no,
    graph: JSON.parse(r.graph_json),
    baseVersionId: r.base_version_id,
    author: r.author,
    message: r.message,
    publishedAt: r.published_at,
  };
}

export interface ResolveResult extends PublishResult {
  forkHypothesisId?: string;
}

/**
 * Derive one of the two solutions offered on the conflict page:
 * - rebase: publish the auto-merged graph on the same hypothesis;
 * - fork: branch a new parallel hypothesis from the current head and publish
 *   my graph there, preserving both competing lineages.
 */
export function resolveConflict(
  db: DatabaseSync,
  hypothesisId: string,
  mode: 'rebase' | 'fork',
  graph: GraphData,
  author: string,
  message: string,
  ctx: GraphContext,
  forkName?: string,
): ResolveResult {
  const draft = getDraft(db, hypothesisId);
  if (!draft) throw new Error('草稿不存在');
  const head = getHeadGraph(db, hypothesisId);
  const baseGraph = getBaseGraph(db, draft.baseVersionId);
  const merge = mergeGraphs(baseGraph, graph, head.graph, ctx);

  if (mode === 'rebase') {
    if (merge.conflicts.length > 0) return { status: 'conflict', merge };
    return commitVersion(
      db,
      hypothesisId,
      merge.merged,
      head.versionId,
      author,
      message,
      true,
      ctx,
    );
  }

  const summary = db
    .prepare('SELECT dataset_id, name FROM hypothesis WHERE id = ?')
    .get(hypothesisId) as { dataset_id: string; name: string };
  const forkId = createHypothesis(
    db,
    summary.dataset_id,
    forkName ?? `${summary.name}（并行分支）`,
    author,
    hypothesisId,
  );
  db.prepare('DELETE FROM draft WHERE hypothesis_id = ?').run(forkId);
  db.prepare(
    `INSERT INTO draft (hypothesis_id, graph_json, base_version_id, rev, updated_by, updated_at)
     VALUES (?, ?, ?, 1, ?, ?)`,
  ).run(forkId, JSON.stringify(graph), head.versionId ?? '', author, new Date().toISOString());
  const result = commitVersion(db, forkId, graph, head.versionId, author, message, false, ctx);
  return { ...result, forkHypothesisId: forkId };
}

/** Recompute the three-way merge for the conflict page. */
export function previewConflict(
  db: DatabaseSync,
  hypothesisId: string,
  graph: GraphData,
  ctx: GraphContext,
): MergeResult {
  const draft = getDraft(db, hypothesisId);
  if (!draft) throw new Error('草稿不存在');
  const head = getHeadGraph(db, hypothesisId);
  return mergeGraphs(getBaseGraph(db, draft.baseVersionId), graph, head.graph, ctx);
}

export { mergeGraphs };
