import './style.css';
import * as graphModule from '../server/graph.js';
import { api, fakeRerun } from './api.js';
import {
  state, subscribe, loadDatasets, selectDataset, loadHypothesis,
  clearEdits, setTool,
} from './state.js';
import { renderAll } from './render.js';
import { renderCandidates, renderPending, renderInspector, renderValidationBar } from './panels.js';
import { showConflictModal, showInvariantModal, promptNewHypothesis } from './conflict-modal.js';
import { toast } from './toast.js';

window.__lineageGraph = graphModule;
window.__lineageRefresh = async (switchToId = null) => {
  await refreshDatasetMeta();
  if (switchToId) await loadHypothesis(switchToId);
  renderAllViews();
};

const short = (id) => (id ? String(id).slice(-8) : '∅');

function renderChrome() {
  const select = document.getElementById('dataset-select');
  if (select.options.length !== state.datasets.length ||
      (state.dataset && select.value !== state.dataset.dataset_hash)) {
    select.innerHTML = state.datasets
      .map((d) => `<option value="${d.dataset_hash}">${d.name} · ${d.dataset_hash.slice(0, 10)}</option>`).join('');
    if (state.dataset) select.value = state.dataset.dataset_hash;
  }

  const tabs = document.getElementById('hypothesis-tabs');
  tabs.innerHTML = state.hypotheses.map((h) => `
    <button class="hyp-tab ${h.hypothesis_id === state.activeHypothesisId ? 'active' : ''}"
            data-hyp="${h.hypothesis_id}">
      ${h.name} <span class="seq">v${h.head_seq ?? 0} · ${short(h.head_version)}</span>
    </button>`).join('');
  tabs.querySelectorAll('.hyp-tab').forEach((tab) => {
    tab.addEventListener('click', () => loadHypothesis(tab.dataset.hyp));
  });

  const info = document.getElementById('version-info');
  if (state.version) {
    info.innerHTML = `当前版本 <strong>v${state.version.seq}</strong>
      <code>${short(state.version.version_id)}</code>
      ${state.version.note ? `· ${state.version.note}` : ''}
      · ${state.edits.length} 个待发布改动`;
  } else {
    info.innerHTML = '尚无已发布版本。';
  }
}

async function publish() {
  if (!state.activeHypothesisId) return toast('请先创建假设', 'err');
  const autoConfirm = new URLSearchParams(window.location.search).has('autopublish');
  const note = autoConfirm
    ? `manual edits × ${state.edits.length}`
    : window.prompt('版本说明（可留空）', state.edits.length ? `manual edits × ${state.edits.length}` : '');
  if (note === null) return;
  const edits = JSON.parse(JSON.stringify(state.edits));
  const base = state.version?.version_id ?? null;

  const { status, data } = await api.publish(state.activeHypothesisId, {
    base_version: base, edits, note, mode: 'strict',
  });

  if (status === 200) {
    toast(`已发布 v${data.seq}（单事务提交，头指针已原子更新）`);
    await loadHypothesis(state.activeHypothesisId);
    await refreshDatasetMeta();
    return;
  }
  if (status === 409) {
    showConflictModal({
      conflict: data, edits, note,
      onResolved: async (result) => {
        await refreshDatasetMeta();
        if (result?.forked?.hypothesis_id) {
          await selectDataset(state.dataset.dataset_hash);
          await loadHypothesis(result.forked.hypothesis_id);
        } else {
          await loadHypothesis(state.activeHypothesisId);
        }
      },
    });
    return;
  }
  if (status === 422) {
    showInvariantModal(data);
    return;
  }
  toast(data.error ?? '发布失败', 'err');
}

async function refreshDatasetMeta() {
  const { data } = await api.dataset(state.dataset.dataset_hash);
  state.dataset = data;
  state.hypotheses = data.hypotheses;
}

function bindChrome() {
  document.getElementById('dataset-select').addEventListener('change', (event) => selectDataset(event.target.value));
  document.querySelectorAll('[data-tool]').forEach((btn) => {
    btn.addEventListener('click', () => {
      setTool(btn.dataset.tool);
      document.querySelectorAll('[data-tool]').forEach((b) => b.classList.toggle('active', b === btn));
      toast(`工具：${btn.title}`);
    });
  });
  document.getElementById('btn-publish').addEventListener('click', publish);
  document.getElementById('btn-new-hypothesis').addEventListener('click', async () => {
    const name = await promptNewHypothesis();
    if (!name) return;
    const { status, data } = await api.newHypothesis(state.dataset.dataset_hash, { name });
    if (status >= 300) return toast(data.error ?? '创建失败', 'err');
    await refreshDatasetMeta();
    await loadHypothesis(data.hypothesis_id);
    toast(`已创建并行假设「${name}」`);
  });
  document.getElementById('candidate-search').addEventListener('input', (event) => {
    state.search = event.target.value;
    renderCandidates();
  });
  document.getElementById('filter-pending').addEventListener('change', (event) => {
    state.filterPending = event.target.checked;
    renderCandidates();
  });
  document.getElementById('btn-refresh-candidates').addEventListener('click', async () => {
    const { status, data } = await fakeRerun(state.dataset);
    if (status >= 300) return toast(data.error ?? '重跑失败', 'err');
    toast(`自动重跑完成：新增 ${data.inserted_candidates} 条候选，已审证据未改动`);
    await refreshDatasetMeta();
    renderCandidates();
  });
}

function renderAllViews() {
  renderChrome();
  renderAll();
  renderCandidates();
  renderPending();
  renderInspector();
  renderValidationBar();
}

async function boot() {
  bindChrome();
  subscribe(() => renderAllViews());
  await loadDatasets();
  if (state.datasets.length > 0) await selectDataset(state.datasets[0].dataset_hash);
  renderAllViews();
}

boot().catch((error) => {
  console.error(error);
  toast(`启动失败：${error.message}`, 'err', 8000);
});
