import { h } from './dom.ts';
import { renderLineage } from './render.ts';
import type { Contour } from '../shared/types.ts';
import type { MergeResult } from '../shared/merge.ts';

export interface ConflictDialogOptions {
  merge: MergeResult;
  contours: Contour[];
  author: string;
  onResolve: (mode: 'rebase' | 'fork', forkName?: string) => Promise<boolean>;
}

export async function showConflictDialog(opts: ConflictDialogOptions): Promise<void> {
  const { merge } = opts;
  const affectedIds = new Set(merge.affected.contourIds);
  const affectedContours = opts.contours.filter((c) => affectedIds.has(c.id));

  const dlg = document.createElement('dialog') as HTMLDialogElement;

  const mineSet = new Set<string>();
  for (const change of [...merge.mineAdded, ...merge.mineRemoved]) {
    const el = change.element as any;
    if (el.fromId) mineSet.add(el.fromId), mineSet.add(el.toId);
    if (el.enterContourId) mineSet.add(el.enterContourId), mineSet.add(el.exitContourId);
  }

  dlg.appendChild(
    h('div', { class: 'dlg-head' },
      h('strong', { text: '并发编辑冲突' }),
      h('span', {
        class: 'muted',
        text: `${merge.conflicts.length} 处冲突 · 已裁剪到最小受影响子图`,
      }),
    ),
  );

  const body = h('div', { class: 'dlg-body' });

  body.appendChild(h('div', { class: 'section-title', text: '冲突明细' }));
  for (const conflict of merge.conflicts) {
    body.appendChild(
      h('div', { class: 'violation', style: 'margin-bottom:8px' },
        h('div', { text: conflict.message }),
        h('div', { class: 'muted', style: 'font-size:11px', text: `涉及: ${conflict.refs.join(' / ')}` }),
      ),
    );
  }

  body.appendChild(
    h('div', { class: 'two-col' },
      changeCard('我方改动', merge.mineAdded, merge.mineRemoved, opts.contours, 'good'),
      changeCard('对方已发布改动', merge.theirsAdded, merge.theirsRemoved, opts.contours, 'warn'),
    ),
  );

  body.appendChild(h('div', { class: 'section-title', text: '最小受影响子图（自动合并结果预览）' }));
  const svgWrap = h('div', { class: 'mini-graph' });
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg') as SVGSVGElement;
  svg.style.width = '100%';
  svg.style.height = `${Math.max(180, 70 + affectedContours.length * 6)}px`;
  svgWrap.appendChild(svg);
  body.appendChild(svgWrap);
  renderLineage(
    svg,
    affectedContours,
    { edges: merge.affected.edges, occlusions: merge.affected.occlusions, negations: merge.affected.negations },
    Math.max(...opts.contours.map((c) => c.frame)) + 1,
    { selectedContourId: null, linkSourceId: null, affectedContourIds: mineSet },
    () => {},
  );

  body.appendChild(
    h('p', {
      class: 'muted',
      text: '「变基」把无冲突的双方改动三路合并后在同一假设上发布；「派生并行假设」保留对方已发布谱系，同时把你的谱系另存为一条新的并行分支。后一次保存不会静默吃掉先前的链接。',
    }),
  );

  dlg.appendChild(body);

  const forkNameInput = h('input', {
    type: 'text',
    placeholder: '并行分支名称（可选）',
    style: 'flex:1',
  }) as HTMLInputElement;

  const foot = h('div', { class: 'dlg-foot' }, forkNameInput);
  const close = () => {
    dlg.close();
    dlg.remove();
  };
  foot.appendChild(h('button', { text: '取消', onclick: () => close() }));
  foot.appendChild(
    h('button', {
      class: 'warn',
      text: '派生两种解：并行假设',
      onclick: async () => {
        if (await opts.onResolve('fork', forkNameInput.value || undefined)) close();
      },
    }),
  );
  foot.appendChild(
    h('button', {
      class: 'good',
      text: '变基并发布',
      disabled: merge.conflicts.some((c) => c.mine.length && c.theirs.length) ? false : false,
      onclick: async () => {
        if (await opts.onResolve('rebase')) close();
      },
    }),
  );
  dlg.appendChild(foot);

  document.body.appendChild(dlg);
  dlg.showModal();
}

function changeCard(
  title: string,
  added: MergeResult['mineAdded'],
  removed: MergeResult['mineRemoved'],
  contours: Contour[],
  tone: 'good' | 'warn',
): HTMLElement {
  const nameOf = (id: string) => contours.find((c) => c.id === id)?.externalId ?? id;
  const card = h('div', { class: 'mini-graph' }, h('div', { class: 'section-title', text: title }));
  for (const change of added) {
    const el = change.element as any;
    const label =
      'fromId' in el
        ? `${el.kind}: ${nameOf(el.fromId)} → ${nameOf(el.toId)}`
        : 'enterContourId' in el
          ? `遮挡 ${nameOf(el.enterContourId)} → ${nameOf(el.exitContourId)}`
          : `否定 ${el.fromContourId ? nameOf(el.fromContourId) : '*'} ✕ ${el.toContourId ? nameOf(el.toContourId) : '*'}`;
    card.appendChild(h('div', { style: `color:var(--${tone});font-size:12px`, text: `+ ${label}` }));
  }
  for (const change of removed) {
    const el = change.element as any;
    const label =
      'fromId' in el
        ? `${el.kind}: ${nameOf(el.fromId)} → ${nameOf(el.toId)}`
        : 'enterContourId' in el
          ? `遮挡 ${nameOf(el.enterContourId)} → ${nameOf(el.exitContourId)}`
          : `否定`;
    card.appendChild(h('div', { class: 'muted', style: 'font-size:12px', text: `− ${label}` }));
  }
  if (added.length + removed.length === 0) {
    card.appendChild(h('div', { class: 'muted', style: 'font-size:12px', text: '无' }));
  }
  return card;
}
