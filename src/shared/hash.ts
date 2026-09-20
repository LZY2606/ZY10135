import { createHash } from 'node:crypto';
import type { DatasetPayload } from './types.ts';

/**
 * Deterministic content hash of an import payload so re-importing the same
 * file is idempotent. Candidate rows are excluded: re-runs add new candidates,
 * contours are the immutable evidence from the upstream segmenter.
 */
export function hashDatasetPayload(payload: {
  name: string;
  frames: number;
  importSource: string;
  contours: unknown[];
}): string {
  const canonical = JSON.stringify({
    name: payload.name,
    frames: payload.frames,
    importSource: payload.importSource,
    contours: payload.contours,
  });
  return 'sha256:' + createHash('sha256').update(canonical).digest('hex');
}

export type { DatasetPayload };
