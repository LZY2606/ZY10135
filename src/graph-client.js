// The invariant checker is dependency-free and shared verbatim with the
// Node server, so the editor gets identical pre-save validation in the browser.
export { validateGraph, affectedSubgraph } from '../server/graph.js';
