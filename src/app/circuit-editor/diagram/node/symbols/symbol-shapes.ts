import { COMPONENT_CATALOG } from '../../model/component-catalog';
import { ComponentType } from '../../model/component-types';

/**
 * Inner SVG markup for each schematic symbol, drawn in its catalog viewBox
 * coordinates. Shapes use `currentColor` so the colour comes from the host: the
 * on-canvas node sets it per selection state, the vector SVG export sets a fixed
 * ink. Single source of truth shared by `ComponentSymbolComponent` (live render)
 * and `ExportService` (file export) — keep both pointed here so they never drift.
 */
export function symbolBody(type: ComponentType): string {
  switch (type) {
    case ComponentType.Resistor:
      return `<polyline points="0,18 36,18 40,9 48,27 56,9 64,27 72,9 80,27 84,18 120,18" />`;
    case ComponentType.Capacitor:
      return (
        `<line x1="0" y1="20" x2="38" y2="20" />` +
        `<line x1="38" y1="8" x2="38" y2="32" />` +
        `<line x1="46" y1="8" x2="46" y2="32" />` +
        `<line x1="46" y1="20" x2="84" y2="20" />`
      );
    case ComponentType.Inductor:
      return (
        `<line x1="0" y1="18" x2="30" y2="18" />` +
        `<path d="M30 18 a7.5 7.5 0 0 1 15 0 a7.5 7.5 0 0 1 15 0 a7.5 7.5 0 0 1 15 0 a7.5 7.5 0 0 1 15 0" />` +
        `<line x1="90" y1="18" x2="120" y2="18" />`
      );
    case ComponentType.Potentiometer:
      return (
        `<polyline points="0,24 40,24 44,15 52,33 60,15 68,33 76,15 84,33 88,24 128,24" />` +
        `<line x1="64" y1="0" x2="64" y2="14" />` +
        `<path d="M58 14 L70 14 L64 24 Z" fill="currentColor" stroke="none" />`
      );
    case ComponentType.Fuse:
      return (
        `<line x1="0" y1="18" x2="96" y2="18" />` +
        `<rect x="26" y="9" width="44" height="18" rx="3" />`
      );
    case ComponentType.Crystal:
      return (
        `<line x1="0" y1="20" x2="30" y2="20" />` +
        `<line x1="30" y1="8" x2="30" y2="32" />` +
        `<rect x="38" y="10" width="12" height="20" />` +
        `<line x1="58" y1="8" x2="58" y2="32" />` +
        `<line x1="58" y1="20" x2="88" y2="20" />`
      );
    case ComponentType.Diode:
      return (
        `<line x1="0" y1="18" x2="36" y2="18" />` +
        `<path d="M36 8 L36 28 L58 18 Z" />` +
        `<line x1="58" y1="8" x2="58" y2="28" />` +
        `<line x1="58" y1="18" x2="96" y2="18" />`
      );
    case ComponentType.ZenerDiode:
      return (
        `<line x1="0" y1="18" x2="36" y2="18" />` +
        `<path d="M36 8 L36 28 L58 18 Z" />` +
        `<path d="M52 8 L58 8 L58 28 L64 28" />` +
        `<line x1="58" y1="18" x2="96" y2="18" />`
      );
    case ComponentType.TransistorNpn:
      return bjtBody(true);
    case ComponentType.TransistorPnp:
      return bjtBody(false);
    case ComponentType.Switch:
      return (
        `<line x1="0" y1="18" x2="28" y2="18" />` +
        `<circle cx="28" cy="18" r="3" fill="currentColor" stroke="none" />` +
        `<line x1="28" y1="18" x2="62" y2="6" />` +
        `<circle cx="68" cy="18" r="3" fill="currentColor" stroke="none" />` +
        `<line x1="68" y1="18" x2="96" y2="18" />`
      );
    case ComponentType.PushButton:
      return (
        `<line x1="0" y1="32" x2="30" y2="32" />` +
        `<line x1="66" y1="32" x2="96" y2="32" />` +
        `<line x1="30" y1="32" x2="30" y2="26" />` +
        `<line x1="66" y1="32" x2="66" y2="26" />` +
        `<line x1="26" y1="26" x2="70" y2="26" />` +
        `<line x1="48" y1="26" x2="48" y2="12" />` +
        `<line x1="38" y1="12" x2="58" y2="12" />`
      );
    case ComponentType.Led:
      return (
        `<line x1="0" y1="24" x2="34" y2="24" />` +
        `<path d="M34 12 L34 36 L56 24 Z" />` +
        `<line x1="56" y1="12" x2="56" y2="36" />` +
        `<line x1="56" y1="24" x2="96" y2="24" />` +
        `<line x1="52" y1="14" x2="64" y2="2" />` +
        `<polyline points="58,2 64,2 64,8" />` +
        `<line x1="60" y1="18" x2="72" y2="6" />` +
        `<polyline points="66,6 72,6 72,12" />`
      );
    case ComponentType.Battery:
      return (
        `<line x1="0" y1="18" x2="34" y2="18" />` +
        `<line x1="34" y1="6" x2="34" y2="30" />` +
        `<line x1="42" y1="11" x2="42" y2="25" />` +
        `<line x1="50" y1="6" x2="50" y2="30" />` +
        `<line x1="58" y1="11" x2="58" y2="25" />` +
        `<line x1="58" y1="18" x2="96" y2="18" />`
      );
    case ComponentType.VoltageSource:
      return `<path d="M24 6 L13 30 L35 30 Z" />` + `<line x1="24" y1="30" x2="24" y2="64" />`;
    case ComponentType.Ground:
      return (
        `<line x1="24" y1="0" x2="24" y2="28" />` +
        `<line x1="8" y1="28" x2="40" y2="28" />` +
        `<line x1="14" y1="38" x2="34" y2="38" />` +
        `<line x1="20" y1="46" x2="28" y2="46" />`
      );
    case ComponentType.Ne555:
      return ne555Body();
  }
}

// BJT (viewBox 96×96): base lead on the left to a vertical base plate, with the
// collector lead leaving top-right and the emitter bottom-right. The emitter
// arrow points away from the base for NPN, toward it for PNP.
function bjtBody(npn: boolean): string {
  const structure =
    `<line x1="0" y1="48" x2="36" y2="48" />` + // base lead
    `<line x1="36" y1="30" x2="36" y2="66" />` + // base plate
    `<line x1="36" y1="42" x2="64" y2="20" />` + // collector diagonal
    `<line x1="64" y1="20" x2="64" y2="0" />` + // collector lead
    `<line x1="36" y1="54" x2="64" y2="76" />` + // emitter diagonal
    `<line x1="64" y1="76" x2="64" y2="96" />`; // emitter lead
  const arrow = npn
    ? `<path d="M55.6 69.4 L46 67 L51 60.7 Z" fill="currentColor" stroke="none" />`
    : `<path d="M43 59.5 L47.6 68.3 L52.6 62 Z" fill="currentColor" stroke="none" />`;
  return structure + arrow;
}

/**
 * NE555 as a functional IC symbol: a rectangular body with 24-unit leads on all
 * four sides. Each lead carries its DIP-8 pin number just outside the body and
 * its pin name just inside, both driven by the catalog port list so the
 * drawing can never disagree with where the wires attach.
 */
function ne555Body(): string {
  const { symbol, ports } = COMPONENT_CATALOG[ComponentType.Ne555];
  const { width, height } = symbol;
  /** Lead length (symbol units) from the box edge to the IC body. */
  const LEAD = 24;
  const PIN_FONT = 9;
  const NAME_FONT = 10;
  const parts: string[] = [
    `<rect x="${LEAD}" y="${LEAD}" width="${width - 2 * LEAD}" height="${height - 2 * LEAD}" rx="4" />`,
  ];
  const text = (x: number, y: number, anchor: string, size: number, value: string) =>
    `<text x="${x}" y="${y}" text-anchor="${anchor}" fill="currentColor" stroke="none" font-size="${size}">${value}</text>`;

  for (const port of ports) {
    const x = port.cx * width;
    const y = port.cy * height;
    const pin = port.pin ?? '';
    const name = port.name ?? '';
    switch (port.side) {
      case 'left':
        parts.push(`<line x1="0" y1="${y}" x2="${LEAD}" y2="${y}" />`);
        parts.push(text(LEAD / 2, y - 4, 'middle', PIN_FONT, pin));
        parts.push(text(LEAD + 6, y + 4, 'start', NAME_FONT, name));
        break;
      case 'right':
        parts.push(`<line x1="${width - LEAD}" y1="${y}" x2="${width}" y2="${y}" />`);
        parts.push(text(width - LEAD / 2, y - 4, 'middle', PIN_FONT, pin));
        parts.push(text(width - LEAD - 6, y + 4, 'end', NAME_FONT, name));
        break;
      case 'top':
        parts.push(`<line x1="${x}" y1="0" x2="${x}" y2="${LEAD}" />`);
        parts.push(text(x + 5, LEAD - 6, 'start', PIN_FONT, pin));
        parts.push(text(x, LEAD + 14, 'middle', NAME_FONT, name));
        break;
      case 'bottom':
        parts.push(`<line x1="${x}" y1="${height - LEAD}" x2="${x}" y2="${height}" />`);
        parts.push(text(x + 5, height - LEAD + 12, 'start', PIN_FONT, pin));
        parts.push(text(x, height - LEAD - 8, 'middle', NAME_FONT, name));
        break;
    }
  }
  return parts.join('');
}
