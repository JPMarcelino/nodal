import { sym } from '../dsl';

const C = 'Power & Sources';

export const power = [
  sym('gnd', 'Ground', C, {
    w: 40, h: 40, prefix: '#PWR', value: 'GND', hideLabels: true, keywords: 'ground earth 0v common',
    draw: 'L 20 0 20 20; L 6 20 34 20; L 11 26 29 26; L 16 32 24 32',
    ports: 'GND:20,0',
  }),
  sym('gnd-signal', 'Signal ground', C, {
    w: 40, h: 40, prefix: '#PWR', value: 'GND', hideLabels: true, keywords: 'ground triangle',
    draw: 'L 20 0 20 18; G 6 18 34 18 20 34',
    ports: 'GND:20,0',
  }),
  sym('gnd-chassis', 'Chassis ground', C, {
    w: 40, h: 40, prefix: '#PWR', value: 'CHASSIS', hideLabels: true, keywords: 'frame ground',
    draw: 'L 20 0 20 18; L 6 18 34 18; L 6 18 0 30; L 20 18 14 30; L 34 18 28 30',
    ports: 'GND:20,0',
  }),
  sym('gnd-earth', 'Protective earth', C, {
    w: 40, h: 40, prefix: '#PWR', value: 'PE', hideLabels: true, keywords: 'earth pe safety',
    draw: 'L 20 0 20 18; L 6 18 34 18; L 11 24 29 24; L 16 30 24 30; C 20 22 15',
    ports: 'PE:20,0',
  }),
  sym('vcc', 'Supply rail (VCC)', C, {
    w: 40, h: 40, prefix: '#PWR', value: 'VCC', hideLabels: true, valueIsLabel: true, keywords: 'power rail vdd 5v 3v3 supply',
    draw: 'L 20 40 20 16; L 8 16 32 16',
    ports: 'VCC:20,40',
  }),
  sym('vcc-arrow', 'Supply rail (arrow)', C, {
    w: 40, h: 40, prefix: '#PWR', value: '+5V', hideLabels: true, valueIsLabel: true, keywords: 'power rail arrow',
    draw: 'L 20 40 20 14; GF 12 20 20 6 28 20',
    ports: 'VCC:20,40',
  }),
  sym('vee', 'Negative rail (VEE)', C, {
    w: 40, h: 40, prefix: '#PWR', value: '-12V', hideLabels: true, valueIsLabel: true, keywords: 'negative supply vss',
    draw: 'L 20 0 20 24; L 8 24 32 24',
    ports: 'VEE:20,0',
  }),
  sym('battery-cell', 'Battery cell', C, {
    w: 40, h: 40, prefix: 'BT', value: '1.5V', fields: 'Chemistry=Alkaline, Capacity=2000mAh', keywords: 'cell aa',
    draw: 'L 0 20 16 20; L 16 6 16 34; W 4; L 24 13 24 27; W 2; L 24 20 40 20; L 4 8 10 8; L 7 5 7 11',
    ports: '+:0,20 -:40,20',
  }),
  sym('battery', 'Battery', C, {
    w: 60, h: 40, prefix: 'BT', value: '9V', fields: 'Chemistry=Li-ion, Capacity=2000mAh', keywords: 'multi cell pack',
    draw: 'L 0 20 14 20; L 14 6 14 34; W 4; L 21 13 21 27; W 2; D 24 20 36 20; L 39 6 39 34; W 4; L 46 13 46 27; W 2; L 46 20 60 20; L 2 8 8 8; L 5 5 5 11',
    ports: '+:0,20 -:60,20',
  }),
  sym('dc-source', 'DC voltage source', C, {
    w: 40, h: 80, prefix: 'V', value: '5V', keywords: 'voltage source dc supply',
    draw: 'L 20 0 20 20; CB 20 40 20; L 20 60 20 80; L 14 30 26 30; L 20 24 20 36; L 14 50 26 50',
    ports: '+:20,0 -:20,80',
  }),
  sym('ac-source', 'AC voltage source', C, {
    w: 40, h: 80, prefix: 'V', value: '230V 50Hz', fields: 'Frequency=50Hz', keywords: 'sine alternating mains',
    draw: 'L 20 0 20 20; CB 20 40 20; L 20 60 20 80; P M 8 40 Q 14 26 20 40 Q 26 54 32 40',
    ports: '1:20,0 2:20,80',
  }),
  sym('current-source', 'Current source', C, {
    w: 40, h: 80, prefix: 'I', value: '1mA', keywords: 'constant current',
    draw: 'L 20 0 20 20; CB 20 40 20; L 20 60 20 80; L 20 52 20 30; GF 14 32 20 24 26 32',
    ports: '+:20,0 -:20,80',
  }),
  sym('vcvs', 'Dependent voltage source', C, {
    w: 40, h: 80, prefix: 'E', value: 'k·V', keywords: 'controlled vcvs ccvs diamond',
    draw: 'L 20 0 20 20; GB 20 20 40 40 20 60 0 40; L 20 60 20 80; L 14 32 26 32; L 20 26 20 38; L 14 50 26 50',
    ports: '+:20,0 -:20,80',
  }),
  sym('cccs', 'Dependent current source', C, {
    w: 40, h: 80, prefix: 'F', value: 'k·I', keywords: 'controlled vccs cccs diamond',
    draw: 'L 20 0 20 20; GB 20 20 40 40 20 60 0 40; L 20 60 20 80; L 20 52 20 30; GF 14 32 20 24 26 32',
    ports: '+:20,0 -:20,80',
  }),
  sym('pulse-source', 'Pulse source', C, {
    w: 40, h: 80, prefix: 'V', value: 'PULSE', fields: 'Frequency=1kHz, Duty cycle=50%', keywords: 'square clock signal generator',
    draw: 'L 20 0 20 20; CB 20 40 20; L 20 60 20 80; L 8 46 14 46 14 34 26 34 26 46 32 46',
    ports: '1:20,0 2:20,80',
  }),
  sym('solar-cell', 'Solar cell', C, {
    w: 60, h: 40, prefix: 'PV', value: '6V 1W', keywords: 'photovoltaic pv panel',
    draw: 'L 0 30 22 30; L 22 18 22 40; W 4; L 30 24 30 36; W 2; L 30 30 60 30; L 36 2 28 12; GF 28 12 29 6 33 9; L 46 2 38 12; GF 38 12 39 6 43 9',
    ports: '+:0,30 -:60,30',
  }),
  sym('generator', 'Generator', C, {
    w: 40, h: 80, prefix: 'G', value: '', keywords: 'alternator dynamo',
    draw: 'L 20 0 20 20; CB 20 40 20; L 20 60 20 80; T 20 45 16 m G',
    ports: '1:20,0 2:20,80',
  }),
  sym('power-flag', 'Power flag', C, {
    w: 40, h: 40, prefix: '#FLG', value: 'PWR_FLAG', hideLabels: true, keywords: 'erc flag',
    draw: 'L 20 40 20 24; GB 20 24 30 14 20 4 10 14',
    ports: '1:20,40',
  }),
];
