/**
* Stable-ish unique id without third-party deps. `prefix` makes ids readable
* in the UI (e_ds1_3 / oc_... / cand_...).
*/
export function newId(prefix: string): string {
  const rand = Math.random().toString(36).slice(2, 10);
  return `${prefix}_${Date.now().toString(36)}${rand}`;
}
