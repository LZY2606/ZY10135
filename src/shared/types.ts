// Shared domain types used by both the Node service and the browser editor.

export type EdgeKind = 'continuation' | 'division' | 'merge';

/** A contour is one detected cell outline in one frame. */
export interface Contour {
  id: string;
  frame: number;
  externalId: string;
  cx: number;
  cy: number;
  area: number;
  /** Simplified polygon boundary, points relative to frame coordinates. */
  boundary: Array<[number, number]>;
  /** Free-form attributes copied verbatim from the external segmenter. */
  meta?: Record<string, unknown>;
}

/** Candidate link proposed by the external auto-tracker. Append-only. */
export interface Candidate {
  id: string;
  runId: string;
  fromContourId: string | null;
  toContourId: string | null;
  kind: EdgeKind;
  score: number;
  /** Raw candidate object from the upstream program, kept for provenance. */
  raw?: unknown;
  createdAt: string;
}

/** Reviewed graph edge. Survives across auto re-runs; never auto-overwritten. */
export interface Edge {
  id: string;
  fromId: string;
  toId: string;
  kind: EdgeKind;
  source: 'manual' | 'candidate';
  candidateId?: string;
  author: string;
  createdAt: string;
  note?: string;
}

/**
 * Occlusion allowance: the trajectory entering at `enterContourId` may stay
 * without a contour between `gapStartFrame` and `gapEndFrame` (inclusive) and
 * re-emerge at `exitContourId`. Gap length is gapEndFrame - gapStartFrame + 1.
 */
export interface Occlusion {
  id: string;
  enterContourId: string;
  exitContourId: string;
  gapStartFrame: number;
  gapEndFrame: number;
  author: string;
  createdAt: string;
  note?: string;
}

/** Human rejection: "these two contours must NOT be linked this way". */
export interface Negation {
  id: string;
  fromContourId: string | null;
  toContourId: string | null;
  kind: EdgeKind;
  candidateId?: string;
  author: string;
  createdAt: string;
  reason?: string;
}

/** Materialized reviewed graph of one published hypothesis version. */
export interface GraphData {
  edges: Edge[];
  occlusions: Occlusion[];
  negations: Negation[];
}

export interface DatasetPayload {
  name: string;
  frames: number;
  /** Import batch identifier of the upstream program. */
  importSource: string;
  contours: Array<Omit<Contour, 'id'> & { id?: string }>;
  candidates?: Array<Omit<Candidate, 'id' | 'createdAt'> & { id?: string }>;
}

export interface Dataset extends DatasetPayload {
  id: string;
  contentHash: string;
  importedAt: string;
  contours: Contour[];
}

export type ViolationCode =
  | 'CYCLE'
  | 'MULTI_PARENT'
  | 'DIVISION_PARENT_CONTINUES'
  | 'DIVISION_MULTI_PARENT'
  | 'MERGE_WITHOUT_MARK'
  | 'MULTI_CHILD_NON_DIVISION'
  | 'TIME_BACKWARDS'
  | 'FRAME_GAP_TOO_LARGE'
  | 'OCCLUSION_WITHOUT_EDGE'
  | 'OCCLUSION_MISMATCH'
  | 'OCCLUSION_GAP_EXCEEDED'
  | 'OCCLUSION_FRAME_CONFLICT'
  | 'CONTOUR_REUSE'
  | 'MISSING_CONTOUR'
  | 'NEGATED_EDGE'
  | 'DATASET_MISMATCH';

export interface Violation {
  code: ViolationCode;
  message: string;
  /** Edge/occlusion/negation ids and contour ids involved. */
  refs: string[];
}

export interface CheckOptions {
  /** Max frames a trajectory may skip without an explicit occlusion. */
  maxGapFrames: number;
}
