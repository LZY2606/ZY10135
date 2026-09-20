import type { Contour, Edge, GraphData, Occlusion } from '../shared/types.ts';

export interface RenderOptions {
  selectedContourId: string | null;
  linkSourceId: string | null;
  affectedContourIds?: Set<string>;
}

const COLORS: Record<Edge['kind'], string> = {
  continuation: '#37c26b',
  division: '#c77dff',
  merge: '#ff9d5c',
};

/**
 * Draw the lineage DAG: one column per frame, contours laid out on rows by
 * track proximity. Edges connect contour centers across frame columns.
 */
export function renderLineage(
  svg: SVGSVGElement,
  contours: Contour[],
  graph: GraphData,
  frames: number,
  options: RenderOptions,
  onSelect: (id: string) => void,
): { colW: number; rowH: number; positions: Map<string, { x: number; y: number }> } {
  const colW = 150;
  const rowH = 74;
  const padX = 46;
  const padY = 30;

  // Assign a row per contour: order within frame by cx so tracks stay stable.
  const perFrame = new Map<number, Contour[]>();
  for (const c of contours) {
    const list = perFrame.get(c.frame) ?? [];
    list.push(c);
    perFrame.set(c.frame, list);
  }
  const positions = new Map<string, { x: number; y: number }>();
  let maxRows = 1;
  for (let f = 0; f < frames; f++) {
    const list = (perFrame.get(f) ?? []).slice().sort((a, b) => a.cy - b.cy || a.cx - b.cx);
    maxRows = Math.max(maxRows, list.length);
    list.forEach((c, i) => {
      positions.set(c.id, { x: padX + f * colW, y: padY + i * rowH });
    });
  }

  const width = padX * 2 + frames * colW;
  const height = padY * 2 + Math.max(maxRows, 4) * rowH;
  svg.setAttribute('viewBox', `0 0 ${width} ${height}`);
  svg.innerHTML = '';

  const NS = 'http://www.w3.org/2000/svg';
  const el = <K extends keyof SVGElementTagNameMap>(tag: K, attrs: Record<string, string>) => {
    const node = document.createElementNS(NS, tag);
    for (const [k, v] of Object.entries(attrs)) node.setAttribute(k, v);
    return node;
  };

  // frame columns
  for (let f = 0; f < frames; f++) {
    const x = padX + f * colW - colW / 2 + 20;
    svg.appendChild(
      el('rect', {
        x: String(x),
        y: '0',
        width: String(colW - 12),
        height: String(height),
        rx: '8',
        fill: f % 2 ? '#111827' : '#0e1424',
      }),
    );
    const label = el('text', {
      x: String(padX + f * colW),
      y: '16',
      fill: '#93a0bd',
      'font-size': '11',
      'text-anchor': 'middle',
    });
    label.textContent = `帧 ${f}`;
    svg.appendChild(label);
  }

  const byId = new Map(contours.map((c) => [c.id, c]));

  // occlusions: dashed cyan bridges
  for (const occlusion of graph.occlusions) {
    const a = positions.get(occlusion.enterContourId);
    const b = positions.get(occlusion.exitContourId);
    if (!a || !b) continue;
    const line = el('line', {
      x1: String(a.x),
      y1: String(a.y),
      x2: String(b.x),
      y2: String(b.y),
      stroke: '#4dd0e1',
      'stroke-width': '2',
      'stroke-dasharray': '6 5',
      opacity: '.9',
    });
    svg.appendChild(line);
  }

  // edges
  for (const edge of graph.edges) {
    const a = positions.get(edge.fromId);
    const b = positions.get(edge.toId);
    if (!a || !b) continue;
    const path = el('path', {
      d: `M ${a.x} ${a.y} C ${a.x + (b.x - a.x) * 0.55} ${a.y}, ${a.x + (b.x - a.x) * 0.45} ${b.y}, ${b.x} ${b.y}`,
      fill: 'none',
      stroke: COLORS[edge.kind],
      'stroke-width': edge.kind === 'continuation' ? '2.4' : '3',
      'data-edge-id': edge.id,
      opacity: '.95',
    });
    const title = el('title', {});
    title.textContent = `${edge.kind}: ${byId.get(edge.fromId)?.externalId} -> ${byId.get(edge.toId)?.externalId}`;
    path.appendChild(title);
    svg.appendChild(path);
  }

  // contours as nodes
  for (const contour of contours) {
    const p = positions.get(contour.id);
    if (!p) continue;
    const isSelected = options.selectedContourId === contour.id;
    const isSource = options.linkSourceId === contour.id;
    const isAffected = options.affectedContourIds?.has(contour.id);
    const g = el('g', {
      transform: `translate(${p.x},${p.y})`,
      style: 'cursor:pointer',
      'data-contour-id': contour.id,
    });
    g.appendChild(
      el('circle', {
        r: isSource ? '11' : '9',
        fill: isSelected ? '#5b8cff' : '#1e2740',
        stroke: isAffected ? '#f2b134' : isSource ? '#f2b134' : '#7c8db5',
        'stroke-width': isSelected || isSource || isAffected ? '2.5' : '1.4',
      }),
    );
    const text = el('text', {
      x: '0',
      y: '-15',
      fill: '#c6d1e8',
      'font-size': '10',
      'text-anchor': 'middle',
    });
    text.textContent = contour.externalId;
    g.appendChild(text);
    g.addEventListener('click', () => onSelect(contour.id));
    svg.appendChild(g);
  }

  return { colW, rowH, positions };
}

/** Draw selected contours' simplified polygon boundaries onto a 2D canvas. */
export function renderContourPreview(
  canvas: HTMLCanvasElement,
  contours: Contour[],
  graph: GraphData,
  focusIds: Set<string>,
): void {
  const ctx2d = canvas.getContext('2d');
  if (!ctx2d) return;
  const w = (canvas.width = canvas.clientWidth * 2);
  const h = (canvas.height = 260 * 2);
  ctx2d.clearRect(0, 0, w, h);

  const minX = Math.min(...contours.map((c) => c.cx)) - 60;
  const minY = Math.min(...contours.map((c) => c.cy)) - 60;
  const maxX = Math.max(...contours.map((c) => c.cx)) + 60;
  const maxY = Math.max(...contours.map((c) => c.cy)) + 60;
  const scale = Math.min(w / (maxX - minX), h / (maxY - minY));
  const tx = (x: number) => (x - minX) * scale;
  const ty = (y: number) => (y - minY) * scale;

  // neighboring edges among displayed contours
  const ids = new Set(contours.map((c) => c.id));
  for (const edge of graph.edges) {
    if (!ids.has(edge.fromId) || !ids.has(edge.toId)) continue;
    const a = contours.find((c) => c.id === edge.fromId)!;
    const b = contours.find((c) => c.id === edge.toId)!;
    ctx2d.beginPath();
    ctx2d.moveTo(tx(a.cx), ty(a.cy));
    ctx2d.lineTo(tx(b.cx), ty(b.cy));
    ctx2d.strokeStyle = COLORS[edge.kind];
    ctx2d.globalAlpha = 0.5;
    ctx2d.lineWidth = 2;
    ctx2d.stroke();
    ctx2d.globalAlpha = 1;
  }

  for (const contour of contours) {
    const focus = focusIds.has(contour.id);
    ctx2d.beginPath();
    contour.boundary.forEach(([x, y], i) => {
      if (i === 0) ctx2d.moveTo(tx(x), ty(y));
      else ctx2d.lineTo(tx(x), ty(y));
    });
    ctx2d.closePath();
    ctx2d.fillStyle = focus ? 'rgba(91,140,255,.32)' : 'rgba(120,145,200,.12)';
    ctx2d.fill();
    ctx2d.strokeStyle = focus ? '#5b8cff' : '#5c6c92';
    ctx2d.lineWidth = focus ? 2.4 : 1.2;
    ctx2d.stroke();
    ctx2d.fillStyle = focus ? '#dbe6ff' : '#8392b4';
    ctx2d.font = `${18}px sans-serif`;
    ctx2d.fillText(`${contour.externalId} f${contour.frame}`, tx(contour.cx) - 8, ty(contour.cy) - 22);
  }
}

export function occlusionLabel(o: Occlusion, contours: Contour[]): string {
  const enter = contours.find((c) => c.id === o.enterContourId)?.externalId ?? o.enterContourId;
  const exit = contours.find((c) => c.id === o.exitContourId)?.externalId ?? o.exitContourId;
  const len = o.gapEndFrame - o.gapStartFrame + 1;
  return `${enter} →（遮挡 ${len} 帧 f${o.gapStartFrame}-${o.gapEndFrame}）→ ${exit}`;
}
