import { api } from './api.js';
import { state } from './state.js';
import { toast } from './toast.js';

const kindLabel = { continuation: '→', division: '⤵', merge: '⇢' };

function miniGraphMarkup(subgraph) {
  const contours = new Set(subgraph.contours);
  const rows = subgraph.edges.map((edge) => {
    contours.add(edge.from_uid);
    contours.add(edge.to_uid);
    return `
      <div class="node-row">
        <span>${edge.from_uid}</span>
        <span class="arrow">${kindLabel[edge.kind] ?? '→'}</span>
        <span>${edge.to_uid}</span>
        <span class="edge-kind muted">${edge.kind}</span>
      </div>`;
  }).join('');
  const occlusionRows = (subgraph.occlusions ?? []).map((o) => `
    <div class="node-row"><span>👁 ${o.occl_uid}</span><span class="muted">f${o.frame_start}-f${o.frame_end}</span></div>`).join('');
  return `
    <div class="mini-graph">
      ${rows || '<div class="muted">最小受影响子图中没有边（轮廓级冲突）。</div>'}
      ${occlusionRows}
      <div class="muted" style="margin-top:6px">涉及轮廓：${[...contours].join(', ')}</div>
    </div>`;
}

export function showConflictModal({ conflict, edits, note, onResolved }) {
  const root = document.getElementById('modal-root');
  root.innerHTML = `
    <div class="modal-backdrop">
      <div class="modal">
        <h2>版本冲突 · 你的保存不会静默吃掉别人的链接</h2>
        <div class="sub">
          你基于 <code>${short(conflict.base_version)}</code> 编辑，但当前头已是
          <code>${short(conflict.current_head)}</code>。
        </div>
        <div class="conflict-grid">
          <div class="conflict-col server">
            <h4>服务器当前头（最小受影响子图）</h4>
            ${miniGraphMarkup(conflict.minimal_subgraph)}
          </div>
          <div class="conflict-col incoming">
            <h4>你的改动（最小受影响子图）</h4>
            ${miniGraphMarkup(conflict.incoming)}
          </div>
        </div>
        <div class="sub">历史版本：${(conflict.server_versions ?? []).map((v) => `v${v.seq}(${short(v.version_id)})`).join(' → ')}</div>
        <div class="modal-actions">
          <button id="conflict-cancel" class="ghost">取消（保留本地改动）</button>
          <button id="conflict-fork" class="danger">派生为并行假设</button>
          <button id="conflict-rebase" class="primary">在最新版本上重放（rebase）</button>
        </div>
      </div>
    </div>`;

  const close = () => { root.innerHTML = ''; };
  document.getElementById('conflict-cancel').addEventListener('click', close);
  document.getElementById('conflict-rebase').addEventListener('click', async () => {
    const { status, data } = await api.publish(state.activeHypothesisId, {
      base_version: conflict.base_version, mode: 'rebase', edits, note,
    });
    close();
    if (status === 200) { toast(`已在 ${short(data.rebased_from)} 之上重放并发布 v${data.seq}`); onResolved(data); }
    else if (status === 422) showInvariantModal(data);
    else toast(data.error ?? 'rebase 失败', 'err');
  });
  document.getElementById('conflict-fork').addEventListener('click', async () => {
    const { status, data } = await api.publish(state.activeHypothesisId, {
      base_version: conflict.base_version, mode: 'fork', edits, note,
    });
    close();
    if (status === 201) {
      toast(`已派生并行假设 ${short(data.hypothesis_id)}，两条竞争谱系都保留`);
      onResolved({ forked: data });
    } else {
      toast(data.error ?? 'fork 失败', 'err');
    }
  });
}

export function showInvariantModal(payload) {
  const root = document.getElementById('modal-root');
  root.innerHTML = `
    <div class="modal-backdrop"><div class="modal">
      <h2>图不变量检查未通过</h2>
      <div class="sub">服务器拒绝发布，以下规则被违反：</div>
      <ul class="error-list">${(payload.errors ?? []).map((e) => `<li><code>${e.code}</code> — ${e.message}</li>`).join('')}</ul>
      ${payload.affected ? `<h4>最小受影响子图</h4>${miniGraphMarkup(payload.affected)}` : ''}
      <div class="modal-actions"><button class="primary" id="invariant-close">回去修改</button></div>
    </div></div>`;
  document.getElementById('invariant-close').addEventListener('click', () => { root.innerHTML = ''; });
}

export async function promptNewHypothesis() {
  const name = window.prompt('新并行假设名称', `假设 ${new Date().toLocaleString()}`);
  return name;
}

function short(id) { return id ? String(id).slice(-8) : '∅'; }
