/**
 * LaTeX maths in text: `$…$` inline, `$$…$$` display style, `\$` for a literal dollar.
 * Formulas are typeset by MathJax into plain SVG paths, so they look the same on the
 * canvas and in every export. MathJax is loaded on first use; until then (and in
 * places that cannot wait) text falls back to showing the source.
 */

export interface MathSvg {
  /** Inner markup of the formula's <svg> (paths only, no fonts needed). */
  body: string;
  viewBox: string;
  /** Size in ex units, and how far the baseline sits above the bottom edge. */
  wEx: number;
  hEx: number;
  depthEx: number;
  error: boolean;
}

export type Run = { math: false; text: string } | { math: true; tex: string; display: boolean };

const MATH_RE = /(?<!\\)\$\$([\s\S]+?)(?<!\\)\$\$|(?<!\\)\$((?:\\\$|[^$])+?)(?<!\\)\$/g;

/** True when the text contains at least one formula. */
export const hasMath = (text: string) => text.includes('$') && new RegExp(MATH_RE.source).test(text);

/** Splits one line of text into plain and maths runs. */
export function splitMath(line: string): Run[] {
  const out: Run[] = [];
  let last = 0;
  const unescape = (s: string) => s.replace(/\\\$/g, '$');
  for (const m of line.matchAll(new RegExp(MATH_RE.source, 'g'))) {
    if (m.index! > last) out.push({ math: false, text: unescape(line.slice(last, m.index)) });
    const display = m[1] !== undefined;
    out.push({ math: true, tex: (display ? m[1] : m[2]).trim(), display });
    last = m.index! + m[0].length;
  }
  if (last < line.length) out.push({ math: false, text: unescape(line.slice(last)) });
  return out;
}

/** Plain-text version of a string with maths (for exports that cannot draw formulas, e.g. DXF, CSV). */
export const stripMath = (text: string) => splitMath(text).map((r) => (r.math ? r.tex : r.text)).join('');

type Convert = (tex: string, display: boolean) => MathSvg;
let convert: Convert | null = null;
let loading: Promise<void> | null = null;
const cache = new Map<string, MathSvg>();
const listeners = new Set<() => void>();
let version = 0;

export const mathVersion = () => version;
export function onMathReady(fn: () => void) {
  listeners.add(fn);
  return () => void listeners.delete(fn);
}

/** Loads MathJax (once). Resolves when formulas can be typeset synchronously. */
export function loadMath(): Promise<void> {
  if (convert) return Promise.resolve();
  loading ??= (async () => {
    const [{ mathjax }, { TeX }, { SVG }, { liteAdaptor }, { RegisterHTMLHandler }, { AllPackages }] = await Promise.all([
      import('mathjax-full/js/mathjax.js'),
      import('mathjax-full/js/input/tex.js'),
      import('mathjax-full/js/output/svg.js'),
      import('mathjax-full/js/adaptors/liteAdaptor.js'),
      import('mathjax-full/js/handlers/html.js'),
      import('mathjax-full/js/input/tex/AllPackages.js'),
    ]);
    const adaptor = liteAdaptor();
    RegisterHTMLHandler(adaptor);
    const packages = AllPackages.filter((p: string) => p !== 'bussproofs' && p !== 'autoload' && p !== 'require');
    const doc = mathjax.document('', { InputJax: new TeX({ packages }), OutputJax: new SVG({ fontCache: 'none' }) });
    convert = (tex, display) => {
      const node = doc.convert(tex, { display, em: 16, ex: 8, containerWidth: 80 * 16 });
      const svg = adaptor.firstChild(node) as Parameters<typeof adaptor.innerHTML>[0];
      const num = (v: string | null | undefined) => parseFloat(v ?? '0') || 0;
      const style = adaptor.getAttribute(svg, 'style') ?? '';
      const valign = /vertical-align:\s*(-?[\d.]+)ex/.exec(style);
      const body = adaptor.innerHTML(svg);
      return {
        body,
        viewBox: adaptor.getAttribute(svg, 'viewBox') ?? '0 0 0 0',
        wEx: num(adaptor.getAttribute(svg, 'width')),
        hEx: num(adaptor.getAttribute(svg, 'height')),
        depthEx: valign ? -parseFloat(valign[1]) : 0,
        error: body.includes('data-mjx-error') || body.includes('merror'),
      };
    };
    version++;
    listeners.forEach((fn) => fn());
  })().catch((e) => {
    loading = null;
    throw e;
  });
  return loading;
}

/** Typeset formula, or null while MathJax is still loading (loading starts automatically). */
export function texToSvg(tex: string, display = false): MathSvg | null {
  if (!convert) {
    void loadMath().catch(() => undefined);
    return null;
  }
  const key = `${display ? 'D' : 'I'}:${tex}`;
  let hit = cache.get(key);
  if (!hit) {
    try {
      hit = convert(tex, display);
    } catch {
      hit = { body: '', viewBox: '0 0 0 0', wEx: 0, hEx: 0, depthEx: 0, error: true };
    }
    cache.set(key, hit);
  }
  return hit;
}

/** Canvas units per ex at a given font size (MathJax's TeX fonts have an x-height of about 0.442 em). */
export const exPx = (fontSize: number) => fontSize * 0.442;

/** Every piece of text in a circuit that can hold maths. */
function* docTexts(doc: { items: Record<string, { type: string; text?: string; label?: string; value?: string; ref?: string }> }) {
  for (const it of Object.values(doc.items)) {
    if (it.text) yield it.text;
    if (it.label) yield it.label;
    if (it.value) yield it.value;
    if (it.ref) yield it.ref;
  }
}

/** Loads MathJax if the circuit uses maths, so a synchronous render (export, print) can typeset it. */
export async function prepareMath(doc: Parameters<typeof docTexts>[0]): Promise<void> {
  for (const t of docTexts(doc)) if (hasMath(t)) return loadMath();
}
