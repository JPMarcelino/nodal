import { chip } from '../chip';
import { sym } from '../dsl';

const C = 'Meters & Test';
const meter = (id: string, name: string, letter: string, prefix: string, keywords: string) =>
  sym(id, name, C, { w: 80, h: 40, prefix, keywords, draw: `L 0 20 20 20; L 60 20 80 20; CB 40 20 19; T 40 26 17 m ${letter}`, ports: '+:0,20 -:80,20' });

export const meters = [
  meter('voltmeter', 'Voltmeter', 'V', 'MV', 'voltage measure meter'),
  meter('ammeter', 'Ammeter', 'A', 'MA', 'current measure meter'),
  meter('ohmmeter', 'Ohmmeter', 'Ω', 'MΩ', 'resistance measure meter'),
  sym('galvanometer', 'Galvanometer', C, { w: 80, h: 40, prefix: 'G', keywords: 'meter needle', draw: 'L 0 20 20 20; L 60 20 80 20; CB 40 20 19; L 32 30 48 10; GF 50 7.5 43.6 10.1 48.3 13.9', ports: '+:0,20 -:80,20' }),
  sym('wattmeter', 'Wattmeter', C, { w: 80, h: 60, prefix: 'MW', keywords: 'power measure meter', draw: 'L 0 20 22 20; L 0 40 22 40; L 58 20 80 20; L 58 40 80 40; CB 40 30 21; T 40 37 18 m W', ports: 'I+:0,20 I-:0,40 V+:80,20 V-:80,40' }),
  sym('oscilloscope', 'Oscilloscope', C, {
    w: 100, h: 80, prefix: 'OSC', keywords: 'scope measure probe',
    draw: 'L 0 20 14 20; L 0 40 14 40; L 0 60 14 60; RB 14 4 82 72 4; R 22 12 66 46 2; W 1.5; P M 26 35 Q 34 15 42 35 Q 50 55 58 35 Q 66 15 74 35 Q 78 44 84 38; W 2; T 30 70 7 s CH1 CH2 GND',
    ports: 'CH1:0,20 CH2:0,40 GND:0,60',
  }),
  chip('frequency-counter', 'Frequency counter', C, { left: ['IN', 'GND'], title: 'Hz', prefix: 'FC', keywords: 'frequency measure', numbers: false }),
  sym('function-generator', 'Function generator', C, {
    w: 80, h: 60, prefix: 'FG', keywords: 'signal generator sine square',
    draw: 'L 60 20 80 20; L 60 40 80 40; RB 4 4 56 52 4; W 1.5; P M 12 24 Q 18 10 24 24 Q 30 38 36 24; L 12 44 18 44 18 36 26 36 26 44 32 44; W 2; T 48 23 7 m OUT; T 48 43 7 m GND',
    ports: 'OUT:80,20 GND:80,40',
  }),
  sym('test-point', 'Test point', C, { w: 20, h: 40, prefix: 'TP', keywords: 'probe pad measure', draw: 'L 10 40 10 22; CB 10 14 8; CF 10 14 2.5', ports: 'TP:10,40' }),
  sym('probe', 'Probe', C, { w: 20, h: 40, prefix: 'P', keywords: 'scope probe tip', draw: 'L 10 40 10 26; GB 4 26 16 26 10 4', ports: 'P:10,40' }),
];
