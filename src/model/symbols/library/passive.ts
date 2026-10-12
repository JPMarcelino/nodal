import { sym, types } from '../dsl';

const C = 'Passive';
const RES_FIELDS = 'Power rating=0.25W, Tolerance=±5%, Package=0805';
const CAP_FIELDS = 'Voltage rating=50V, Dielectric=X7R, Package=0805';

export const passive = [
  sym('resistor', 'Resistor', C, {
    w: 80, h: 20, prefix: 'R', value: '10kΩ', fields: RES_FIELDS, keywords: 'ohm resistance us zigzag',
    draw: 'L 0 10 20 10 23 3 30 17 37 3 43 17 50 3 57 17 60 10 80 10',
    ports: '1:0,10 2:80,10',
  }),
  sym('resistor-iec', 'Resistor (IEC)', C, {
    w: 80, h: 20, prefix: 'R', value: '10kΩ', fields: RES_FIELDS, keywords: 'ohm resistance box european',
    draw: 'L 0 10 20 10; RB 20 3 40 14; L 60 10 80 10',
    ports: '1:0,10 2:80,10',
  }),
  sym('resistor-variable', 'Variable resistor', C, {
    w: 80, h: 40, prefix: 'R', value: '10kΩ', fields: RES_FIELDS, keywords: 'rheostat adjustable',
    draw: 'L 0 20 20 20 23 13 30 27 37 13 43 27 50 13 57 27 60 20 80 20; L 26 34 54 6; GF 54 6 46 8 52 13',
    ports: '1:0,20 2:80,20',
  }),
  sym('potentiometer', 'Potentiometer', C, {
    w: 80, h: 40, prefix: 'RV', value: '10kΩ', fields: 'Taper=Linear, Power rating=0.1W', keywords: 'pot trimmer wiper',
    draw: 'L 0 30 20 30 23 23 30 37 37 23 43 37 50 23 57 37 60 30 80 30; L 40 0 40 18; GF 40 22 35 13 45 13',
    ports: '1:0,30 2:80,30 W:40,0',
  }),
  sym('trimmer', 'Trimmer', C, {
    w: 80, h: 40, prefix: 'RV', value: '10kΩ', keywords: 'preset trim pot',
    draw: 'L 0 20 20 20 23 13 30 27 37 13 43 27 50 13 57 27 60 20 80 20; L 28 33 52 7; L 48 3 56 11',
    ports: '1:0,20 2:80,20',
  }),
  sym('thermistor', 'Thermistor (NTC)', C, {
    w: 80, h: 40, prefix: 'TH', value: '10kΩ', fields: 'Beta=3950K', keywords: 'ntc ptc temperature sensor',
    draw: 'L 0 20 20 20; RB 20 13 40 14; L 60 20 80 20; L 22 34 30 34 54 6; T 58 38 9 s -t°',
    ports: '1:0,20 2:80,20',
  }),
  sym('photoresistor', 'Photoresistor (LDR)', C, {
    w: 80, h: 40, prefix: 'R', value: 'LDR', keywords: 'ldr light dependent sensor cds',
    draw: 'L 0 30 20 30; RB 20 23 40 14; L 60 30 80 30; L 24 2 34 14; GF 34 14 27 11 31 8; L 36 2 46 14; GF 46 14 39 11 43 8',
    ports: '1:0,30 2:80,30',
  }),
  sym('varistor', 'Varistor (MOV)', C, {
    w: 80, h: 40, prefix: 'RV', value: 'MOV', keywords: 'mov surge voltage dependent',
    draw: 'L 0 20 20 20; RB 20 13 40 14; L 60 20 80 20; L 22 34 30 34 54 6; T 58 38 9 s U',
    ports: '1:0,20 2:80,20',
  }),
  ...types(
    sym('capacitor', 'Capacitor', C, {
      w: 40, h: 40, prefix: 'C', value: '100nF', fields: CAP_FIELDS, keywords: 'cap ceramic film non-polarized',
      draw: 'L 0 20 16 20; W 3; L 16 6 16 34; L 24 6 24 34; W 2; L 24 20 40 20',
      ports: '1:0,20 2:40,20',
    }),
    sym('capacitor-curved', 'Capacitor', C, {
      w: 40, h: 40, prefix: 'C', value: '100nF', variantOf: 'capacitor', variantName: 'Type B · curved plate', keywords: 'cap ceramic film curved',
      draw: 'L 0 20 16 20; W 3; L 16 6 16 34; P M 28 6 Q 22 20 28 34; W 2; L 25 20 40 20',
      ports: '1:0,20 2:40,20',
    }),
  ),
  sym('capacitor-polarized', 'Capacitor (polarized)', C, {
    w: 40, h: 40, prefix: 'C', value: '10µF', fields: 'Voltage rating=25V, Dielectric=Electrolytic, Package=Radial', keywords: 'electrolytic tantalum polarised',
    draw: 'L 0 20 16 20; W 3; L 16 6 16 34; P M 28 6 Q 21 20 28 34; W 2; L 24.5 20 40 20; L 6 8 12 8; L 9 5 9 11',
    ports: '+:0,20 -:40,20',
  }),
  sym('capacitor-variable', 'Variable capacitor', C, {
    w: 40, h: 40, prefix: 'C', value: '10-100pF', keywords: 'trimmer tuning varicap',
    draw: 'L 0 20 16 20; W 3; L 16 8 16 32; L 24 8 24 32; W 2; L 24 20 40 20; L 6 36 34 4; GF 34 4 26 7 31 12',
    ports: '1:0,20 2:40,20',
  }),
  ...types(
    sym('inductor', 'Inductor', C, {
      w: 80, h: 20, prefix: 'L', value: '10µH', fields: 'Current rating=1A, DCR=0.1Ω', keywords: 'coil choke',
      draw: 'L 0 10 20 10; A 25 10 5 180 360; A 35 10 5 180 360; A 45 10 5 180 360; A 55 10 5 180 360; L 60 10 80 10',
      ports: '1:0,10 2:80,10',
    }),
    sym('inductor-loops', 'Inductor', C, {
      w: 80, h: 20, prefix: 'L', value: '10µH', variantOf: 'inductor', variantName: 'Type B · full loops', keywords: 'coil choke loops circles',
      draw: 'L 0 10 20 10; C 25 10 5; C 35 10 5; C 45 10 5; C 55 10 5; L 60 10 80 10',
      ports: '1:0,10 2:80,10',
    }),
  ),
  sym('inductor-core', 'Inductor (iron core)', C, {
    w: 80, h: 40, prefix: 'L', value: '1mH', keywords: 'coil choke ferrite core',
    draw: 'L 0 30 20 30; A 25 30 5 180 360; A 35 30 5 180 360; A 45 30 5 180 360; A 55 30 5 180 360; L 60 30 80 30; L 20 20 60 20; L 20 16 60 16',
    ports: '1:0,30 2:80,30',
  }),
  sym('ferrite-bead', 'Ferrite bead', C, {
    w: 60, h: 20, prefix: 'FB', value: '600Ω@100MHz', keywords: 'emi filter bead',
    draw: 'L 0 10 60 10; RF 22 2 16 16 2',
    ports: '1:0,10 2:60,10',
  }),
  sym('transformer', 'Transformer', C, {
    w: 60, h: 80, prefix: 'T', value: '1:1', fields: 'Ratio=1:1, Power=10VA', keywords: 'xfmr isolation coupled inductor',
    draw: 'L 0 0 20 0 20 20; A 20 25 5 270 450; A 20 35 5 270 450; A 20 45 5 270 450; A 20 55 5 270 450; L 20 60 20 80 0 80; L 40 0 60 0; L 40 20 40 0; A 40 25 5 90 270; A 40 35 5 90 270; A 40 45 5 90 270; A 40 55 5 90 270; L 40 60 40 80 60 80; L 28 18 28 62; L 32 18 32 62',
    ports: 'P1:0,0 P2:0,80 S1:60,0 S2:60,80',
  }),
  sym('transformer-ct', 'Transformer (center tap)', C, {
    w: 60, h: 80, prefix: 'T', value: '1:1 CT', keywords: 'xfmr center tapped',
    draw: 'L 0 0 20 0 20 20; A 20 25 5 270 450; A 20 35 5 270 450; A 20 45 5 270 450; A 20 55 5 270 450; L 20 60 20 80 0 80; L 40 0 60 0; L 40 20 40 0; A 40 25 5 90 270; A 40 35 5 90 270; A 40 45 5 90 270; A 40 55 5 90 270; L 40 60 40 80 60 80; L 35 40 60 40; L 28 18 28 62; L 32 18 32 62',
    ports: 'P1:0,0 P2:0,80 S1:60,0 CT:60,40 S2:60,80',
  }),
  sym('crystal', 'Crystal', C, {
    w: 60, h: 40, prefix: 'Y', value: '16MHz', fields: 'Load capacitance=18pF', keywords: 'xtal quartz oscillator resonator',
    draw: 'L 0 20 20 20; L 20 8 20 32; RB 25 6 10 28; L 40 8 40 32; L 40 20 60 20',
    ports: '1:0,20 2:60,20',
  }),
  sym('resonator', 'Ceramic resonator', C, {
    w: 60, h: 60, prefix: 'Y', value: '8MHz', keywords: 'ceramic resonator 3-pin',
    draw: 'L 0 20 20 20; L 20 8 20 32; RB 25 6 10 28; L 40 8 40 32; L 40 20 60 20; L 14 40 46 40; L 30 40 30 60; L 14 36 14 40; L 46 36 46 40',
    ports: '1:0,20 2:60,20 G:30,60',
  }),
  sym('fuse', 'Fuse', C, {
    w: 80, h: 20, prefix: 'F', value: '1A', fields: 'Type=Fast blow, Voltage rating=250V', keywords: 'protection',
    draw: 'L 0 10 20 10; RB 20 4 40 12; L 20 10 60 10; L 60 10 80 10',
    ports: '1:0,10 2:80,10',
  }),
  sym('fuse-resettable', 'Resettable fuse (PTC)', C, {
    w: 80, h: 40, prefix: 'F', value: '500mA', keywords: 'polyfuse ptc protection',
    draw: 'L 0 20 20 20; RB 20 14 40 12; L 20 20 60 20; L 60 20 80 20; L 22 34 30 34 54 6',
    ports: '1:0,20 2:80,20',
  }),
  sym('memristor', 'Memristor', C, {
    w: 80, h: 20, prefix: 'M', value: '', keywords: 'memory resistor',
    draw: 'L 0 10 20 10; RB 20 2 40 16; RF 20 2 5 16; L 25 10 30 10 30 5 36 5 36 15 42 15 42 5 48 5 48 15 54 15 54 10 60 10; L 60 10 80 10',
    ports: '1:0,10 2:80,10',
  }),
  sym('antenna', 'Antenna', C, {
    w: 40, h: 60, prefix: 'AE', value: '', hideLabels: false, keywords: 'aerial rf radio',
    draw: 'L 20 60 20 10; L 4 2 20 22 36 2; L 4 2 36 2',
    ports: '1:20,60',
  }),
  sym('thermistor-ptc', 'Thermistor (PTC)', C, {
    w: 80, h: 40, prefix: 'TH', value: 'PTC 100Ω', fields: 'Beta=3950K', keywords: 'ptc positive temperature coefficient thermistor',
    draw: 'L 0 20 20 20; RB 20 13 40 14; L 60 20 80 20; L 22 34 30 34 54 6; T 58 38 9 s +t°',
    ports: '1:0,20 2:80,20',
  }),
  sym('capacitor-bipolar', 'Capacitor (bipolar)', C, {
    w: 40, h: 40, prefix: 'C', value: '10µF', fields: 'Voltage rating=50V, Dielectric=Electrolytic, Package=0805', keywords: 'non-polarized electrolytic',
    draw: 'L 0 20 16 20; W 3; E 20 20 4 14; E 24 20 4 14; W 2; L 24 20 40 20',
    ports: '1:0,20 2:40,20',
  }),
  sym('inductor-coupled', 'Coupled inductor', C, {
    w: 100, h: 60, prefix: 'L', value: 'k=0.99', fields: 'Coupling coefficient=0.99', keywords: 'transformer coupled coil mutual inductance',
    draw: 'L 0 20 8 20; A 13 20 5 180 360; A 23 20 5 180 360; L 28 20 38 20; L 38 40 8 40; L 38 40 38 40; D 48 20 48 40; L 48 20 56 20; A 61 20 5 180 360; A 71 20 5 180 360; L 76 20 100 20; L 48 40 56 40; A 61 40 5 180 360; A 71 40 5 180 360; L 76 40 100 40; C 20 30 2; C 80 30 2',
    ports: 'P1:0,20 P2:0,40 S1:100,20 S2:100,40',
  }),
  sym('transformer-dual', 'Transformer (dual secondary)', C, {
    w: 100, h: 80, prefix: 'T', value: '1:1:1', fields: 'Ratio=1:1:1, Power=10VA', keywords: 'xfmr dual secondary two windings',
    draw: 'L 0 10 15 10 15 26; A 15 31 5 270 450; A 15 41 5 270 450; L 15 46 15 70 0 70; L 55 10 70 10; L 55 26 55 10; A 55 31 5 90 270; A 55 41 5 90 270; L 55 46 55 70 70 70; L 55 80 70 80; A 55 75 5 90 270; L 55 70 55 80; L 70 80 100 80; L 32 20 32 70; L 36 20 36 70; L 78 10 100 10; L 78 70 100 70',
    ports: 'P1:0,10 P2:0,70 S1:100,10 S2:100,70 S3:100,20 S4:100,60',
  }),
  sym('resistor-network-4', 'Resistor network (4×)', C, {
    w: 80, h: 80, prefix: 'RN', value: '4×10kΩ', fields: 'Configuration=isolated, Tolerance=±5%', keywords: 'sip dip array resistor pack',
    draw: 'D 8 2 72 2 72 78 8 78 8 2; L 0 10 8 10; L 0 30 8 30; L 0 50 8 50; L 0 70 8 70; L 72 10 80 10; L 72 30 80 30; L 72 50 80 50; L 72 70 80 70; RB 15 14 20 12; RB 15 34 20 12; RB 15 54 20 12; RB 15 74 20 12; L 8 10 15 10; L 35 10 72 10; L 8 30 15 30; L 35 30 72 30; L 8 50 15 50; L 35 50 72 50; L 8 70 15 70; L 35 70 72 70; T 45 77 8 m 1; T 45 57 8 m 2; T 45 37 8 m 3; T 45 17 8 m 4; T 45 72 8 m 5; T 45 52 8 m 6; T 45 32 8 m 7; T 45 12 8 m 8',
    ports: '1:0,10 2:80,10 3:0,30 4:80,30 5:0,50 6:80,50 7:0,70 8:80,70',
  }),
  sym('resistor-shunt', 'Shunt resistor (4-terminal)', C, {
    w: 80, h: 60, prefix: 'R', value: '10mΩ', fields: 'Power rating=1W, Tolerance=±1%', keywords: 'kelvin current sense shunt 4-terminal',
    draw: 'L 0 20 20 20; RB 20 10 40 20; L 60 20 80 20; L 0 40 20 40; L 60 40 80 40; L 22 4 24 6; L 24 6 58 6; L 58 6 60 4; L 22 56 24 54; L 24 54 58 54; L 58 54 60 56; T 20 5 8 m S+; T 20 55 8 m S−; T 64 20 8 m I+; T 64 40 8 m I−',
    ports: 'Ip:0,20 In:80,20 Sp:0,40 Sn:80,40',
  }),
  sym('spark-gap', 'Spark gap', C, {
    w: 60, h: 40, prefix: 'E', value: '', keywords: 'gap overvoltage protection discharge',
    draw: 'L 0 20 18 20; GF 18 12 18 28 28 20; GF 32 20 42 12 42 28; L 42 20 60 20; L 22 20 38 20',
    ports: '1:0,20 2:60,20',
  }),
  sym('gdt', 'Gas discharge tube', C, {
    w: 60, h: 40, prefix: 'E', value: '', keywords: 'gdt esd surge protection overvoltage',
    draw: 'L 0 20 20 20; CB 30 20 10; L 20 18 40 18; L 20 22 40 22; L 40 20 60 20; CF 30 20 2',
    ports: '1:0,20 2:60,20',
  }),
];
