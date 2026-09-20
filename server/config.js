export const DEFAULT_MAX_OCCLUSION_GAP = 3;
export const EDGE_KINDS = ['continuation', 'division', 'merge'];

export function envInt(name, fallback) {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;
  const value = Number.parseInt(raw, 10);
  return Number.isFinite(value) ? value : fallback;
}
