import { checkGraph, type GraphContext } from './graph.ts';
import type {
  Edge,
  GraphData,
  Negation,
  Occlusion,
  Violation,
} from './types.ts';

export interface GraphConflict {
  message: string;
  refs: string[];
  mine: string[];
  theirs: string[];
}

export interface AffectedSubgraph {
  contourIds: string[];
  edges: Edge[];
  occlusions: Occlusion[];
  negations: Negation[];
}

export interface MergeResult {
  merged: GraphData;
  conflicts: GraphConflict[];
  violations: Violation[];
  affected: AffectedSubgraph;
  mineAdded: ElementChange[];
  mineRemoved: ElementChange[];
  theirsAdded: ElementChange[];
  theirsRemoved: ElementChange[];
}

interface ElementChange {
  kind: 'edge' | 'occlusion' | 'negation';
  key: string;
  element: Edge | Occlusion | Negation;
}

const edgeKey = (e: Edge) => `edge:${e.kind}:${e.fromId}->${e.toId}`;
const occKey = (o: Occlusion) => `occ:${o.enterContourId}->${o.exitContourId}`;
const negKey = (n: Negation) =>
  `neg:${n.kind}:${n.fromContourId ?? '*'}->${n.toContourId ?? '*'}`;

function indexGraph(graph: GraphData) {
  const edges = new Map<string, Edge>();
  const occlusions = new Map<string, Occlusion>();
  const negations = new Map<string, Negation>();
  for (const e of graph.edges) edges.set(edgeKey(e), e);
  for (const o of graph.occlusions) occlusions.set(occKey(o), o);
  for (const n of graph.negations) negations.set(negKey(n), n);
  return { edges, occlusions, negations };
}

function diff(base: GraphData, next: GraphData) {
  const b = indexGraph(base);
  const n = indexGraph(next);
  const added: ElementChange[] = [];
  const removed: ElementChange[] = [];
  for (const [key, el] of n.edges)
    if (!b.edges.has(key)) added.push({ kind: 'edge', key, element: el });
  for (const [key, el] of b.edges)
    if (!n.edges.has(key)) removed.push({ kind: 'edge', key, element: el });
  for (const [key, el] of n.occlusions)
    if (!b.occlusions.has(key)) added.push({ kind: 'occlusion', key, element: el });
  for (const [key, el] of b.occlusions)
    if (!n.occlusions.has(key)) removed.push({ kind: 'occlusion', key, element: el });
  for (const [key, el] of n.negations)
    if (!b.negations.has(key)) added.push({ kind: 'negation', key, element: el });
  for (const [key, el] of b.negations)
    if (!n.negations.has(key)) removed.push({ kind: 'negation', key, element: el });
  return { added, removed };
}

const cloneGraph = (g: GraphData): GraphData => ({
  edges: g.edges.map((e) => ({ ...e })),
  occlusions: g.occlusions.map((o) => ({ ...o })),
  negations: g.negations.map((n) => ({ ...n })),
});

function removeByKey(graph: GraphData, change: ElementChange): void {
  if (change.kind === 'edge') graph.edges = graph.edges.filter((e) => edgeKey(e) !== change.key);
  if (change.kind === 'occlusion')
    graph.occlusions = graph.occlusions.filter((o) => occKey(o) !== change.key);
  if (change.kind === 'negation')
    graph.negations = graph.negations.filter((n) => negKey(n) !== change.key);
}

/**
 * Three-way merge of a draft against a concurrently published head.
 * `base` is the version the draft started from. Non-overlapping changes merge
 * automatically; competing edits on the same contour/arc are reported as
 * conflicts together with the minimal affected subgraph.
 */
export function mergeGraphs(
  base: GraphData,
  mine: GraphData,
  theirs: GraphData,
  ctx: GraphContext,
): MergeResult {
  const my = diff(base, mine);
  const their = diff(base, theirs);
  const myAddKeys = new Set(my.added.map((c) => c.key));
  const theirAddKeys = new Set(their.added.map((c) => c.key));

  const merged = cloneGraph(theirs);

  // My deletions win only for elements the other side did not re-create.
  for (const change of my.removed) {
    if (!theirAddKeys.has(change.key)) removeByKey(merged, change);
  }
  // My additions: identical additions converge; different additions are both
  // kept here, then screened for cardinality / negation conflicts below.
  for (const change of my.added) {
    if (theirAddKeys.has(change.key)) continue;
    if (change.kind === 'edge') merged.edges.push(change.element as Edge);
    if (change.kind === 'occlusion')
      merged.occlusions.push(change.element as Occlusion);
    if (change.kind === 'negation')
      merged.negations.push(change.element as Negation);
  }

  const violations = checkGraph(merged, ctx);
  const myElementIds = new Set<string>();
  for (const change of my.added) myElementIds.add(change.element.id);
  for (const change of my.removed) myElementIds.add(change.element.id);

  // Direct conflicts: same arc edited on both sides in incompatible ways.
  const conflicts: GraphConflict[] = [];
  for (const mineAdded of my.added.filter((c) => c.kind === 'edge')) {
    for (const theirsAdded of their.added.filter((c) => c.kind === 'edge')) {
      const me = mineAdded.element as Edge;
      const th = theirsAdded.element as Edge;
      const sameContour =
        me.fromId === th.fromId ||
        me.toId === th.toId ||
        me.fromId === th.toId ||
        me.toId === th.fromId;
      if (sameContour && mineAdded.key !== theirsAdded.key) {
        conflicts.push({
          message: `两条编辑在轮廓 ${[me.fromId, me.toId, th.fromId, th.toId]
            .filter((v, i, a) => a.indexOf(v) === i)
            .join(' / ')} 上竞争同一前驱或后继位置`,
          refs: [...endpoints(me), ...endpoints(th)],
          mine: [me.id],
          theirs: [th.id],
        });
      }
    }
  }

  // Negation cross-conflict: my edge negated by their new negation and vice
  // versa, or my negation contradicts their newly added edge.
  const myEdges = my.added.filter((c) => c.kind === 'edge').map((c) => c.element as Edge);
  const theirEdges = their.added
    .filter((c) => c.kind === 'edge')
    .map((c) => c.element as Edge);
  const myNegations = my.added
    .filter((c) => c.kind === 'negation')
    .map((c) => c.element as Negation);
  const theirNegations = their.added
    .filter((c) => c.kind === 'negation')
    .map((c) => c.element as Negation);

  for (const edge of myEdges) {
    for (const neg of theirNegations) {
      if (negationHits(neg, edge)) {
        conflicts.push({
          message: `我方边 ${edge.id} 被对方新否定 ${neg.id} 覆盖`,
          refs: [edge.id, neg.id, ...endpoints(edge)],
          mine: [edge.id],
          theirs: [neg.id],
        });
      }
    }
  }
  for (const edge of theirEdges) {
    for (const neg of myNegations) {
      if (negationHits(neg, edge)) {
        conflicts.push({
          message: `对方边 ${edge.id} 与我方新否定 ${neg.id} 冲突`,
          refs: [edge.id, neg.id, ...endpoints(edge)],
          mine: [neg.id],
          theirs: [edge.id],
        });
      }
    }
  }

  // Structural conflicts: invariants of the merged graph whose refs involve
  // at least one element changed on my side.
  for (const violation of violations) {
    const touchesMine = violation.refs.some((ref) => myElementIds.has(ref));
    if (touchesMine) {
      conflicts.push({
        message: `合并后违反 ${violation.code}: ${violation.message}`,
        refs: violation.refs,
        mine: violation.refs.filter((r) => myElementIds.has(r)),
        theirs: [],
      });
    }
  }

  const affected = buildAffectedSubgraph(merged, conflicts, my, their);
  return {
    merged,
    conflicts,
    violations,
    affected,
    mineAdded: my.added,
    mineRemoved: my.removed,
    theirsAdded: their.added,
    theirsRemoved: their.removed,
  };
}

function endpoints(edge: Edge): string[] {
  return [edge.fromId, edge.toId];
}

function negationHits(neg: Negation, edge: Edge): boolean {
  return (
    neg.kind === edge.kind &&
    (neg.fromContourId === null || neg.fromContourId === edge.fromId) &&
    (neg.toContourId === null || neg.toContourId === edge.toId)
  );
}

/**
 * Minimal affected subgraph: every contour/edge/occlusion/negation named by a
 * conflict, expanded by one adjacency hop so reviewers see the local context.
 */
function buildAffectedSubgraph(
  graph: GraphData,
  conflicts: GraphConflict[],
  my: { added: ElementChange[]; removed: ElementChange[] },
  their: { added: ElementChange[]; removed: ElementChange[] },
): AffectedSubgraph {
  const seedIds = new Set<string>();
  for (const conflict of conflicts) for (const ref of conflict.refs) seedIds.add(ref);
  for (const set of [my.added, my.removed, their.added, their.removed]) {
    for (const change of set) {
      seedIds.add(change.element.id);
      const el = change.element;
      if ('fromId' in el) seedIds.add(el.fromId), seedIds.add(el.toId);
      if ('enterContourId' in el)
        seedIds.add(el.enterContourId), seedIds.add(el.exitContourId);
      if ('fromContourId' in el) {
        if (el.fromContourId) seedIds.add(el.fromContourId);
        if (el.toContourId) seedIds.add(el.toContourId);
      }
    }
  }

  // Expand one hop through edges.
  const contourIds = new Set<string>();
  for (const edge of graph.edges) {
    if (seedIds.has(edge.id) || seedIds.has(edge.fromId) || seedIds.has(edge.toId)) {
      contourIds.add(edge.fromId);
      contourIds.add(edge.toId);
    }
  }
  for (const id of seedIds) contourIds.add(id);

  const edges = graph.edges.filter(
    (e) => contourIds.has(e.fromId) && contourIds.has(e.toId),
  );
  const occlusions = graph.occlusions.filter(
    (o) => contourIds.has(o.enterContourId) && contourIds.has(o.exitContourId),
  );
  const negations = graph.negations.filter(
    (n) =>
      (n.fromContourId === null || contourIds.has(n.fromContourId)) &&
      (n.toContourId === null || contourIds.has(n.toContourId)),
  );

  return { contourIds: [...contourIds], edges, occlusions, negations };
}

export { edgeKey, occKey, negKey, indexGraph };
