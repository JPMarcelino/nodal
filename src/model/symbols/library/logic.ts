import { chip } from '../chip';
import { sym } from '../dsl';

const C = 'Logic';
const IN2 = 'L 0 10 18 10; L 0 30 18 30';
const IN3 = 'L 0 10 18 10; L 0 30 24 30; L 0 50 18 50';
const AND = 'PB M 16 2 H 44 A 18 18 0 0 1 44 38 H 16 Z';
const AND3 = 'PB M 16 2 H 42 A 28 28 0 0 1 42 58 H 16 Z';
const OR = 'PB M 12 2 Q 32 2 48 8 Q 58 13 64 20 Q 58 27 48 32 Q 32 38 12 38 Q 22 20 12 2 Z';
const OR3 = 'PB M 12 2 Q 36 2 54 12 Q 64 20 70 30 Q 64 40 54 48 Q 36 58 12 58 Q 25 30 12 2 Z';
const XOR_BACK = 'P M 5 2 Q 15 20 5 38';
const BUBBLE = (x: number, y: number) => `CB ${x} ${y} 4`;
const SCHMITT = 'W 1.5; P M 27 24 H 36 V 16 M 31 24 V 16 H 40; W 2';
const gate = (id: string, name: string, draw: string, ports = 'A:0,10 B:0,30 Y:80,20', h = 40, value = '') =>
  sym(id, name, C, { w: 80, h, prefix: 'U', value, keywords: 'gate logic boolean digital', draw, ports });

export const logic = [
  gate('and-gate', 'AND gate', `${IN2}; L 62 20 80 20; ${AND}`, undefined, 40, '74HC08'),
  gate('nand-gate', 'NAND gate', `${IN2}; L 70 20 80 20; ${AND}; ${BUBBLE(66, 20)}`, undefined, 40, '74HC00'),
  gate('or-gate', 'OR gate', `${IN2}; L 64 20 80 20; ${OR}`, undefined, 40, '74HC32'),
  gate('nor-gate', 'NOR gate', `${IN2}; L 72 20 80 20; ${OR}; ${BUBBLE(68, 20)}`, undefined, 40, '74HC02'),
  gate('xor-gate', 'XOR gate', `${IN2}; L 64 20 80 20; ${OR}; ${XOR_BACK}`, undefined, 40, '74HC86'),
  gate('xnor-gate', 'XNOR gate', `${IN2}; L 72 20 80 20; ${OR}; ${XOR_BACK}; ${BUBBLE(68, 20)}`, undefined, 40, '74HC266'),
  gate('not-gate', 'NOT gate (inverter)', 'L 0 20 20 20; L 64 20 80 20; GB 20 4 20 36 56 20; CB 60 20 4', 'A:0,20 Y:80,20', 40, '74HC04'),
  gate('buffer', 'Buffer', 'L 0 20 20 20; L 60 20 80 20; GB 20 4 20 36 60 20', 'A:0,20 Y:80,20', 40, '74HC125'),
  gate('schmitt-buffer', 'Schmitt trigger', `L 0 20 20 20; L 60 20 80 20; GB 20 4 20 36 60 20; ${SCHMITT}`, 'A:0,20 Y:80,20', 40, '74HC17'),
  gate('inverter-schmitt', 'Schmitt inverter', `L 0 20 20 20; L 64 20 80 20; GB 20 4 20 36 56 20; CB 60 20 4; ${SCHMITT}`, 'A:0,20 Y:80,20', 40, '74HC14'),
  gate('buffer-tri', 'Tri-state buffer', 'L 0 20 20 20; L 60 20 80 20; L 40 40 40 28; GB 20 4 20 36 60 20', 'A:0,20 Y:80,20 EN:40,40', 40, '74HC125'),
  gate('and3-gate', 'AND gate (3 inputs)', `${IN3}; L 70 30 80 30; ${AND3}`, 'A:0,10 B:0,30 C:0,50 Y:80,30', 60, '74HC11'),
  gate('nand3-gate', 'NAND gate (3 inputs)', `${IN3}; L 74 30 80 30; ${AND3}; ${BUBBLE(74, 30)}`, 'A:0,10 B:0,30 C:0,50 Y:80,30', 60, '74HC10'),
  gate('or3-gate', 'OR gate (3 inputs)', `${IN3}; L 70 30 80 30; ${OR3}`, 'A:0,10 B:0,30 C:0,50 Y:80,30', 60, '74HC4075'),
  chip('d-flipflop', 'D flip-flop', C, { left: ['D', 'CLK'], right: ['Q', '~Q'], top: ['PRE'], bottom: ['CLR'], value: '74HC74', keywords: 'register latch sequential', numbers: false }),
  chip('jk-flipflop', 'JK flip-flop', C, { left: ['J', 'CLK', 'K'], right: ['Q', '~Q'], value: '74HC107', keywords: 'sequential', numbers: false }),
  chip('t-flipflop', 'T flip-flop', C, { left: ['T', 'CLK'], right: ['Q', '~Q'], value: '', keywords: 'toggle sequential', numbers: false }),
  chip('sr-latch', 'SR latch', C, { left: ['S', 'R'], right: ['Q', '~Q'], value: '74HC279', keywords: 'set reset sequential', numbers: false }),
  chip('mux2', 'Multiplexer 2:1', C, { left: ['I0', 'I1'], right: ['Y'], bottom: ['SEL'], title: 'MUX', value: '74HC157', keywords: 'selector', numbers: false }),
  chip('mux4', 'Multiplexer 4:1', C, { left: ['I0', 'I1', 'I2', 'I3'], right: ['Y'], bottom: ['S0', 'S1'], title: 'MUX', value: '74HC153', keywords: 'selector', numbers: false }),
  chip('demux2', 'Demultiplexer 1:2', C, { left: ['IN'], right: ['Y0', 'Y1'], bottom: ['SEL'], title: 'DEMUX', value: '74HC139', keywords: 'decoder', numbers: false }),
  chip('decoder-3to8', 'Decoder 3→8', C, { left: ['A0', 'A1', 'A2', 'E1', '~E2', '~E3'], right: ['~Y0', '~Y1', '~Y2', '~Y3', '~Y4', '~Y5', '~Y6', '~Y7'], title: '138', value: '74HC138', keywords: 'decoder demux', numbers: false }),
  chip('half-adder', 'Half adder', C, { left: ['A', 'B'], right: ['S', 'C'], title: 'HA', keywords: 'arithmetic', numbers: false }),
  chip('full-adder', 'Full adder', C, { left: ['A', 'B', 'CIN'], right: ['S', 'COUT'], title: 'FA', keywords: 'arithmetic', numbers: false }),
  chip('counter-4bit', 'Counter (4-bit)', C, { left: ['CLK', 'RST', 'EN'], right: ['Q0', 'Q1', 'Q2', 'Q3'], title: 'CTR', value: '74HC161', keywords: 'binary counter', numbers: false }),
  chip('shift-register', 'Shift register (595)', C, { left: ['SER', 'SRCLK', 'RCLK', '~OE', '~SRCLR'], right: ['QA', 'QB', 'QC', 'QD', 'QE', 'QF', 'QG', 'QH', "QH'"], title: '595', value: '74HC595', keywords: 'serial parallel output', numbers: false }),
  sym('clock-source', 'Clock source', C, { w: 60, h: 40, prefix: 'X', value: '1kHz', keywords: 'oscillator square signal', draw: 'CB 20 20 16; W 1.5; L 10 24 15 24 15 16 21 16 21 24 26 24 26 16 30 16; W 2; L 36 20 60 20', ports: 'CLK:60,20' }),
  sym('logic-high', 'Logic high (1)', C, { w: 40, h: 40, prefix: '#PWR', value: 'HIGH', hideLabels: true, keywords: 'tie high vcc constant', draw: 'L 20 40 20 24; RB 8 6 24 18 2; T 20 19 11 m 1', ports: 'H:20,40' }),
  sym('logic-low', 'Logic low (0)', C, { w: 40, h: 40, prefix: '#PWR', value: 'LOW', hideLabels: true, keywords: 'tie low gnd constant', draw: 'L 20 0 20 16; RB 8 16 24 18 2; T 20 29 11 m 0', ports: 'L:20,0' }),
];
