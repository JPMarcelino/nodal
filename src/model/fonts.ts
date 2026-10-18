/** Font families offered for text; sans (the app's own font) is the absence of a choice. */
export type FontName = 'serif' | 'mono';

export const FONT_STACKS: Record<FontName, string> = {
  serif: 'Georgia, "Times New Roman", serif',
  mono: 'ui-monospace, "SF Mono", Menlo, Consolas, monospace',
};

/** The font choices, in the order they are listed ('' = sans). */
export const FONT_OPTIONS: { value: FontName | ''; label: string }[] = [
  { value: '', label: 'Sans' },
  { value: 'serif', label: 'Serif' },
  { value: 'mono', label: 'Mono' },
];
