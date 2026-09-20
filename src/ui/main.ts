import './style.css';
import { api } from './api.ts';
import {
  addEdge,
  addNegation,
  confirmDivision,
  confirmMerge,
  edgeExists,
  getAuthor,
  incomingEdges,
  markOcclusion,
  outgoingEdges,
  removeEdge,
  removeNegation,
  removeOcclusion,
} from './model.ts';
import { renderContourPreview, renderLineage } from './render.ts';
import { showConflictDialog } from './conflict.ts';
import { showImportDialog } from './importDialog.ts';
import { buildStaticChrome, renderAll } from './views.ts';
import type {
  Candidate,
  Contour,
  Edge,
  GraphData,
  Violation,
} from '../shared/types.ts';

interface State {
  datasets: any[];
  datasetId: string | null;
  contours: Contour[];
  candidates: Candidate[];
  frames: number;
  hypotheses: any[];
  hypothesisId: string | null;
  graph: GraphData;
  rev: number;
  baseVersionId: string | null;
  selectedContourId: string | null;
  linkSourceId: string | null;
  violations: Violation[];
  dirty: boolean;
  mode: 'link' | 'division' | 'merge';
  pendingDivision: string[];
  pendingMerges: string[];
  author: string;
  viewFrame: number | null;
}

const state: State = {
  datasets: [],
  datasetId: null,
  contours: [],
  candidates: [],
  frames: 0,
  hypotheses: [],
  hypothesisId: null,
  graph: { edges: [], occlusions: [], negations: [] },
  rev: 0,
  baseVersionId: null,
  selectedContourId: null,
  linkSourceId: null,
  violations: [],
  dirty: false,
  mode: 'link',
  pendingDivision: [],
  pendingMerges: [],
  author: getAuthor(),
  viewFrame: null,
};

const $ = (sel: string) => document.querySelector(sel) as HTMLElement;

function toast(message: string, kind: 'good' | 'bad' | '' = ''): void {
  const node = document.createElement('div');
  node.className = `toast ${kind}`;
  node.textContent = message;
  document.body.appendChild(node);
  setTimeout(() => node.remove(), 2600);
}

function contourById(id: string | null): Contour | undefined {
  return state.contours.find((c) => c.id === id);
}

async function loadDatasets(): Promise<void> {
  state.datasets = await api.listDatasets();
  renderAll();
  if (!state.datasetId && state.datasets.length > 0) {
    await selectDataset(state.datasets[0].id);
  }
}

async function selectDataset(datasetId: string): Promise<void> {
  state.datasetId = datasetId;
  const detail = await api.getDataset(datasetId);
  state.contours = detail.contours;
  state.candidates = detail.candidates;
  state.frames = detail.dataset.frames;
  state.hypotheses = await api.listHypotheses(datasetId);
  state.viewFrame = null;
  const first = state.hypotheses[0];
  if (first) await selectHypothesis(first.id);
  else {
    state.hypothesisId = null;
    state.graph = { edges: [], occlusions: [], negations: [] };
    renderAll();
  }
}

async function selectHypothesis(hypothesisId: string): Promise<void> {
  state.hypothesisId = hypothesisId;
  const draft = await api.getDraft(hypothesisId);
  state.graph = draft.graph;
  state.rev = draft.rev;
  state.baseVersionId = draft.baseVersionId;
  state.dirty = false;
  state.selectedContourId = null;
  state.linkSourceId = null;
  state.pendingDivision = [];
  state.pendingMerges = [];
  await revalidate();
  renderAll();
}

async function revalidate(): Promise<void> {
  if (!state.hypothesisId) {
    state.violations = [];
    return;
  }
  try {
    const { violations } = await api.check(state.hypothesisId, state.graph);
    state.violations = violations;
  } catch {
    state.violations = [];
  }
}

function mutate(next: GraphData): void {
  state.graph = next;
  state.dirty = true;
  void revalidate().then(renderAll);
}

async function save(silent = false): Promise<boolean> {
  if (!state.hypothesisId) return false;
  try {
    const result = await api.saveDraft(state.hypothesisId, state.graph, state.rev, state.author);
    state.rev = result.rev;
    state.dirty = false;
    if (!silent) toast('草稿已保存', 'good');
    renderAll();
    return true;
  } catch (err: any) {
    if (err.status === 409) {
      toast('保存冲突：另一位研究员已更新，请通过冲突页解决', 'bad');
      await openConflict();
    } else {
      toast(err.message, 'bad');
    }
    return false;
  }
}

async function publish(): Promise<void> {
  if (!state.hypothesisId) return;
  if (state.violations.length > 0) {
    toast('图不变量检查未通过，不能发布', 'bad');
    return;
  }
  try {
    const result = await api.publish(
      state.hypothesisId,
      state.graph,
      state.rev,
      state.author,
      '人工编辑发布',
    );
    state.rev += 1;
    state.dirty = false;
    state.baseVersionId = result.version.id;
    toast(`已发布版本 v${result.version.versionNo}`, 'good');
    state.hypotheses = await api.listHypotheses(state.datasetId!);
    renderAll();
  } catch (err: any) {
    if (err.status === 409 && err.body?.merge) {
      await openConflict(err.body.merge);
    } else if (err.status === 422) {
      state.violations = err.body.violations;
      renderAll();
      toast('发布被拒绝：存在不变量违例', 'bad');
    } else {
      toast(err.message, 'bad');
    }
  }
}

async function openConflict(prefetched?: any): Promise<void> {
  if (!state.hypothesisId) return;
  const merge = prefetched ?? (await api.conflictPreview(state.hypothesisId, state.graph));
  await showConflictDialog({
    merge,
    contours: state.contours,
    author: state.author,
    onResolve: async (mode, forkName) => {
      try {
        const result = await api.resolve(
          state.hypothesisId!,
          mode,
          state.graph,
          state.author,
          mode === 'rebase' ? '冲突后变基发布' : '保留为并行假设',
          forkName,
        );
        if (mode === 'fork' && result.forkHypothesisId) {
          toast('已派生并行假设，两条谱系均保留', 'good');
          await selectDataset(state.datasetId!);
          await selectHypothesis(result.forkHypothesisId);
        } else {
          toast(`已变基并发布 v${result.version.versionNo}`, 'good');
          await selectHypothesis(state.hypothesisId!);
        }
        return true;
      } catch (e: any) {
        toast(e.message, 'bad');
        return false;
      }
    },
  });
}

// --- contour interaction ---------------------------------------------------

function selectContour(contourId: string): void {
  state.selectedContourId = contourId;
  if (state.mode === 'merge') {
    if (!state.pendingMerges.includes(contourId)) state.pendingMerges.push(contourId);
  }
  renderAll();
}

function clickContour(contourId: string): void {
  const contour = contourById(contourId)!;

  if (state.mode === 'division') {
    const pending = state.pendingDivision;
    if (pending.includes(contourId)) {
      state.pendingDivision = pending.filter((id) => id !== contourId);
    } else if (pending.length === 0) {
      state.pendingDivision = [contourId];
      state.selectedContourId = contourId;
      toast('已选母细胞，请依次选择两个更晚帧的子细胞', '');
    } else if (pending.length === 1) {
      const mother = contourById(pending[0])!;
      if (contour.frame <= mother.frame) {
        toast('子细胞必须在母细胞之后的帧', 'bad');
        renderAll();
        return;
      }
      state.pendingDivision = [...pending, contourId];
      toast('已选第一个子细胞，再选一个子细胞确认分裂', '');
    } else {
      const mother = contourById(pending[0])!;
      if (contour.frame <= mother.frame || contourId === pending[1]) {
        toast('请选择另一个更晚帧的子细胞', 'bad');
        renderAll();
        return;
      }
      try {
        mutate(
          confirmDivision(state.graph, pending[0], [pending[1], contourId], state.author),
        );
        toast('分裂已确认：母细胞终止，两个子细胞各有唯一前驱', 'good');
      } catch (e: any) {
        toast(e.message, 'bad');
      }
      state.pendingDivision = [];
    }
    renderAll();
    return;
  }

  if (state.mode === 'merge') {
    selectContour(contourId);
    return;
  }

  // link mode
  if (state.linkSourceId === null) {
    state.linkSourceId = contourId;
    state.selectedContourId = contourId;
    renderAll();
    return;
  }
  if (state.linkSourceId === contourId) {
    state.linkSourceId = null;
    renderAll();
    return;
  }
  const from = contourById(state.linkSourceId)!;
  if (contour.frame <= from.frame) {
    toast('目标必须位于更晚的帧（时间不可倒流）', 'bad');
    state.linkSourceId = null;
    renderAll();
    return;
  }
  const existing = edgeExists(state.graph, from.id, contourId);
  if (existing) {
    mutate(removeEdge(state.graph, existing.id));
  } else {
    const { graph, replaced } = addEdge(
      state.graph,
      from.id,
      contourId,
      'continuation',
      state.author,
    );
    if (replaced && replaced.length > 0) {
      toast(`已替换 ${replaced.length} 条原有入边，保持单前驱`, '');
    }
    mutate(graph);
  }
  state.linkSourceId = null;
}

function finishMerge(): void {
  // last selected contour = child, preceding ones = parents
  if (state.pendingMerges.length < 3) {
    toast('合并需要至少两个母轮廓 + 一个更晚的子轮廓（按顺序选择）', 'bad');
    return;
  }
  const child = state.pendingMerges[state.pendingMerges.length - 1];
  const parents = state.pendingMerges.slice(0, -1);
  const childContour = contourById(child)!;
  for (const parentId of parents) {
    const parent = contourById(parentId)!;
    if (childContour.frame <= parent.frame) {
      toast('合并的子轮廓必须晚于所有母轮廓', 'bad');
      state.pendingMerges = [];
      renderAll();
      return;
    }
  }
  try {
    mutate(confirmMerge(state.graph, parents, child, state.author));
    toast('合并已标记：多条入边显式为 merge', 'good');
  } catch (e: any) {
    toast(e.message, 'bad');
  }
  state.pendingMerges = [];
}

export {
  state,
  clickContour,
  finishMerge,
  mutate,
  save,
  publish,
  selectDataset,
  selectHypothesis,
  loadDatasets,
  contourById,
  toast,
  openConflict,
  revalidate,
};
export type { State };

void bootstrap();

async function bootstrap(): Promise<void> {
  buildStaticChrome();
  await loadDatasets();
}
