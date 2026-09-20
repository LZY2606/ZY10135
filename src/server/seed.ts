import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { importDataset } from './repo-datasets.ts';
import {
  createHypothesis,
  publishDraft,
  saveDraft,
} from './repo-hypotheses.ts';
import type { Contour, Edge, GraphData, Negation } from '../shared/types.ts';

const here = dirname(fileURLToPath(import.meta.url));
const fixturePath = (name: string) => join(here, '../../fixtures', name);

export function seedDemo(db: DatabaseSync): { datasetId: string; hypothesisId: string } | null {
  if (process.env.LINEAGE_NO_SEED === '1') return null;
  const existing = db.prepare('SELECT id FROM dataset LIMIT 1').get() as
    | { id: string }
    | undefined;
  if (existing) return null;

  const payload = JSON.parse(readFileSync(fixturePath('demo-t0.json'), 'utf8'));
  const imported = importDataset(db, payload);
  const datasetId = imported.datasetId;

  const author = 'seed';
  const hypothesisId = createHypothesis(db, datasetId, '已审核主谱系', author);

  // A clean, already-published lineage: A track, B track with an occlusion
  // across frame 4, and a reviewed negation of the spurious crowd link.
  const edge = (
    id: string,
    fromId: string,
    toId: string,
    kind: Edge['kind'],
    source: Edge['source'] = 'candidate',
  ): Edge => ({
    id,
    fromId,
    toId,
    kind,
    source,
    author,
    createdAt: '2026-09-01T00:00:00.000Z',
  });

  const graph: GraphData = {
    edges: [
      edge('seed_e_a01', 'c_a0', 'c_a1', 'continuation'),
      edge('seed_e_a12', 'c_a1', 'c_a2', 'continuation'),
      edge('seed_e_a23', 'c_a2', 'c_a3', 'continuation'),
      edge('seed_e_a34', 'c_a3', 'c_a4', 'continuation'),
      edge('seed_e_a45', 'c_a4', 'c_a5', 'continuation'),
      edge('seed_e_a56', 'c_a5', 'c_a6', 'continuation'),
      edge('seed_e_a67', 'c_a6', 'c_a7', 'continuation'),

      edge('seed_e_b01', 'c_b0', 'c_b1', 'continuation'),
      edge('seed_e_b12', 'c_b1', 'c_b2', 'continuation'),
      edge('seed_e_b23', 'c_b2', 'c_b3', 'continuation'),
      // B disappears at frame 4: continuation edge with an occlusion window.
      edge('seed_e_b35', 'c_b3', 'c_b5', 'continuation', 'manual'),
      edge('seed_e_b56', 'c_b5', 'c_b6', 'continuation'),
    ],
    occlusions: [
      {
        id: 'seed_oc_b4',
        enterContourId: 'c_b3',
        exitContourId: 'c_b5',
        gapStartFrame: 4,
        gapEndFrame: 4,
        author,
        createdAt: '2026-09-01T00:00:00.000Z',
        note: 'B 细胞在 f4 短暂消失',
      },
    ],
    negations: [
      {
        id: 'seed_neg_a2b3',
        fromContourId: 'c_a2',
        toContourId: 'c_b3',
        kind: 'continuation',
        candidateId: 't0-8',
        author,
        createdAt: '2026-09-01T00:00:00.000Z',
        reason: '拥挤区域的错误交叉链接',
      } satisfies Negation,
    ],
  };

  const draft = db.prepare('SELECT rev FROM draft WHERE hypothesis_id = ?').get(hypothesisId) as {
    rev: number;
  };
  saveDraft(db, hypothesisId, graph, draft.rev, author);
  const contours = new Map<string, Contour>(
    payload.contours.map((c: Contour) => [c.id, c]),
  );
  publishDraft(
    db,
    hypothesisId,
    graph,
    draft.rev + 1,
    author,
    '种子：已审核主谱系 v1',
    { contours, options: { maxGapFrames: 3 } },
  );

  // A second hypothesis with no published version, ready for experimenting
  // with the competing lineage (division / merge).
  createHypothesis(db, datasetId, '竞争假设（分裂/合并待确认）', author);

  return { datasetId, hypothesisId };
}
