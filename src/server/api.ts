import express from 'express';
import { getDb } from './db.ts';
import {
  getCandidates,
  getContours,
  getDataset,
  importDataset,
  listDatasets,
} from './repo-datasets.ts';
import {
  createHypothesis,
  getDraft,
  getHeadGraph,
  getVersion,
  listHypotheses,
  listVersions,
  previewConflict,
  publishDraft,
  resolveConflict,
  saveDraft,
} from './repo-hypotheses.ts';
import { checkGraph } from '../shared/graph.ts';
import type { DatabaseSync } from 'node:sqlite';
import type { GraphData } from '../shared/types.ts';
import { seedDemo } from './seed.ts';

function graphContext(db: DatabaseSync, datasetId: string) {
  const dataset = getDataset(db, datasetId) as any;
  const contours = getContours(db, datasetId);
  return {
    contours: new Map(contours.map((c) => [c.id, c])),
    options: { maxGapFrames: dataset?.max_gap_frames ?? 3 },
  };
}

function asyncRoute(
  handler: (req: express.Request, res: express.Response) => Promise<void> | void,
) {
  return (req: express.Request, res: express.Response, next: express.NextFunction) => {
    Promise.resolve(handler(req, res)).catch(next);
  };
}

export function createApiRouter(db: DatabaseSync = getDb()): express.Express {
  seedDemo(db);
  const app = express();
  app.use(express.json({ limit: '20mb' }));

  // --- datasets ------------------------------------------------------------
  app.get('/api/datasets', (_req, res) => {
    res.json(listDatasets(db));
  });

  app.post(
    '/api/datasets/import',
    asyncRoute((req, res) => {
      const result = importDataset(db, req.body);
      res.status(result.created ? 201 : 200).json(result);
    }),
  );

  app.get(
    '/api/datasets/:id',
    asyncRoute((req, res) => {
      const dataset = getDataset(db, req.params.id as string);
      if (!dataset) return void res.status(404).json({ error: '数据集不存在' });
      res.json({
        dataset,
        contours: getContours(db, req.params.id as string),
        candidates: getCandidates(db, req.params.id as string),
      });
    }),
  );

  // --- hypotheses ----------------------------------------------------------
  app.get(
    '/api/datasets/:id/hypotheses',
    asyncRoute((req, res) => {
      res.json(listHypotheses(db, req.params.id as string));
    }),
  );

  app.post(
    '/api/datasets/:id/hypotheses',
    asyncRoute((req, res) => {
      const name = String(req.body?.name ?? '未命名假设');
      const author = String(req.body?.author ?? '研究员');
      const hypId = createHypothesis(db, req.params.id as string, name, author);
      res.status(201).json({ id: hypId });
    }),
  );

  // --- draft ---------------------------------------------------------------
  app.get(
    '/api/hypotheses/:hid/draft',
    asyncRoute((req, res) => {
      const draft = getDraft(db, req.params.hid as string);
      if (!draft) return void res.status(404).json({ error: '草稿不存在' });
      res.json(draft);
    }),
  );

  app.put(
    '/api/hypotheses/:hid/draft',
    asyncRoute((req, res) => {
      const { graph, expectedRev, author } = req.body ?? {};
      const result = saveDraft(
        db,
        req.params.hid as string,
        graph as GraphData,
        Number(expectedRev),
        String(author ?? '研究员'),
      );
      if (!result.ok) {
        return void res.status(409).json({ error: '草稿已被其他编辑更新', currentRev: result.currentRev });
      }
      res.json({ ok: true, rev: result.rev });
    }),
  );

  // --- live validation -----------------------------------------------------
  app.post(
    '/api/hypotheses/:hid/check',
    asyncRoute((req, res) => {
      const hypothesis = db
        .prepare('SELECT dataset_id FROM hypothesis WHERE id = ?')
        .get(req.params.hid as string) as { dataset_id: string } | undefined;
      if (!hypothesis) return void res.status(404).json({ error: '假设不存在' });
      const ctx = graphContext(db, hypothesis.dataset_id);
      const violations = checkGraph((req.body?.graph ?? EMPTY) as GraphData, ctx);
      res.json({ violations });
    }),
  );

  // --- publish -------------------------------------------------------------
  app.post(
    '/api/hypotheses/:hid/publish',
    asyncRoute((req, res) => {
      const hypothesis = db
        .prepare('SELECT dataset_id FROM hypothesis WHERE id = ?')
        .get(req.params.hid as string) as { dataset_id: string } | undefined;
      if (!hypothesis) return void res.status(404).json({ error: '假设不存在' });
      const ctx = graphContext(db, hypothesis.dataset_id);
      const result = publishDraft(
        db,
        req.params.hid as string,
        req.body.graph as GraphData,
        Number(req.body.expectedRev),
        String(req.body?.author ?? '研究员'),
        String(req.body?.message ?? '人工编辑'),
        ctx,
      );
      if (result.status === 'conflict') {
        return void res.status(409).json({ status: 'conflict', merge: result.merge });
      }
      res.status(201).json({ status: 'published', version: result.version });
    }),
  );

  // --- conflict resolution -------------------------------------------------
  app.post(
    '/api/hypotheses/:hid/conflict-preview',
    asyncRoute((req, res) => {
      const hypothesis = db
        .prepare('SELECT dataset_id FROM hypothesis WHERE id = ?')
        .get(req.params.hid as string) as { dataset_id: string } | undefined;
      if (!hypothesis) return void res.status(404).json({ error: '假设不存在' });
      const ctx = graphContext(db, hypothesis.dataset_id);
      const merge = previewConflict(
        db,
        req.params.hid as string,
        (req.body?.graph ?? EMPTY) as GraphData,
        ctx,
      );
      res.json(merge);
    }),
  );

  app.post(
    '/api/hypotheses/:hid/resolve',
    asyncRoute((req, res) => {
      const mode = req.body?.mode === 'fork' ? 'fork' : 'rebase';
      const hypothesis = db
        .prepare('SELECT dataset_id FROM hypothesis WHERE id = ?')
        .get(req.params.hid as string) as { dataset_id: string } | undefined;
      if (!hypothesis) return void res.status(404).json({ error: '假设不存在' });
      const ctx = graphContext(db, hypothesis.dataset_id);
      const result = resolveConflict(
        db,
        req.params.hid as string,
        mode,
        req.body.graph as GraphData,
        String(req.body?.author ?? '研究员'),
        String(req.body?.message ?? '冲突解决'),
        ctx,
        req.body?.forkName ? String(req.body.forkName) : undefined,
      );
      if (result.status === 'conflict') {
        return void res.status(409).json({ status: 'conflict', merge: result.merge });
      }
      res.status(201).json(result);
    }),
  );

  // --- versions / head -----------------------------------------------------
  app.get(
    '/api/hypotheses/:hid/versions',
    asyncRoute((req, res) => {
      res.json(listVersions(db, req.params.hid as string));
    }),
  );

  app.get(
    '/api/hypotheses/:hid/head',
    asyncRoute((req, res) => {
      res.json(getHeadGraph(db, req.params.hid as string));
    }),
  );

  app.get(
    '/api/versions/:vid',
    asyncRoute((req, res) => {
      const version = getVersion(db, req.params.vid as string);
      if (!version) return void res.status(404).json({ error: '版本不存在' });
      res.json(version);
    }),
  );

  app.use(
    (err: any, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
      if (err?.message === 'GRAPH_VIOLATIONS') {
        return void res.status(422).json({ error: '图不变量检查失败', violations: err.violations });
      }
      res.status(400).json({ error: err?.message ?? String(err) });
    },
  );

  return app;
}

const EMPTY: GraphData = { edges: [], occlusions: [], negations: [] };

/** Vite dev/preview middleware: only forward /api requests. */
export function createApiMiddleware(db?: DatabaseSync) {
  const router = createApiRouter(db);
  return (req: express.Request | any, res: express.Response | any, next: (err?: unknown) => void) => {
    if (!req.url?.startsWith('/api')) return next();
    // eslint-disable-next-line no-console
    if (process.env.LINEAGE_DEBUG) console.error('[api] hit', req.url);
    try {
      router(req, res, (err: unknown) => {
        if (err) {
          // eslint-disable-next-line no-console
          console.error('[api] handler error', err);
          if (!res.headersSent) {
            res.statusCode = 500;
            res.setHeader('content-type', 'application/json');
            res.end(JSON.stringify({ error: String(err) }));
            return;
          }
        }
        next(err);
      });
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error('[api] throw', err);
      next(err);
    }
  };
}
