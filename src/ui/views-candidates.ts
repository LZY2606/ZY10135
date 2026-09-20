import { contourById, mutate, state } from './main.ts';
import { h } from './dom.ts';
import { addEdge, addNegation, edgeExists, isNegatedCandidate } from './candidate-actions.ts';
import { removeNegation } from './model.ts';
import type { Candidate } from '../shared/types.ts';

export function renderCandidatePanel(): void {
  const col = document.getElementById('col-right');
  if (!col) return;
  col.innerHTML = '';
  if (!state.hypothesisId) return;

  const runs = [...new Set(state.candidates.map((c) => c.runId))];
  col.appendChild(
    h('div', { class: 'section-title', text: `外部候选（${state.candidates.length}）` }),
  );
  col.appendChild(h('div', { class: 'muted', style: 'margin-bottom:8px', text: `自动跟踪运行：${runs.join('、')}。重跑只追加候选，不覆盖已审核证据。` }));

  const selectedId = state.selectedContourId;
  const relevant = selectedId
    ? state.candidates.filter((c) => c.fromContourId === selectedId || c.toContourId === selectedId)
    : state.candidates;

  const list = relevant.slice().sort((a, b) => b.score - a.score);
  if (list.length === 0) {
    col.appendChild(h('div', { class: 'muted', text: '点击任一轮廓可筛选其相关候选。' }));
  }
  for (const candidate of list) {
    col.appendChild(renderCandidate(candidate));
  }

  col.appendChild(h('div', { class: 'section-title', text: `人工否定（${state.graph.negations.length}）` }));
  for (const neg of state.graph.negations) {
    const from = neg.fromContourId ? contourById(neg.fromContourId)?.externalId ?? neg.fromContourId : '*';
    const to = neg.toContourId ? contourById(neg.toContourId)?.externalId ?? neg.toContourId : '*';
    col.appendChild(
      h('div', { class: 'card' },
        h('div', { class: 'line' },
          h('span', { class: 'badge', text: neg.kind }),
          h('span', { text: `${from} ✕ ${to}` }),
          h('div', { style: 'flex:1' }),
          h('button', {
            text: '撤销否定',
            onclick: () => mutate(removeNegation(state.graph, neg.id)),
          }),
        ),
        neg.reason ? h('div', { class: 'sub muted', text: neg.reason }) : null,
      ),
    );
  }
}

function renderCandidate(candidate: Candidate): HTMLElement {
  const from = candidate.fromContourId ? contourById(candidate.fromContourId) : null;
  const to = candidate.toContourId ? contourById(candidate.toContourId) : null;
  const accepted = candidate.fromContourId && candidate.toContourId
    ? edgeExists(state.graph, candidate.fromContourId, candidate.toContourId, candidate.kind)
    : undefined;
  const negated = isNegatedCandidate(state.graph, candidate);

  return h('div', {
    class: `card ${accepted ? 'active' : ''}`,
    style: negated ? 'opacity:.55' : '',
  },
    h('div', { class: 'cand-row' },
      h('div', { class: 'line' },
        h('span', { class: `badge ${candidate.kind}`, text: candidate.kind }),
        h('span', { text: `score ${candidate.score.toFixed(2)}` }),
        h('div', { style: 'flex:1' }),
        h('span', { class: 'muted', style: 'font-size:10px', text: candidate.runId }),
      ),
      h('div', {
        text: `${from ? `${from.externalId} f${from.frame}` : '∅'} → ${to ? `${to.externalId} f${to.frame}` : '∅'}`,
      }),
      h('div', { class: 'line' },
        accepted
          ? h('span', { class: 'ok-note', text: '✓ 已采纳' })
          : h('button', {
              class: 'good',
              text: negated ? '（已否定）' : '采纳为边',
              disabled: negated || !candidate.fromContourId || !candidate.toContourId,
              onclick: () =>
                mutate(
                  addEdge(
                    state.graph,
                    candidate.fromContourId!,
                    candidate.toContourId!,
                    candidate.kind,
                    state.author,
                    'candidate',
                    candidate.id,
                  ).graph,
                ),
            }),
        h('button', {
          class: accepted ? '' : 'danger',
          text: accepted ? '移除已采纳' : '人工否定',
          onclick: () => {
            if (accepted) {
              mutate({
                ...state.graph,
                edges: state.graph.edges.filter((e) => e.id !== accepted.id),
              });
            } else {
              const reason = window.prompt('否定理由（可留空）', '人工判定为错误链接') ?? undefined;
              mutate(
                addNegation(
                  state.graph,
                  candidate.fromContourId,
                  candidate.toContourId,
                  candidate.kind,
                  state.author,
                  candidate.id,
                  reason,
                ),
              );
            }
          },
        }),
      ),
      h('details', {},
        h('summary', { class: 'muted', style: 'cursor:pointer', text: '原始来源 / provenance' }),
        h('pre', {
          style: 'white-space:pre-wrap;font-size:10px;color:var(--muted);margin:4px 0',
          text: JSON.stringify(
            {
              candidateId: candidate.id,
              runId: candidate.runId,
              fromExternal: from?.externalId ?? null,
              toExternal: to?.externalId ?? null,
              raw: candidate.raw ?? null,
              createdAt: candidate.createdAt,
            },
            null,
            2,
          ),
        }),
      ),
    ),
  );
}
