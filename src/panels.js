import { state, dropEdit, validationResult } from './state.js';
import { api } from './api.js';
import { toast } from './toast.js';
import { emit } from './state.js';

const kindGlyph = { continuation: '→', division: '⤵', merge: '⇢' };

export function renderCandidates() {
  const list = document.getElementById('candidate-list');
  if (!state.dataset) return;
  const evidence = new Map(state.dataset.evidence.map((e) => [e.candidate_id, e]));
  const search = state.search.trim().toLowerCase();
  const items = state.dataset.candidates
    .filter((c) => !state.filterPending || !evidence.has(c.candidate_id))
    .filter((c) => !search ||
      c.from_uid.toLowerCase().includes(search) ||
      c.to_uid.toLowerCase().includes(search) ||
      String(c.from_frame).includes(search) ||
      String(c.to_frame).includes(search));

  list.innerHTML = items.length === 0
    ? '<li class="muted" style="padding:14px">没有匹配的候选。</li>'
    : items.map((c) => {
      const ev = evidence.get(c.candidate_id);
      return `
      <li class="candidate-item ${ev?.verdict ?? ''}" data-candidate-id="${c.candidate_id}">
        <span class="kind kind-${c.kind}">${kindGlyph[c.kind] ?? '?'}</span>
        <div>
          <div class="ids">${c.from_uid} → ${c.to_uid}</div>
          <div class="meta">f${c.from_frame}→f${c.to_frame} · score ${c.score ?? '—'} · ${c.source ?? 'ext'}</div>
          <div class="meta">${ev ? `已${ev.verdict === 'accepted' ? '接受' : '否定'}：${ev.reason ?? '人工审核'}` : '待审'}</div>
        </div>
        <div class="candidate-actions">
          <button class="accept" data-action="accept" title="接受候选（加为已审证据）">✓</button>
          <button class="danger" data-action="reject" title="人工否定">✕</button>
        </div>
      </li>`;
    }).join('');

  list.querySelectorAll('.candidate-item').forEach((li) => {
    li.addEventListener('click', (event) => {
      if (event.target.closest('button')) return;
      const candidate = state.dataset.candidates.find((c) => c.candidate_id === li.dataset.candidateId);
      state.selection = { type: 'candidate', candidate };
      emit('selection');
    });
    li.querySelector('[data-action="accept"]').addEventListener('click', () => verdict(li.dataset.candidateId, 'accepted', '人工接受候选'));
    li.querySelector('[data-action="reject"]').addEventListener('click', () => verdict(li.dataset.candidateId, 'rejected', '人工否定候选'));
  });
}

async function verdict(candidateId, v, reason) {
  const candidate = state.dataset.candidates.find((c) => c.candidate_id === candidateId);
  const { status, data } = await api.evidence(state.dataset.dataset_hash, {
    candidate_id: candidateId,
    from_uid: candidate.from_uid,
    to_uid: candidate.to_uid,
    verdict: v, reason,
  });
  if (status >= 300) return toast(data.error ?? '审核失败', 'err');
  if (v === 'accepted') {
    state.edits.push({
      op: 'upsertEdge',
      edge: {
        from_uid: candidate.from_uid, to_uid: candidate.to_uid,
        kind: candidate.kind === 'division' ? 'division' : candidate.kind === 'merge' ? 'merge' : 'continuation',
        gap: candidate.to_frame - candidate.from_frame,
        occluded: candidate.to_frame - candidate.from_frame > 1 ? 1 : 0,
        origin: `candidate:${candidateId}`,
      },
    });
    toast('已接受并加入当前待发布改动');
  } else {
    toast('已标记为人工否定（自动重跑不会覆盖该证据）');
  }
  emit('edits');
  await reloadDatasetOnly();
}

async function reloadDatasetOnly() {
  const { data } = await api.dataset(state.dataset.dataset_hash);
  state.dataset = data;
  emit('dataset-refresh');
}

export function renderPending() {
  const ul = document.getElementById('pending-edits');
  if (state.edits.length === 0) {
    ul.innerHTML = '<li class="muted">当前版本之上无未发布改动。</li>';
    return;
  }
  ul.innerHTML = state.edits.map((edit, index) => {
    let label = '';
    if (edit.op === 'upsertEdge') label = `+ ${edit.edge.kind} ${edit.edge.from_uid} → ${edit.edge.to_uid}`;
    if (edit.op === 'deleteEdge') label = `− 断开 ${edit.from_uid} → ${edit.to_uid}`;
    if (edit.op === 'addOcclusion') label = `👁 遮挡 ${edit.occlusion.occl_uid} f${edit.occlusion.frame_start}-f${edit.occlusion.frame_end}`;
    if (edit.op === 'deleteOcclusion') label = `✕ 删除遮挡 ${edit.occl_uid} f${edit.frame_start}-f${edit.frame_end}`;
    return `<li><span>${label}</span><span class="del" data-index="${index}" title="撤销该改动">⟲</span></li>`;
  }).join('');
  ul.querySelectorAll('.del').forEach((el) => {
    el.addEventListener('click', () => dropEdit(Number(el.dataset.index)));
  });
}

export async function renderInspector() {
  const host = document.getElementById('inspector');
  const sel = state.selection;
  if (!sel) {
    host.innerHTML = '<p class="muted">未选中对象。点击轮廓、边或候选查看完整来源。</p>';
    return;
  }

  if (sel.type === 'contour') {
    const contour = state.dataset.frames.flatMap((f) => f.contours.map((c) => ({ ...c, frame: f.frame })))
      .find((c) => c.uid === sel.uid);
    if (!contour) return;
    const { status, data } = await api.rawContour(state.dataset.dataset_hash, sel.uid);
    const raw = status === 200 ? data : { note: '原始记录不可用' };
    host.innerHTML = `
      <h3>轮廓 ${contour.uid}</h3>
      <dl>
        <dt>帧</dt><dd>${contour.frame}</dd>
        <dt>中心</dt><dd>(${contour.center?.x ?? '—'}, ${contour.center?.y ?? '—'})</dd>
        <dt>面积</dt><dd>${contour.area ?? '—'}</dd>
        <dt>来源</dt><dd>${contour.source ?? 'external'}</dd>
        <dt>边界点数</dt><dd>${(contour.boundary ?? []).length}</dd>
      </dl>
      <details open><summary>完整原始轮廓记录（外部程序原文）</summary><pre>${escapeHtml(JSON.stringify(raw, null, 2))}</pre></details>
    `;
    return;
  }

  if (sel.type === 'edge') {
    const e = sel.edge;
    host.innerHTML = `
      <h3>边 ${e.from_uid} → ${e.to_uid}</h3>
      <dl>
        <dt>类型</dt><dd class="kind kind-${e.kind}">${kindGlyph[e.kind] ?? e.kind} ${e.kind}</dd>
        <dt>帧跨度</dt><dd>f${state.frameOf.get(e.from_uid)} → f${state.frameOf.get(e.to_uid)}（gap=${e.gap ?? 1}）</dd>
        <dt>遮挡</dt><dd>${e.occluded ? '是（跨帧缺失）' : '否'}</dd>
        <dt>来源</dt><dd>${e.origin ?? 'manual'}</dd>
        <dt>编辑者</dt><dd>${e.created_by ?? 'local'}</dd>
      </dl>
      <p class="muted">单一已发布假设中每个轮廓至多一个前驱；分裂/合并必须成对出现。</p>
    `;
    return;
  }

  if (sel.type === 'candidate') {
    const c = sel.candidate;
    const evidence = state.dataset.evidence.find((e) => e.candidate_id === c.candidate_id);
    host.innerHTML = `
      <h3>外部候选 ${c.candidate_id}</h3>
      <dl>
        <dt>链接</dt><dd>${c.from_uid} → ${c.to_uid}</dd>
        <dt>类型</dt><dd>${c.kind}</dd>
        <dt>帧</dt><dd>${c.from_frame} → ${c.to_frame}</dd>
        <dt>分数</dt><dd>${c.score ?? '—'}</dd>
        <dt>外部来源</dt><dd>${c.source ?? 'ext'}</dd>
        <dt>审核状态</dt><dd>${evidence ? evidence.verdict + '：' + (evidence.reason ?? '') : '待审'}</dd>
      </dl>
      <details open><summary>候选原始记录</summary><pre>${escapeHtml(JSON.stringify(c, null, 2))}</pre></details>
      <p class="muted">自动重跑只会新增候选；已审证据永不被覆盖。</p>
    `;
  }
}

export function renderValidationBar() {
  const result = validationResult();
  const host = document.getElementById('canvas-hint');
  if (result.ok) {
    host.textContent = `✓ 图不变量检查通过（${result.edges.length} 条边，${result.occlusions.length} 个遮挡区间）。`;
    host.style.color = 'var(--accent-2)';
  } else {
    host.innerHTML = `✕ ${result.errors.length} 处违规：` +
      result.errors.slice(0, 4).map((e) => e.code).join('，') +
      (result.errors.length > 4 ? ` 等 ${result.errors.length} 条` : '');
    host.style.color = 'var(--danger)';
  }
}

function escapeHtml(text) {
  return text.replace(/[&<>"']/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]));
}
