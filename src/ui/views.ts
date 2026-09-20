import {
  clickContour,
  contourById,
  finishMerge,
  loadDatasets,
  mutate,
  publish,
  save,
  selectDataset,
  selectHypothesis,
  state,
} from './main.ts';
import { api } from './api.ts';
import { h } from './dom.ts';
import { renderCenter } from './views-center.ts';
import { renderCandidatePanel } from './views-candidates.ts';
import { showImportDialog } from './importDialog.ts';

export function renderAll(): void {
  renderTopbar();
  renderHypothesisList();
  renderCenter();
  renderCandidatePanel();
}

export function buildStaticChrome(): void {
  const app = document.getElementById('app')!;
  app.innerHTML = '';
  app.appendChild(
    h('header', { class: 'topbar' },
      h('h1', { text: '细胞谱系编辑器' }),
      h('select', {
        id: 'dataset-select',
        onchange: (e: any) => selectDataset(e.target.value),
      }),
      h('button', {
        text: '导入 / 重跑…',
        onclick: () =>
          showImportDialog().then((changed) => {
            if (changed) void loadDatasets();
          }),
      }),
      h('div', { class: 'spacer' }),
      h('label', { class: 'muted' }, '编辑者 ',
        h('input', {
          type: 'text',
          id: 'author-input',
          value: state.author,
          style: 'width:90px',
          onchange: (e: any) => {
            state.author = e.target.value || '研究员';
            localStorage.setItem('lineage.author', state.author);
          },
        })),
      h('span', { id: 'status-pill', class: 'badge' }),
      h('button', { id: 'btn-save', text: '保存草稿', onclick: () => save() }),
      h('button', { class: 'good', id: 'btn-publish', text: '发布版本', onclick: () => publish() }),
    ),
  );

  app.appendChild(
    h('div', { class: 'layout' },
      h('div', { class: 'col left', id: 'col-left' }),
      h('div', { class: 'col', id: 'col-center' }),
      h('div', { class: 'col right', id: 'col-right' }),
    ),
  );
  app.appendChild(
    h('div', { class: 'legend' },
      h('span', {}, h('i', { style: 'background:#37c26b' }), '延续'),
      h('span', {}, h('i', { style: 'background:#c77dff' }), '分裂'),
      h('span', {}, h('i', { style: 'background:#ff9d5c' }), '合并'),
      h('span', {}, h('i', { style: 'background:#4dd0e1' }), '遮挡（虚线）'),
    ),
  );
}

export function renderTopbar(): void {
  const select = document.getElementById('dataset-select') as HTMLSelectElement | null;
  if (select) {
    select.innerHTML = '';
    for (const d of state.datasets) {
      select.appendChild(
        h('option', { value: d.id, text: `${d.name}（${d.contour_count} 轮廓 / ${d.candidate_count} 候选）` }),
      );
    }
    if (state.datasetId) select.value = state.datasetId;
  }
  const pill = document.getElementById('status-pill');
  if (pill) {
    pill.textContent = state.dirty ? '● 未保存修改' : '○ 已保存';
    pill.style.color = state.dirty ? 'var(--warn)' : 'var(--good)';
  }
  const saveBtn = document.getElementById('btn-save') as HTMLButtonElement | null;
  const pubBtn = document.getElementById('btn-publish') as HTMLButtonElement | null;
  if (saveBtn) saveBtn.disabled = !state.hypothesisId || !state.dirty;
  if (pubBtn) pubBtn.disabled = !state.hypothesisId;
}

function renderHypothesisList(): void {
  const col = document.getElementById('col-left');
  if (!col) return;
  col.innerHTML = '';
  col.appendChild(h('div', { class: 'section-title', text: '已发布假设（可并行保留多条谱系）' }));
  col.appendChild(
    h('button', {
      class: 'primary',
      style: 'width:100%',
      text: '+ 新建假设',
      onclick: async () => {
        if (!state.datasetId) return;
        const name = prompt('假设名称', `假设 ${state.hypotheses.length + 1}`);
        if (!name) return;
        const created = await api.createHypothesis(state.datasetId, name, state.author);
        await selectDataset(state.datasetId);
        await selectHypothesis(created.id);
      },
    }),
  );
  for (const hyp of state.hypotheses) {
    col.appendChild(
      h('div', {
        class: `card ${hyp.id === state.hypothesisId ? 'active' : ''}`,
        onclick: () => selectHypothesis(hyp.id),
      },
        h('div', { class: 'name', text: hyp.name }),
        h('div', {
          class: 'sub',
          text: `当前版本：${hyp.currentVersionNo ? 'v' + hyp.currentVersionNo : '未发布'} · 草稿 rev${hyp.draftRev ?? '-'}${hyp.parentId ? ' · 分支派生' : ''}`,
        }),
      ),
    );
  }

  col.appendChild(h('div', { class: 'section-title', text: '工具模式' }));
  const modes: Array<[StateMode, string, string]> = [
    ['link', '连接 / 断开', '依次点两个轮廓；再点同一条边即断开'],
    ['division', '确认分裂', '依次点母细胞与两个子细胞'],
    ['merge', '标记合并', '按顺序点两个以上母轮廓，再点子轮廓'],
  ];
  for (const [mode, label, hint] of modes) {
    col.appendChild(
      h('div', {
        class: `card ${state.mode === mode ? 'active' : ''}`,
        style: 'cursor:pointer',
        onclick: () => {
          state.mode = mode;
          state.linkSourceId = null;
          state.pendingDivision = [];
          state.pendingMerges = [];
          renderAll();
        },
      },
        h('div', { class: 'name', text: label }),
        h('div', { class: 'sub', text: hint }),
      ),
    );
  }
  if (state.mode === 'merge') {
    col.appendChild(
      h('button', {
        class: 'warn',
        style: 'width:100%;margin-top:6px',
        text: `完成合并（已选 ${state.pendingMerges.length}）`,
        onclick: () => finishMerge(),
      }),
    );
  }

  col.appendChild(h('div', { class: 'section-title', text: '不变量检查' }));
  if (state.violations.length === 0) {
    col.appendChild(h('div', { class: 'ok-note', text: '✓ 当前草稿满足全部谱系不变量' }));
  } else {
    for (const v of state.violations) {
      col.appendChild(
        h('div', { class: 'violation' },
          h('div', { text: v.code }),
          h('div', { class: 'muted', text: v.message }),
        ),
      );
    }
  }
}

type StateMode = 'link' | 'division' | 'merge';
