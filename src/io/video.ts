import { prepareMath, stripMath } from '../model/latex';
import { cameraAt, cameraRect, entryAt, overviewShot, presentationSteps, stepCaption, stepShot, timeline } from '../model/presentation';
import type { CircuitDoc } from '../model/types';
import { EXPORT_THEMES, exportSvg } from './export';

export interface VideoOptions {
  width: number;
  height: number;
  fps: number;
  theme: 'light' | 'dark';
  /** Burn each step's note / frame title in as a caption. */
  captions: boolean;
  onProgress?: (done: number) => void;
  signal?: AbortSignal;
}

export interface Video {
  blob: Blob;
  ext: 'mp4' | 'webm';
}

export const videoSupported = () => typeof VideoEncoder !== 'undefined';

/**
 * Renders the presentation timeline to a video: the camera glides exactly as
 * in Present mode (frames themselves are not drawn). Encoding uses WebCodecs,
 * so it runs faster than real time and never drops frames.
 */
export async function renderVideo(doc: CircuitDoc, opts: VideoOptions): Promise<Video> {
  if (!videoSupported()) throw new Error('Video export needs a browser with WebCodecs (Chrome, Edge or a recent Safari / Firefox).');
  const mb = await import('mediabunny');
  const { width: W, height: H, fps } = opts;
  await prepareMath(doc);

  const steps = presentationSteps(doc);
  const { entries, total } = timeline(doc, steps);
  const shots = steps.map((s) => stepShot(doc, s));
  const overview = overviewShot(doc);
  const palette = EXPORT_THEMES[opts.theme];

  // the whole scene once; each video frame only swaps the viewBox
  const { svg } = exportSvg(doc, { theme: opts.theme, background: false, padding: 0 });
  const open = /<svg [^>]*>/.exec(svg)!;
  const head = svg.slice(0, open.index);
  const body = svg.slice(open.index + open[0].length);

  // pick a codec the browser can actually encode
  let codec: 'avc' | 'vp9' | 'vp8' | null = null;
  for (const c of ['avc', 'vp9', 'vp8'] as const) {
    if (await mb.canEncodeVideo(c, { width: W, height: H })) {
      codec = c;
      break;
    }
  }
  if (!codec) throw new Error(`This browser cannot encode ${W}×${H} video. Try a smaller size.`);
  const ext = codec === 'avc' ? 'mp4' : 'webm';

  const canvas = document.createElement('canvas');
  canvas.width = W;
  canvas.height = H;
  const ctx = canvas.getContext('2d')!;
  const base = document.createElement('canvas');
  base.width = W;
  base.height = H;
  const bctx = base.getContext('2d')!;

  const output = new mb.Output({ format: ext === 'mp4' ? new mb.Mp4OutputFormat({ fastStart: 'in-memory' }) : new mb.WebMOutputFormat(), target: new mb.BufferTarget() });
  const source = new mb.CanvasSource(canvas, { codec, bitrate: mb.QUALITY_HIGH, keyFrameInterval: 2 });
  output.addVideoTrack(source, { frameRate: fps });
  await output.start();

  const frames = Math.max(1, Math.ceil(total * fps) + 1);
  let lastKey = '';
  try {
    for (let f = 0; f < frames; f++) {
      if (opts.signal?.aborted) throw new DOMException('Cancelled', 'AbortError');
      const t = Math.min(total, f / fps);
      const cam = cameraAt(entries, shots, overview, t, W, H);
      const r = cameraRect(cam, W, H);
      const key = `${r.x.toFixed(3)},${r.y.toFixed(3)},${r.w.toFixed(3)}`;
      // holds re-use the last render
      if (key !== lastKey) {
        lastKey = key;
        const frameSvg = `${head}<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="${r.x} ${r.y} ${r.w} ${r.h}" preserveAspectRatio="xMidYMid meet">${body}`;
        const img = await loadSvg(frameSvg);
        bctx.fillStyle = palette.bg;
        bctx.fillRect(0, 0, W, H);
        bctx.drawImage(img, 0, 0, W, H);
      }
      ctx.drawImage(base, 0, 0);
      if (opts.captions && entries.length) {
        const { index, k } = entryAt(entries, t);
        const s = steps[index];
        const text = s ? stripMath(stepCaption(s)) : '';
        if (text) drawCaption(ctx, W, H, s.step ?? index + 1, text, s.stroke, opts.theme, Math.min(1, k * 1.6));
      }
      await source.add(f / fps, 1 / fps);
      opts.onProgress?.((f + 1) / frames);
    }
    await output.finalize();
  } catch (e) {
    await output.cancel().catch(() => undefined);
    throw e;
  }
  const buf = (output.target as InstanceType<typeof mb.BufferTarget>).buffer!;
  return { blob: new Blob([buf], { type: ext === 'mp4' ? 'video/mp4' : 'video/webm' }), ext };
}

async function loadSvg(svg: string): Promise<HTMLImageElement> {
  const url = URL.createObjectURL(new Blob([svg], { type: 'image/svg+xml' }));
  try {
    const img = new Image();
    img.src = url;
    await img.decode();
    return img;
  } finally {
    URL.revokeObjectURL(url);
  }
}

/** Caption card at the bottom: step badge and the first lines of the note. */
function drawCaption(ctx: CanvasRenderingContext2D, W: number, H: number, n: number, text: string, color: string, theme: 'light' | 'dark', alpha: number) {
  if (alpha <= 0) return;
  const u = H / 1080;
  const fs = 34 * u;
  const lines = text.split('\n').slice(0, 3);
  ctx.save();
  ctx.globalAlpha = alpha;
  ctx.font = `500 ${fs}px Inter, 'Segoe UI', system-ui, sans-serif`;
  const tw = Math.min(W * 0.8, Math.max(...lines.map((l) => ctx.measureText(l).width)));
  const badge = 26 * u;
  const padX = 28 * u;
  const lh = fs * 1.3;
  const w = padX * 2 + badge * 2 + 18 * u + tw;
  const h = Math.max(badge * 2, lines.length * lh) + 30 * u;
  const x = (W - w) / 2;
  const y = H - h - 40 * u;
  const accent = color === '#000000' ? (theme === 'dark' ? '#e6dfcf' : '#1d1a14') : color;
  ctx.fillStyle = theme === 'dark' ? 'rgba(26,25,21,0.92)' : 'rgba(255,253,248,0.94)';
  ctx.shadowColor = 'rgba(0,0,0,0.25)';
  ctx.shadowBlur = 30 * u;
  ctx.beginPath();
  ctx.roundRect(x, y, w, h, 22 * u);
  ctx.fill();
  ctx.shadowBlur = 0;
  ctx.fillStyle = accent;
  ctx.beginPath();
  ctx.arc(x + padX + badge, y + h / 2, badge, 0, Math.PI * 2);
  ctx.fill();
  ctx.fillStyle = color === '#000000' && theme === 'dark' ? '#1a1915' : '#fff';
  ctx.font = `800 ${fs * 0.8}px Inter, 'Segoe UI', system-ui, sans-serif`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(String(n), x + padX + badge, y + h / 2 + u);
  ctx.textAlign = 'left';
  ctx.font = `500 ${fs}px Inter, 'Segoe UI', system-ui, sans-serif`;
  ctx.fillStyle = theme === 'dark' ? '#f4efe4' : '#1d1a14';
  const tx = x + padX + badge * 2 + 18 * u;
  const ty = y + h / 2 - ((lines.length - 1) * lh) / 2;
  lines.forEach((l, i) => ctx.fillText(l, tx, ty + i * lh, tw));
  ctx.restore();
}
