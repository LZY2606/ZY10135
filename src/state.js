import { api } from './api.js';
import { validateGraph } from './graph-client.js';

export const state = {
  datasets: [],
  dataset: null,
  frameOf: new Map(),
  hypotheses: [],
  activeHypothesisId: null,
  version: null,          // published head
  snapshot: { edges: [], occlusions: [] },
  edits: [],              // pending, applied against snapshot
  tool: 'select',
  selection: null,        // {type:'contour'|'edge'|'candidate', ...}
  pickChain: [],          // staged contour clicks for link/division/merge
  filterPending: true,
  search: '',
};

const listeners = new Set();
export function subscribe(fn) { listeners.add(fn); return () => listeners.delete(fn); }
export function emit(reason) { for (const fn of listeners) fn(reason); }

export async function loadDatasets() {
  const { data } = await api.datasets();
  state.datasets = data;
  emit('datasets');
}

export async function selectDataset(hash) {
  const { data } = await api.dataset(hash);
  state.dataset = data;
  state.frameOf = new Map(data.frames.flatMap((f) => f.contours.map((c) => [c.uid, f.frame])));
  state.hypotheses = data.hypotheses;
  state.activeHypothesisId = data.hypotheses[0]?.hypothesis_id ?? null;
  state.edits = [];
  state.selection = null;
  if (state.activeHypothesisId) await loadHypothesis(state.activeHypothesisId);
  emit('dataset');
}

export async function loadHypothesis(hypothesisId) {
  state.activeHypothesisId = hypothesisId;
  const { data } = await api.snapshot(hypothesisId);
  state.version = data.version;
  state.snapshot = { edges: data.edges ?? [], occlusions: data.occlusions ?? [] };
  state.edits = [];
  state.pickChain = [];
  emit('hypothesis');
}

/** Working graph = published snapshot with pending edits replayed locally. */
export function workingGraph() {
  let edges = state.snapshot.edges.map((e) => ({ ...e }));
  let occlusions = state.snapshot.occlusions.map((o) => ({ ...o }));
  for (const edit of state.edits) {
    if (edit.op === 'upsertEdge') {
      const edge = { gap: 1, occluded: 0, origin: 'manual', created_by: 'local', ...edit.edge };
      edges = edges.filter((e) => !(e.from_uid === edge.from_uid && e.to_uid === edge.to_uid));
      edges.push(edge);
    } else if (edit.op === 'deleteEdge') {
      edges = edges.filter((e) => !(e.from_uid === edit.from_uid && e.to_uid === edit.to_uid));
    } else if (edit.op === 'addOcclusion') {
      occlusions.push({ ...edit.occlusion });
    } else if (edit.op === 'deleteOcclusion') {
      occlusions = occlusions.filter((o) => !(o.occl_uid === edit.occl_uid && o.frame_start === edit.frame_start && o.frame_end === edit.frame_end));
    }
  }
  return { edges, occlusions };
}

export function validationResult() {
  const { edges, occlusions } = workingGraph();
  return {
    ...validateGraph({ edges, occlusions, frameOf: state.frameOf, maxOcclusionGap: 3 }),
    edges, occlusions,
  };
}

export function queueEdit(edit) {
  state.edits.push(edit);
  state.pickChain = [];
  emit('edits');
}

export function dropEdit(index) {
  state.edits.splice(index, 1);
  emit('edits');
}

export function clearEdits() {
  state.edits = [];
  state.pickChain = [];
  emit('edits');
}

export function setTool(tool) {
  state.tool = tool;
  state.pickChain = [];
  emit('tool');
}

export function selectContour(uid) {
  state.selection = { type: 'contour', uid };
  emit('selection');
}

export function selectEdge(edge) {
  state.selection = { type: 'edge', edge };
  emit('selection');
}

export function selectCandidate(candidate) {
  state.selection = { type: 'candidate', candidate };
  emit('selection');
}
