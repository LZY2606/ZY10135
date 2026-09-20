import { clickContour, contourById, mutate, state } from './main.ts';
import { h } from './dom.ts';
import { renderContourPreview, renderLineage, occlusionLabel } from './render.ts';
import { incomingEdges, markOcclusion, outgoingEdges, removeEdge, removeOcclusion } from './model.ts';

export function renderCenter(): void {
  const col = document.getElementById('col-center');
  if (!col) return;
  col.innerHTML = '';

  if (!state.hypothesisId) {
    col.appendChild(
      h('div', { class: 'card', style: 'margin-top:30px' },
        h('div', { class: 'name', text: '请选择或新建一个假设' }),
        h('div', { class: 'sub', text: '原始轮廓与外部候选已安全保存，编辑只会产生新的假设版本。' }),
      ),
    );
    return;
  }

  const hint =
    state.mode === 'link'
      ? state.linkSourceId
        ? `链接起点：${contourById(state.linkSourceId)?.externalId}，请点更晚帧的目标`
        : '连接模式：依次点击两个轮廓建立延续边，再次点击同一条边断开'
      : state.mode === 'division'
        ? state.pendingDivision.length === 0
          ? '分裂模式：先点母细胞'
          : state.pendingDivision.length === 1
            ? `母细胞 ${contourById(state.pendingDivision[0])?.externalId}，再点两个子细胞`
            : '再点一个子细胞以确认分裂'
        : `合并模式：按顺序点 ≥2 个母轮廓再点子轮廓（已选 ${state.pendingMerges.length}）`;
  col.appendChild(h('div', { class: 'card', style: 'border-color:var(--accent)' }, h('div', { text: hint })));

  renderFrameStrip(col);

  const svgWrap = h('div', {
    style: 'overflow:auto;border:1px solid var(--line);border-radius:8px;background:#0c111c;margin-bottom:10px',
  });
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg') as SVGSVGElement;
  svg.style.minWidth = '100%';
  svg.style.height = '340px';
  svgWrap.appendChild(svg);
  col.appendChild(svgWrap);

  renderLineage(
    svg,
    state.contours,
    state.graph,
    state.frames,
    {
      selectedContourId: state.selectedContourId,
      linkSourceId: state.linkSourceId ?? state.pendingDivision[0] ?? null,
    },
    (id) => clickContour(id),
  );

  // Contour polygon preview focused on current selection + neighbours.
  const focus = new Set<string>();
  if (state.selectedContourId) {
    focus.add(state.selectedContourId);
    for (const e of [...incomingEdges(state.graph, state.selectedContourId), ...outgoingEdges(state.graph, state.selectedContourId)]) {
      focus.add(e.fromId);
      focus.add(e.toId);
    }
  }
  const canvas = h('canvas', { style: 'width:100%;height:130px' }) as HTMLCanvasElement;
  col.appendChild(h('div', { class: 'section-title', text: '轮廓边界（简化多边形）' }));
  col.appendChild(canvas);
  requestAnimationFrame(() => {
    const shown = focus.size > 0 ? state.contours.filter((c) => focus.has(c.id)) : state.contours.slice(0, 12);
    renderContourPreview(canvas, shown.length ? shown : state.contours.slice(0, 8), state.graph, focus);
  });

  // Occlusion list + quick mark between selected contours.
  col.appendChild(h('div', { class: 'section-title', text: '遮挡区间' }));
  col.appendChild(
    h('div', { class: 'row' },
      h('button', {
        class: 'warn',
        text: '用选中的两个轮廓标记遮挡…',
        onclick: () => markSelectedOcclusion(),
      }),
    ),
  );
  if (state.graph.occlusions.length === 0) {
    col.appendChild(h('div', { class: 'muted', text: '暂无遮挡标记。' }));
  }
  for (const occlusion of state.graph.occlusions) {
    col.appendChild(
      h('div', { class: 'card' },
        h('div', { class: 'row', style: 'justify-content:space-between' },
          h('span', {},
            h('span', { class: 'badge occlusion', text: 'OCC' }),
            ' ',
            occlusionLabel(occlusion, state.contours),
          ),
          h('button', {
            class: 'danger',
            text: '删除',
            onclick: () => mutate(removeOcclusion(state.graph, occlusion.id)),
          }),
        ),
        occlusion.note ? h('div', { class: 'sub muted', text: occlusion.note }) : null,
      ),
    );
  }

  // Edges inspector
  col.appendChild(h('div', { class: 'section-title', text: `当前图的边（${state.graph.edges.length}）` }));
  for (const edge of state.graph.edges) {
    const from = contourById(edge.fromId);
    const to = contourById(edge.toId);
    col.appendChild(
      h('div', { class: 'card cand-row' },
        h('div', { class: 'line' },
          h('span', { class: `badge ${edge.kind}`, text: edge.kind }),
          h('span', { text: `${from?.externalId ?? edge.fromId} f${from?.frame} → ${to?.externalId ?? edge.toId} f${to?.frame}` }),
          h('div', { style: 'flex:1' }),
          h('button', {
            text: '断开',
            onclick: () => mutate(removeEdge(state.graph, edge.id)),
          }),
        ),
        h('div', { class: 'sub muted', text: `${edge.source === 'manual' ? '手工' : '采纳候选'} · ${edge.author}` }),
      ),
    );
  }
}

function markSelectedOcclusion(): void {
  const a = state.linkSourceId ?? state.pendingMerges[0] ?? null;
  const b = state.selectedContourId;
  if (!a || !b || a === b) {
    window.alert('请先在连接模式下依次点选进入遮挡前的轮廓与重新出现的轮廓');
    return;
  }
  const enter = contourById(a)!;
  const exit = contourById(b)!;
  const earlier = enter.frame < exit.frame ? a : b;
  const later = enter.frame < exit.frame ? b : a;
  const note = window.prompt('遮挡备注（可留空）', '短暂消失/被遮挡') ?? undefined;
  mutate(
    markOcclusion(
      state.graph,
      new Map(state.contours.map((c) => [c.id, c])),
      earlier,
      later,
      state.author,
      note,
    ),
  );
  state.linkSourceId = null;
}

function renderFrameStrip(col: HTMLElement): void {
  const strip = h('div', { class: 'frame-strip' });
  for (let f = 0; f < state.frames; f++) {
    const contours = state.contours
      .filter((c) => c.frame === f)
      .sort((a, b) => a.cy - b.cy);
    const cell = h('div', { class: `frame-cell ${state.viewFrame === f ? 'current' : ''}` },
      h('div', { class: 'fhead' }, h('span', { text: `帧 ${f}` }), h('span', { text: `${contours.length} 轮廓` })),
    );
    for (const contour of contours) {
      const linked = state.graph.edges.some((e) => e.fromId === contour.id || e.toId === contour.id);
      cell.appendChild(
        h('div', {
          class: `contour-chip ${state.selectedContourId === contour.id ? 'sel' : ''} ${linked ? 'linked' : ''}`,
          onclick: () => clickContour(contour.id),
        },
          h('span', { class: 'dot' }),
          h('span', { text: contour.externalId }),
          h('div', { style: 'flex:1' }),
          h('span', { class: 'muted', style: 'font-size:10px', text: `a${Math.round(contour.area)}` }),
        ),
      );
    }
    strip.appendChild(cell);
  }
  col.appendChild(strip);
}
