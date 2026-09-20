import { describe, expect, it } from 'vitest';
import { checkGraph } from '../src/shared/graph.ts';
import { graphWith, makeEdge, setupDataset } from './helpers.ts';

describe('graph invariants', () => {
  it('accepts a clean forward lineage', () => {
    const s = setupDataset();
    const { c_a0, c_a1, c_a2 } = pick(s, 'c_a0', 'c_a1', 'c_a2');
    const violations = checkGraph(
      graphWith(makeEdge(c_a0, c_a1), makeEdge(c_a1, c_a2)),
      s.ctx,
    );
    expect(violations).toEqual([]);
  });

  it('rejects time-backwards edges', () => {
    const s = setupDataset();
    const { c_a2, c_a1 } = pick(s, 'c_a2', 'c_a1');
    const violations = checkGraph(graphWith(makeEdge(c_a2, c_a1)), s.ctx);
    expect(violations.map((v) => v.code)).toContain('TIME_BACKWARDS');
  });

  it('rejects one-to-many that is not a confirmed division', () => {
    const s = setupDataset();
    const { c_a1, c_a2, c_b2 } = pick(s, 'c_a1', 'c_a2', 'c_b2');
    const violations = checkGraph(
      graphWith(makeEdge(c_a1, c_a2), makeEdge(c_a1, c_b2)),
      s.ctx,
    );
    expect(violations.map((v) => v.code)).toContain('MULTI_CHILD_NON_DIVISION');
  });

  it('rejects many-to-one that is not a marked merge', () => {
    const s = setupDataset();
    const { c_a5, c_b5, c_a6 } = pick(s, 'c_a5', 'c_b5', 'c_a6');
    const violations = checkGraph(
      graphWith(makeEdge(c_a5, c_a6), makeEdge(c_b5, c_a6)),
      s.ctx,
    );
    expect(violations.map((v) => v.code)).toContain('MULTI_PARENT');
  });

  it('accepts a marked merge with >=2 parents and rejects a lone merge edge', () => {
    const s = setupDataset();
    const { c_a6, c_b6, c_m7 } = pick(s, 'c_a6', 'c_b6', 'c_m7');
    const ok = checkGraph(
      graphWith(makeEdge(c_a6, c_m7, 'merge'), makeEdge(c_b6, c_m7, 'merge')),
      s.ctx,
    );
    expect(ok).toEqual([]);

    const bad = checkGraph(graphWith(makeEdge(c_a6, c_m7, 'merge')), s.ctx);
    expect(bad.map((v) => v.code)).toContain('MERGE_WITHOUT_MARK');
  });

  it('a division mother cannot also continue, and needs exactly two daughters', () => {
    const s = setupDataset();
    const { c_b2, c_b3, c_d3 } = pick(s, 'c_b2', 'c_b3', 'c_d3');
    const mixed = checkGraph(
      graphWith(
        makeEdge(c_b2, c_b3, 'continuation'),
        makeEdge(c_b2, c_b3, 'division'),
      ),
      s.ctx,
    );
    expect(mixed.map((v) => v.code)).toContain('DIVISION_PARENT_CONTINUES');

    const oneDaughter = checkGraph(graphWith(makeEdge(c_b2, c_d3, 'division')), s.ctx);
    expect(oneDaughter.map((v) => v.code)).toContain('MULTI_CHILD_NON_DIVISION');
  });

  it('rejects long fabricated gaps without an occlusion window', () => {
    const s = setupDataset();
    const { c_a3, c_a7 } = pick(s, 'c_a3', 'c_a7');
    // frames 3 -> 7 leaves frames 4,5,6 empty: gap of 3 is allowed by bound,
    // so use an even longer edge via the temporary custom context below.
    const noOcc = checkGraph(graphWith(makeEdge(c_a3, c_a7)), {
      contours: s.contoursById,
      options: { maxGapFrames: 1 },
    });
    expect(noOcc.map((v) => v.code)).toContain('FRAME_GAP_TOO_LARGE');

    const withOcc = checkGraph(
      {
        edges: [makeEdge(c_a3, c_a7)],
        occlusions: [
          {
            id: 'occ1',
            enterContourId: c_a3.id,
            exitContourId: c_a7.id,
            gapStartFrame: 4,
            gapEndFrame: 6,
            author: 'tester',
            createdAt: new Date().toISOString(),
          },
        ],
        negations: [],
      },
      { contours: s.contoursById, options: { maxGapFrames: 3 } },
    );
    expect(withOcc).toEqual([]);
  });

  it('rejects an occlusion longer than the configured bound', () => {
    const s = setupDataset();
    const { c_a0, c_a5 } = pick(s, 'c_a0', 'c_a5');
    const violations = checkGraph(
      {
        edges: [makeEdge(c_a0, c_a5)],
        occlusions: [
          {
            id: 'occLong',
            enterContourId: c_a0.id,
            exitContourId: c_a5.id,
            gapStartFrame: 1,
            gapEndFrame: 4,
            author: 'tester',
            createdAt: new Date().toISOString(),
          },
        ],
        negations: [],
      },
      { contours: s.contoursById, options: { maxGapFrames: 3 } },
    );
    expect(violations.map((v) => v.code)).toContain('OCCLUSION_GAP_EXCEEDED');
  });

  it('rejects edges that contradict a human negation', () => {
    const s = setupDataset();
    const { c_a0, c_a1 } = pick(s, 'c_a0', 'c_a1');
    const violations = checkGraph(
      {
        edges: [makeEdge(c_a0, c_a1)],
        occlusions: [],
        negations: [
          {
            id: 'neg1',
            fromContourId: c_a0.id,
            toContourId: c_a1.id,
            kind: 'continuation',
            author: 'tester',
            createdAt: new Date().toISOString(),
          },
        ],
      },
      s.ctx,
    );
    expect(violations.map((v) => v.code)).toContain('NEGATED_EDGE');
  });

  it('detects a cycle defensively even with malformed frame data', () => {
    const s = setupDataset();
    const { c_a0, c_a1, c_a2 } = pick(s, 'c_a0', 'c_a1', 'c_a2');
    const e1 = makeEdge(c_a0, c_a1);
    const e2 = makeEdge(c_a1, c_a2);
    // fabricate a backwards-closing arc; TIME_BACKWARDS also fires but CYCLE
    // must be present on the DFS.
    const e3 = makeEdge(c_a2, c_a0);
    const violations = checkGraph(graphWith(e1, e2, e3), {
      contours: s.contoursById,
      options: { maxGapFrames: 99 },
    });
    expect(violations.map((v) => v.code)).toContain('CYCLE');
  });
});

function pick<T extends string>(s: ReturnType<typeof setupDataset>, ...ids: T[]) {
  return Object.fromEntries(ids.map((id) => [id, s.contoursById.get(id)!])) as Record<
    T,
    ReturnType<typeof setupDataset>['contours'][number]
  >;
}
