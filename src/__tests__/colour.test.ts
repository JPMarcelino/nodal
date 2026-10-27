import { describe, expect, it } from 'vitest';
import { colourLightness } from '../model/colour';

const RED = 0.2126;
const GREEN = 0.7152;
const BLUE = 0.0722;

/** Resolve a colour's lightness, failing on the spot when it is unreadable. */
function light(colour: string): number {
  const value = colourLightness(colour);
  expect(value).not.toBeNull();
  return value as number;
}

describe('colourLightness', () => {
  it('reads named and hex colours, including alpha forms', () => {
    expect(light('black')).toBe(0);
    expect(light('white')).toBe(1);
    expect(light('red')).toBeCloseTo(RED, 5);
    expect(light('lime')).toBeCloseTo(GREEN, 5);
    expect(light('blue')).toBeCloseTo(BLUE, 5);

    for (const value of ['#f00', '#f00f', '#ff0000', '#ff0000ff', '#FF0000']) {
      expect(light(value)).toBeCloseTo(RED, 5);
    }
    const grey = light('#aabbcc');
    for (const value of ['#abc', '#abcf', '#aabbccff']) {
      expect(light(value)).toBeCloseTo(grey, 5);
    }
  });

  it('reads rgb/rgba in comma and slash forms', () => {
    for (const value of [
      'rgb(255, 0, 0)',
      'rgba(255, 0, 0, .5)',
      'rgb(255 0 0 / .5)',
      'rgb(100% 0% 0%)',
    ]) {
      expect(light(value)).toBeCloseTo(RED, 5);
    }
    const legacy = light('rgb(1, 2, 3, .5)');
    expect(legacy).toBeCloseTo(light('rgb(1 2 3 / .5)'), 6);
    expect(legacy).toBeCloseTo(light('rgb(1 2 3)'), 6);
  });

  it('reads hsl and converts grad/rad/turn hues', () => {
    expect(light('hsl(0 100% 50%)')).toBeCloseTo(RED, 5);
    expect(light('hsla(0, 100%, 50%, .5)')).toBeCloseTo(RED, 5);
    for (const value of [
      'hsl(120deg 100% 50%)',
      'hsl(133.333333grad 100% 50%)',
      'hsl(2.094395102rad 100% 50%)',
      'hsl(0.333333333turn 100% 50%)',
    ]) {
      expect(light(value)).toBeCloseTo(GREEN, 4);
    }
  });

  it('reads hwb and treats w + b >= 1 as a pure grey', () => {
    expect(light('hwb(0 0% 0%)')).toBeCloseTo(RED, 5);
    for (const value of [
      'hwb(120deg 0% 0%)',
      'hwb(133.333333grad 0% 0%)',
      'hwb(2.094395102rad 0% 0%)',
      'hwb(0.333333333turn 0% 0%)',
    ]) {
      expect(light(value)).toBeCloseTo(GREEN, 4);
    }
    // The mid-green page colour from the bug report: 60% + 60% must be grey 0.5, not 0.6.
    expect(light('hwb(100deg 60% 60%)')).toBeCloseTo(0.5, 6);
    expect(light('hwb(0 50% 50%)')).toBeCloseTo(0.5, 6);
    expect(light('hwb(0 80% 20%)')).toBeCloseTo(0.8, 6);
    expect(light('hwb(0 100% 0%)')).toBeCloseTo(1, 6);
    expect(light('hwb(0 0% 100%)')).toBeCloseTo(0, 6);
  });

  it('reads oklab and oklch against the sRGB primaries', () => {
    expect(light('oklab(0 0 0)')).toBe(0);
    expect(light('oklab(1 0 0)')).toBeCloseTo(1, 6);
    expect(light('oklab(0.627955 0.224863 0.125846)')).toBeCloseTo(RED, 4);
    expect(light('oklab(0.86644 -0.233888 0.179498)')).toBeCloseTo(GREEN, 4);
    expect(light('oklab(0.452014 -0.032458 -0.311528)')).toBeCloseTo(BLUE, 4);

    expect(light('oklch(0 0 0)')).toBe(0);
    expect(light('oklch(1 0 0)')).toBeCloseTo(1, 6);
    expect(light('oklch(0.627955 0.257683 29.2339)')).toBeCloseTo(RED, 4);
    expect(light('oklch(0.86644 0.294828 142.495)')).toBeCloseTo(GREEN, 4);
    expect(light('oklch(0.452014 0.313214 264.052)')).toBeCloseTo(BLUE, 4);
  });

  it('reads D50 lab and lch against the sRGB primaries', () => {
    expect(light('lab(0 0 0)')).toBe(0);
    expect(light('lab(100 0 0)')).toBeCloseTo(1, 4);
    expect(light('lch(50 0 0)')).toBeCloseTo(light('lab(50 0 0)'), 6);
    expect(light('lab(54.29 80.82 69.89)')).toBeCloseTo(RED, 4);
    expect(light('lab(87.82 -79.27 80.99)')).toBeCloseTo(GREEN, 4);
    expect(light('lab(29.57 68.30 -112.03)')).toBeCloseTo(BLUE, 4);
    expect(light('lch(54.29 106.84 40.85)')).toBeCloseTo(RED, 4);
    expect(light('lch(87.82 113.34 134.38)')).toBeCloseTo(GREEN, 4);
    expect(light('lch(29.57 131.21 301.37)')).toBeCloseTo(BLUE, 4);
  });

  it('reads color(srgb ...) with numbers, percentages and alpha', () => {
    expect(light('color(srgb 1 0 0)')).toBeCloseTo(RED, 6);
    expect(light('color(srgb 100% 0% 0%)')).toBeCloseTo(RED, 6);
    expect(light('color(srgb 0.5 0.5 0.5)')).toBeCloseTo(0.5, 6);
    expect(light('color(srgb 0.5 0.5 0.5 / .5)')).toBeCloseTo(0.5, 6);
  });

  it('returns null for transparent and for colours only a browser can resolve', () => {
    // These all need getComputedStyle/canvas, which the node test environment does not have.
    for (const value of [
      '',
      'transparent',
      '  TRANSPARENT  ',
      'var(--canvas)',
      'color-mix(in srgb, red, blue)',
      'color(display-p3 1 0 0)',
      'currentColor',
    ]) {
      expect(colourLightness(value)).toBeNull();
    }
  });
});
