import { h } from './dom.ts';
import { api } from './api.ts';
import type { DatasetPayload } from '../shared/types.ts';

export async function showImportDialog(): Promise<boolean> {
  return new Promise<boolean>((resolve) => {
    const dlg = document.createElement('dialog') as HTMLDialogElement;
    dlg.appendChild(h('div', { class: 'dlg-head' }, h('strong', { text: '导入分割程序输出 / 自动重跑' })));

    const ta = document.createElement('textarea');
    ta.style.width = '100%';
    ta.style.height = '300px';
    ta.placeholder = '粘贴 JSON：{ name, frames, importSource, contours[], candidates[] }';
    const fileInput = h('input', { type: 'file', accept: '.json,application/json' }) as HTMLInputElement;
    fileInput.addEventListener('change', () => {
      const file = fileInput.files?.[0];
      if (!file) return;
      const reader = new FileReader();
      reader.onload = () => (ta.value = String(reader.result ?? ''));
      reader.readAsText(file);
    });

    const resultBox = h('div', { style: 'margin-top:8px' });

    const close = (changed: boolean) => {
      dlg.close();
      dlg.remove();
      resolve(changed);
    };

    const body = h('div', { class: 'dlg-body' },
      h('div', { class: 'muted', style: 'margin-bottom:8px', text: '导入以轮廓内容哈希幂等：相同文件重复导入不会重建数据；候选按 (runId, extKey) 追加，已审核边不会被覆盖。' }),
      fileInput,
      ta,
      resultBox,
    );
    const foot = h('div', { class: 'dlg-foot' },
      h('button', { text: '取消', onclick: () => close(false) }),
      h('button', {
        class: 'primary',
        text: '导入',
        onclick: async () => {
          try {
            const payload = JSON.parse(ta.value) as DatasetPayload;
            const result = await api.importDataset(payload);
            resultBox.innerHTML = '';
            resultBox.appendChild(
              h('div', { class: 'ok-note' },
                result.created
                  ? `新数据集已创建（${result.insertedCandidates} 条候选）。`
                  : `同一内容哈希已存在：追加 ${result.insertedCandidates} 条新候选，跳过 ${result.skippedCandidates} 条重复候选。`,
              ),
            );
            setTimeout(() => close(true), 900);
          } catch (e: any) {
            resultBox.innerHTML = '';
            resultBox.appendChild(h('div', { class: 'violation', text: e.message }));
          }
        },
      }),
    );
    dlg.appendChild(body);
    dlg.appendChild(foot);
    document.body.appendChild(dlg);
    dlg.showModal();
  });
}
