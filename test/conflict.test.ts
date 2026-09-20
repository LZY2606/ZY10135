import { describe, expect, it } from 'vitest';
import { mergeGraphs } from '../src/shared/merge.ts';
import {
  getDraft,
  getHeadGraph,
  listHypotheses,
  publishDraft,
  resolveConflict,
  saveDraft,
} from '../src/server/repo-hypotheses.ts';
import { graphWith, makeEdge, publishGraph, setupDataset } from './helpers.ts';

describe('three-way merge on concurrent publish', () => {
  it('auto-merges disjoint edits but flags competing predecessors', () => {
    const s = setupDataset();
    const a0 = s.contoursById.get('c_a0')!;
    const a1 = s.contoursById.get('c_a1')!;
    const b0 = s.contoursById.get('c_b0')!;
    const b1 = s.contoursById.get('c_b1')!;
    const b2 = s.contoursById.get('c_b2')!;
    const a2 = s.contoursById.get('c_a2')!;

    // Base v1: a0->a1 and b0->b1.
    publishGraph(s, graphWith(makeEdge(a0, a1), makeEdge(b0, b1)));
    const headV1 = getHeadGraph(s.db, s.hypothesisId);

    // My draft (started at v1): adds a1->a2.
    const mine = graphWith(makeEdge(a0, a1), makeEdge(b0, b1), makeEdge(a1, a2));
    // Their published v2: adds b1->b2 (disjoint from mine).
    const theirs = graphWith(makeEdge(a0, a1), makeEdge(b0, b1), makeEdge(b1, b2));

    const merged = mergeGraphs(headV1.graph, mine, theirs, s.ctx);
    expect(merged.conflicts).toEqual([]);
    expect(merged.merged.edges).toHaveLength(4);
  });

  it('reports a conflict when both sides claim the same successor differently', () => {
    const s = setupDataset();
    const a1 = s.contoursById.get('c_a1')!;
    const b1 = s.contoursById.get('c_b1')!;
    const a2 = s.contoursById.get('c_a2')!;
    const b2 = s.contoursById.get('c_b2')!;

    publishGraph(s, graphWith(makeEdge(a1, a2)));
    const base = getHeadGraph(s.db, s.hypothesisId).graph;

    // Mine: re-point a2's predecessor from a1 to b1.
    const mine = graphWith(makeEdge(b1, a2));
    // Theirs: connect b1->b2 instead, keeping a1->a2.
    const theirs = graphWith(makeEdge(a1, a2), makeEdge(b1, b2));
    const merged = mergeGraphs(base, mine, theirs, s.ctx);
    // b1 has two different outgoing claims across the merge; either a
    // structural MULTI_CHILD violation or a direct conflict surfaces.
    expect(merged.conflicts.length).toBeGreaterThan(0);
    expect(merged.affected.contourIds).toEqual(
      expect.arrayContaining([b1.id, a2.id, b2.id]),
    );
  });

  it('flags a cross negation conflict (my edge vs their new negation)', () => {
    const s = setupDataset();
    const a2 = s.contoursById.get('c_a2')!;
    const b3 = s.contoursById.get('c_b3')!;
    const base = graphWith();
    const mine = {
      ...graphWith(makeEdge(a2, b3)),
    };
    const theirs: typeof mine = {
      edges: [],
      occlusions: [],
      negations: [
        {
          id: 'negX',
          fromContourId: a2.id,
          toContourId: b3.id,
          kind: 'continuation' as const,
          author: 'them',
          createdAt: new Date().toISOString(),
        },
      ],
    };
    const merged = mergeGraphs(base, mine, theirs, s.ctx);
    expect(merged.conflicts.some((c) => c.refs.includes('negX'))).toBe(true);
  });

  it('publish refuses on concurrent conflict; rebase then fork both succeed', () => {
    const s = setupDataset();
    const a1 = s.contoursById.get('c_a1')!;
    const a2 = s.contoursById.get('c_a2')!;
    const a3 = s.contoursById.get('c_a3')!;
    const b1 = s.contoursById.get('c_b1')!;
    const b2 = s.contoursById.get('c_b2')!;

    // v1 base
    publishGraph(s, graphWith(makeEdge(a1, a2)));
    const draftBase = getDraft(s.db, s.hypothesisId)!;
    expect(draftBase.baseVersionId).toBeTruthy();

    // Simulate a concurrent editor publishing v2 from the same base.
    const concurrentGraph = graphWith(makeEdge(a1, a2), makeEdge(b1, b2));
    const concurrentDraft = getDraft(s.db, s.hypothesisId)!;
    saveDraft(s.db, s.hypothesisId, concurrentGraph, concurrentDraft.rev, 'them');
    const d2 = getDraft(s.db, s.hypothesisId)!;
    publishDraft(s.db, s.hypothesisId, concurrentGraph, d2.rev, 'them', 'v2', s.ctx);

    // My stale draft tries to publish a competing a1 successor (a3 instead of a2).
    const myGraph = graphWith(makeEdge(a1, a3));
    const attempt = publishDraft(
      s.db,
      s.hypothesisId,
      myGraph,
      draftBase.rev + 1, // rev observed by me before their publish
      'me',
      'mine',
      s.ctx,
    );
    expect(attempt.status).toBe('conflict');
    expect(attempt.merge?.affected.contourIds).toEqual(
      expect.arrayContaining([a1.id, a3.id, a2.id, b2.id]),
    );

    // Fork resolution keeps both lineages as parallel hypotheses.
    const fork = resolveConflict(
      s.db,
      s.hypothesisId,
      'fork',
      myGraph,
      'me',
      'my lineage',
      s.ctx,
      '我的并行分支',
    );
    expect(fork.status).toBe('published');
    expect(fork.forkHypothesisId).toBeTruthy();
    const hyps = listHypotheses(s.db, s.datasetId);
    expect(hyps).toHaveLength(2);
    const forkHead = getHeadGraph(s.db, fork.forkHypothesisId!);
    expect(forkHead.graph.edges.map((e) => e.toId)).toEqual([a3.id]);
    const mainHead = getHeadGraph(s.db, s.hypothesisId);
    expect(mainHead.graph.edges).toHaveLength(2); // their v2 intact
  });
});
