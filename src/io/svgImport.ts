import type { Prim } from '../model/types';

const r20 = (v: number) => Math.max(20, Math.round(v / 20) * 20);

/**
 * Converts SVG markup into symbol outlines scaled to fit a `size` px box
 * (grid-aligned). Needs a live DOM so transforms and path lengths resolve.
 */
export function svgToPrims(text: string, size = 80): { prims: Prim[]; w: number; h: number } {
  const doc = new DOMParser().parseFromString(text, 'image/svg+xml');
  const svg = doc.querySelector('svg');
  if (!svg) throw new Error('No <svg> element found');
  const host = document.createElement('div');
  host.style.cssText = 'position:absolute;visibility:hidden;left:-9999px';
  host.appendChild(document.importNode(svg, true));
  document.body.appendChild(host);
  try {
    const live = host.querySelector('svg')!;
    const els = [...live.querySelectorAll('path,line,polyline,polygon,rect,circle,ellipse')] as SVGGeometryElement[];
    if (!els.length) throw new Error('The SVG has no drawable shapes');
    const runs: { pts: number[]; filled: boolean }[] = [];
    for (const el of els) {
      const len = el.getTotalLength();
      if (!len) continue;
      const m = el.getCTM();
      const steps = Math.min(400, Math.max(8, Math.ceil(len / 2)));
      const pts: number[] = [];
      for (let i = 0; i <= steps; i++) {
        let p = el.getPointAtLength((len * i) / steps);
        if (m) p = p.matrixTransform(m);
        pts.push(p.x, p.y);
      }
      const fill = getComputedStyle(el).fill;
      const filled = !!fill && fill !== 'none' && !fill.includes('rgba(0, 0, 0, 0)');
      runs.push({ pts, filled });
    }
    if (!runs.length) throw new Error('The SVG has no drawable shapes');
    const xs = runs.flatMap((r) => r.pts.filter((_, i) => i % 2 === 0));
    const ys = runs.flatMap((r) => r.pts.filter((_, i) => i % 2 === 1));
    const minX = Math.min(...xs);
    const minY = Math.min(...ys);
    const bw = Math.max(...xs) - minX || 1;
    const bh = Math.max(...ys) - minY || 1;
    const k = (size - 20) / Math.max(bw, bh);
    const w = r20(bw * k + 20);
    const h = r20(bh * k + 20);
    const ox = (w - bw * k) / 2;
    const oy = (h - bh * k) / 2;
    const prims: Prim[] = runs.map((r) => {
      const pts = simplifyPts(r.pts.map((v, i) => +(i % 2 === 0 ? (v - minX) * k + ox : (v - minY) * k + oy).toFixed(1)));
      return r.filled ? { t: 'poly', pts, fill: 'solid' } : { t: 'line', pts };
    });
    return { prims, w, h };
  } finally {
    host.remove();
  }
}

function simplifyPts(pts: number[]): number[] {
  // drop nearly collinear points to keep the symbol light
  const out: number[] = [pts[0], pts[1]];
  for (let i = 2; i < pts.length - 2; i += 2) {
    const ax = out[out.length - 2],
      ay = out[out.length - 1];
    const bx = pts[i],
      by = pts[i + 1];
    const cx = pts[i + 2],
      cy = pts[i + 3];
    const cross = Math.abs((bx - ax) * (cy - ay) - (by - ay) * (cx - ax));
    if (cross > 0.6) out.push(bx, by);
  }
  out.push(pts[pts.length - 2], pts[pts.length - 1]);
  return out;
}
