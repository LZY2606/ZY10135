// Pure graph invariant checking. No database or framework dependencies.
//
// Model:
//   edges:  { from_uid, to_uid, kind, gap?, occluded? }
//     - continuation: one predecessor -> one successor (normal track)
//     - division:     one mother -> two daughters (fan-out)
//     - merge:        two parents -> one child (fan-in)
//   occlusions: { occl_uid, frame_start, frame_end }
//     A track anchored at contour occl_uid may have no contour for frames
//     frame_start..frame_end (inclusive).
//
// Every contour belongs to exactly one frame (frameOf).

export const EDGE_KINDS = ['continuation', 'division', 'merge'];

export function indexEdges(edges) {
  const out = new Map();
  const inn = new Map();
  for (const edge of edges) {
    if (!out.has(edge.from_uid)) out.set(edge.from_uid, []);
    if (!inn.has(edge.to_uid)) inn.set(edge.to_uid, []);
    out.get(edge.from_uid).push(edge);
    inn.get(edge.to_uid).push(edge);
  }
  return { out, inn };
}

/**
 * Validate a complete hypothesis snapshot.
 * @returns {{ok: true} | {ok: false, errors: Array<{code:string, message:string, refs?:object}>}}
 */
export function validateGraph({ edges = [], occlusions = [], frameOf = new Map(), maxOcclusionGap = 3 }) {
  const errors = [];
  const add = (code, message, refs = undefined) => errors.push({ code, message, refs });
  const { out, inn } = indexEdges(edges);

  for (const edge of edges) {
    if (!EDGE_KINDS.includes(edge.kind)) {
      add('EDGE_BAD_KIND', `Edge ${edge.from_uid}->${edge.to_uid} has unknown kind ${edge.kind}`, { edge });
    }
    const ff = frameOf.get(edge.from_uid);
    const tf = frameOf.get(edge.to_uid);
    if (ff === undefined || tf === undefined) {
      add('EDGE_UNKNOWN_CONTOUR', `Edge ${edge.from_uid}->${edge.to_uid} references a contour not in this dataset`, { edge });
      continue;
    }
    if (edge.from_uid === edge.to_uid) {
      add('EDGE_SELF_LOOP', `Contour ${edge.from_uid} links to itself`, { edge });
    }
    if (tf <= ff) {
      add('TIME_REVERSAL', `Edge ${edge.from_uid}(frame ${ff}) -> ${edge.to_uid}(frame ${tf}) does not move forward in time`, { edge });
    }
  }

  // Detect directed cycles (all edges are intended to be forward in time,
  // but defend against missing/foreign frame data).
  const cycle = detectCycle(edges);
  if (cycle) add('CYCLE', `Cycle detected: ${cycle.join(' -> ')}`, { cycle });

  // Outgoing-degree constraints by edge kind.
  for (const [uid, list] of out) {
    const kinds = new Set(list.map((e) => e.kind));
    if (list.length === 1 && list[0].kind === 'division') {
      add('DIVISION_TOO_FEW', `Division at ${uid} requires two daughters, found 1`, { uid });
    }
    if (list.length === 2 && !(list.every((e) => e.kind === 'division'))) {
      add('NON_DIVISION_FAN_OUT', `Contour ${uid} has two successors but they are not both marked division`, { uid, edges: list });
    }
    if (list.length > 2) {
      add('NON_DIVISION_FAN_OUT', `Contour ${uid} has ${list.length} successors; at most 2 and only via division`, { uid, edges: list });
    }
    if (kinds.has('division') && kinds.has('continuation')) {
      add('MOTHER_CONTINUES_AFTER_DIVISION',
        `Mother ${uid} cannot both divide and continue into the next frame (dividing mothers terminate at division)`,
        { uid, edges: list });
    }
  }

  // Incoming-degree constraints: at most one predecessor unless the contour is a merge child.
  for (const [uid, list] of inn) {
    const kinds = new Set(list.map((e) => e.kind));
    if (list.length === 1 && list[0].kind === 'merge') {
      add('MERGE_TOO_FEW', `Merge child ${uid} needs two parents, found 1`, { uid });
    }
    if (list.length === 2 && !list.every((e) => e.kind === 'merge')) {
      add('NON_MERGE_FAN_IN', `Contour ${uid} has two predecessors that are not both marked merge`, { uid, edges: list });
    }
    if (list.length > 2) {
      add('NON_MERGE_FAN_IN', `Contour ${uid} has ${list.length} predecessors; at most 2 and only via merge`, { uid, edges: list });
    }
    if (list.length === 2 && kinds.size > 1) {
      add('MIXED_FAN_IN', `Merge child ${uid} mixes edge kinds`, { uid });
    }
  }

  // Multi-frame / "fictional" gap links require a covering occlusion interval.
  const occlusionsFor = buildOcclusionIndex(occlusions);
  for (const candidateEdge of edges) {
    const ff = frameOf.get(candidateEdge.from_uid);
    const tf = frameOf.get(candidateEdge.to_uid);
    if (ff === undefined || tf === undefined) continue;
    const frameGap = tf - ff;
    if (frameGap > 1) {
      if (frameGap > maxOcclusionGap + 1) {
        add('GAP_TOO_LARGE',
          `Edge ${candidateEdge.from_uid}->${candidateEdge.to_uid} spans ${frameGap - 1} missing frames; occlusion limit is ${maxOcclusionGap}`,
          { edge: candidateEdge, gap: frameGap });
      }
      const covered = occlusionsFor.has(candidateEdge.from_uid) &&
        occlusionsFor.get(candidateEdge.from_uid).some((o) => o.frame_start <= ff + 1 && o.frame_end >= tf - 1);
      if (!covered) {
        add('GAP_WITHOUT_OCCLUSION',
          `Edge ${candidateEdge.from_uid}->${candidateEdge.to_uid} skips ${frameGap - 1} frame(s) without a covering occlusion interval`,
          { edge: candidateEdge, gap: frameGap });
      }
      if (!candidateEdge.occluded) {
        add('GAP_NOT_FLAGGED', `Gap link ${candidateEdge.from_uid}->${candidateEdge.to_uid} must be flagged as occluded`, { edge: candidateEdge });
      }
    } else if (frameGap === 1 && candidateEdge.occluded) {
      add('SPURIOUS_OCCLUSION_FLAG', `Adjacent edge ${candidateEdge.from_uid}->${candidateEdge.to_uid} is wrongly marked occluded`, { edge: candidateEdge });
    }
  }

  // Occlusion intervals themselves must be well-formed and bounded.
  for (const occ of occlusions) {
    if (occ.frame_end < occ.frame_start) {
      add('OCCLUSION_REVERSED', `Occlusion at ${occ.occl_uid} ends before it starts`, { occlusion: occ });
    }
    const span = occ.frame_end - occ.frame_start + 1;
    if (span > maxOcclusionGap) {
      add('OCCLUSION_TOO_LONG',
        `Occlusion at ${occ.occl_uid} covers ${span} frames; limit is ${maxOcclusionGap}`, { occlusion: occ });
    }
    const anchorFrame = frameOf.get(occ.occl_uid);
    if (anchorFrame === undefined) {
      add('OCCLUSION_UNKNOWN_ANCHOR', `Occlusion anchored at unknown contour ${occ.occl_uid}`, { occlusion: occ });
    } else if (occ.frame_start !== anchorFrame + 1) {
      add('OCCLUSION_MISALIGNED',
        `Occlusion at ${occ.occl_uid} must start at frame ${anchorFrame + 1}`, { occlusion: occ });
    }
  }

  return errors.length ? { ok: false, errors } : { ok: true };
}

function buildOcclusionIndex(occlusions) {
  const map = new Map();
  for (const occ of occlusions) {
    if (!map.has(occ.occl_uid)) map.set(occ.occl_uid, []);
    map.get(occ.occl_uid).push(occ);
  }
  return map;
}

/** Returns the first cycle found as an ordered list of uids, or null. */
export function detectCycle(edges) {
  const { out } = indexEdges(edges);
  const seen = new Set();
  const stack = new Set();
  let found = null;

  const visit = (uid, path) => {
    if (found) return;
    if (stack.has(uid)) {
      const start = path.indexOf(uid);
      found = path.slice(start).concat(uid);
      return;
    }
    if (seen.has(uid)) return;
    seen.add(uid);
    stack.add(uid);
    path.push(uid);
    for (const edge of out.get(uid) ?? []) visit(edge.to_uid, path);
    path.pop();
    stack.delete(uid);
  };

  for (const uid of out.keys()) {
    visit(uid, []);
    if (found) return found;
  }
  return null;
}

/**
 * Apply a list of edits to a snapshot and return the new edges/occlusions.
 * Edits are normalized but not validated; run validateGraph afterwards.
 *  {op:'upsertEdge', edge} | {op:'deleteEdge', from_uid,to_uid}
 *  {op:'addOcclusion', occlusion} | {op:'updateOcclusion', occl_uid, frame_start, frame_end, note?}
 *  | {op:'deleteOcclusion', occl_uid, frame_start, frame_end}
 */
export function applyEdits(snapshot, edits) {
  let edges = snapshot.edges.map((e) => ({ ...e }));
  let occlusions = snapshot.occlusions.map((o) => ({ ...o }));

  for (const edit of edits) {
    switch (edit.op) {
      case 'upsertEdge': {
        const edge = normalizeEdge(edit.edge);
        edges = edges.filter((e) => !(e.from_uid === edge.from_uid && e.to_uid === edge.to_uid));
        edges.push(edge);
        break;
      }
      case 'deleteEdge':
        edges = edges.filter((e) => !(e.from_uid === edit.from_uid && e.to_uid === edit.to_uid));
        break;
      case 'addOcclusion':
        occlusions = occlusions.filter(
          (o) => !(o.occl_uid === edit.occlusion.occl_uid &&
                   o.frame_start === edit.occlusion.frame_start &&
                   o.frame_end === edit.occlusion.frame_end),
        );
        occlusions.push({ ...edit.occlusion });
        break;
      case 'updateOcclusion':
        occlusions = occlusions.filter(
          (o) => !(o.occl_uid === edit.occl_uid &&
                   o.frame_start === edit.frame_start &&
                   o.frame_end === edit.frame_end),
        );
        occlusions.push({
          occl_uid: edit.occl_uid,
          frame_start: edit.new_start ?? edit.frame_start,
          frame_end: edit.new_end ?? edit.frame_end,
          note: edit.note,
        });
        break;
      case 'deleteOcclusion':
        occlusions = occlusions.filter(
          (o) => !(o.occl_uid === edit.occl_uid &&
                   o.frame_start === edit.frame_start &&
                   o.frame_end === edit.frame_end),
        );
        break;
      default:
        throw new Error(`Unknown edit op: ${edit.op}`);
    }
  }
  return { edges, occlusions };
}

export function normalizeEdge(edge) {
  const gap = Number(edge.gap ?? 1);
  return {
    from_uid: edge.from_uid,
    to_uid: edge.to_uid,
    kind: edge.kind ?? 'continuation',
    gap: Number.isFinite(gap) ? gap : 1,
    occluded: edge.occluded ? 1 : 0,
    origin: edge.origin ?? 'manual',
    created_by: edge.created_by ?? 'local',
  };
}

/**
 * Minimal affected subgraph for a set of edits: all edited edges' endpoints,
 * expanded by one edge so users can see why a constraint fired.
 */
export function affectedSubgraph(edges, occlusions, edits) {
  const focus = new Set();
  for (const edit of edits) {
    if (edit.edge) focus.add(edit.edge.from_uid), focus.add(edit.edge.to_uid);
    if (edit.from_uid) focus.add(edit.from_uid);
    if (edit.to_uid) focus.add(edit.to_uid);
    if (edit.occlusion) focus.add(edit.occlusion.occl_uid);
    if (edit.occl_uid) focus.add(edit.occl_uid);
  }
  const keep = new Set(focus);
  const subEdges = [];
  for (const edge of edges) {
    if (focus.has(edge.from_uid) || focus.has(edge.to_uid)) {
      keep.add(edge.from_uid);
      keep.add(edge.to_uid);
      subEdges.push(edge);
    }
  }
  const subOcclusions = occlusions.filter((o) => focus.has(o.occl_uid));
  return { contours: [...keep], edges: subEdges, occlusions: subOcclusions };
}

/** Set difference of edge identities (from_uid,to_uid,kind). */
export function diffEdges(before, after) {
  const key = (e) => `${e.from_uid}\u0000${e.to_uid}\u0000${e.kind}`;
  const beforeMap = new Map(before.map((e) => [key(e), e]));
  const afterMap = new Map(after.map((e) => [key(e), e]));
  const added = [];
  const removed = [];
  const changed = [];
  for (const [k, e] of afterMap) {
    if (!beforeMap.has(k)) added.push(e);
    else if (JSON.stringify(beforeMap.get(k)) !== JSON.stringify(e)) changed.push(e);
  }
  for (const [k, e] of beforeMap) if (!afterMap.has(k)) removed.push(e);
  return { added, removed, changed };
}

/**
 * Detect a conflict between two branches derived from the same base:
 * they both touch the same edge identity with differing results,
 * or touch the same contour (competing successor/predecessor) incompatibly.
 * Returns the conflicting contour focus list.
 */
export function conflictFocus(localEdits, serverEdits, serverEdges) {
  const touchedContours = (edits) => {
    const set = new Set();
    for (const edit of edits) {
      if (edit.edge) set.add(edit.edge.from_uid), set.add(edit.edge.to_uid);
      if (edit.from_uid) set.add(edit.from_uid);
      if (edit.to_uid) set.add(edit.to_uid);
      if (edit.occlusion) set.add(edit.occlusion.occl_uid);
      if (edit.occl_uid) set.add(edit.occl_uid);
    }
    return set;
  };
  const a = touchedContours(localEdits);
  const b = touchedContours(serverEdits);
  const overlap = [...a].filter((uid) => b.has(uid));
  if (overlap.length === 0) return null;
  return { contours: overlap, subgraph: affectedSubgraph(serverEdges, [], []) };
}
