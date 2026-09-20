import { addEdge, addNegation, edgeExists } from './model.ts';
import { isNegated } from '../shared/graph.ts';
import type { Candidate, GraphData } from '../shared/types.ts';

export { addEdge, addNegation, edgeExists };

export function isNegatedCandidate(graph: GraphData, candidate: Candidate): boolean {
  if (!candidate.fromContourId || !candidate.toContourId) return false;
  return isNegated(
    { fromId: candidate.fromContourId, toId: candidate.toContourId, kind: candidate.kind },
    graph.negations,
  );
}
