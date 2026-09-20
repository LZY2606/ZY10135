import type {
  Candidate,
  Contour,
  DatasetPayload,
  GraphData,
  Violation,
} from '../shared/types.ts';
import type { MergeResult } from '../shared/merge.ts';

async function req<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(path, {
    headers: { 'content-type': 'application/json' },
    ...init,
  });
  const text = await res.text();
  const body = text ? JSON.parse(text) : null;
  if (!res.ok) throw Object.assign(new Error(body?.error ?? `HTTP ${res.status}`), { body, status: res.status });
  return body as T;
}

export const api = {
  listDatasets: () => req<any[]>('/api/datasets'),
  importDataset: (payload: DatasetPayload) =>
    req<{ datasetId: string; created: boolean; insertedCandidates: number; skippedCandidates: number }>(
      '/api/datasets/import',
      { method: 'POST', body: JSON.stringify(payload) },
    ),
  getDataset: (id: string) =>
    req<{ dataset: any; contours: Contour[]; candidates: Candidate[] }>(`/api/datasets/${id}`),
  listHypotheses: (datasetId: string) =>
    req<any[]>(`/api/datasets/${datasetId}/hypotheses`),
  createHypothesis: (datasetId: string, name: string, author: string) =>
    req<{ id: string }>(`/api/datasets/${datasetId}/hypotheses`, {
      method: 'POST',
      body: JSON.stringify({ name, author }),
    }),
  getDraft: (hid: string) =>
    req<{ graph: GraphData; baseVersionId: string | null; rev: number }>(
      `/api/hypotheses/${hid}/draft`,
    ),
  saveDraft: (hid: string, graph: GraphData, expectedRev: number, author: string) =>
    req<{ ok: true; rev: number }>(`/api/hypotheses/${hid}/draft`, {
      method: 'PUT',
      body: JSON.stringify({ graph, expectedRev, author }),
    }),
  check: (hid: string, graph: GraphData) =>
    req<{ violations: Violation[] }>(`/api/hypotheses/${hid}/check`, {
      method: 'POST',
      body: JSON.stringify({ graph }),
    }),
  publish: (hid: string, graph: GraphData, expectedRev: number, author: string, message: string) =>
    req<any>(`/api/hypotheses/${hid}/publish`, {
      method: 'POST',
      body: JSON.stringify({ graph, expectedRev, author, message }),
    }),
  conflictPreview: (hid: string, graph: GraphData) =>
    req<MergeResult>(`/api/hypotheses/${hid}/conflict-preview`, {
      method: 'POST',
      body: JSON.stringify({ graph }),
    }),
  resolve: (
    hid: string,
    mode: 'rebase' | 'fork',
    graph: GraphData,
    author: string,
    message: string,
    forkName?: string,
  ) =>
    req<any>(`/api/hypotheses/${hid}/resolve`, {
      method: 'POST',
      body: JSON.stringify({ mode, graph, author, message, forkName }),
    }),
  listVersions: (hid: string) => req<any[]>(`/api/hypotheses/${hid}/versions`),
  getHead: (hid: string) =>
    req<{ graph: GraphData; versionId: string | null }>(`/api/hypotheses/${hid}/head`),
};
