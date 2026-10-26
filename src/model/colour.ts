/** An sRGB colour with channels in 0..1. */
type Rgb = [number, number, number];

const clamp = (n: number) => Math.min(1, Math.max(0, n));

/** CSS named colours (CSS Color 4); `transparent` is handled as unreadable. */
const NAMED: Record<string, string> = {
  aliceblue: 'f0f8ff',
  antiquewhite: 'faebd7',
  aqua: '00ffff',
  aquamarine: '7fffd4',
  azure: 'f0ffff',
  beige: 'f5f5dc',
  bisque: 'ffe4c4',
  black: '000000',
  blanchedalmond: 'ffebcd',
  blue: '0000ff',
  blueviolet: '8a2be2',
  brown: 'a52a2a',
  burlywood: 'deb887',
  cadetblue: '5f9ea0',
  chartreuse: '7fff00',
  chocolate: 'd2691e',
  coral: 'ff7f50',
  cornflowerblue: '6495ed',
  cornsilk: 'fff8dc',
  crimson: 'dc143c',
  cyan: '00ffff',
  darkblue: '00008b',
  darkcyan: '008b8b',
  darkgoldenrod: 'b8860b',
  darkgray: 'a9a9a9',
  darkgreen: '006400',
  darkgrey: 'a9a9a9',
  darkkhaki: 'bdb76b',
  darkmagenta: '8b008b',
  darkolivegreen: '556b2f',
  darkorange: 'ff8c00',
  darkorchid: '9932cc',
  darkred: '8b0000',
  darksalmon: 'e9967a',
  darkseagreen: '8fbc8f',
  darkslateblue: '483d8b',
  darkslategray: '2f4f4f',
  darkslategrey: '2f4f4f',
  darkturquoise: '00ced1',
  darkviolet: '9400d3',
  deeppink: 'ff1493',
  deepskyblue: '00bfff',
  dimgray: '696969',
  dimgrey: '696969',
  dodgerblue: '1e90ff',
  firebrick: 'b22222',
  floralwhite: 'fffaf0',
  forestgreen: '228b22',
  fuchsia: 'ff00ff',
  gainsboro: 'dcdcdc',
  ghostwhite: 'f8f8ff',
  gold: 'ffd700',
  goldenrod: 'daa520',
  gray: '808080',
  green: '008000',
  greenyellow: 'adff2f',
  grey: '808080',
  honeydew: 'f0fff0',
  hotpink: 'ff69b4',
  indianred: 'cd5c5c',
  indigo: '4b0082',
  ivory: 'fffff0',
  khaki: 'f0e68c',
  lavender: 'e6e6fa',
  lavenderblush: 'fff0f5',
  lawngreen: '7cfc00',
  lemonchiffon: 'fffacd',
  lightblue: 'add8e6',
  lightcoral: 'f08080',
  lightcyan: 'e0ffff',
  lightgoldenrodyellow: 'fafad2',
  lightgray: 'd3d3d3',
  lightgreen: '90ee90',
  lightgrey: 'd3d3d3',
  lightpink: 'ffb6c1',
  lightsalmon: 'ffa07a',
  lightseagreen: '20b2aa',
  lightskyblue: '87cefa',
  lightslategray: '778899',
  lightslategrey: '778899',
  lightsteelblue: 'b0c4de',
  lightyellow: 'ffffe0',
  lime: '00ff00',
  limegreen: '32cd32',
  linen: 'faf0e6',
  magenta: 'ff00ff',
  maroon: '800000',
  mediumaquamarine: '66cdaa',
  mediumblue: '0000cd',
  mediumorchid: 'ba55d3',
  mediumpurple: '9370db',
  mediumseagreen: '3cb371',
  mediumslateblue: '7b68ee',
  mediumspringgreen: '00fa9a',
  mediumturquoise: '48d1cc',
  mediumvioletred: 'c71585',
  midnightblue: '191970',
  mintcream: 'f5fffa',
  mistyrose: 'ffe4e1',
  moccasin: 'ffe4b5',
  navajowhite: 'ffdead',
  navy: '000080',
  oldlace: 'fdf5e6',
  olive: '808000',
  olivedrab: '6b8e23',
  orange: 'ffa500',
  orangered: 'ff4500',
  orchid: 'da70d6',
  palegoldenrod: 'eee8aa',
  palegreen: '98fb98',
  paleturquoise: 'afeeee',
  palevioletred: 'db7093',
  papayawhip: 'ffefd5',
  peachpuff: 'ffdab9',
  peru: 'cd853f',
  pink: 'ffc0cb',
  plum: 'dda0dd',
  powderblue: 'b0e0e6',
  purple: '800080',
  rebeccapurple: '663399',
  red: 'ff0000',
  rosybrown: 'bc8f8f',
  royalblue: '4169e1',
  saddlebrown: '8b4513',
  salmon: 'fa8072',
  sandybrown: 'f4a460',
  seagreen: '2e8b57',
  seashell: 'fff5ee',
  sienna: 'a0522d',
  silver: 'c0c0c0',
  skyblue: '87ceeb',
  slateblue: '6a5acd',
  slategray: '708090',
  slategrey: '708090',
  snow: 'fffafa',
  springgreen: '00ff7f',
  steelblue: '4682b4',
  tan: 'd2b48c',
  teal: '008080',
  thistle: 'd8bfd8',
  tomato: 'ff6347',
  turquoise: '40e0d0',
  violet: 'ee82ee',
  wheat: 'f5deb3',
  white: 'ffffff',
  whitesmoke: 'f5f5f5',
  yellow: 'ffff00',
  yellowgreen: '9acd32',
};

function hexRgb(value: string): Rgb | null {
  const m = /^#([0-9a-f]{3,8})$/i.exec(value);
  if (!m) return null;
  const h = m[1];
  if (h.length !== 3 && h.length !== 4 && h.length !== 6 && h.length !== 8) return null;
  const full = h.length <= 4 ? [...h].map((c) => c + c).join('') : h;
  return [0, 2, 4].map((i) => parseInt(full.slice(i, i + 2), 16) / 255) as Rgb;
}

/** Arguments without a trailing alpha: both `rgb(1, 2, 3, .5)` and `rgb(1 2 3 / .5)` work. */
function args(body: string): string[] | null {
  const slash = body.indexOf('/');
  const main = (slash < 0 ? body : body.slice(0, slash)).trim();
  const parts = main.split(/[\s,]+/).filter(Boolean);
  if (slash < 0 && parts.length === 4) parts.pop();
  return parts.length === 3 ? parts : null;
}

function channel(value: string, scale: number): number | null {
  const n = parseFloat(value);
  if (!Number.isFinite(n)) return null;
  return clamp(value.endsWith('%') ? n / 100 : n / scale);
}

function rgbFn(value: string): Rgb | null {
  const m = /^rgba?\((.*)\)$/i.exec(value);
  const parts = m && args(m[1]);
  if (!parts) return null;
  const out = parts.map((p) => channel(p, 255));
  return out.every((n) => n !== null) ? (out as Rgb) : null;
}

function hue(value: string): number | null {
  const n = parseFloat(value);
  if (!Number.isFinite(n)) return null;
  if (/grad$/i.test(value)) return n * 0.9;
  if (/rad$/i.test(value)) return (n * 180) / Math.PI;
  if (/turn$/i.test(value)) return n * 360;
  return n;
}

function hslToRgb(h: number, s: number, l: number): Rgb {
  const k = (n: number) => (n + h / 30) % 12;
  const a = s * Math.min(l, 1 - l);
  const f = (n: number) => l - a * Math.max(-1, Math.min(k(n) - 3, Math.min(9 - k(n), 1)));
  return [f(0), f(8), f(4)];
}

function hslFn(value: string): Rgb | null {
  const m = /^hsla?\((.*)\)$/i.exec(value);
  const parts = m && args(m[1]);
  if (!parts) return null;
  const h = hue(parts[0]);
  const s = channel(parts[1], 100);
  const l = channel(parts[2], 100);
  return h === null || s === null || l === null ? null : hslToRgb(h, s, l);
}

function hwbFn(value: string): Rgb | null {
  const m = /^hwb\((.*)\)$/i.exec(value);
  const parts = m && args(m[1]);
  if (!parts) return null;
  const h = hue(parts[0]);
  const w = channel(parts[1], 100);
  const b = channel(parts[2], 100);
  if (h === null || w === null || b === null) return null;
  if (w + b >= 1) {
    const grey = w / (w + b);
    return [grey, grey, grey];
  }
  return hslToRgb(h, 1, 0.5).map((c) => c * (1 - w - b) + w) as Rgb;
}

function fraction(value: string, scale: number): number | null {
  const n = parseFloat(value);
  if (!Number.isFinite(n)) return null;
  return value.endsWith('%') ? (n / 100) * scale : n;
}

function linearToSrgb(v: number): number {
  const a = Math.abs(v);
  return a <= 0.0031308 ? 12.92 * v : Math.sign(v) * (1.055 * a ** (1 / 2.4) - 0.055);
}

function oklabToRgb(l: number, a: number, b: number): Rgb {
  const [x, y, z] = [
    l + 0.3963377774 * a + 0.2158037573 * b,
    l - 0.1055613458 * a - 0.0638541728 * b,
    l - 0.0894841775 * a - 1.291485548 * b,
  ].map((v) => v ** 3);
  return [
    4.0767416621 * x - 3.3077115913 * y + 0.2309699292 * z,
    -1.2684380046 * x + 2.6097574011 * y - 0.3413193965 * z,
    -0.0041960863 * x - 0.7034186147 * y + 1.707614701 * z,
  ].map((v) => clamp(linearToSrgb(v))) as Rgb;
}

function oklabFn(value: string): Rgb | null {
  const m = /^oklab\((.*)\)$/i.exec(value);
  const parts = m && args(m[1]);
  if (!parts) return null;
  const l = fraction(parts[0], 1);
  const a = fraction(parts[1], 0.4);
  const b = fraction(parts[2], 0.4);
  return l === null || a === null || b === null ? null : oklabToRgb(l, a, b);
}

function oklchFn(value: string): Rgb | null {
  const m = /^oklch\((.*)\)$/i.exec(value);
  const parts = m && args(m[1]);
  if (!parts) return null;
  const l = fraction(parts[0], 1);
  const c = fraction(parts[1], 0.4);
  const h = hue(parts[2]);
  if (l === null || c === null || h === null) return null;
  const rad = (h * Math.PI) / 180;
  return oklabToRgb(l, c * Math.cos(rad), c * Math.sin(rad));
}

function labToRgb(l: number, a: number, b: number): Rgb {
  const fy = (l + 16) / 116;
  const fx = fy + a / 500;
  const fz = fy - b / 200;
  const finv = (t: number) => (t > 6 / 29 ? t ** 3 : 3 * (6 / 29) ** 2 * (t - 4 / 29));
  // D50 white, then Bradford to D65 and into linear sRGB
  const x = 0.96422 * finv(fx);
  const y = finv(fy);
  const z = 0.82521 * finv(fz);
  const x65 = 0.955473421488075 * x - 0.02309845494876471 * y + 0.06325924320057072 * z;
  const y65 = -0.0283697093338637 * x + 1.0099953980813041 * y + 0.021041441191917323 * z;
  const z65 =
    0.012314014864481998 * x - 0.020507649298898964 * y + 1.330365926242124 * z;
  return [
    3.2409699419045226 * x65 - 1.537383177570094 * y65 - 0.4986107602930034 * z65,
    -0.9692436362808796 * x65 + 1.8759675015077202 * y65 + 0.04155505740717559 * z65,
    0.05563007969699366 * x65 - 0.20397695888897652 * y65 + 1.0569715142428786 * z65,
  ].map((v) => clamp(linearToSrgb(v))) as Rgb;
}

function labFn(value: string): Rgb | null {
  const m = /^lab\((.*)\)$/i.exec(value);
  const parts = m && args(m[1]);
  if (!parts) return null;
  const l = fraction(parts[0], 100);
  const a = fraction(parts[1], 125);
  const b = fraction(parts[2], 125);
  return l === null || a === null || b === null ? null : labToRgb(l, a, b);
}

function lchFn(value: string): Rgb | null {
  const m = /^lch\((.*)\)$/i.exec(value);
  const parts = m && args(m[1]);
  if (!parts) return null;
  const l = fraction(parts[0], 100);
  const c = fraction(parts[1], 125);
  const h = hue(parts[2]);
  if (l === null || c === null || h === null) return null;
  const rad = (h * Math.PI) / 180;
  return labToRgb(l, c * Math.cos(rad), c * Math.sin(rad));
}

/** `color(srgb …)`, the sRGB form browsers expose for wide-gamut computed colours. */
function colorFn(value: string): Rgb | null {
  const m = /^color\(\s*srgb\s+(.*)\)$/i.exec(value);
  const parts = m && args(m[1]);
  if (!parts) return null;
  const out = parts.map((p) => channel(p, 1));
  return out.every((n) => n !== null) ? (out as Rgb) : null;
}

function literal(value: string): Rgb | null {
  const v = value.trim().toLowerCase();
  const hex = hexRgb(v);
  if (hex) return hex;
  const named = NAMED[v];
  if (named) return hexRgb(`#${named}`);
  return rgbFn(v) ?? hslFn(v) ?? hwbFn(v) ?? oklabFn(v) ?? oklchFn(v) ?? labFn(v) ?? lchFn(v) ?? colorFn(v);
}

let canvas: CanvasRenderingContext2D | null | undefined;

/** A canvas serialises any colour it understands back to hex/rgba(), including wide-gamut ones. */
function canvasRgb(value: string): Rgb | null {
  if (typeof document === 'undefined') return null;
  if (canvas === undefined) canvas = document.createElement('canvas').getContext('2d');
  if (!canvas) return null;
  const sentinel = '#010203';
  canvas.fillStyle = sentinel;
  canvas.fillStyle = value;
  const out = String(canvas.fillStyle);
  if (out === sentinel && value.trim().toLowerCase() !== sentinel) return null;
  return hexRgb(out) ?? literal(out);
}

/** Asks the browser to resolve anything the pure parsers don't know (var(), oklch(), color-mix(), system colours). */
function browserRgb(value: string): Rgb | null {
  if (typeof document === 'undefined' || typeof getComputedStyle !== 'function') return null;
  const root = document.body ?? document.documentElement;
  if (!root) return null;
  const el = document.createElement('span');
  el.style.color = value;
  if (!el.style.color) return null;
  root.appendChild(el);
  try {
    const computed = getComputedStyle(el).color;
    return literal(computed) ?? canvasRgb(computed);
  } finally {
    el.remove();
  }
}

function parseColour(value: string): Rgb | null {
  const v = value.trim().toLowerCase();
  if (!v || v === 'transparent') return null;
  return literal(v) ?? browserRgb(v) ?? canvasRgb(v);
}

/** Perceived lightness (0..1) of any readable CSS colour; null when it can't be resolved. */
export function colourLightness(colour: string): number | null {
  const rgb = parseColour(colour);
  if (!rgb) return null;
  const [r, g, b] = rgb;
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}
