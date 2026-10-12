import { chip } from '../chip';
import { sym } from '../dsl';

const C = 'Switches & Relays';
const SW = (y: number) => `L 0 ${y} 20 ${y}; CB 22 ${y} 2.5; L 24 ${y - 1} 56 ${y - 14}; CB 58 ${y} 2.5; L 60.5 ${y} 80 ${y}`;
const COIL = 'L 20 0 20 16; RB 6 16 28 28; L 20 44 20 60; L 6 38 34 22';

export const electromechanical = [
  sym('switch-spst', 'Switch (SPST)', C, { w: 80, h: 40, prefix: 'SW', value: '', fields: 'Rating=250V 3A', keywords: 'toggle on off single pole', draw: SW(30), ports: '1:0,30 2:80,30' }),
  sym('switch-spdt', 'Switch (SPDT)', C, {
    w: 80, h: 40, prefix: 'SW', value: '', keywords: 'changeover single pole double throw',
    draw: 'L 0 30 20 30; CB 22 30 2.5; L 24 29 55 12; CB 58 10 2.5; L 60.5 10 80 10; CB 58 30 2.5; L 60.5 30 80 30',
    ports: 'COM:0,30 A:80,10 B:80,30',
  }),
  sym('switch-dpst', 'Switch (DPST)', C, { w: 80, h: 60, prefix: 'SW', keywords: 'double pole', draw: `${SW(20)}; ${SW(50)}; D 40 14 40 42`, ports: '1:0,20 2:80,20 3:0,50 4:80,50' }),
  sym('switch-dpdt', 'Switch (DPDT)', C, {
    w: 80, h: 80, prefix: 'SW', keywords: 'double pole double throw changeover',
    draw: 'L 0 30 20 30; CB 22 30 2.5; L 24 29 55 12; CB 58 10 2.5; L 60.5 10 80 10; CB 58 30 2.5; L 60.5 30 80 30; L 0 70 20 70; CB 22 70 2.5; L 24 69 55 52; CB 58 50 2.5; L 60.5 50 80 50; CB 58 70 2.5; L 60.5 70 80 70; D 40 21 40 60',
    ports: 'COM1:0,30 A1:80,10 B1:80,30 COM2:0,70 A2:80,50 B2:80,70',
  }),
  sym('pushbutton-no', 'Push button (NO)', C, { w: 80, h: 40, prefix: 'SW', keywords: 'tactile momentary normally open key', draw: 'L 0 30 20 30; CB 22 30 2.5; CB 58 30 2.5; L 60.5 30 80 30; L 18 20 62 20; L 40 20 40 6; L 32 6 48 6', ports: '1:0,30 2:80,30' }),
  sym('pushbutton-nc', 'Push button (NC)', C, { w: 80, h: 40, prefix: 'SW', keywords: 'momentary normally closed', draw: 'L 0 30 20 30; CB 22 30 2.5; CB 58 30 2.5; L 60.5 30 80 30; L 18 34 62 34; L 40 34 40 6; L 32 6 48 6', ports: '1:0,30 2:80,30' }),
  sym('reed-switch', 'Reed switch', C, { w: 80, h: 40, prefix: 'SW', keywords: 'magnetic reed', draw: 'E 40 26 28 10; L 0 30 44 30; L 34 24 58 24 64 26 80 26 80 30', ports: '1:0,30 2:80,30' }),
  sym('limit-switch', 'Limit switch', C, { w: 80, h: 40, prefix: 'SW', keywords: 'endstop microswitch roller', draw: `${SW(30)}; C 56 11 4`, ports: '1:0,30 2:80,30' }),
  sym('rotary-switch-4', 'Rotary switch (4 pos.)', C, {
    w: 80, h: 80, prefix: 'SW', keywords: 'selector multi position',
    draw: 'L 0 40 20 40; CB 22 40 2.5; L 24 39 55 31; CB 58 10 2.5; L 60.5 10 80 10; CB 58 30 2.5; L 60.5 30 80 30; CB 58 50 2.5; L 60.5 50 80 50; CB 58 70 2.5; L 60.5 70 80 70',
    ports: 'COM:0,40 1:80,10 2:80,30 3:80,50 4:80,70',
  }),
  chip('dip-switch-4', 'DIP switch (4)', C, { left: ['1', '2', '3', '4'], right: ['8', '7', '6', '5'], title: 'DIP-4', prefix: 'SW', keywords: 'dip switch config', numbers: false }),
  sym('relay-coil', 'Relay coil', C, { w: 40, h: 60, prefix: 'K', value: '5V', fields: 'Coil voltage=5V, Coil resistance=70Ω', keywords: 'relay coil solenoid', draw: COIL, ports: 'A1:20,0 A2:20,60' }),
  sym('relay-spdt', 'Relay (SPDT)', C, {
    w: 120, h: 60, prefix: 'K', value: '5V', fields: 'Coil voltage=5V, Contact rating=10A 250V', keywords: 'relay changeover',
    draw: `${COIL}; L 80 60 80 46; CB 80 44 2.5; L 79 41 70 16; L 70 0 70 12; CB 70 14 2.5; L 100 0 100 12; CB 100 14 2.5; D 34 30 75 30`,
    ports: 'A1:20,0 A2:20,60 COM:80,60 NC:70,0 NO:100,0',
  }),
  sym('relay-dpdt', 'Relay (DPDT)', C, {
    w: 160, h: 60, prefix: 'K', value: '5V', keywords: 'relay double pole',
    draw: `${COIL}; L 80 60 80 46; CB 80 44 2.5; L 79 41 70 16; L 70 0 70 12; CB 70 14 2.5; L 100 0 100 12; CB 100 14 2.5; L 130 60 130 46; CB 130 44 2.5; L 129 41 120 16; L 120 0 120 12; CB 120 14 2.5; L 150 0 150 12; CB 150 14 2.5; D 34 30 125 30`,
    ports: 'A1:20,0 A2:20,60 COM1:80,60 NC1:70,0 NO1:100,0 COM2:130,60 NC2:120,0 NO2:150,0',
  }),
  sym('relay-ssr', 'Solid-state relay', C, {
    w: 100, h: 80, prefix: 'K', value: 'SSR-25DA', keywords: 'ssr solid state relay triac',
    draw: 'W 1.5; R 6 6 88 68 4; W 2; L 0 20 30 20 30 31; GF 22 31 38 31 30 45; W 2.5; L 22 45 38 45; W 2; L 30 45 30 60 0 60; L 42 40 54 40; GF 58 40 52 37 52 43; L 100 20 76 20 76 30; L 100 60 76 60 76 50; RB 68 30 16 20; T 76 44 8 m AC',
    ports: '+:0,20 -:0,60 L1:100,20 L2:100,60',
  }),
  sym('circuit-breaker', 'Circuit breaker', C, { w: 80, h: 40, prefix: 'CB', value: '10A', keywords: 'mcb breaker protection', draw: `${SW(30)}; L 54 26 62 34; L 62 26 54 34`, ports: '1:0,30 2:80,30' }),
  sym('contactor', 'Contactor contact', C, { w: 80, h: 40, prefix: 'K', keywords: 'contactor power contact', draw: `${SW(30)}; A 58 24 5 180 360`, ports: '1:0,30 2:80,30' }),
  sym('thermal-switch', 'Thermal switch', C, { w: 80, h: 40, prefix: 'S', value: '70°C', keywords: 'thermostat bimetal temperature', draw: `${SW(30)}; T 40 39 9 m ϑ`, ports: '1:0,30 2:80,30' }),
  sym('emergency-stop', 'Emergency stop', C, { w: 80, h: 40, prefix: 'S', keywords: 'e-stop mushroom estop', draw: 'L 0 30 20 30; CB 22 30 2.5; CB 58 30 2.5; L 60.5 30 80 30; L 18 34 62 34; L 40 34 40 10; PB M 28 10 A 12 8 0 0 1 52 10 Z', ports: '1:0,30 2:80,30' }),
  sym('pushbutton-4pin', 'Push button (4-pin)', C, {
    w: 80, h: 60, prefix: 'SW', keywords: 'tactile 4-pin momentary switch button',
    draw: 'L 0 20 20 20; CB 22 20 2.5; CB 58 20 2.5; L 60.5 20 80 20; L 0 40 20 40; CB 22 40 2.5; CB 58 40 2.5; L 60.5 40 80 40; L 18 10 62 10; L 40 10 40 0; L 32 0 48 0; L 18 50 62 50; L 40 50 40 60; L 32 60 48 60',
    ports: '1:0,20 2:80,20 3:0,40 4:80,40',
  }),
  chip('rotary-encoder', 'Rotary encoder', C, {
    left: ['A', 'B', 'C'],
    right: ['SW1', 'SW2'],
    title: 'ENC',
    value: 'EC11',
    prefix: 'SW',
    keywords: 'rotary encoder switch incremental',
    numbers: false,
  }),
];
