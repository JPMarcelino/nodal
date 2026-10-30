/**
 * A Word-style equation editor ("math zone"): the equation is a tree that is built
 * up as you type, and is written out as LaTeX for the text it lives in.
 *
 * - `\name` then Space (or any non-letter) is replaced by its symbol or structure
 *   (`\Omega` → Ω, `\sqrt` → √□, `\sum` → ∑); unknown names stay as they are.
 * - `_` starts a subscript and `^` a superscript; Space leaves it. `/` makes the
 *   operand before it the numerator of a fraction; `(`…`)` are stretchy brackets.
 * - `sin`, `log`, `lim`… become upright function names when followed by Space.
 * - `<=` → ≤, `>=` → ≥, `!=` → ≠, `->` → →, `+-` → ± and so on.
 * The tree is plain data (rows of nodes) so it can be snapshotted for undo.
 */

export type SymCls = 'var' | 'num' | 'ord' | 'bin' | 'rel' | 'punct' | 'open' | 'close' | 'large' | 'fn' | 'cmd' | 'raw';
export type Row = MNode[];
export type MNode =
  | { t: 'sym'; v: string; tex: string; cls: SymCls }
  | { t: 'frac'; num: Row; den: Row }
  | { t: 'sqrt'; idx: Row | null; body: Row }
  | { t: 'scripts'; sub: Row | null; sup: Row | null }
  | { t: 'delim'; l: string; r: string; body: Row }
  | { t: 'accent'; acc: string; body: Row }
  | { t: 'mat'; cols: number; cells: Row[] };

/* ------------------------------------------------------------------ */
/* Symbols                                                             */
/* ------------------------------------------------------------------ */

export interface SymDef {
  v: string;
  tex: string;
  cls: SymCls;
}

const greek = 'alpha α beta β gamma γ delta δ epsilon ϵ varepsilon ε zeta ζ eta η theta θ vartheta ϑ iota ι kappa κ lambda λ mu μ nu ν xi ξ omicron ο pi π varpi ϖ rho ρ varrho ϱ sigma σ varsigma ς tau τ upsilon υ phi ϕ varphi φ chi χ psi ψ omega ω';
const Greek = 'Gamma Γ Delta Δ Theta Θ Lambda Λ Xi Ξ Pi Π Sigma Σ Upsilon Υ Phi Φ Psi Ψ Omega Ω';
// capitals that look like Latin letters (Word has \Alpha…; LaTeX does not)
const GreekLatin = 'Alpha Α A Beta Β B Epsilon Ε E Zeta Ζ Z Eta Η H Iota Ι I Kappa Κ K Mu Μ M Nu Ν N Omicron Ο O Rho Ρ P Tau Τ T Chi Χ X';

/** name → [char, tex, class]; tex defaults to `\name`. */
const SYM_TABLE: Record<string, [string, string | null, SymCls]> = {
  // binary operators
  pm: ['±', null, 'bin'], mp: ['∓', null, 'bin'], times: ['×', null, 'bin'], div: ['÷', null, 'bin'], cdot: ['⋅', null, 'bin'],
  ast: ['∗', null, 'bin'], star: ['⋆', null, 'bin'], circ: ['∘', null, 'bin'], bullet: ['∙', null, 'bin'], oplus: ['⊕', null, 'bin'],
  ominus: ['⊖', null, 'bin'], otimes: ['⊗', null, 'bin'], odot: ['⊙', null, 'bin'], cap: ['∩', null, 'bin'], cup: ['∪', null, 'bin'],
  wedge: ['∧', null, 'bin'], land: ['∧', '\\wedge', 'bin'], vee: ['∨', null, 'bin'], lor: ['∨', '\\vee', 'bin'], setminus: ['∖', null, 'bin'],
  // relations
  le: ['≤', null, 'rel'], leq: ['≤', null, 'rel'], ge: ['≥', null, 'rel'], geq: ['≥', null, 'rel'], ne: ['≠', null, 'rel'], neq: ['≠', null, 'rel'],
  approx: ['≈', null, 'rel'], equiv: ['≡', null, 'rel'], sim: ['∼', null, 'rel'], simeq: ['≃', null, 'rel'], cong: ['≅', null, 'rel'],
  propto: ['∝', null, 'rel'], ll: ['≪', null, 'rel'], gg: ['≫', null, 'rel'], in: ['∈', null, 'rel'], notin: ['∉', null, 'rel'],
  ni: ['∋', null, 'rel'], subset: ['⊂', null, 'rel'], subseteq: ['⊆', null, 'rel'], supset: ['⊃', null, 'rel'], supseteq: ['⊇', null, 'rel'],
  perp: ['⊥', null, 'rel'], parallel: ['∥', null, 'rel'], mid: ['∣', null, 'rel'], coloneq: ['≔', '\\coloneqq', 'rel'], coloneqq: ['≔', null, 'rel'],
  triangleq: ['≜', null, 'rel'], doteq: ['≐', null, 'rel'], prec: ['≺', null, 'rel'], succ: ['≻', null, 'rel'],
  // arrows
  to: ['→', null, 'rel'], rightarrow: ['→', null, 'rel'], leftarrow: ['←', null, 'rel'], gets: ['←', null, 'rel'], uparrow: ['↑', null, 'rel'],
  downarrow: ['↓', null, 'rel'], leftrightarrow: ['↔', null, 'rel'], updownarrow: ['↕', null, 'rel'], Rightarrow: ['⇒', null, 'rel'],
  Leftarrow: ['⇐', null, 'rel'], Uparrow: ['⇑', null, 'rel'], Downarrow: ['⇓', null, 'rel'], Leftrightarrow: ['⇔', null, 'rel'],
  Updownarrow: ['⇕', null, 'rel'], implies: ['⟹', null, 'rel'], impliedby: ['⟸', null, 'rel'], iff: ['⟺', null, 'rel'], mapsto: ['↦', null, 'rel'],
  longrightarrow: ['⟶', null, 'rel'], longleftarrow: ['⟵', null, 'rel'], nearrow: ['↗', null, 'rel'], searrow: ['↘', null, 'rel'],
  swarrow: ['↙', null, 'rel'], nwarrow: ['↖', null, 'rel'], rightleftharpoons: ['⇌', null, 'rel'], hookleftarrow: ['↩', null, 'rel'],
  hookrightarrow: ['↪', null, 'rel'], rightleftarrows: ['⇄', null, 'rel'],
  // ordinary symbols
  infty: ['∞', null, 'ord'], partial: ['∂', null, 'ord'], nabla: ['∇', null, 'ord'], forall: ['∀', null, 'ord'], exists: ['∃', null, 'ord'],
  nexists: ['∄', null, 'ord'], emptyset: ['∅', null, 'ord'], varnothing: ['∅', null, 'ord'], hbar: ['ℏ', null, 'ord'], ell: ['ℓ', null, 'ord'],
  Re: ['ℜ', null, 'ord'], Im: ['ℑ', null, 'ord'], wp: ['℘', null, 'ord'], aleph: ['ℵ', null, 'ord'], beth: ['ℶ', null, 'ord'],
  angle: ['∠', null, 'ord'], measuredangle: ['∡', null, 'ord'], degree: ['°', '^{\\circ}', 'ord'], deg: ['°', '^{\\circ}', 'ord'],
  prime: ['′', "'", 'ord'], cdots: ['⋯', null, 'ord'], ldots: ['…', null, 'ord'], dots: ['…', '\\ldots', 'ord'], vdots: ['⋮', null, 'ord'],
  ddots: ['⋱', null, 'ord'], therefore: ['∴', null, 'ord'], because: ['∵', null, 'ord'], neg: ['¬', null, 'ord'], lnot: ['¬', '\\neg', 'ord'],
  top: ['⊤', null, 'ord'], bot: ['⊥', null, 'ord'], triangle: ['△', null, 'ord'], Box: ['□', '\\square', 'ord'], square: ['□', null, 'ord'],
  qed: ['∎', '\\blacksquare', 'ord'], complement: ['∁', null, 'ord'], mho: ['℧', null, 'ord'], ohm: ['Ω', '\\Omega', 'ord'],
  micro: ['μ', '\\mu', 'var'], celsius: ['℃', '{}^{\\circ}\\mathrm{C}', 'ord'], fahrenheit: ['℉', '{}^{\\circ}\\mathrm{F}', 'ord'],
  Angstrom: ['Å', '\\mathring{\\mathrm{A}}', 'ord'], percent: ['%', '\\%', 'ord'], dag: ['†', '\\dagger', 'ord'], dagger: ['†', null, 'ord'],
  langle: ['⟨', null, 'open'], rangle: ['⟩', null, 'close'], lfloor: ['⌊', null, 'open'], rfloor: ['⌋', null, 'close'],
  lceil: ['⌈', null, 'open'], rceil: ['⌉', null, 'close'], Vert: ['‖', '\\|', 'ord'], vert: ['|', null, 'ord'],
  R: ['ℝ', '\\mathbb{R}', 'ord'], N: ['ℕ', '\\mathbb{N}', 'ord'], Z: ['ℤ', '\\mathbb{Z}', 'ord'], Q: ['ℚ', '\\mathbb{Q}', 'ord'], C: ['ℂ', '\\mathbb{C}', 'ord'],
  // large operators
  sum: ['∑', null, 'large'], prod: ['∏', null, 'large'], coprod: ['∐', null, 'large'], int: ['∫', null, 'large'], iint: ['∬', null, 'large'],
  iiint: ['∭', null, 'large'], oint: ['∮', null, 'large'], bigcup: ['⋃', null, 'large'], bigcap: ['⋂', null, 'large'],
  bigoplus: ['⨁', null, 'large'], bigotimes: ['⨂', null, 'large'], bigvee: ['⋁', null, 'large'], bigwedge: ['⋀', null, 'large'],
};
for (const src of [greek, Greek]) {
  const p = src.split(' ');
  for (let i = 0; i < p.length; i += 2) SYM_TABLE[p[i]] = [p[i + 1], null, p[i][0] === p[i][0].toUpperCase() ? 'ord' : 'var'];
}
{
  const p = GreekLatin.split(' ');
  for (let i = 0; i < p.length; i += 3) SYM_TABLE[p[i]] = [p[i + 1], `\\mathrm{${p[i + 2]}}`, 'ord'];
}

/** Function names typed as plain letters that turn upright (with Space). */
export const FUNCTIONS = new Set(
  'sin cos tan cot sec csc arcsin arccos arctan sinh cosh tanh coth sech csch log ln lg exp lim limsup liminf max min sup inf det gcd dim ker arg Pr hom mod'.split(' '),
);
/** Functions whose scripts sit under/over them in display style. */
const LIMIT_FNS = new Set(['lim', 'limsup', 'liminf', 'max', 'min', 'sup', 'inf', 'det', 'gcd', 'Pr']);
const SUM_LIKE = new Set(['∑', '∏', '∐', '⋃', '⋂', '⨁', '⨂', '⋁', '⋀']);
const LATEX_FNS = new Set([...FUNCTIONS].filter((f) => !['sech', 'csch', 'mod'].includes(f)));

const fnTex = (name: string) => (name === 'mod' ? '\\bmod' : LATEX_FNS.has(name) ? `\\${name}` : `\\operatorname{${name}}`);
export const fnSym = (name: string): MNode => ({ t: 'sym', v: name, tex: fnTex(name), cls: 'fn' });

export function lookupSym(name: string): SymDef | null {
  const e = SYM_TABLE[name];
  if (!e) return null;
  return { v: e[0], tex: e[1] ?? `\\${name}`, cls: e[2] };
}

/** Unicode character → LaTeX (for symbols typed or pasted directly, e.g. from the ribbon). */
const CHAR_TEX = new Map<string, SymDef>();
for (const name of Object.keys(SYM_TABLE)) {
  const d = lookupSym(name)!;
  if (!CHAR_TEX.has(d.v) && d.v.length === 1) CHAR_TEX.set(d.v, d);
}

export const ACCENTS: Record<string, { mark: string; tex: string }> = {
  hat: { mark: '^', tex: '\\hat' },
  check: { mark: 'ˇ', tex: '\\check' },
  tilde: { mark: '~', tex: '\\tilde' },
  bar: { mark: '¯', tex: '\\bar' },
  vec: { mark: '→', tex: '\\vec' },
  dot: { mark: '˙', tex: '\\dot' },
  ddot: { mark: '¨', tex: '\\ddot' },
  breve: { mark: '˘', tex: '\\breve' },
  overline: { mark: '', tex: '\\overline' },
  underline: { mark: '', tex: '\\underline' },
  widehat: { mark: '^', tex: '\\widehat' },
  widetilde: { mark: '~', tex: '\\widetilde' },
};

const OPEN_CLOSE: Record<string, string> = { '(': ')', '[': ']', '{': '}', '|': '|', '‖': '‖', '⟨': '⟩', '⌊': '⌋', '⌈': '⌉' };
const CLOSERS = new Set([')', ']', '}', '⟩', '⌋', '⌉']);
const DELIM_TEX: Record<string, string> = {
  '(': '(', ')': ')', '[': '[', ']': ']', '{': '\\{', '}': '\\}', '|': '|', '‖': '\\|', '⟨': '\\langle', '⟩': '\\rangle',
  '⌊': '\\lfloor', '⌋': '\\rfloor', '⌈': '\\lceil', '⌉': '\\rceil', '': '.',
};
const TEX_DELIM: Record<string, string> = Object.fromEntries(Object.entries(DELIM_TEX).map(([k, v]) => [v, k]));
Object.assign(TEX_DELIM, { '\\lbrace': '{', '\\rbrace': '}', '\\vert': '|', '\\Vert': '‖', '\\lvert': '|', '\\rvert': '|', '\\lVert': '‖', '\\rVert': '‖', '<': '⟨', '>': '⟩' });

/** Two (or three) characters typed in a row that Word's Math AutoCorrect replaces. */
const AUTOCORRECT: [string, string][] = [
  ['<=', 'le'], ['>=', 'ge'], ['!=', 'ne'], ['−>', 'to'], ['<−', 'gets'], ['+−', 'pm'], ['−+', 'mp'], ['<<', 'll'], ['>>', 'gg'],
  ['∼=', 'cong'], [':=', 'coloneqq'], ['...', 'ldots'], ['=>', 'Rightarrow'],
];

/** A symbol for one typed character. */
export function charSym(ch: string): MNode {
  if (/^[A-Za-z]$/.test(ch)) return { t: 'sym', v: ch, tex: ch, cls: 'var' };
  if (/^[0-9.]$/.test(ch)) return { t: 'sym', v: ch, tex: ch, cls: 'num' };
  const plain: Record<string, [string, string, SymCls]> = {
    '+': ['+', '+', 'bin'], '-': ['−', '-', 'bin'], '−': ['−', '-', 'bin'], '*': ['∗', '\\ast', 'bin'], '=': ['=', '=', 'rel'],
    '<': ['<', '<', 'rel'], '>': ['>', '>', 'rel'], ',': [',', ',', 'punct'], ';': [';', ';', 'punct'], ':': [':', ':', 'rel'],
    '!': ['!', '!', 'ord'], '?': ['?', '?', 'ord'], "'": ['′', "'", 'ord'], '~': ['∼', '\\sim', 'rel'], '#': ['#', '\\#', 'ord'],
    '%': ['%', '\\%', 'ord'], '&': ['&', '\\&', 'ord'], $: ['$', '\\$', 'ord'], '@': ['@', '@', 'ord'], '"': ['"', '\\text{"}', 'ord'],
    '{': ['{', '\\{', 'open'], '}': ['}', '\\}', 'close'], ')': [')', ')', 'close'], ']': [']', ']', 'close'], '(': ['(', '(', 'open'],
    '[': ['[', '[', 'open'], '|': ['|', '|', 'ord'], '_': ['_', '\\_', 'ord'], '^': ['^', '\\hat{}', 'ord'], '`': ['`', '`', 'ord'],
    '/': ['/', '/', 'ord'], '\\': ['\\', '\\backslash', 'ord'],
  };
  const p = plain[ch];
  if (p) return { t: 'sym', v: p[0], tex: p[1], cls: p[2] };
  const known = CHAR_TEX.get(ch);
  if (known) return { t: 'sym', ...known };
  if (/\p{L}/u.test(ch)) return { t: 'sym', v: ch, tex: ch, cls: 'var' };
  return { t: 'sym', v: ch, tex: ch, cls: 'ord' };
}

const sym = (name: string): MNode => ({ t: 'sym', ...lookupSym(name)! });

/* ------------------------------------------------------------------ */
/* Tree helpers                                                        */
/* ------------------------------------------------------------------ */

/** A node's child rows in a fixed order (absent ones are null, so indices never shift). */
export function slots(n: MNode): (Row | null)[] {
  switch (n.t) {
    case 'frac':
      return [n.num, n.den];
    case 'sqrt':
      return [n.idx, n.body];
    case 'scripts':
      return [n.sub, n.sup];
    case 'delim':
    case 'accent':
      return [n.body];
    case 'mat':
      return n.cells;
    default:
      return [];
  }
}
const live = (n: MNode) => slots(n).flatMap((r, i) => (r ? [i] : []));
const isEmptyNode = (n: MNode) => n.t !== 'sym' && slots(n).every((r) => !r || r.length === 0);

export function isLimitsBase(n: MNode | undefined): boolean {
  return !!n && n.t === 'sym' && ((n.cls === 'large' && SUM_LIKE.has(n.v)) || (n.cls === 'fn' && LIMIT_FNS.has(n.v)));
}

const clone = <T>(x: T): T => JSON.parse(JSON.stringify(x));

/* ------------------------------------------------------------------ */
/* LaTeX out                                                           */
/* ------------------------------------------------------------------ */

function joinTex(a: string, b: string) {
  if (!a || !b) return a + b;
  // \alpha x, and x^n y (not x^ny, which is right but reads wrongly)
  return (/\\[a-zA-Z]+$/.test(a) && /^[a-zA-Z]/.test(b)) || (/[_^][a-zA-Z0-9]$/.test(a) && /^[a-zA-Z0-9]/.test(b)) ? `${a} ${b}` : a + b;
}

/** A pending `\name` written out as what it will become. */
function cmdTex(v: string) {
  const name = v.slice(1);
  // a lone \ just typed: nothing yet (and the field doesn't flicker wider)
  if (!name) return '';
  const d = lookupSym(name);
  if (d) return d.tex;
  if (FUNCTIONS.has(name)) return fnTex(name);
  return v;
}

function scriptArg(r: Row) {
  const t = rowTex(r);
  if (r.length === 1 && r[0].t === 'sym' && /^[a-zA-Z0-9]$/.test(t)) return t;
  return `{${t}}`;
}

export function rowTex(row: Row): string {
  let out = '';
  row.forEach((n, i) => {
    let s: string;
    switch (n.t) {
      case 'sym':
        s = n.cls === 'cmd' ? cmdTex(n.v) : n.tex;
        break;
      case 'frac':
        s = `\\frac{${rowTex(n.num)}}{${rowTex(n.den)}}`;
        break;
      case 'sqrt': {
        const idx = n.idx ? rowTex(n.idx) : '';
        s = idx ? `\\sqrt[${idx}]{${rowTex(n.body)}}` : `\\sqrt{${rowTex(n.body)}}`;
        break;
      }
      case 'scripts': {
        const prev = row[i - 1];
        s = !prev || prev.t === 'scripts' || (prev.t === 'sym' && prev.cls === 'cmd' && prev.v === '\\') ? '{}' : '';
        if (n.sub) s += `_${scriptArg(n.sub)}`;
        if (n.sup) s += `^${scriptArg(n.sup)}`;
        break;
      }
      case 'delim':
        s = joinTex(joinTex(`\\left${DELIM_TEX[n.l] ?? '.'}`, rowTex(n.body)), `\\right${DELIM_TEX[n.r] ?? '.'}`);
        break;
      case 'accent':
        s = `${ACCENTS[n.acc]?.tex ?? '\\hat'}{${rowTex(n.body)}}`;
        break;
      case 'mat': {
        const rows: string[] = [];
        for (let r = 0; r < n.cells.length / n.cols; r++) rows.push(n.cells.slice(r * n.cols, (r + 1) * n.cols).map(rowTex).join(' & '));
        s = `\\begin{matrix}${rows.join(' \\\\ ')}\\end{matrix}`;
        break;
      }
    }
    out = joinTex(out, s);
  });
  return out;
}

/* ------------------------------------------------------------------ */
/* LaTeX in                                                            */
/* ------------------------------------------------------------------ */

interface Tok {
  k: 'cmd' | 'ch';
  v: string;
  a: number;
  b: number;
}

function tokenize(src: string): Tok[] {
  const out: Tok[] = [];
  let i = 0;
  while (i < src.length) {
    const c = src[i];
    if (/\s/.test(c)) {
      i++;
      continue;
    }
    if (c === '\\') {
      const m = /^\\([a-zA-Z]+|.)/s.exec(src.slice(i));
      const name = m ? m[1] : '';
      out.push({ k: 'cmd', v: name, a: i, b: i + 1 + name.length });
      i += 1 + name.length;
      continue;
    }
    const cp = String.fromCodePoint(src.codePointAt(i)!);
    out.push({ k: 'ch', v: cp, a: i, b: i + cp.length });
    i += cp.length;
  }
  return out;
}

const MATRIX_ENVS: Record<string, [string, string]> = { matrix: ['', ''], pmatrix: ['(', ')'], bmatrix: ['[', ']'], Bmatrix: ['{', '}'], vmatrix: ['|', '|'], Vmatrix: ['‖', '‖'] };

/** Builds an equation tree from LaTeX (anything it doesn't know is kept verbatim). */
export function parseTex(src: string): Row {
  const toks = tokenize(src);
  let p = 0;
  const raw = (a: number, b: number): MNode => ({ t: 'sym', v: src.slice(a, b).trim(), tex: src.slice(a, b).trim(), cls: 'raw' });
  const peek = () => toks[p];
  const isCmd = (t: Tok | undefined, ...names: string[]) => !!t && t.k === 'cmd' && names.includes(t.v);
  const isCh = (t: Tok | undefined, ch: string) => !!t && t.k === 'ch' && t.v === ch;

  /** Skips one argument (a group or a token) and returns where it ends. */
  const skipArg = (): number => {
    const t = toks[p];
    if (!t) return src.length;
    if (isCh(t, '{')) {
      let depth = 0;
      while (p < toks.length) {
        const u = toks[p++];
        if (isCh(u, '{')) depth++;
        else if (isCh(u, '}') && --depth === 0) return u.b;
      }
      return src.length;
    }
    p++;
    return t.b;
  };
  const arg = (): Row => {
    const t = peek();
    if (!t) return [];
    if (isCh(t, '{')) {
      p++;
      const r = row((u) => isCh(u, '}'));
      if (isCh(peek(), '}')) p++;
      return r;
    }
    const out: Row = [];
    atom(out);
    return out;
  };
  const delimTok = (): string => {
    const t = toks[p++];
    if (!t) return '';
    const key = t.k === 'cmd' ? `\\${t.v}` : t.v;
    if (key === '.') return '';
    return TEX_DELIM[key] ?? (t.k === 'ch' ? t.v : '');
  };

  const atom = (out: Row) => {
    const t = toks[p];
    if (t.k === 'ch') {
      p++;
      if (t.v === '{') {
        const r = row((u) => isCh(u, '}'));
        if (isCh(peek(), '}')) p++;
        out.push(...r);
        return;
      }
      if (t.v === '_' || t.v === '^') {
        const a = arg();
        const prev = out[out.length - 1];
        const key = t.v === '_' ? 'sub' : 'sup';
        if (prev && prev.t === 'scripts' && !prev[key]) prev[key] = a;
        else out.push({ t: 'scripts', sub: key === 'sub' ? a : null, sup: key === 'sup' ? a : null });
        return;
      }
      if (t.v === '~' || t.v === '&') {
        out.push(raw(t.a, t.b));
        return;
      }
      if (t.v === "'") {
        out.push({ t: 'sym', v: '′', tex: "'", cls: 'ord' });
        return;
      }
      out.push(charSym(t.v));
      return;
    }
    // commands
    const name = t.v;
    p++;
    if (name === 'frac' || name === 'dfrac' || name === 'tfrac' || name === 'cfrac') {
      const num = arg();
      out.push({ t: 'frac', num, den: arg() });
      return;
    }
    if (name === 'sqrt') {
      let idx: Row | null = null;
      if (isCh(peek(), '[')) {
        p++;
        idx = row((u) => isCh(u, ']'));
        if (isCh(peek(), ']')) p++;
      }
      out.push({ t: 'sqrt', idx, body: arg() });
      return;
    }
    if (name === 'left') {
      const l = delimTok();
      const body = row((u) => isCmd(u, 'right'));
      let r = '';
      if (isCmd(peek(), 'right')) {
        p++;
        r = delimTok();
      }
      out.push({ t: 'delim', l, r, body });
      return;
    }
    if (name === 'begin' && isCh(peek(), '{')) {
      const a = t.a;
      p++;
      let env = '';
      while (p < toks.length && !isCh(toks[p], '}')) env += toks[p++].v;
      p++;
      if (MATRIX_ENVS[env]) {
        const grid: Row[][] = [[]];
        for (;;) {
          const cell = row((u) => isCh(u, '&') || isCmd(u, '\\', 'end'));
          grid[grid.length - 1].push(cell);
          const u = peek();
          if (!u) break;
          p++;
          if (isCh(u, '&')) continue;
          if (isCmd(u, '\\')) {
            grid.push([]);
            continue;
          }
          skipArg();
          break;
        }
        if (grid.length > 1 && grid[grid.length - 1].length === 1 && grid[grid.length - 1][0].length === 0) grid.pop();
        const cols = Math.max(...grid.map((r) => r.length));
        const cells = grid.flatMap((r) => [...r, ...Array.from({ length: cols - r.length }, () => [] as Row)]);
        const m: MNode = { t: 'mat', cols, cells };
        const [l, r] = MATRIX_ENVS[env];
        out.push(l ? { t: 'delim', l, r, body: [m] } : m);
        return;
      }
      // anything else (aligned, cases…) is kept as it is, up to its \end
      let depth = 1;
      while (p < toks.length && depth) {
        const u = toks[p++];
        if (isCmd(u, 'begin')) depth++;
        else if (isCmd(u, 'end')) depth--;
      }
      out.push(raw(a, skipArg()));
      return;
    }
    if (ACCENTS[name] || name === 'mathring') {
      out.push({ t: 'accent', acc: ACCENTS[name] ? name : 'dot', body: arg() });
      return;
    }
    if (name === 'operatorname') {
      const a = p;
      const end = skipArg();
      const inner = src.slice(toks[a]?.a ?? end, end).replace(/^\{|\}$/g, '');
      out.push({ t: 'sym', v: inner, tex: `\\operatorname{${inner}}`, cls: 'fn' });
      return;
    }
    if (name === 'bmod' || name === 'mod') {
      out.push(fnSym('mod'));
      return;
    }
    if (FUNCTIONS.has(name)) {
      out.push(fnSym(name));
      return;
    }
    if (name === 'mathbb' && isCh(peek(), '{')) {
      const a = t.a;
      const save = p;
      const r = arg();
      const letter = r.length === 1 && r[0].t === 'sym' ? r[0].v : '';
      const d = letter && lookupSym(letter);
      if (d && d.tex === `\\mathbb{${letter}}`) {
        out.push({ t: 'sym', ...d });
        return;
      }
      p = save;
      out.push(raw(a, skipArg()));
      return;
    }
    if (name === 'mathrm' && isCh(peek(), '{')) {
      // \mathrm{A} as written for Word's \Alpha etc.
      const a = t.a;
      const save = p;
      const end = skipArg();
      const inner = src.slice(toks[save].b, end - 1).trim();
      const gk = Object.keys(SYM_TABLE).find((k) => SYM_TABLE[k][1] === `\\mathrm{${inner}}`);
      if (gk) out.push(sym(gk));
      else out.push(raw(a, end));
      return;
    }
    if (name === 'right' || name === 'end') {
      out.push(raw(t.a, t.b));
      return;
    }
    const d = lookupSym(name);
    if (d && !['R', 'N', 'Z', 'Q', 'C', 'ohm', 'micro', 'degree', 'deg', 'celsius', 'fahrenheit', 'percent', 'Angstrom'].includes(name)) {
      out.push({ t: 'sym', ...d });
      return;
    }
    if (/^[{}#%&$_]$/.test(name)) {
      out.push(charSym(name));
      return;
    }
    if (name === '|') {
      out.push({ t: 'sym', v: '‖', tex: '\\|', cls: 'ord' });
      return;
    }
    // unknown, spacing or text commands: kept verbatim with their arguments
    let end = t.b;
    while (isCh(peek(), '{') || (isCh(peek(), '[') && end === t.b)) {
      if (isCh(peek(), '[')) {
        while (p < toks.length && !isCh(toks[p], ']')) p++;
        end = toks[p] ? toks[p++].b : src.length;
      } else end = skipArg();
    }
    out.push(raw(t.a, end));
  };

  const row = (stop: (t: Tok) => boolean): Row => {
    const out: Row = [];
    while (p < toks.length && !stop(toks[p])) {
      if (isCh(toks[p], '}') || isCmd(toks[p], 'right') || isCmd(toks[p], 'end')) {
        // unbalanced: keep it rather than lose it
        out.push(raw(toks[p].a, toks[p].b));
        p++;
        continue;
      }
      atom(out);
    }
    return out;
  };
  try {
    return row(() => false);
  } catch {
    return src.trim() ? [{ t: 'sym', v: src.trim(), tex: src.trim(), cls: 'raw' }] : [];
  }
}

/* ------------------------------------------------------------------ */
/* Editor                                                              */
/* ------------------------------------------------------------------ */

export type KeyResult = 'exit-left' | 'exit-right' | 'done' | undefined;

/** Where the caret is: a path of (node index, slot index) pairs down to a row, and a position in it. */
export interface Caret {
  path: number[];
  pos: number;
}

export class EqEditor {
  root: Row = [];
  path: number[] = [];
  pos = 0;
  /** Selection anchor in the caret's row (null: no selection). */
  anchor: number | null = null;
  private undos: string[] = [];
  private redos: string[] = [];

  constructor(tex = '') {
    if (tex) {
      this.root = parseTex(tex);
      this.pos = this.root.length;
    }
  }

  toTex() {
    return rowTex(this.root).trim();
  }

  get isEmpty() {
    return this.root.length === 0;
  }

  rowAt(path: number[] = this.path): Row {
    let r = this.root;
    for (let i = 0; i < path.length; i += 2) r = slots(r[path[i]])[path[i + 1]] as Row;
    return r;
  }
  get row() {
    return this.rowAt();
  }
  private parent() {
    if (!this.path.length) return null;
    const rowPath = this.path.slice(0, -2);
    const idx = this.path[this.path.length - 2];
    const slot = this.path[this.path.length - 1];
    return { rowPath, idx, slot, node: this.rowAt(rowPath)[idx] };
  }
  get selection(): [number, number] | null {
    if (this.anchor === null || this.anchor === this.pos) return null;
    return [Math.min(this.anchor, this.pos), Math.max(this.anchor, this.pos)];
  }

  /* ---- undo ---- */
  private snap() {
    return JSON.stringify([this.root, this.path, this.pos]);
  }
  private restore(s: string) {
    [this.root, this.path, this.pos] = JSON.parse(s);
    this.anchor = null;
  }
  private save() {
    this.undos.push(this.snap());
    if (this.undos.length > 200) this.undos.shift();
    this.redos = [];
  }
  undo() {
    const s = this.undos.pop();
    if (!s) return false;
    this.redos.push(this.snap());
    this.restore(s);
    return true;
  }
  redo() {
    const s = this.redos.pop();
    if (!s) return false;
    this.undos.push(this.snap());
    this.restore(s);
    return true;
  }

  /* ---- caret ---- */
  place(path: number[], pos: number, extend = false) {
    if (extend && this.samePath(path)) {
      this.anchor ??= this.pos;
    } else this.anchor = null;
    this.path = path;
    this.pos = Math.max(0, Math.min(pos, this.rowAt(path).length));
  }
  private samePath(p: number[]) {
    return p.length === this.path.length && p.every((v, i) => v === this.path[i]);
  }
  private enter(idx: number, slot: number, atEnd: boolean) {
    this.path = [...this.path, idx, slot];
    this.pos = atEnd ? this.row.length : 0;
    this.anchor = null;
  }
  private exit(after: boolean) {
    const p = this.parent();
    if (!p) return;
    this.path = p.rowPath;
    this.pos = after ? p.idx + 1 : p.idx;
    this.anchor = null;
  }
  /** Places the caret in the first empty slot of nodes [from, to) of the current row, else after them. */
  private caretIntoFirstEmpty(from: number, to: number) {
    const find = (row: Row, base: number[], a: number, b: number): Caret | null => {
      for (let i = a; i < b; i++) {
        const n = row[i];
        const s = slots(n);
        for (let k = 0; k < s.length; k++) {
          const r = s[k];
          if (!r) continue;
          if (r.length === 0) return { path: [...base, i, k], pos: 0 };
          const inner = find(r, [...base, i, k], 0, r.length);
          if (inner) return inner;
        }
      }
      return null;
    };
    const c = find(this.row, this.path, from, to);
    if (c) {
      this.path = c.path;
      this.pos = c.pos;
    } else this.pos = to;
    this.anchor = null;
  }

  moveLeft(shift = false): KeyResult {
    const row = this.row;
    if (shift) {
      this.anchor ??= this.pos;
      if (this.pos > 0) this.pos--;
      else if (this.path.length) this.climbSelect(false);
      return;
    }
    const sel = this.selection;
    if (sel) {
      this.pos = sel[0];
      this.anchor = null;
      return;
    }
    this.anchor = null;
    if (this.pos > 0) {
      const n = row[this.pos - 1];
      const l = live(n);
      if (l.length) this.enter(this.pos - 1, l[l.length - 1], true);
      else this.pos--;
      return;
    }
    const p = this.parent();
    if (!p) return 'exit-left';
    const l = live(p.node);
    const k = l.indexOf(p.slot);
    if (k > 0) {
      this.path = [...p.rowPath, p.idx, l[k - 1]];
      this.pos = this.row.length;
    } else this.exit(false);
  }

  moveRight(shift = false): KeyResult {
    const row = this.row;
    if (shift) {
      this.anchor ??= this.pos;
      if (this.pos < row.length) this.pos++;
      else if (this.path.length) this.climbSelect(true);
      return;
    }
    const sel = this.selection;
    if (sel) {
      this.pos = sel[1];
      this.anchor = null;
      return;
    }
    this.anchor = null;
    if (this.pos < row.length) {
      const n = row[this.pos];
      const l = live(n);
      if (l.length) this.enter(this.pos, l[0], false);
      else this.pos++;
      return;
    }
    const p = this.parent();
    if (!p) return 'exit-right';
    const l = live(p.node);
    const k = l.indexOf(p.slot);
    if (k < l.length - 1) {
      this.path = [...p.rowPath, p.idx, l[k + 1]];
      this.pos = 0;
    } else this.exit(true);
  }

  /** Shift+arrow at the edge of a slot: the selection grows to the whole structure. */
  private climbSelect(right: boolean) {
    const p = this.parent()!;
    this.path = p.rowPath;
    this.anchor = right ? p.idx : p.idx + 1;
    this.pos = right ? p.idx + 1 : p.idx;
  }

  moveVertical(up: boolean) {
    this.anchor = null;
    for (let d = this.path.length; d >= 2; d -= 2) {
      const rowPath = this.path.slice(0, d - 2);
      const idx = this.path[d - 2];
      const slot = this.path[d - 1];
      const n = this.rowAt(rowPath)[idx];
      let target = -1;
      if (n.t === 'frac') target = up ? (slot === 1 ? 0 : -1) : slot === 0 ? 1 : -1;
      else if (n.t === 'scripts' && n.sub && n.sup) target = up ? (slot === 0 ? 1 : -1) : slot === 1 ? 0 : -1;
      else if (n.t === 'mat') {
        const t = slot + (up ? -n.cols : n.cols);
        target = t >= 0 && t < n.cells.length ? t : -1;
      }
      if (target >= 0) {
        const old = this.pos;
        this.path = [...rowPath, idx, target];
        this.pos = d === this.path.length ? Math.min(old, this.row.length) : this.row.length;
        return true;
      }
    }
    return false;
  }

  home(shift = false) {
    if (shift) {
      this.anchor ??= this.pos;
      this.pos = 0;
      return;
    }
    this.path = [];
    this.pos = 0;
    this.anchor = null;
  }
  end(shift = false) {
    if (shift) {
      this.anchor ??= this.pos;
      this.pos = this.row.length;
      return;
    }
    this.path = [];
    this.pos = this.root.length;
    this.anchor = null;
  }
  selectAll() {
    this.path = [];
    this.anchor = 0;
    this.pos = this.root.length;
  }

  /* ---- editing ---- */
  private cut(): Row {
    const sel = this.selection;
    if (!sel) {
      this.anchor = null;
      return [];
    }
    const out = this.row.splice(sel[0], sel[1] - sel[0]);
    this.pos = sel[0];
    this.anchor = null;
    return out;
  }
  private insert(nodes: MNode[]) {
    this.row.splice(this.pos, 0, ...nodes);
    this.pos += nodes.length;
  }

  /** The LaTeX of the selection (for copy). */
  selectedTex() {
    const sel = this.selection;
    return sel ? rowTex(this.row.slice(sel[0], sel[1])) : '';
  }
  deleteSelection() {
    if (!this.selection) return false;
    this.save();
    this.cut();
    return true;
  }

  backspace() {
    if (this.selection) return void this.deleteSelection();
    this.save();
    const row = this.row;
    if (this.pos > 0) {
      const n = row[this.pos - 1];
      if (n.t === 'sym') {
        if (n.cls === 'cmd' && n.v.length > 1) n.v = n.tex = n.v.slice(0, -1);
        else {
          row.splice(this.pos - 1, 1);
          this.pos--;
        }
      } else if (isEmptyNode(n)) {
        row.splice(this.pos - 1, 1);
        this.pos--;
      } else {
        const l = live(n);
        this.enter(this.pos - 1, l[l.length - 1], true);
      }
      return;
    }
    const p = this.parent();
    if (!p) return;
    const prow = this.rowAt(p.rowPath);
    const l = live(p.node);
    const k = l.indexOf(p.slot);
    if (isEmptyNode(p.node)) {
      prow.splice(p.idx, 1);
      this.path = p.rowPath;
      this.pos = p.idx;
    } else if (p.node.t === 'sqrt' && p.slot === 0) {
      p.node.idx = null;
      this.path = [...p.rowPath, p.idx, 1];
      this.pos = 0;
    } else if (k > 0) {
      this.path = [...p.rowPath, p.idx, l[k - 1]];
      this.pos = this.row.length;
    } else if (p.node.t !== 'mat') {
      // at the start of the first slot: take the structure apart, keeping what was in it
      const content = l.flatMap((s) => slots(p.node)[s] as Row);
      prow.splice(p.idx, 1, ...content);
      this.path = p.rowPath;
      this.pos = p.idx;
    }
  }

  del() {
    if (this.selection) return void this.deleteSelection();
    this.save();
    const row = this.row;
    if (this.pos < row.length) {
      const n = row[this.pos];
      if (n.t === 'sym' || isEmptyNode(n)) row.splice(this.pos, 1);
      else this.enter(this.pos, live(n)[0], false);
      return;
    }
    const p = this.parent();
    if (!p) return;
    const l = live(p.node);
    const k = l.indexOf(p.slot);
    if (isEmptyNode(p.node)) {
      this.rowAt(p.rowPath).splice(p.idx, 1);
      this.path = p.rowPath;
      this.pos = p.idx;
    } else if (k < l.length - 1) {
      this.path = [...p.rowPath, p.idx, l[k + 1]];
      this.pos = 0;
    }
  }

  /** The `\name` being typed just before the caret, if any. */
  private pendingCmd() {
    const n = this.row[this.pos - 1];
    return n && n.t === 'sym' && n.cls === 'cmd' ? n : null;
  }

  /** Replaces the `\name` before the caret with what it stands for. */
  private resolveCmd() {
    const n = this.pendingCmd();
    if (!n) return;
    const name = n.v.slice(1);
    const row = this.row;
    const at = this.pos - 1;
    const replace = (...nodes: MNode[]) => {
      row.splice(at, 1, ...nodes);
      this.pos = at + nodes.length;
    };
    if (!name) {
      replace({ t: 'sym', v: '∖', tex: '\\backslash', cls: 'ord' });
      return;
    }
    const d = lookupSym(name);
    if (d) {
      if (d.cls === 'open' && OPEN_CLOSE[d.v]) {
        row.splice(at, 1);
        this.pos = at;
        this.openDelim(d.v);
        return;
      }
      return replace({ t: 'sym', ...d });
    }
    if (FUNCTIONS.has(name) || name === 'bmod') return replace(fnSym(name === 'bmod' ? 'mod' : name));
    const structure = (node: MNode) => {
      replace(node);
      this.caretIntoFirstEmpty(at, at + 1);
    };
    switch (name) {
      case 'sqrt':
        return structure({ t: 'sqrt', idx: null, body: [] });
      case 'cbrt':
        return structure({ t: 'sqrt', idx: [charSym('3')], body: [] });
      case 'qdrt':
        return structure({ t: 'sqrt', idx: [charSym('4')], body: [] });
      case 'root':
      case 'nthroot':
        return structure({ t: 'sqrt', idx: [], body: [] });
      case 'frac':
      case 'dfrac':
      case 'tfrac':
        return structure({ t: 'frac', num: [], den: [] });
      case 'over':
      case 'fraction':
        row.splice(at, 1);
        this.pos = at;
        return this.fraction();
      case 'matrix':
        return structure({ t: 'mat', cols: 2, cells: [[], [], [], []] });
      case 'pmatrix':
      case 'bmatrix':
      case 'vmatrix': {
        const [l, r] = MATRIX_ENVS[name];
        return structure({ t: 'delim', l, r, body: [{ t: 'mat', cols: 2, cells: [[], [], [], []] }] });
      }
      case 'abs':
        return structure({ t: 'delim', l: '|', r: '|', body: [] });
      case 'norm':
        return structure({ t: 'delim', l: '‖', r: '‖', body: [] });
      case 'left':
      case 'right':
        row.splice(at, 1);
        this.pos = at;
        return;
    }
    if (ACCENTS[name]) {
      // like Word: an accent typed after a letter goes on that letter (x\dot → ẋ)
      const prev = row[at - 1];
      if (prev && prev.t === 'sym' && (prev.cls === 'var' || prev.cls === 'num' || prev.cls === 'ord') && !/^\\/.test(prev.v)) {
        row.splice(at - 1, 2, { t: 'accent', acc: name, body: [prev] });
        this.pos = at;
        return;
      }
      return structure({ t: 'accent', acc: name, body: [] });
    }
    // unknown: kept as written
    row[at] = { t: 'sym', v: n.v, tex: n.v, cls: 'raw' };
  }

  /** Letters before the caret that spell a function name become one upright name. */
  private tryFunction() {
    const row = this.row;
    let k = this.pos;
    while (k > 0) {
      const n = row[k - 1];
      if (n.t === 'sym' && n.cls === 'var' && /^[a-zA-Z]$/.test(n.v)) k--;
      else break;
    }
    if (k === this.pos) return false;
    const word = row.slice(k, this.pos).map((n) => (n as { v: string }).v).join('');
    if (!FUNCTIONS.has(word)) return false;
    row.splice(k, this.pos - k, fnSym(word));
    this.pos = k + 1;
    return true;
  }

  private script(key: 'sub' | 'sup') {
    this.cut();
    const row = this.row;
    const prev = row[this.pos - 1];
    if (prev && prev.t === 'scripts' && !(key === 'sub' ? prev.sub : prev.sup)?.length) {
      if (!prev[key]) prev[key] = [];
      this.enter(this.pos - 1, key === 'sub' ? 0 : 1, true);
      return;
    }
    if (prev && prev.t === 'scripts') {
      this.enter(this.pos - 1, key === 'sub' ? 0 : 1, true);
      return;
    }
    this.insert([{ t: 'scripts', sub: key === 'sub' ? [] : null, sup: key === 'sup' ? [] : null }]);
    this.enter(this.pos - 1, key === 'sub' ? 0 : 1, false);
  }

  /** Where the operand ending at the caret starts (for `/`): a run of letters and digits or one structure, with its scripts. */
  private operandStart(): number {
    const row = this.row;
    const isRun = (n: MNode | undefined) => !!n && n.t === 'sym' && (n.cls === 'var' || n.cls === 'num' || (n.cls === 'ord' && !/^[!?]$/.test(n.v)));
    let k = this.pos;
    if (k > 0 && row[k - 1].t === 'scripts') k--;
    if (k > 0) {
      const prev = row[k - 1];
      if (prev.t !== 'sym') k--;
      else while (k > 0 && isRun(row[k - 1])) k--;
    }
    return k;
  }

  fraction() {
    let num = this.cut();
    if (!num.length) {
      const k = this.operandStart();
      num = this.row.splice(k, this.pos - k);
      this.pos = k;
    }
    // like Word, the brackets around a numerator go: (a+b)/c → a+b over c
    if (num.length === 1 && num[0].t === 'delim' && num[0].l === '(' && num[0].r === ')') num = num[0].body;
    this.insert([{ t: 'frac', num, den: [] }]);
    this.enter(this.pos - 1, num.length ? 1 : 0, false);
  }

  private openDelim(l: string) {
    const body = this.cut();
    this.insert([{ t: 'delim', l, r: OPEN_CLOSE[l] ?? '', body }]);
    this.enter(this.pos - 1, 0, true);
  }

  /** The innermost bracket around the caret, as a path to it. */
  private enclosingDelim(): number[] | null {
    for (let d = this.path.length; d >= 2; d -= 2) {
      const rowPath = this.path.slice(0, d - 2);
      if (this.rowAt(rowPath)[this.path[d - 2]].t === 'delim') return this.path.slice(0, d);
    }
    return null;
  }

  private closeDelim(ch: string): boolean {
    const at = this.enclosingDelim();
    if (!at) return false;
    const rowPath = at.slice(0, -2);
    const idx = at[at.length - 2];
    const node = this.rowAt(rowPath)[idx] as Extract<MNode, { t: 'delim' }>;
    if (ch === '|' && node.l !== '|') return false;
    node.r = ch;
    this.path = rowPath;
    this.pos = idx + 1;
    this.anchor = null;
    return true;
  }

  private autocorrect() {
    const row = this.row;
    for (const [seq, name] of AUTOCORRECT) {
      const n = seq.length;
      if (this.pos < n) continue;
      const tail = row.slice(this.pos - n, this.pos);
      if (tail.every((x, i) => x.t === 'sym' && x.cls !== 'cmd' && x.cls !== 'raw' && x.v === seq[i])) {
        row.splice(this.pos - n, n, sym(name));
        this.pos -= n - 1;
        return;
      }
    }
  }

  /** One typed character. */
  type(ch: string) {
    this.save();
    this.typeRaw(ch);
  }

  /** Several characters, as if typed (e.g. pasted text, or text turned into an equation). */
  typeText(text: string) {
    this.save();
    for (const ch of text.replace(/\r?\n/g, ' ')) this.typeRaw(ch);
  }

  private typeRaw(ch: string) {
    const pending = this.pendingCmd();
    if (pending) {
      if (/^[a-zA-Z]$/.test(ch)) {
        pending.v += ch;
        pending.tex = pending.v;
        return;
      }
      if (pending.v === '\\' && ch !== ' ' && ch !== '\\') {
        // \{ \, \| …: a literal character
        this.row[this.pos - 1] = ch === '|' ? { t: 'sym', v: '‖', tex: '\\|', cls: 'ord' } : charSym(ch);
        const n = this.row[this.pos - 1] as Extract<MNode, { t: 'sym' }>;
        if (ch === '{' || ch === '}') n.cls = 'ord';
        if (/^[,;:!]$/.test(ch)) Object.assign(n, { v: ' ', tex: `\\${ch}`, cls: 'raw' });
        return;
      }
      this.resolveCmd();
      if (ch === ' ') return;
    }
    if (ch === '\\') {
      this.cut();
      this.insert([{ t: 'sym', v: '\\', tex: '\\', cls: 'cmd' }]);
      return;
    }
    if (ch === ' ' || ch === '\t') {
      if (this.cut().length) return;
      if (this.tryFunction()) return;
      const p = this.parent();
      // Space finishes a script, fraction, root or accent; brackets close with their closing bracket
      if (p && p.node.t !== 'delim' && p.node.t !== 'mat') this.exit(true);
      return;
    }
    const p = this.parent();
    // at the end of a script, the operators that bind looser than it leave it first (x_i^2, x^2/2)
    const atScriptEnd = p && p.node.t === 'scripts' && this.pos === this.row.length && this.row.length > 0 && !this.selection;
    if (ch === '_' || ch === '^') {
      this.tryFunction();
      const key = ch === '_' ? 'sub' : 'sup';
      if (atScriptEnd && p.node.t === 'scripts' && !p.node[key]?.length) this.exit(true);
      return this.script(key);
    }
    if (ch === '/') {
      if (atScriptEnd) this.exit(true);
      return this.fraction();
    }
    if (ch === '(' || ch === '[' || ch === '{' || ch === '⟨' || ch === '⌊' || ch === '⌈') {
      this.tryFunction();
      return this.openDelim(ch);
    }
    if (ch === '|' || ch === '‖') {
      if (!this.selection && this.closeDelim(ch)) return;
      return this.openDelim(ch);
    }
    if (CLOSERS.has(ch)) {
      if (this.closeDelim(ch)) return;
    }
    this.cut();
    this.insert([charSym(ch)]);
    this.autocorrect();
  }

  /** Inserts a structure from the ribbon; the selection goes into its first empty slot. */
  insertTemplate(nodes: MNode[]) {
    this.save();
    if (this.pendingCmd()) this.resolveCmd();
    const sel = this.cut();
    const copy = clone(nodes);
    if (sel.length) {
      const fill = (row: Row): boolean => {
        for (const n of row)
          for (const r of slots(n)) {
            if (!r) continue;
            if (r.length === 0) {
              r.push(...sel);
              return true;
            }
            if (fill(r)) return true;
          }
        return false;
      };
      if (!fill(copy)) copy.unshift(...sel);
    }
    const from = this.pos;
    this.insert(copy);
    // a script with nothing before it: the caret waits where its base goes
    if (copy[0]?.t === 'scripts' && (from === 0 || this.row[from - 1].t !== 'sym' || (this.row[from - 1] as { cls: SymCls }).cls === 'bin' || (this.row[from - 1] as { cls: SymCls }).cls === 'rel')) {
      this.pos = from;
      return;
    }
    this.caretIntoFirstEmpty(from, from + copy.length);
  }

  /** Pasted text: LaTeX is parsed, anything else is typed. */
  paste(text: string) {
    const t = text.trim().replace(/^\$\$?([\s\S]*?)\$?\$$/, '$1');
    if (/\\[a-zA-Z]+\s*\{|\\(frac|sqrt|left|begin)\b/.test(t)) this.insertTemplate(parseTex(t));
    else this.typeText(t);
  }

  /** Finishes a `\name` still being typed (e.g. before closing). */
  finishPending() {
    if (this.pendingCmd()) this.resolveCmd();
  }
}
