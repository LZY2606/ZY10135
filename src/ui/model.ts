import { newId } from '../shared/id.ts';
import type { Contour, Edge, EdgeKind, GraphData, Negation } from '../shared/types.ts';

const now = () => new Date().toISOString();

export function cloneGraph(graph: GraphData): GraphData {
  return {
    edges: graph.edges.map((e) => ({ ...e })),
    occlusions: graph.occlusions.map((o) => ({ ...o })),
    negations: graph.negations.map((n) => ({ ...n })),
  };
}

export function edgeExists(
  graph: GraphData,
  fromId: string,
  toId: string,
  kind?: EdgeKind,
): Edge | undefined {
  return graph.edges.find(
    (e) => e.fromId === fromId && e.toId === toId && (kind ? e.kind === kind : true),
  );
}

export function incomingEdges(graph: GraphData, contourId: string): Edge[] {
  return graph.edges.filter((e) => e.toId === contourId);
}
export function outgoingEdges(graph: GraphData, contourId: string): Edge[] {
  return graph.edges.filter((e) => e.fromId === contourId);
}

/**
 * Add one edge. Existing edges on the same arc/kind are idempotent. When the
 * target already has a single-predecessor claim, the old incoming edge is
 * replaced for continuation/division so a contour never silently keeps two
 * predecessors; merges explicitly allow multiple marked parents.
 */
export function addEdge(
  graph: GraphData,
  fromId: string,
  toId: string,
  kind: EdgeKind,
  author: string,
  source: Edge['source'] = 'manual',
  candidateId?: string,
): { graph: GraphData; replaced?: Edge[] } {
  const next = cloneGraph(graph);
  const existing = edgeExists(next, fromId, toId, kind);
  if (existing) return { graph: next };

  const replaced: Edge[] = [];
  if (kind !== 'merge') {
    // single-predecessor invariant, proactively maintained by the editor
    for (const old of incomingEdges(next, toId).filter((e) => e.kind !== 'merge')) {
      replaced.push(old);
    }
    next.edges = next.edges.filter(
      (e) => !(e.toId === toId && e.kind !== 'merge' && replaced.includes(e)),
    );
  }

  next.edges.push({
    id: newId('e'),
    fromId,
    toId,
    kind,
    source,
    candidateId,
    author,
    createdAt: now(),
  });
  return { graph: next, replaced };
}

export function removeEdge(graph: GraphData, edgeId: string): GraphData {
  const next = cloneGraph(graph);
  next.edges = next.edges.filter((e) => e.id !== edgeId);
  // An occlusion without its bridge edge cannot stand; drop it too.
  const removed = graph.edges.find((e) => e.id === edgeId);
  if (removed) {
    next.occlusions = next.occlusions.filter(
      (o) => !(o.enterContourId === removed.fromId && o.exitContourId === removed.toId),
    );
  }
  return next;
}

/**
 * Confirm a division: mother keeps exactly two outgoing division edges and
 * must not also continue. Prior outgoing edges of the mother are replaced.
 */
export function confirmDivision(
  graph: GraphData,
  motherId: string,
  daughterIds: [string, string],
  author: string,
): GraphData {
  if (new Set(daughterIds).size < 2 || daughterIds.includes(motherId)) {
    throw new Error('分裂需要两个不同的子细胞轮廓');
  }
  let next = cloneGraph(graph);
  next.edges = next.edges.filter((e) => e.fromId !== motherId);
  for (const daughterId of daughterIds) {
    // daughter gets exactly this division as predecessor
    next.edges = next.edges.filter(
      (e) => !(e.toId === daughterId && e.kind !== 'merge'),
    );
    next.edges.push({
      id: newId('e'),
      fromId: motherId,
      toId: daughterId,
      kind: 'division',
      source: 'manual',
      author,
      createdAt: now(),
    });
  }
  return next;
}

/**
 * Mark a merge: >=2 parents join into one child. All incoming edges of the
 * child become explicit merge edges from the chosen parents.
 */
export function confirmMerge(
  graph: GraphData,
  parentIds: string[],
  childId: string,
  author: string,
): GraphData {
  const unique = [...new Set(parentIds)].filter((id) => id !== childId);
  if (unique.length < 2) throw new Error('合并至少需要两个不同的母轮廓');
  let next = cloneGraph(graph);
  next.edges = next.edges.filter((e) => e.toId !== childId);
  for (const parentId of unique) {
    next.edges = next.edges.filter((e) => !(e.fromId === parentId && e.toId === childId));
    next.edges.push({
      id: newId('e'),
      fromId: parentId,
      toId: childId,
      kind: 'merge',
      source: 'manual',
      author,
      createdAt: now(),
    });
  }
  return next;
}

/**
 * Mark an occlusion window over a continuation edge that skips frames.
 * The gap is derived from the contour frames; the continuation edge is
 * created when missing.
 */
export function markOcclusion(
  graph: GraphData,
  contoursById: Map<string, Contour>,
  enterId: string,
  exitId: string,
  author: string,
  note?: string,
): GraphData {
  const enter = contoursById.get(enterId);
  const exit = contoursById.get(exitId);
  if (!enter || !exit) throw new Error('轮廓不存在');
  if (exit.frame <= enter.frame + 1) {
    throw new Error('遮挡只能标记在至少跨过一个空帧的链接上');
  }
  let next = edgeExists(graph, enterId, exitId, 'continuation')
    ? cloneGraph(graph)
    : addEdge(graph, enterId, exitId, 'continuation', author).graph;
  next.occlusions = next.occlusions.filter(
    (o) => !(o.enterContourId === enterId && o.exitContourId === exitId),
  );
  next.occlusions.push({
    id: newId('oc'),
    enterContourId: enterId,
    exitContourId: exitId,
    gapStartFrame: enter.frame + 1,
    gapEndFrame: exit.frame - 1,
    author,
    createdAt: now(),
    note,
  });
  return next;
}

export function removeOcclusion(graph: GraphData, occlusionId: string): GraphData {
  const next = cloneGraph(graph);
  next.occlusions = next.occlusions.filter((o) => o.id !== occlusionId);
  return next;
}

export function addNegation(
  graph: GraphData,
  fromContourId: string | null,
  toContourId: string | null,
  kind: EdgeKind,
  author: string,
  candidateId?: string,
  reason?: string,
): GraphData {
  const next = cloneGraph(graph);
  const dup = next.negations.some(
    (n) =>
      n.kind === kind &&
      n.fromContourId === fromContourId &&
      n.toContourId === toContourId,
  );
  if (dup) return next;
  const negation: Negation = {
    id: newId('neg'),
    fromContourId,
    toContourId,
    kind,
    candidateId,
    author,
    createdAt: now(),
    reason,
  };
  next.negations.push(negation);
  // A published graph must respect negations: drop a conflicting live edge.
  next.edges = next.edges.filter(
    (e) =>
      !(
        e.kind === kind &&
        (fromContourId === null || e.fromId === fromContourId) &&
        (toContourId === null || e.toId === toContourId)
      ),
  );
  return next;
}

export function removeNegation(graph: GraphData, negationId: string): GraphData {
  const next = cloneGraph(graph);
  next.negations = next.negations.filter((n) => n.id !== negationId);
  return next;
}

export const AUTHOR_KEY = 'lineage.author';
export function getAuthor(): string {
  return localStorage.getItem(AUTHOR_KEY) || '研究员';
}
