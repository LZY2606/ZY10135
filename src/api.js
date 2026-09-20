async function request(path, options = {}) {
  const response = await fetch(path, {
    headers: { 'content-type': 'application/json' },
    ...options,
    body: options.body ? JSON.stringify(options.body) : undefined,
  });
  const text = await response.text();
  const data = text ? JSON.parse(text) : {};
  return { status: response.status, data };
}

export const api = {
  datasets: () => request('/api/datasets'),
  dataset: (hash) => request(`/api/datasets/${encodeURIComponent(hash)}`),
  import: (payload) => request('/api/datasets/import', { method: 'POST', body: payload }),
  rawContour: (hash, uid) => request(`/api/contours/${encodeURIComponent(hash)}/${encodeURIComponent(uid)}/raw`),
  evidence: (hash, body) => request(`/api/datasets/${encodeURIComponent(hash)}/evidence`, { method: 'POST', body }),
  newHypothesis: (hash, body) => request(`/api/datasets/${encodeURIComponent(hash)}/hypotheses`, { method: 'POST', body }),
  hypothesis: (id) => request(`/api/hypotheses/${encodeURIComponent(id)}`),
  snapshot: (id) => request(`/api/hypotheses/${encodeURIComponent(id)}/snapshot`),
  publish: (id, body) => request(`/api/hypotheses/${encodeURIComponent(id)}/publish`, { method: 'POST', body }),
  fork: (id, body) => request(`/api/hypotheses/${encodeURIComponent(id)}/fork`, { method: 'POST', body }),
  version: (id) => request(`/api/versions/${encodeURIComponent(id)}`),
};

export async function fakeRerun(dataset) {
  // Simulate an auto-tracker re-run: append a previously-unseen candidate with
  // a new external id. Import is hash-idempotent and only inserts new rows.
  const payload = JSON.parse(JSON.stringify(dataset.raw_payload ?? dataset));
  delete payload.dataset_hash;
  const stamp = Date.now();
  payload.candidates = [
    ...(payload.candidates ?? []),
    {
      id: `rerun-${stamp}`,
      from_uid: 'f0_b', to_uid: 'f1_a',
      from_frame: 0, to_frame: 1,
      score: Number((Math.random() * 0.3).toFixed(2)),
      kind: 'continuation', source: `tracker-rerun-${stamp}`,
    },
  ];
  payload.dataset_hash = dataset.dataset_hash;
  return api.import(payload);
}
