// @ts-check
import { test, expect } from '@playwright/test';
import { rmSync } from 'node:fs';

rmSync('/tmp/lineage-e2e.sqlite', { force: true });
rmSync('/tmp/lineage-e2e.sqlite-wal', { force: true });
rmSync('/tmp/lineage-e2e.sqlite-shm', { force: true });

test('editor: render, cut, link, time-reversal guard, occlusion, division invariant', async ({ page }) => {
  const errors = [];
  page.on('console', (msg) => { if (msg.type() === 'error') errors.push(msg.text()); });

  await page.goto('http://127.0.0.1:5335/?autopublish');

  await expect(page.locator('.hyp-tab')).toHaveCount(2);
  await expect(page.locator('.contour-node')).toHaveCount(21);
  await expect(page.locator('#canvas-hint')).toContainText('图不变量检查通过');
  await expect(page.locator('.candidate-item').first()).toContainText('f0_a');

  // Raw provenance in the inspector.
  await page.locator('[data-uid="f0_b"]').click();
  await expect(page.locator('#inspector')).toContainText('完整原始轮廓记录');

  // Cut an existing edge and publish v2.
  await page.locator('[data-tool="cut"]').click();
  await page.locator('[data-edge-from="f0_b"][data-edge-to="f1_b"]').click();
  await expect(page.locator('#pending-edits')).toContainText('断开 f0_b');
  await page.locator('#btn-publish').click();
  await expect(page.locator('.toast.ok').last()).toContainText('已发布 v2');
  await expect(page.locator('[data-edge-from="f0_b"][data-edge-to="f1_b"]')).toHaveCount(0);

  // Time reversal guard.
  await page.locator('[data-tool="link"]').click();
  await page.locator('[data-uid="f2_b"]').click();
  await page.locator('[data-uid="f0_b"]').click();
  await expect(page.locator('.toast.err').last()).toContainText('时间倒流');

  // Reconnect forward and publish v3.
  await page.locator('[data-uid="f0_b"]').click();
  await page.locator('[data-uid="f1_b"]').click();
  await expect(page.locator('.toast.ok').last()).toContainText('已加入连接');
  await page.locator('#btn-publish').click();
  await expect(page.locator('.toast.ok').last()).toContainText('已发布 v3');

  // Occlusion interval f2_c -> f4_c (missing frame 3) and publish v4.
  await page.locator('[data-tool="occlusion"]').click();
  await page.locator('[data-uid="f2_c"]').click();
  await page.locator('[data-uid="f4_c"]').click();
  await expect(page.locator('#pending-edits')).toContainText('遮挡 f2_c f3-f3');
  await expect(page.locator('#canvas-hint')).toContainText('图不变量检查通过');
  await page.locator('#btn-publish').click();
  await expect(page.locator('.toast.ok').last()).toContainText('已发布 v4');

  // Server-side invariant: a dividing mother cannot also continue.
  await page.locator('[data-tool="link"]').click();
  await page.locator('[data-uid="f1_a"]').click();
  await page.locator('[data-uid="f2_b"]').click();
  await page.locator('#btn-publish').click();
  await expect(page.locator('.modal h2')).toContainText('图不变量检查未通过');
  await expect(page.locator('.error-list')).toContainText('MOTHER_CONTINUES_AFTER_DIVISION');
  await page.locator('#invariant-close').click();

  const unexpected = errors.filter((e) => !e.includes('favicon') && !e.includes('422'));
  expect(unexpected).toEqual([]);
});

test('conflict: stale save shows minimal subgraph and supports fork', async ({ page, request }) => {
  await page.goto('http://127.0.0.1:5335/?autopublish');
  await expect(page.locator('.hyp-tab').first()).toBeVisible();

  const hash = (await (await request.get('http://127.0.0.1:5335/api/datasets')).json())[0].dataset_hash;
  const hid = (await (await request.post(`http://127.0.0.1:5335/api/datasets/${hash}/hypotheses`, {
    data: { name: 'conflict-e2e' },
  })).json()).hypothesis_id;

  // Publish v1 on the server...
  const v1 = await (await request.post(`http://127.0.0.1:5335/api/hypotheses/${hid}/publish`, {
    data: { edits: [{ op: 'upsertEdge', edge: { from_uid: 'f0_b', to_uid: 'f1_b', kind: 'continuation', gap: 1, occluded: 0 } }] },
  })).json();

  // ...and open it in the editor while it is still the head.
  await page.evaluate((id) => window.__lineageRefresh(id), hid);
  await expect(page.locator('#version-info')).toContainText('v1');

  // Concurrent editor advances the server head to v2.
  await request.post(`http://127.0.0.1:5335/api/hypotheses/${hid}/publish`, {
    data: {
      base_version: v1.version_id,
      edits: [{ op: 'upsertEdge', edge: { from_uid: 'f1_b', to_uid: 'f2_b', kind: 'continuation', gap: 1, occluded: 0 } }],
    },
  });

  // The still-open editor saves a competing edit against its stale v1 base.
  await page.locator('[data-tool="link"]').click();
  await page.locator('[data-uid="f2_b"]').click();
  await page.locator('[data-uid="f3_b"]').click();
  await page.locator('#btn-publish').click();

  const modal = page.locator('.modal');
  await expect(modal).toContainText('版本冲突');
  await expect(modal.locator('.conflict-col.server')).toContainText('f1_b');
  await expect(modal.locator('.conflict-col.incoming')).toContainText('f2_b');

  // Fork: both competing lineages survive as parallel hypotheses.
  await page.locator('#conflict-fork').click();
  await expect(page.locator('.toast.ok').last()).toContainText('并行假设');
  const forkedTab = page.locator('.hyp-tab', { hasText: 'conflict branch' });
  await expect(forkedTab).toBeVisible();
  await expect(forkedTab).toHaveClass(/active/);
  await expect(page.locator('[data-edge-from="f1_b"][data-edge-to="f2_b"]')).toHaveCount(1);
  await expect(page.locator('[data-edge-from="f2_b"][data-edge-to="f3_b"]')).toHaveCount(1);
});
