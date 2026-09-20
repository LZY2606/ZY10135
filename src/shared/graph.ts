import type {
  Candidate,
  CheckOptions,
  Contour,
  Edge,
  GraphData,
  Negation,
  Occlusion,
  Violation,
} from './types.ts';

export interface GraphContext {
  contours: Map<string, Contour>;
  options: CheckOptions;
}

function groupBy<K, V>(items: V[], key: (item: V) => K): Map<K, V[]> {
  const out = new Map<K, V[]>();
  for (const item of items) {
    const k = key(item);
    const list = out.get(k);
    if (list) list.push(item);
    else out.set(k, [item]);
  }
  return out;
}

/**
 * Validate a materialized hypothesis graph against the lineage invariants:
 * single predecessor per contour (unless marked merge), division/merge
 * cardinality, forward-in-time edges, bounded occlusions without contour
 * reuse, acyclicity and respect for human negations.
 */
export function checkGraph(graph: GraphData, ctx: GraphContext): Violation[] {
  const violations: Violation[] = [];
  const { contours, options } = ctx;
  const { edges, occlusions, negations } = graph;

  const byId = new Map<string, Edge>();
  for (const edge of edges) {
    if (byId.has(edge.id)) {
      violations.push({ code: 'CYCLE', message: `重复边 id ${edge.id}`, refs: [edge.id] });
    }
    byId.set(edge.id, edge);
  }

  const outgoing = groupBy(edges, (e) => e.fromId);
  const incoming = groupBy(edges, (e) => e.toId);

  // --- Per-edge checks -----------------------------------------------------
  for (const edge of edges) {
    const from = contours.get(edge.fromId);
    const to = contours.get(edge.toId);
    if (!from || !to) {
      violations.push({
        code: 'MISSING_CONTOUR',
        message: `边 ${edge.id} 引用了不存在的轮廓`,
        refs: [edge.id, edge.fromId, edge.toId],
      });
      continue;
    }

    if (to.frame <= from.frame) {
      violations.push({
        code: 'TIME_BACKWARDS',
        message: `边 ${edge.id} 时间倒流: f${from.frame} → f${to.frame}`,
        refs: [edge.id, from.id, to.id],
      });
    }

    const gap = to.frame - from.frame - 1;
    const hasOcclusion = occlusions.some(
      (o) => o.enterContourId === edge.fromId && o.exitContourId === edge.toId,
    );
    if (gap > options.maxGapFrames && !hasOcclusion) {
      violations.push({
        code: 'FRAME_GAP_TOO_LARGE',
        message: `边 ${edge.id} 跨越 ${gap} 个空帧（上限 ${options.maxGapFrames}）且未标记遮挡`,
        refs: [edge.id, from.id, to.id],
      });
    }

    for (const negation of negations) {
      if (
        negation.kind === edge.kind &&
        (negation.fromContourId === null || negation.fromContourId === from.id) &&
        (negation.toContourId === null || negation.toContourId === to.id)
      ) {
        violations.push({
          code: 'NEGATED_EDGE',
          message: `边 ${edge.id} 与人工否定冲突`,
          refs: [edge.id, negation.id, from.id, to.id],
        });
      }
    }
  }

  // --- Outgoing cardinality ------------------------------------------------
  for (const [contourId, outs] of outgoing) {
    const kinds = new Set(outs.map((e) => e.kind));
    if (kinds.size > 1) {
      violations.push({
        code: 'DIVISION_PARENT_CONTINUES',
        message: `母细胞 ${contourId} 既已分裂又在下一帧继续`,
        refs: [contourId, ...outs.map((e) => e.id)],
      });
      continue;
    }
    const kind = outs[0].kind;
    if (kind === 'continuation' && outs.length > 1) {
      violations.push({
        code: 'MULTI_CHILD_NON_DIVISION',
        message: `轮廓 ${contourId} 有 ${outs.length} 条普通后继（一对多必须确认为分裂）`,
        refs: [contourId, ...outs.map((e) => e.id)],
      });
    }
    if (kind === 'division' && outs.length !== 2) {
      violations.push({
        code: 'MULTI_CHILD_NON_DIVISION',
        message: `分裂必须恰好有两个子细胞，轮廓 ${contourId} 有 ${outs.length} 个`,
        refs: [contourId, ...outs.map((e) => e.id)],
      });
    }
  }

  // --- Incoming cardinality ------------------------------------------------
  for (const [contourId, ins] of incoming) {
    const mergeEdges = ins.filter((e) => e.kind === 'merge');
    const otherEdges = ins.filter((e) => e.kind !== 'merge');

    if (mergeEdges.length > 0 && otherEdges.length > 0) {
      violations.push({
        code: 'MERGE_WITHOUT_MARK',
        message: `轮廓 ${contourId} 同时有合并边与普通入边`,
        refs: [contourId, ...ins.map((e) => e.id)],
      });
    }
    if (mergeEdges.length > 0 && mergeEdges.length < 2) {
      violations.push({
        code: 'MERGE_WITHOUT_MARK',
        message: `合并至少需要两条入边，轮廓 ${contourId} 只有 ${mergeEdges.length} 条`,
        refs: [contourId, ...mergeEdges.map((e) => e.id)],
      });
    }
    if (mergeEdges.length === 0 && otherEdges.length > 1) {
      violations.push({
        code: 'MULTI_PARENT',
        message: `轮廓 ${contourId} 有 ${otherEdges.length} 个前驱（多对一必须标记合并）`,
        refs: [contourId, ...otherEdges.map((e) => e.id)],
      });
    }
    const divisionEdges = ins.filter((e) => e.kind === 'division');
    if (divisionEdges.length > 1) {
      violations.push({
        code: 'MULTI_PARENT',
        message: `轮廓 ${contourId} 是 ${divisionEdges.length} 次分裂的子细胞`,
        refs: [contourId, ...divisionEdges.map((e) => e.id)],
      });
    }
  }

  validateOcclusions(graph, ctx, violations);
  detectCycles(edges, violations);

  return violations;
}

function validateOcclusions(
  graph: GraphData,
  ctx: GraphContext,
  violations: Violation[],
) {
  const { contours, options } = ctx;
  const edgeByPair = new Map(
    graph.edges.map((e) => [`${e.fromId} ${e.toId}`, e]),
  );

  for (const occlusion of graph.occlusions) {
    const enter = contours.get(occlusion.enterContourId);
    const exit = contours.get(occlusion.exitContourId);
    if (!enter || !exit) {
      violations.push({
        code: 'OCCLUSION_MISMATCH',
        message: `遮挡区间 ${occlusion.id} 引用了不存在的轮廓`,
        refs: [occlusion.id, occlusion.enterContourId, occlusion.exitContourId],
      });
      continue;
    }

    const edge = edgeByPair.get(`${enter.id} ${exit.id}`);
    if (!edge) {
      violations.push({
        code: 'OCCLUSION_WITHOUT_EDGE',
        message: `遮挡区间 ${occlusion.id} 没有对应的跨帧链接`,
        refs: [occlusion.id, enter.id, exit.id],
      });
    } else if (edge.kind !== 'continuation') {
      violations.push({
        code: 'OCCLUSION_MISMATCH',
        message: `遮挡区间 ${occlusion.id} 只能挂在普通延续边上`,
        refs: [occlusion.id, edge.id],
      });
    }

    if (occlusion.gapEndFrame < occlusion.gapStartFrame) {
      violations.push({
        code: 'OCCLUSION_MISMATCH',
        message: `遮挡区间 ${occlusion.id} 起止帧颠倒`,
        refs: [occlusion.id],
      });
    }

    const gapLength = occlusion.gapEndFrame - occlusion.gapStartFrame + 1;
    if (gapLength > options.maxGapFrames) {
      violations.push({
        code: 'OCCLUSION_GAP_EXCEEDED',
        message: `遮挡区间 ${occlusion.id} 长 ${gapLength} 帧，超过上限 ${options.maxGapFrames}`,
        refs: [occlusion.id],
      });
    }

    if (
      occlusion.gapStartFrame !== enter.frame + 1 ||
      occlusion.gapEndFrame !== exit.frame - 1
    ) {
      violations.push({
        code: 'OCCLUSION_MISMATCH',
        message: `遮挡区间 ${occlusion.id} 的帧范围与两端轮廓不匹配`,
        refs: [occlusion.id, enter.id, exit.id],
      });
    }

    if (occlusion.gapStartFrame <= enter.frame) {
      violations.push({
        code: 'TIME_BACKWARDS',
        message: `遮挡区间 ${occlusion.id} 不能覆盖已有轮廓的帧`,
        refs: [occlusion.id, enter.id],
      });
    }
  }

  // Two occluded tracks may not cover the same empty frame unless they join
  // (share an endpoint): that would be two tracks reusing one path without a
  // declared merge.
  const overlapping = (a: Occlusion, b: Occlusion): boolean =>
    a.gapStartFrame <= b.gapEndFrame && b.gapStartFrame <= a.gapEndFrame;
  const joins = (a: Occlusion, b: Occlusion): boolean =>
    a.enterContourId === b.enterContourId ||
    a.exitContourId === b.exitContourId ||
    a.exitContourId === b.enterContourId ||
    a.enterContourId === b.exitContourId;

  for (let i = 0; i < graph.occlusions.length; i++) {
    for (let j = i + 1; j < graph.occlusions.length; j++) {
      const a = graph.occlusions[i];
      const b = graph.occlusions[j];
      if (overlapping(a, b) && !joins(a, b)) {
        violations.push({
          code: 'CONTOUR_REUSE',
          message: `两条遮挡轨迹在未标记合并时复用同一时间路径`,
          refs: [a.id, b.id],
        });
      }
    }
  }
}

function detectCycles(edges: Edge[], violations: Violation[]) {
  const adjacency = new Map<string, string[]>();
  const edgeOnArc = new Map<string, string>();
  for (const edge of edges) {
    const list = adjacency.get(edge.fromId) ?? [];
    list.push(edge.toId);
    adjacency.set(edge.fromId, list);
    edgeOnArc.set(`${edge.fromId} ${edge.toId}`, edge.id);
  }

  const state = new Map<string, 0 | 1 | 2>();
  const stack: string[] = [];
  let foundCycle = false;

  const visit = (node: string): void => {
    if (foundCycle) return;
    state.set(node, 1);
    stack.push(node);
    for (const next of adjacency.get(node) ?? []) {
      const s = state.get(next) ?? 0;
      if (s === 1) {
        const start = stack.indexOf(next);
        const cycleNodes = stack.slice(start);
        const edgeIds = cycleNodes
          .map((n, i) =>
            edgeOnArc.get(`${n} ${cycleNodes[(i + 1) % cycleNodes.length]}`),
          )
          .filter((x): x is string => Boolean(x));
        violations.push({
          code: 'CYCLE',
          message: `谱系中存在环: ${cycleNodes.join(' -> ')} -> ${next}`,
          refs: [...edgeIds, ...cycleNodes],
        });
        foundCycle = true;
        return;
      }
      if (s === 0) visit(next);
    }
    stack.pop();
    state.set(node, 2);
  };

  for (const node of adjacency.keys()) {
    if ((state.get(node) ?? 0) === 0) visit(node);
    if (foundCycle) break;
  }
}

/** Does an edge duplicate an existing candidate pair/kind? */
export function findCandidateForEdge(
  edge: Pick<Edge, 'fromId' | 'toId' | 'kind'>,
  candidates: Candidate[],
): Candidate | undefined {
  return candidates.find(
    (c) =>
      c.kind === edge.kind &&
      c.fromContourId === edge.fromId &&
      c.toContourId === edge.toId,
  );
}

export function isNegated(
  edge: Pick<Edge, 'fromId' | 'toId' | 'kind'>,
  negations: Negation[],
): boolean {
  return negations.some(
    (n) =>
      n.kind === edge.kind &&
      (n.fromContourId === null || n.fromContourId === edge.fromId) &&
      (n.toContourId === null || n.toContourId === edge.toId),
  );
}

export type { Occlusion };
