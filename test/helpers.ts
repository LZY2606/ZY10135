import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { openDb } from '../src/server/db.ts';
import { importDataset } from '../src/server/repo-datasets.ts';
import {
  createHypothesis,
  getDraft,
  publishDraft,
  saveDraft,
} from '../src/server/repo-hypotheses.ts';
import type { Contour, DatasetPayload, Edge, EdgeKind, GraphData } from '../src/shared/types.ts';

const here = dirname(fileURLToPath(import.meta.url));

export function makeDb(): DatabaseSync {
  process.env.LINEAGE_NO_SEED = '1';
  return openDb(':memory:');
}

export function loadFixture(name = 'demo-t0.json'): DatasetPayload {
  return JSON.parse(readFileSync(join(here, '../fixtures', name), 'utf8'));
}

export interface Setup {
  db: DatabaseSync;
  datasetId: string;
  contours: Contour[];
  contoursById: Map<string, Contour>;
  hypothesisId: string;
  ctx: { contours: Map<string, Contour>; options: { maxGapFrames: number } };
}

export function setupDataset(fixture = 'demo-t0.json'): Setup {
  const db = makeDb();
  const payload = loadFixture(fixture);
  const { datasetId } = importDataset(db, payload);
  const hypothesisId = createHypothesis(db, datasetId, 'test', 'tester');
  const contours = payload.contours as Contour[];
  const contoursById = new Map(contours.map((c) => [c.id, c]));
  return {
    db,
    datasetId,
    contours,
    contoursById,
    hypothesisId,
    ctx: { contours: contoursById, options: { maxGapFrames: 3 } },
  };
}

let edgeSeq = 0;
export function makeEdge(
  from: Contour | string,
  to: Contour | string,
  kind: EdgeKind = 'continuation',
): Edge {
  const fromId = typeof from === 'string' ? from : from.id;
  const toId = typeof to === 'string' ? to : to.id;
  edgeSeq += 1;
  return {
    id: `te_${edgeSeq}`,
    fromId,
    toId,
    kind,
    source: 'manual',
    author: 'tester',
    createdAt: new Date().toISOString(),
  };
}

export function graphWith(...edges: Edge[]): GraphData {
  return { edges, occlusions: [], negations: [] };
}

export function publishGraph(s: Setup, graph: GraphData, message = 'publish') {
  const draft = getDraft(s.db, s.hypothesisId)!;
  saveDraft(s.db, s.hypothesisId, graph, draft.rev, 'tester');
  const draft2 = getDraft(s.db, s.hypothesisId)!;
  return publishDraft(
    s.db,
    s.hypothesisId,
    graph,
    draft2.rev,
    'tester',
    message,
    s.ctx,
  );
}

export { getDraft, saveDraft, publishDraft };
