// Deterministic layout: every contour gets (x,y) inside one wide stage.
// Columns = frames; lanes = tracks/components laid out by connected edges.

export const NODE_W = 74;
export const NODE_H = 46;
export const FRAME_GAP_X = 70;
export const LANE_GAP_Y = 30;
export const TOP_PAD = 20;

export function layout({ frames, edges, occlusions }) {
  const frameIndex = Math.max(0, ...frames.map((f) => f.frame));
  const frameByNumber = new Map(frames.map((f) => [f.frame, f]));

  // Connected components by undirected adjacency => lanes ("tracks").
  const adj = new Map();
  const ensure = (uid) => { if (!adj.has(uid)) adj.set(uid, new Set()); return adj.get(uid); };
  for (const e of edges) { ensure(e.from_uid).add(e.to_uid); ensure(e.to_uid).add(e.from_uid); }

  const laneOf = new Map();
  const lanes = [];
  for (const frame of frames) {
    for (const contour of frame.contours) {
      if (laneOf.has(contour.uid)) continue;
      // Join a neighbor lane if already assigned.
      let lane = -1;
      for (const neighbor of ensure(contour.uid)) {
        if (laneOf.has(neighbor)) { lane = laneOf.get(neighbor); break; }
      }
      if (lane === -1) {
        lane = lanes.length;
        lanes.push([]);
      }
      // BFS paint the whole component so far.
      const stack = [contour.uid];
      while (stack.length) {
        const uid = stack.pop();
        if (laneOf.has(uid)) continue;
        laneOf.set(uid, lane);
        lanes[lane].push(uid);
        for (const neighbor of ensure(uid)) if (!laneOf.has(neighbor)) stack.push(neighbor);
      }
    }
  }

  // Within a lane, contours may fan out (division). Assign each frame slot in
  // the lane an offset lane to avoid vertical overlaps.
  const occupied = new Map(); // key frame|subSlot
  const positionOf = new Map();

  const laneFrames = lanes.map(() => new Map()); // lane -> frame -> [uids]
  for (const frame of frames) {
    for (const contour of frame.contours) {
      const lane = laneOf.get(contour.uid) ?? laneOf.size;
      if (!laneFrames[lane]) laneFrames[lane] = new Map();
      if (!laneFrames[lane].has(frame.frame)) laneFrames[lane].set(frame.frame, []);
      laneFrames[lane].get(frame.frame).push(contour.uid);
    }
  }

  // Assign each lane a horizontal band; within lane, multi-contour frames
  // receive sibling offsets.
  let cursorY = TOP_PAD;
  const laneTop = [];
  const laneHeights = [];
  laneFrames.forEach((byFrame) => {
    let maxRows = 1;
    for (const uids of byFrame.values()) maxRows = Math.max(maxRows, uids.length);
    const height = maxRows * (NODE_H + 14) + LANE_GAP_Y;
    laneTop.push(cursorY);
    laneHeights.push(height);
    cursorY += height;
  });

  const width = (frameIndex + 1) * (NODE_W + FRAME_GAP_X) + 40;
  const height = cursorY + 40;

  for (let lane = 0; lane < laneFrames.length; lane += 1) {
    for (const [frameNumber, uids] of laneFrames[lane].entries()) {
      const x = frameNumber * (NODE_W + FRAME_GAP_X) + 24;
      uids.sort().forEach((uid, index) => {
        const y = laneTop[lane] + 8 + index * (NODE_H + 14);
        positionOf.set(uid, { x, y, frame: frameNumber, lane, sibling: index });
      });
    }
  }
  // Any contours not assigned (shouldn't happen) get a default lane.
  for (const frame of frames) {
    for (const contour of frame.contours) {
      if (!positionOf.has(contour.uid)) {
        positionOf.set(contour.uid, {
          x: frame.frame * (NODE_W + FRAME_GAP_X) + 24,
          y: cursorY, frame: frame.frame, lane: laneFrames.length, sibling: 0,
        });
      }
    }
  }

  const occlusionMarks = occlusions.map((o) => {
    const anchor = positionOf.get(o.occl_uid);
    return anchor
      ? { ...o, x: anchor.x + NODE_W, y: anchor.y + NODE_H / 2, start: o.frame_start, end: o.frame_end }
      : null;
  }).filter(Boolean);

  return { positionOf, width, height, frameByNumber, laneOf, occlusionMarks };
}

export function edgePath(a, b) {
  const x1 = a.x + NODE_W;
  const y1 = a.y + NODE_H / 2;
  const x2 = b.x;
  const y2 = b.y + NODE_H / 2;
  const dx = Math.max(24, (x2 - x1) / 2);
  return `M ${x1} ${y1} C ${x1 + dx} ${y1}, ${x2 - dx} ${y2}, ${x2} ${y2}`;
}

// Invisible click target: identical shape plus a 2px bow so perfectly flat
// edges get a non-empty geometry bounding box (Playwright visibility check).
export function edgeHitPath(a, b) {
  const x1 = a.x + NODE_W;
  const y1 = a.y + NODE_H / 2;
  const x2 = b.x;
  const y2 = b.y + NODE_H / 2;
  const dx = Math.max(24, (x2 - x1) / 2);
  const midY = (y1 + y2) / 2 - 8;
  return `M ${x1} ${y1} C ${x1 + dx} ${midY}, ${x2 - dx} ${midY}, ${x2} ${y2}`;
}
