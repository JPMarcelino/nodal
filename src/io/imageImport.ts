import { makeShape } from '../model/doc';
import { snap } from '../model/geometry';
import type { CircuitDoc, Point } from '../model/types';
import { S, mutate } from '../store/store';

/** Pixels on the longest side an imported picture is stored at (keeps files and autosave small). */
const MAX_PIXELS = 1600;
/** Longest side, in canvas units, a picture is placed at. */
const MAX_DISPLAY = 600;
/** Pages of a PDF that are imported. */
const MAX_PDF_PAGES = 20;

export interface Picture {
  src: string;
  /** Natural display size (canvas units). */
  w: number;
  h: number;
}

export const isPdf = (f: File) => f.type === 'application/pdf' || /\.pdf$/i.test(f.name);
export const isRaster = (f: File) => (/^image\//.test(f.type) && f.type !== 'image/svg+xml') || /\.(png|jpe?g|gif|webp|bmp|avif)$/i.test(f.name);

const readDataUrl = (blob: Blob) =>
  new Promise<string>((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(r.result as string);
    r.onerror = () => reject(r.error ?? new Error('Could not read the file'));
    r.readAsDataURL(blob);
  });

const loadImage = (src: string) =>
  new Promise<HTMLImageElement>((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error('The image could not be decoded'));
    img.src = src;
  });

/** PNG keeps transparency and crisp line art; big results fall back to JPEG on white. */
function encode(canvas: HTMLCanvasElement): string {
  const png = canvas.toDataURL('image/png');
  if (png.length < 2_000_000) return png;
  const flat = document.createElement('canvas');
  flat.width = canvas.width;
  flat.height = canvas.height;
  const ctx = flat.getContext('2d')!;
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, flat.width, flat.height);
  ctx.drawImage(canvas, 0, 0);
  return flat.toDataURL('image/jpeg', 0.88);
}

const displaySize = (w: number, h: number) => {
  const k = Math.min(1, MAX_DISPLAY / Math.max(w, h));
  return { w: Math.round(w * k), h: Math.round(h * k) };
};

/** Reads a PNG / JPEG / GIF / WebP…, downscaling very large ones. */
export async function rasterToPicture(file: Blob): Promise<Picture> {
  const original = await readDataUrl(file);
  const img = await loadImage(original);
  const iw = img.naturalWidth;
  const ih = img.naturalHeight;
  if (!iw || !ih) throw new Error('The image is empty');
  const k = Math.min(1, MAX_PIXELS / Math.max(iw, ih));
  // small PNGs / JPEGs are stored untouched
  if (k === 1 && /^data:image\/(png|jpeg);/.test(original) && original.length < 2_000_000) return { src: original, ...displaySize(iw, ih) };
  const c = document.createElement('canvas');
  c.width = Math.max(1, Math.round(iw * k));
  c.height = Math.max(1, Math.round(ih * k));
  c.getContext('2d')!.drawImage(img, 0, 0, c.width, c.height);
  return { src: encode(c), ...displaySize(iw, ih) };
}

/** Renders each page of a PDF to a picture (pdf.js is loaded on first use). */
export async function pdfToPictures(file: Blob): Promise<{ pages: Picture[]; total: number }> {
  const pdfjs = await import('pdfjs-dist');
  const { default: workerSrc } = await import('pdfjs-dist/build/pdf.worker.min.mjs?url');
  pdfjs.GlobalWorkerOptions.workerSrc = workerSrc;
  const pdf = await pdfjs.getDocument({ data: new Uint8Array(await file.arrayBuffer()) }).promise;
  try {
    const pages: Picture[] = [];
    for (let n = 1; n <= Math.min(pdf.numPages, MAX_PDF_PAGES); n++) {
      const page = await pdf.getPage(n);
      const base = page.getViewport({ scale: 1 });
      const viewport = page.getViewport({ scale: MAX_PIXELS / Math.max(base.width, base.height) });
      const c = document.createElement('canvas');
      c.width = Math.round(viewport.width);
      c.height = Math.round(viewport.height);
      const ctx = c.getContext('2d')!;
      ctx.fillStyle = '#ffffff';
      ctx.fillRect(0, 0, c.width, c.height);
      await page.render({ canvasContext: ctx, viewport }).promise;
      pages.push({ src: encode(c), ...displaySize(base.width, base.height) });
      page.cleanup();
    }
    return { pages, total: pdf.numPages };
  } finally {
    void pdf.destroy();
  }
}

/** Adds pictures as image shapes, stacked top to bottom and centred on `at`, in one undo step. */
export function insertPictures(pictures: Picture[], at: Point): string[] {
  const g = S().doc.settings.grid;
  const gap = g * 2;
  const totalH = pictures.reduce((h, p) => h + p.h, 0) + gap * (pictures.length - 1);
  const maxW = Math.max(...pictures.map((p) => p.w));
  let y = snap(at.y - totalH / 2, g);
  const x = snap(at.x - maxW / 2, g);
  const ids: string[] = [];
  mutate((d) => {
    for (const p of pictures) {
      const s = makeShape(d as CircuitDoc, 'image', x, y, p.w, p.h);
      s.src = p.src;
      s.group = S().scope;
      d.items[s.id] = s;
      ids.push(s.id);
      y += p.h + gap;
    }
  }, ids);
  return ids;
}
