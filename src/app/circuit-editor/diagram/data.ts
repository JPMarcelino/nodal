import { type Edge, type Node, type Point } from 'ng-diagram';
import { COMPONENT_CATALOG, getNodeSize } from './model/component-catalog';
import {
  CIRCUIT_NODE_TYPE,
  ComponentType,
  WIRE_EDGE_TYPE,
  type CircuitEdgeData,
  type CircuitNodeData,
} from './model/component-types';
import { junctionNodeAt } from './wire/junction/geometry';
import { JUNCTION_PORT_IDS } from './wire/junction/model';

interface SeedNode {
  id: string;
  type: ComponentType;
  position: Point;
  angle?: number;
  reference: string;
  value?: string;
  description?: string;
  specs?: Record<string, string>;
}

interface SeedJunction {
  id: string;
  /** Centre of the solder dot. */
  centre: Point;
}

/** One end of a wire: a component port or a junction side. */
type SeedTerminal = [nodeId: string, portId: string];

interface SeedWire {
  id: string;
  from: SeedTerminal;
  to: SeedTerminal;
}

const seedNodes: SeedNode[] = [
  // ── Timing chain (left column, x = 336) ──────────────────────────────────
  {
    id: 'v1',
    type: ComponentType.VoltageSource,
    position: { x: 312, y: 0 },
    reference: '+5V',
    description: 'Supply rail for the timing chain',
    specs: { net: 'VCC' },
  },
  {
    id: 'r1',
    type: ComponentType.Resistor,
    position: { x: 280, y: 136 },
    angle: 90,
    reference: 'R1',
    value: '1kΩ',
    description: 'Charge resistor (RA) — sets the high time together with R2',
  },
  {
    id: 'r2',
    type: ComponentType.Resistor,
    position: { x: 280, y: 320 },
    angle: 90,
    reference: 'R2',
    value: '680kΩ',
    description: 'Timing resistor (RB) — sets the low time',
  },
  {
    id: 'c1',
    type: ComponentType.Capacitor,
    position: { x: 296, y: 480 },
    angle: 90,
    reference: 'C1',
    value: '1µF',
    description: 'Timing capacitor — with R1/R2 gives f ≈ 1 Hz',
    specs: { voltage: '50V', package: 'Film' },
  },
  {
    id: 'gnd1',
    type: ComponentType.Ground,
    position: { x: 312, y: 600 },
    reference: 'GND',
    specs: { net: 'GND' },
  },

  // ── Timer (centre) ───────────────────────────────────────────────────────
  {
    id: 'u1',
    type: ComponentType.Ne555,
    position: { x: 480, y: 176 },
    reference: 'U1',
    value: 'NE555',
    description: 'Astable multivibrator, ~1 Hz, ~50 % duty cycle',
  },
  {
    id: 'v2',
    type: ComponentType.VoltageSource,
    position: { x: 528, y: 32 },
    reference: '+5V',
    description: 'Supply to VCC (8) and RESET (4)',
    specs: { net: 'VCC' },
  },
  {
    id: 'gnd2',
    type: ComponentType.Ground,
    position: { x: 528, y: 400 },
    reference: 'GND',
    specs: { net: 'GND' },
  },
  {
    id: 'c2',
    type: ComponentType.Capacitor,
    position: { x: 632, y: 360 },
    reference: 'C2',
    value: '10nF',
    description: 'Control-voltage (pin 5) decoupling',
    specs: { voltage: '50V', package: 'Ceramic' },
  },
  {
    id: 'gnd4',
    type: ComponentType.Ground,
    position: { x: 728, y: 416 },
    reference: 'GND',
    specs: { net: 'GND' },
  },

  // ── Output stage (right) ─────────────────────────────────────────────────
  {
    id: 'r3',
    type: ComponentType.Resistor,
    position: { x: 688, y: 248 },
    reference: 'R3',
    value: '330Ω',
    description: 'LED current limiter (≈ 9 mA at 5 V)',
  },
  {
    id: 'led1',
    type: ComponentType.Led,
    position: { x: 856, y: 240 },
    reference: 'LED1',
    value: 'Red',
    description: 'Blinks at ≈ 1 Hz',
  },
  {
    id: 'gnd3',
    type: ComponentType.Ground,
    position: { x: 960, y: 320 },
    reference: 'GND',
    specs: { net: 'GND' },
  },
];

const seedJunctions: SeedJunction[] = [
  { id: 'j7', centre: { x: 336, y: 264 } }, // R1 / R2 / DIS (7)
  { id: 'j6', centre: { x: 336, y: 448 } }, // R2 / C1 / THR-TRIG net
  { id: 'j2', centre: { x: 400, y: 312 } }, // THR (6) / TRIG (2) tie
  { id: 'j8', centre: { x: 552, y: 152 } }, // +5V / VCC (8) / RESET (4)
];

const { top, right, bottom } = JUNCTION_PORT_IDS;

const seedWires: SeedWire[] = [
  // Timing chain
  { id: 'w-v1-r1', from: ['v1', 'p1'], to: ['r1', 'p1'] },
  { id: 'w-r1-j7', from: ['r1', 'p2'], to: ['j7', top] },
  { id: 'w-j7-dis', from: ['j7', right], to: ['u1', 'p7'] },
  { id: 'w-j7-r2', from: ['j7', bottom], to: ['r2', 'p1'] },
  { id: 'w-r2-j6', from: ['r2', 'p2'], to: ['j6', top] },
  { id: 'w-j6-c1', from: ['j6', bottom], to: ['c1', 'p1'] },
  { id: 'w-c1-gnd', from: ['c1', 'p2'], to: ['gnd1', 'p1'] },
  // Threshold / trigger tie
  { id: 'w-j6-j2', from: ['j6', right], to: ['j2', bottom] },
  { id: 'w-j2-thr', from: ['j2', top], to: ['u1', 'p6'] },
  { id: 'w-j2-trig', from: ['j2', right], to: ['u1', 'p2'] },
  // Supply
  { id: 'w-v2-j8', from: ['v2', 'p1'], to: ['j8', top] },
  { id: 'w-j8-vcc', from: ['j8', bottom], to: ['u1', 'p8'] },
  { id: 'w-j8-rst', from: ['j8', right], to: ['u1', 'p4'] },
  // Ground & control voltage
  { id: 'w-gnd-gnd2', from: ['u1', 'p1'], to: ['gnd2', 'p1'] },
  { id: 'w-cv-c2', from: ['u1', 'p5'], to: ['c2', 'p1'] },
  { id: 'w-c2-gnd', from: ['c2', 'p2'], to: ['gnd4', 'p1'] },
  // Output
  { id: 'w-out-r3', from: ['u1', 'p3'], to: ['r3', 'p1'] },
  { id: 'w-r3-led', from: ['r3', 'p2'], to: ['led1', 'p1'] },
  { id: 'w-led-gnd', from: ['led1', 'p2'], to: ['gnd3', 'p1'] },
];

// ── Builders ─────────────────────────────────────────────────────────────────

function buildNode(seed: SeedNode): Node<CircuitNodeData> {
  const def = COMPONENT_CATALOG[seed.type];
  return {
    id: seed.id,
    position: seed.position,
    angle: seed.angle,
    type: CIRCUIT_NODE_TYPE,
    size: getNodeSize(def),
    autoSize: false,
    data: {
      label: def.label,
      componentType: seed.type,
      reference: seed.reference,
      value: seed.value ?? def.defaultValue,
      description: seed.description ?? '',
      specs: { ...def.defaultSpecs, ...seed.specs },
    },
  };
}

function buildJunction(seed: SeedJunction): Node {
  return junctionNodeAt(seed.centre, seed.id);
}

function buildWire(seed: SeedWire): Edge<CircuitEdgeData> {
  return {
    id: seed.id,
    source: seed.from[0],
    sourcePort: seed.from[1],
    target: seed.to[0],
    targetPort: seed.to[1],
    type: WIRE_EDGE_TYPE,
    data: { kind: 'wire' },
  };
}

export const diagramModel: {
  nodes: Node[];
  edges: Edge<CircuitEdgeData>[];
} = {
  nodes: [...seedNodes.map(buildNode), ...seedJunctions.map(buildJunction)],
  edges: seedWires.map(buildWire),
};
