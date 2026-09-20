import { describe, it, expect } from 'vitest';
import { validateGraph, applyEdits, detectCycle, affectedSubgraph } from '../server/graph.js';

const frameOf = new Map([
  ['a', 0], ['b', 1], ['c', 1], ['d', 2], ['g', 2], ['e', 3], ['f', 4],
]);

const cont = (from_uid, to_uid, extra = {}) => ({ from_uid, to_uid, kind: 'continuation', gap: 1, occluded: 0, ...extra });
const div = (from_uid, to_uid) => ({ from_uid, to_uid, kind: 'division', gap: 1, occluded: 0 });
const merge = (from_uid, to_uid) => ({ from_uid, to_uid, kind: 'merge', gap: 1, occluded: 0 });

describe('validateGraph', () => {
  it('accepts a clean continuation chain', () => {
    const result = validateGraph({ edges: [cont('a', 'b'), cont('b', 'd')], frameOf });
    expect(result.ok).toBe(true);
  });

  it('accepts a properly marked division with two daughters', () => {
    const result = validateGraph({ edges: [cont('a', 'b'), div('b', 'd'), div('b', 'g')], frameOf });
    expect(result.ok).toBe(true);
  });

  it('rejects a mother that both continues and divides', () => {
    const result = validateGraph({ edges: [div('b', 'd'), div('b', 'g'), cont('b', 'c')], frameOf });
    expect(result.ok).toBe(false);
    expect(result.errors.some((e) => e.code === 'MOTHER_CONTINUES_AFTER_DIVISION')).toBe(true);
  });

  it('rejects one-to-many fan-out not marked division', () => {
    const result = validateGraph({ edges: [cont('b', 'd'), cont('b', 'e')], frameOf });
    expect(result.ok).toBe(false);
    expect(result.errors.some((e) => e.code === 'NON_DIVISION_FAN_OUT')).toBe(true);
  });

  it('rejects many-to-one fan-in not marked merge', () => {
    const result = validateGraph({ edges: [cont('b', 'd'), cont('c', 'd')], frameOf });
    expect(result.ok).toBe(false);
    expect(result.errors.some((e) => e.code === 'NON_MERGE_FAN_IN')).toBe(true);
  });

  it('accepts two parents for a merge child', () => {
    const result = validateGraph({ edges: [merge('b', 'd'), merge('c', 'd')], frameOf });
    expect(result.ok).toBe(true);
  });

  it('rejects time reversal', () => {
    const result = validateGraph({ edges: [cont('b', 'a')], frameOf });
    expect(result.ok).toBe(false);
    expect(result.errors.some((e) => e.code === 'TIME_REVERSAL')).toBe(true);
  });

  it('detects cycles even with missing frame data', () => {
    const edges = [
      { from_uid: 'x', to_uid: 'y', kind: 'continuation' },
      { from_uid: 'y', to_uid: 'z', kind: 'continuation' },
      { from_uid: 'z', to_uid: 'x', kind: 'continuation' },
    ];
    expect(detectCycle(edges)).toEqual(['x', 'y', 'z', 'x']);
    const result = validateGraph({ edges, frameOf: new Map() });
    expect(result.errors.some((e) => e.code === 'CYCLE')).toBe(true);
  });

  it('rejects a multi-frame gap without occlusion interval', () => {
    const result = validateGraph({
      edges: [cont('b', 'e', { gap: 2, occluded: 1 })], frameOf, maxOcclusionGap: 3,
    });
    expect(result.errors.some((e) => e.code === 'GAP_WITHOUT_OCCLUSION')).toBe(true);
  });

  it('accepts a multi-frame gap covered by a bounded occlusion interval', () => {
    const result = validateGraph({
      edges: [cont('b', 'e', { gap: 2, occluded: 1 })],
      occlusions: [{ occl_uid: 'b', frame_start: 2, frame_end: 2 }],
      frameOf, maxOcclusionGap: 3,
    });
    expect(result.ok).toBe(true);
  });

  it('rejects a fictional link spanning more frames than the occlusion limit', () => {
    const result = validateGraph({
      edges: [cont('b', 'f', { gap: 3, occluded: 1 })],
      occlusions: [{ occl_uid: 'b', frame_start: 2, frame_end: 3 }],
      frameOf, maxOcclusionGap: 1,
    });
    expect(result.errors.some((e) => e.code === 'GAP_TOO_LARGE')).toBe(true);
  });

  it('rejects two tracks reusing the same contour without merge (double predecessor)', () => {
    const result = validateGraph({
      edges: [cont('a', 'd'), cont('b', 'd')], frameOf,
    });
    expect(result.ok).toBe(false);
    expect(result.errors.some((e) => e.code === 'NON_MERGE_FAN_IN')).toBe(true);
  });
});

describe('applyEdits', () => {
  it('upserts and deletes edges', () => {
    const snapshot = { edges: [cont('a', 'b')], occlusions: [] };
    const next = applyEdits(snapshot, [
      { op: 'upsertEdge', edge: cont('b', 'd') },
      { op: 'deleteEdge', from_uid: 'a', to_uid: 'b' },
    ]);
    expect(next.edges).toHaveLength(1);
    expect(next.edges[0]).toMatchObject({ from_uid: 'b', to_uid: 'd' });
  });

  it('computes a minimal affected subgraph around edits', () => {
    const edges = [cont('a', 'b'), cont('b', 'd')];
    const sub = affectedSubgraph(edges, [], [{ op: 'deleteEdge', from_uid: 'a', to_uid: 'b' }]);
    expect(sub.contours).toEqual(expect.arrayContaining(['a', 'b', 'd']));
  });
});
