import { state, emit } from './state.js';
import { layout, NODE_W, NODE_H, edgePath, edgeHitPath } from './layout.js';
import { toast } from './toast.js';

const edgeKey = (e) => `${e.from_uid}|${e.to_uid}`;

export function renderAll() {
  renderRibbon();
  renderStage();
}

function renderRibbon() {
  const ribbon = document.getElementById('frame-ribbon');
  if (!state.dataset) { ribbon.innerHTML = ''; return; }
  const { frames } = state.dataset;
  ribbon.innerHTML = `
    <div class="frames-row">
      ${frames.map((frame) => `
        <div class="frame-col" data-frame="${frame.frame}">
          <div class="frame-label">frame ${frame.frame} · ${frame.contours.length} cells</div>
          <button class="ghost" data-scroll-frame="${frame.frame}">查看列 ↓</button>
        </div>`).join('')}
    </div>`;
  ribbon.querySelectorAll('[data-scroll-frame]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const f = Number(btn.dataset.scrollFrame);
      const target = document.querySelector(`.lineage-stage [data-frame-col="${f}"]`);
      if (target) target.scrollIntoView({ behavior: 'smooth', inline: 'center', block: 'center' });
    });
  });
}

function renderStage() {
  const container = document.getElementById('lineage-graph');
  if (!state.dataset) { container.innerHTML = '<p class="muted" style="padding:20px">无数据集</p>'; return; }

  const { edges, occlusions, errors } = computeView();
  const { positionOf, width, height, occlusionMarks } = layout({
    frames: state.dataset.frames, edges, occlusions,
  });

  const errorCodes = new Map(); // uid|uid -> codes; uid -> codes
  for (const error of errors) {
    const refs = error.refs ?? {};
    if (refs.edge) errorCodes.set(edgeKey(refs.edge), error.code);
    if (refs.uid) errorCodes.set(`n:${refs.uid}`, error.code);
    if (refs.cycle) for (const uid of refs.cycle) errorCodes.set(`n:${uid}`, error.code);
  }

  const byFrame = new Map(state.dataset.frames.map((f) => [f.frame, f]));
  const contourById = new Map();
  for (const f of state.dataset.frames) for (const c of f.contours) contourById.set(c.uid, { ...c, frame: f.frame });

  const edgeSet = new Set(edges.map(edgeKey));
  const candidateSvg = candidateOverlayPaths(edgeSet, positionOf);
  const publishedSvg = edges.map((edge) => {
    const a = positionOf.get(edge.from_uid);
    const b = positionOf.get(edge.to_uid);
    if (!a || !b) return '';
    const errorCode = errorCodes.get(edgeKey(edge));
    const selected = state.selection?.type === 'edge' &&
      state.selection.edge.from_uid === edge.from_uid && state.selection.edge.to_uid === edge.to_uid;
    const gap = (b.frame - a.frame) > 1;
    const classes = ['edge-path', edge.kind, gap || edge.occluded ? 'occluded-link' : '', errorCode ? 'error' : '', selected ? 'selected' : ''].join(' ');
    const title = `${edge.kind} ${edge.from_uid} → ${edge.to_uid}${errorCode ? ' [' + errorCode + ']' : ''}`;
    // Visible stylized path plus a transparent thick hit-area; the latter owns
    // interaction/data attributes so perfectly flat edges remain clickable.
    return `
      <path class="${classes}" d="${edgePath(a, b)}" pointer-events="none"><title>${title}</title></path>
      <path class="edge-hit" data-edge-from="${edge.from_uid}" data-edge-to="${edge.to_uid}"
            d="${edgeHitPath(a, b)}"><title>${title}</title></path>`;
  }).join('');

  const occlusionSvg = occlusionMarks.map((mark) => {
    const x1 = mark.x;
    const x2 = (mark.end + 1) * (NODE_W + 70) + 24 - 14;
    return `
      <g class="occlusion-group">
        <line x1="${x1}" y1="${mark.y}" x2="${x2}" y2="${mark.y}"
              stroke="var(--occlusion)" stroke-width="3" stroke-dasharray="3 4" opacity=".75"/>
        <rect x="${(x1 + x2) / 2 - 34}" y="${mark.y - 20}" width="68" height="14" rx="4"
              fill="var(--occlusion)" data-occl-uid="${mark.occl_uid}"
              data-frame-start="${mark.frame_start}" data-frame-end="${mark.frame_end}" class="occlusion-rect"/>
        <text x="${(x1 + x2) / 2}" y="${mark.y - 9}" text-anchor="middle" font-size="9" fill="#0f1420">
          遮挡 f${mark.frame_start}-f${mark.frame_end}
        </text>
      </g>`;
  }).join('');

  const frameCols = [...byFrame.entries()].map(([frameNumber]) => `
    <div class="frame-col-header" data-frame-col="${frameNumber}"
         style="left:${frameNumber * (NODE_W + 70) + 24}px">F${frameNumber}</div>`).join('');

  const nodes = [...contourById.values()].map((contour) => {
    const pos = positionOf.get(contour.uid);
    if (!pos) return '';
    const errorCode = errorCodes.get(`n:${contour.uid}`);
    const selected = state.selection?.type === 'contour' && state.selection.uid === contour.uid;
    const picked = state.pickChain.includes(contour.uid);
    const outKinds = outKindBadges(edges, contour.uid);
    return `
      <div class="contour-node ${errorCode ? 'error' : ''} ${selected ? 'selected' : ''} ${picked ? 'pick' : ''}"
           data-uid="${contour.uid}"
           style="left:${pos.x}px;top:${pos.y}px"
           title="${contour.uid} @ frame ${contour.frame}">
        <span class="cid">${contour.uid}</span>
        <span class="area">area ${contour.area ?? '—'} · (${Math.round(contour.center?.x ?? 0)},${Math.round(contour.center?.y ?? 0)})</span>
        ${outKinds}
      </div>`;
  }).join('');

  container.innerHTML = `
    <div class="lineage-stage" style="width:${width}px;height:${height}px">
      <svg width="${width}" height="${height}" class="stage-svg">
        ${candidateSvg}
        ${occlusionSvg}
        ${publishedSvg}
      </svg>
      ${frameCols}
      ${nodes}
    </div>`;

  bindStageEvents(container);
}

function computeView() {
  // Mirror state.workingGraph but keep errors accessible.
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
  // Import the same checker the server uses.
  // validationResult in state.js already computes this; we re-import lazily.
  const { validateGraph } = window.__lineageGraph;
  const result = validateGraph({ edges, occlusions, frameOf: state.frameOf, maxOcclusionGap: 3 });
  return { edges, occlusions, errors: result.ok ? [] : result.errors };
}

function outKindBadges(edges, uid) {
  const outs = edges.filter((e) => e.from_uid === uid);
  if (outs.length === 2 && outs.every((e) => e.kind === 'division')) {
    return '<span class="badge division-badge">分裂×2</span>';
  }
  const ins = edges.filter((e) => e.to_uid === uid);
  if (ins.length === 2 && ins.every((e) => e.kind === 'merge')) {
    return '<span class="badge merge-badge">合并</span>';
  }
  return '';
}

function candidateOverlayPaths(edgeSet, positionOf) {
  if (state.tool !== 'select' || !state.dataset) return '';
  return state.dataset.candidates
    .filter((c) => !edgeSet.has(`${c.from_uid}|${c.to_uid}`))
    .map((c) => {
      const a = positionOf.get(c.from_uid);
      const b = positionOf.get(c.to_uid);
      if (!a || !b) return '';
      return `<path class="edge-path candidate-edge" data-candidate-id="${c.candidate_id}"
        d="${edgePath(a, b)}"><title>候选 ${c.kind} score=${c.score ?? '?'} from ${c.source ?? 'ext'}</title></path>`;
    }).join('');
}

function bindStageEvents(container) {
  container.querySelectorAll('.contour-node').forEach((node) => {
    node.addEventListener('click', (event) => {
      event.stopPropagation();
      handleContourClick(node.dataset.uid);
    });
  });
  container.querySelectorAll('.edge-hit').forEach((path) => {
    path.addEventListener('click', (event) => {
      event.stopPropagation();
      const from = path.dataset.edgeFrom;
      const to = path.dataset.edgeTo;
      const anchor = document.querySelector(`.lineage-stage [data-uid="${CSS.escape(from)}"]`);
      if (anchor && (anchor.getBoundingClientRect().right < 0 || anchor.getBoundingClientRect().left > window.innerWidth)) {
        anchor.scrollIntoView({ block: 'nearest', inline: 'center' });
      }
      const { edges } = computeView();
      const edge = edges.find((e) => e.from_uid === from && e.to_uid === to);
      if (state.tool === 'cut') {
        state.edits.push({ op: 'deleteEdge', from_uid: from, to_uid: to });
        state.pickChain = [];
        toast(`已断开 ${from} → ${to}`);
        emit('edits');
        return;
      }
      state.selection = { type: 'edge', edge };
      emit('selection');
    });
  });
  container.querySelectorAll('.candidate-edge').forEach((path) => {
    path.addEventListener('click', (event) => {
      event.stopPropagation();
      const candidate = state.dataset.candidates.find((c) => c.candidate_id === path.dataset.candidateId);
      if (candidate) {
        state.selection = { type: 'candidate', candidate };
        emit('selection');
      }
    });
  });
  container.querySelectorAll('.occlusion-rect').forEach((rect) => {
    rect.addEventListener('click', (event) => {
      event.stopPropagation();
      if (state.tool !== 'cut') {
        toast('用 ✂ 工具点击遮挡块可删除该遮挡区间', 'ok');
        return;
      }
      state.edits.push({
        op: 'deleteOcclusion',
        occl_uid: rect.dataset.occlUid,
        frame_start: Number(rect.dataset.frameStart),
        frame_end: Number(rect.dataset.frameEnd),
      });
      toast('已删除遮挡区间');
      emit('edits');
    });
  });
  container.addEventListener('click', (event) => {
    if (event.target === container.querySelector('.lineage-stage')) {
      state.selection = null;
      state.pickChain = [];
      emit('selection');
    }
  });
}

function handleContourClick(uid) {
  const nodeEl = document.querySelector(`.lineage-stage [data-uid="${CSS.escape(uid)}"]`);
  if (nodeEl) nodeEl.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  const tool = state.tool;
  if (tool === 'select') {
    state.selection = { type: 'contour', uid };
    state.pickChain = [];
    emit('selection');
    return;
  }
  state.selection = { type: 'contour', uid };
  state.pickChain.push(uid);
  emit('selection');

  if (tool === 'link') {
    if (state.pickChain.length === 2) {
      const [from, to] = state.pickChain;
      queueLink(from, to, 'continuation');
    }
  } else if (tool === 'division') {
    if (state.pickChain.length === 3) {
      const [mother, daughterA, daughterB] = state.pickChain;
      if (daughterA === daughterB) { toast('两个子细胞不能是同一轮廓', 'err'); state.pickChain = []; emit('selection'); return; }
      state.edits.push({ op: 'upsertEdge', edge: { from_uid: mother, to_uid: daughterA, kind: 'division' } });
      state.edits.push({ op: 'upsertEdge', edge: { from_uid: mother, to_uid: daughterB, kind: 'division' } });
      state.pickChain = [];
      toast(`确认分裂：${mother} → {${daughterA}, ${daughterB}}`);
      emit('edits');
    } else {
      toast(`分裂：已选 ${state.pickChain.length}/3（母，子，子）`);
    }
  } else if (tool === 'merge') {
    if (state.pickChain.length === 3) {
      const [parentA, parentB, child] = state.pickChain;
      state.edits.push({ op: 'upsertEdge', edge: { from_uid: parentA, to_uid: child, kind: 'merge' } });
      state.edits.push({ op: 'upsertEdge', edge: { from_uid: parentB, to_uid: child, kind: 'merge' } });
      state.pickChain = [];
      toast(`确认合并：{${parentA}, ${parentB}} → ${child}`);
      emit('edits');
    } else {
      toast(`合并：已选 ${state.pickChain.length}/3（父，父，子）`);
    }
  } else if (tool === 'occlusion') {
    if (state.pickChain.length === 2) {
      const [anchorUid, untilUid] = state.pickChain;
      const anchorFrame = state.frameOf.get(anchorUid);
      const untilFrame = state.frameOf.get(untilUid);
      if (!Number.isFinite(anchorFrame) || !Number.isFinite(untilFrame) || untilFrame <= anchorFrame + 1) {
        toast('遮挡需要两个不同帧的轮廓（遮挡前、重现后）', 'err');
        state.pickChain = [];
        emit('selection');
        return;
      }
      const start = anchorFrame + 1;
      const end = untilFrame - 1;
      state.edits.push({ op: 'addOcclusion', occlusion: { occl_uid: anchorUid, frame_start: start, frame_end: end } });
      queueLink(anchorUid, untilUid, 'continuation', { occluded: 1, gap: untilFrame - anchorFrame });
    } else {
      toast('遮挡：依次点遮挡前轮廓与重现后的轮廓');
    }
  }
}

function queueLink(from, to, kind, extra = {}) {
  const fromFrame = state.frameOf.get(from);
  const toFrame = state.frameOf.get(to);
  if (!Number.isFinite(fromFrame) || !Number.isFinite(toFrame)) {
    toast('轮廓帧信息缺失，无法连接', 'err');
    state.pickChain = [];
    emit('selection');
    return;
  }
  if (toFrame <= fromFrame) {
    toast('时间倒流：只能连接更晚帧的轮廓', 'err');
    state.pickChain = [];
    emit('selection');
    return;
  }
  state.edits.push({
    op: 'upsertEdge',
    edge: { from_uid: from, to_uid: to, kind, gap: toFrame - fromFrame, occluded: extra.occluded ? 1 : 0 },
  });
  state.pickChain = [];
  toast(`已加入连接 ${from} → ${to}${kind === 'continuation' ? '' : ' [' + kind + ']'}`);
  emit('edits');
}
