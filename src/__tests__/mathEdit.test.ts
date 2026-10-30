import { describe, expect, it } from 'vitest';
import { EqEditor, parseTex, rowTex } from '../model/mathEdit';

const typed = (s: string) => {
  const e = new EqEditor();
  e.typeText(s);
  e.finishPending();
  return e.toTex();
};

describe('equation editor typing', () => {
  it('turns \\name + space into symbols', () => {
    expect(typed('\\Omega ')).toBe('\\Omega');
    expect(typed('\\alpha +\\beta ')).toBe('\\alpha+\\beta');
    expect(typed('R=10k\\Omega')).toBe('R=10k\\Omega');
  });
  it('_ and ^ start scripts, space leaves them', () => {
    expect(typed('x_2 +y^2 ')).toBe('x_2+y^2');
    expect(typed('x_i^2 ')).toBe('x_i^2');
    expect(typed('e^-j\\omega t ')).toBe('e^{-j\\omega t}');
    expect(typed('V_out ')).toBe('V_{out}');
  });
  it('/ builds a fraction from the operand before it', () => {
    expect(typed('1/2\\pi RC ')).toBe('\\frac{1}{2\\pi RC}');
    expect(typed('(a+b)/c ')).toBe('\\frac{a+b}{c}');
    expect(typed('y=x^2/2 ')).toBe('y=\\frac{x^2}{2}');
    expect(typed('a_k e^x/N ')).toBe('a_k\\frac{e^x}{N}');
    expect(typed('2ab/c ')).toBe('\\frac{2ab}{c}');
    expect(typed('a_k e^x/N ')).toBe('a_k\\frac{e^x}{N}');
    expect(typed('2ab/c ')).toBe('\\frac{2ab}{c}');
  });
  it('brackets, roots and large operators', () => {
    expect(typed('(a+b)')).toBe('\\left(a+b\\right)');
    expect(typed('\\sqrt x+1')).toBe('\\sqrt{x+1}');
    expect(typed('\\sqrt x +1')).toBe('\\sqrt{x}+1');
    expect(typed('\\sum_i=1 ^n x_i ')).toBe('\\sum_{i=1}^n x_i');
    expect(typed('|x|')).toBe('\\left|x\\right|');
  });
  it('functions and autocorrect', () => {
    expect(typed('sin x')).toBe('\\sin x');
    expect(typed('a<=b')).toBe('a\\le b');
    expect(typed('x->0')).toBe('x\\to0');
    expect(typed('a+-b')).toBe('a\\pm b');
    expect(typed('lim_n->\\infty ')).toBe('\\lim_{n\\to\\infty}');
    expect(typed('x\\dot ')).toBe('\\dot{x}');
  });
  it('unknown commands stay as written', () => {
    expect(typed('\\foo ')).toBe('\\foo');
  });
  it('backspace edits a pending command and takes structures apart', () => {
    const e = new EqEditor();
    e.typeText('\\Omegx');
    e.backspace();
    e.typeText('a ');
    expect(e.toTex()).toBe('\\Omega');
    const f = new EqEditor();
    f.typeText('\\sqrt x');
    f.moveLeft();
    f.backspace();
    expect(f.toTex()).toBe('x');
  });
  it('escapes dollars so the formula stays one formula', () => {
    expect(typed('$5')).toBe('\\$5');
  });
  it('undo restores the previous state', () => {
    const e = new EqEditor();
    e.type('x');
    e.type('^');
    e.type('2');
    e.undo();
    expect(e.toTex()).toBe('x^{}');
  });
});

describe('LaTeX round trip', () => {
  const cases = [
    '\\frac{1}{2\\pi RC}',
    'x_i^2',
    '\\sqrt[3]{x}',
    '\\left(a+b\\right)',
    '\\sum_{i=1}^n x_i',
    '\\Omega',
    '\\hat{x}',
    '\\sin\\theta',
    '\\left(\\begin{matrix}a & b \\\\ c & d\\end{matrix}\\right)',
    'V_{\\mathrm{out}}',
    '\\SI{10}{\\kilo\\ohm}',
    '\\begin{aligned}a&=b\\end{aligned}',
  ];
  for (const c of cases)
    it(c, () => {
      expect(rowTex(parseTex(c))).toBe(c);
    });
  it('normalises the matrix environments and \\frac variants', () => {
    expect(rowTex(parseTex('\\pmatrix{a}'))).toBe('\\pmatrix{a}');
    expect(rowTex(parseTex('\\begin{pmatrix}1&0\\\\0&1\\end{pmatrix}'))).toBe('\\left(\\begin{matrix}1 & 0 \\\\ 0 & 1\\end{matrix}\\right)');
    expect(rowTex(parseTex('\\dfrac12'))).toBe('\\frac{1}{2}');
  });
});
