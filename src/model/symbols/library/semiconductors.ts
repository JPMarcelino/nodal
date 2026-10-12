import { chip } from '../chip';
import { sym, types } from '../dsl';

const C = 'Semiconductors';
const DIODE = 'L 0 20 20 20; GF 20 10 20 30 38 20; L 38 20 60 20';
// hollow-triangle diode body (alternate drafting style)
const DIODE_HOLLOW = 'L 0 20 20 20; G 20 10 20 30 38 20; L 38 20 60 20';
const BAR = 'W 2.5; L 38 10 38 30; W 2';
const OUT_ARROWS = 'L 30 9 37 2; GF 38.5 0.5 32.9 2.6 36.4 6.1; L 38 11 45 4; GF 46.5 2.5 40.9 4.6 44.4 8.1';
const IN_ARROWS = 'L 46 0 39 7; GF 37.5 8.5 39.6 2.9 43.1 6.4; L 54 2 47 9; GF 45.5 10.5 47.6 4.9 51.1 8.4';
// BJT geometry (60×60): base left, collector top, emitter bottom
const BJT = 'L 20 24 40 12 40 0; L 20 36 40 48 40 60; W 3; L 20 14 20 46; W 2';
// MOSFET geometry (60×60). Three drafting types:
//   A — substrate arrow + three channel bars (classic)
//   B — gate centred, single channel bar, filled arrow on the source lead
//   C — the same as B, plus a bulk (B) lead to the right
const MOS_GATE = 'W 2.5; L 16 18 16 42; L 22 14 22 22; L 22 26 22 34; L 22 38 22 46; W 2';
const NMOS_A = `L 0 40 16 40; ${MOS_GATE}; L 22 18 40 18 40 0; L 22 42 40 42 40 60; L 22 30 40 30 40 42; GF 23 30 30 26.5 30 33.5`;
const PMOS_A = `L 0 20 16 20; ${MOS_GATE}; L 22 18 40 18 40 0; L 22 42 40 42 40 60; L 22 30 40 30 40 18; GF 39 30 32 26.5 32 33.5`;
const NMOS_B = 'L 0 30 14 30; W 2.5; L 14 12 14 48; L 20 12 20 48; W 2; L 20 16 40 16 40 0; L 20 44 40 44 40 60; GF 36 44 25.5 39.5 25.5 48.5';
const PMOS_B = 'L 0 30 14 30; W 2.5; L 14 12 14 48; L 20 12 20 48; W 2; L 20 16 40 16 40 0; L 20 44 40 44 40 60; GF 23 16 34 11.5 34 20.5';
const BULK = 'L 20 30 60 30';
const NMOS_C = `${NMOS_B}; ${BULK}`;
const PMOS_C = `${PMOS_B}; ${BULK}`;

// Depletion mode: the same three types with a continuous channel. Type A draws
// it as one solid line; B (and C) use a heavy bar, with the arrows clear of it.
const DEP_A = (draw: string) => draw.replace(MOS_GATE, 'W 2.5; L 16 18 16 42; L 22 14 22 46; W 2');
const DEP_BAR = (draw: string) => draw.replace('L 20 12 20 48', 'W 5; L 20 12 20 48');
const NMOS_DEP_A = DEP_A(NMOS_A);
const PMOS_DEP_A = DEP_A(PMOS_A);
const NMOS_DEP_B = DEP_BAR(NMOS_B).replace('GF 36 44 25.5 39.5 25.5 48.5', 'GF 37 44 26 39.5 26 48.5');
const PMOS_DEP_B = DEP_BAR(PMOS_B).replace('GF 23 16 34 11.5 34 20.5', 'GF 26 16 37 11.5 37 20.5');
const NMOS_DEP_C = `${NMOS_DEP_B}; ${BULK}`;
const PMOS_DEP_C = `${PMOS_DEP_B}; ${BULK}`;

export const semiconductors = [
  ...types(
    sym('diode', 'Diode', C, { w: 60, h: 40, prefix: 'D', value: '1N4148', fields: 'Package=SOD-123', keywords: 'rectifier signal', draw: `${DIODE}; ${BAR}`, ports: 'A:0,20 K:60,20' }),
    sym('diode-outline', 'Diode', C, { w: 60, h: 40, prefix: 'D', value: '1N4148', variantOf: 'diode', variantName: 'Type B · hollow triangle', keywords: 'rectifier signal outline', draw: `${DIODE_HOLLOW}; ${BAR}`, ports: 'A:0,20 K:60,20' }),
  ),
  sym('led', 'LED', C, { w: 60, h: 40, prefix: 'D', value: 'Red', fields: 'Forward voltage=2.0V, Current=20mA, Package=0805', keywords: 'light emitting diode lamp', draw: `${DIODE}; ${BAR}; ${OUT_ARROWS}`, ports: 'A:0,20 K:60,20' }),
  sym('zener', 'Zener diode', C, { w: 60, h: 40, prefix: 'D', value: '5V1', keywords: 'voltage reference regulator', draw: `${DIODE}; W 2.5; L 33 33 38 30 38 10 43 7; W 2`, ports: 'A:0,20 K:60,20' }),
  sym('schottky', 'Schottky diode', C, { w: 60, h: 40, prefix: 'D', value: 'BAT54', keywords: 'low drop fast', draw: `${DIODE}; W 2.5; L 33 26 33 30 38 30 38 10 43 10 43 14; W 2`, ports: 'A:0,20 K:60,20' }),
  sym('tvs', 'TVS diode (bidirectional)', C, { w: 80, h: 40, prefix: 'D', value: 'SMBJ5.0CA', keywords: 'esd surge protection transient', draw: 'L 0 20 20 20; GF 20 10 20 30 40 20; GF 60 10 60 30 40 20; W 2.5; L 35 33 40 30 40 10 45 7; W 2; L 60 20 80 20', ports: '1:0,20 2:80,20' }),
  sym('varactor', 'Varactor', C, { w: 60, h: 40, prefix: 'D', value: 'BB910', keywords: 'varicap tuning capacitance diode', draw: 'L 0 20 20 20; GF 20 10 20 30 36 20; W 2.5; L 36 10 36 30; L 42 10 42 30; W 2; L 42 20 60 20', ports: 'A:0,20 K:60,20' }),
  sym('photodiode', 'Photodiode', C, { w: 60, h: 40, prefix: 'D', value: 'BPW34', keywords: 'light sensor optical', draw: `${DIODE}; ${BAR}; ${IN_ARROWS}`, ports: 'A:0,20 K:60,20' }),
  sym('laser-diode', 'Laser diode', C, { w: 60, h: 40, prefix: 'D', value: '650nm', keywords: 'laser optical', draw: `${DIODE}; ${BAR}; L 27 8 27 1; GF 27 -1 24 5 30 5; L 33 8 33 1; GF 33 -1 30 5 36 5`, ports: 'A:0,20 K:60,20' }),
  sym('diac', 'DIAC', C, { w: 60, h: 40, prefix: 'D', value: 'DB3', keywords: 'trigger thyristor', draw: 'L 0 20 22 20; W 2.5; L 22 6 22 34; L 38 6 38 34; W 2; GF 22 8 22 19 37 13.5; GF 38 21 38 32 23 26.5; L 38 20 60 20', ports: '1:0,20 2:60,20' }),
  sym('bridge-rectifier', 'Bridge rectifier', C, {
    w: 80, h: 80, prefix: 'D', value: 'DB107', keywords: 'full wave rectifier',
    draw: 'G 40 6 74 40 40 74 6 40; GF 19 21 27 13 30 30; L 21 29 31 19; GF 61 21 53 13 50 30; L 59 29 49 19; GF 19 59 27 67 30 50; L 21 51 31 61; GF 61 59 53 67 50 50; L 59 51 49 61; L 40 0 40 6; L 40 74 40 80; L 0 40 6 40; L 74 40 80 40; T 56 10 9 m +; T 56 76 9 m −',
    ports: 'AC1:40,0 AC2:40,80 -:0,40 +:80,40',
  }),
  sym('npn', 'NPN transistor', C, { w: 60, h: 60, prefix: 'Q', value: '2N3904', fields: 'Package=SOT-23', keywords: 'bjt bipolar', draw: `L 0 30 20 30; ${BJT}; GF 36 45.6 29.3 45.1 32.4 39.9`, ports: 'B:0,30 C:40,0 E:40,60' }),
  sym('pnp', 'PNP transistor', C, { w: 60, h: 60, prefix: 'Q', value: '2N3906', fields: 'Package=SOT-23', keywords: 'bjt bipolar', draw: `L 0 30 20 30; ${BJT}; GF 24 21.6 30.7 21.1 27.6 15.9`, ports: 'B:0,30 E:40,0 C:40,60' }),
  sym('npn-circle', 'NPN transistor (circled)', C, { w: 60, h: 60, prefix: 'Q', value: '2N2222', keywords: 'bjt bipolar', draw: `C 30 30 24; L 0 30 20 30; ${BJT}; GF 36 45.6 29.3 45.1 32.4 39.9`, ports: 'B:0,30 C:40,0 E:40,60' }),
  sym('pnp-circle', 'PNP transistor (circled)', C, { w: 60, h: 60, prefix: 'Q', value: '2N2907', keywords: 'bjt bipolar', draw: `C 30 30 24; L 0 30 20 30; ${BJT}; GF 24 21.6 30.7 21.1 27.6 15.9`, ports: 'B:0,30 E:40,0 C:40,60' }),
  sym('npn-darlington', 'Darlington (NPN)', C, {
    w: 60, h: 60, prefix: 'Q', value: 'TIP120', keywords: 'darlington pair bjt',
    draw: 'L 0 30 14 30; W 3; L 14 22 14 38; L 40 32 40 52; W 2; L 14 26 26 20 26 8; L 26 8 60 8 60 0; L 14 34 26 40 40 40; GF 24 39 18.4 39 20.6 34.6; L 40 36 52 28 52 8; L 40 48 54 56 60 56 60 60; GF 50 53.7 44.4 53.4 46.9 49',
    ports: 'B:0,30 C:60,0 E:60,60',
  }),
  sym('phototransistor', 'Phototransistor', C, { w: 60, h: 60, prefix: 'Q', value: 'PT333', keywords: 'light sensor optical', draw: `${BJT}; GF 36 45.6 29.3 45.1 32.4 39.9; L 0 14 9 23; GF 11 25 5 23.5 9.5 19; L 0 26 9 35; GF 11 37 5 35.5 9.5 31`, ports: 'C:40,0 E:40,60' }),
  ...types(
    sym('nmos', 'N-channel MOSFET', C, {
      w: 60, h: 60, prefix: 'Q', value: '2N7002', fields: 'Vds=60V, Id=300mA, Package=SOT-23', keywords: 'mosfet fet enhancement standard',
      draw: NMOS_A, ports: 'G:0,40 D:40,0 S:40,60',
    }),
    sym('nmos-b', 'N-channel MOSFET', C, {
      w: 60, h: 60, prefix: 'Q', value: '2N7002', variantOf: 'nmos', variantName: 'Type B · source arrow', keywords: 'mosfet fet enhancement source arrow',
      draw: NMOS_B, ports: 'G:0,30 D:40,0 S:40,60',
    }),
    sym('nmos-c', 'N-channel MOSFET', C, {
      w: 60, h: 60, prefix: 'Q', value: '2N7002', variantOf: 'nmos', variantName: 'Type C · simplified, bulk pin', keywords: 'mosfet fet enhancement simplified bulk body substrate',
      draw: NMOS_C, ports: 'G:0,30 D:40,0 S:40,60 B:60,30',
    }),
  ),
  ...types(
    sym('pmos', 'P-channel MOSFET', C, {
      w: 60, h: 60, prefix: 'Q', value: 'AO3401', fields: 'Vds=-30V, Id=-4A, Package=SOT-23', keywords: 'mosfet fet enhancement standard',
      draw: PMOS_A, ports: 'G:0,20 S:40,0 D:40,60',
    }),
    sym('pmos-b', 'P-channel MOSFET', C, {
      w: 60, h: 60, prefix: 'Q', value: 'AO3401', variantOf: 'pmos', variantName: 'Type B · source arrow', keywords: 'mosfet fet enhancement source arrow',
      draw: PMOS_B, ports: 'G:0,30 S:40,0 D:40,60',
    }),
    sym('pmos-c', 'P-channel MOSFET', C, {
      w: 60, h: 60, prefix: 'Q', value: 'AO3401', variantOf: 'pmos', variantName: 'Type C · simplified, bulk pin', keywords: 'mosfet fet enhancement simplified bulk body substrate',
      draw: PMOS_C, ports: 'G:0,30 S:40,0 D:40,60 B:60,30',
    }),
  ),
  ...types(
    sym('nmos-depletion', 'N-MOSFET (depletion)', C, {
      w: 60, h: 60, prefix: 'Q', value: 'BSS139', keywords: 'mosfet depletion standard',
      draw: NMOS_DEP_A, ports: 'G:0,40 D:40,0 S:40,60',
    }),
    sym('nmos-depletion-b', 'N-MOSFET (depletion)', C, {
      w: 60, h: 60, prefix: 'Q', value: 'BSS139', variantOf: 'nmos-depletion', variantName: 'Type B · source arrow', keywords: 'mosfet depletion source arrow',
      draw: NMOS_DEP_B, ports: 'G:0,30 D:40,0 S:40,60',
    }),
    sym('nmos-depletion-c', 'N-MOSFET (depletion)', C, {
      w: 60, h: 60, prefix: 'Q', value: 'BSS139', variantOf: 'nmos-depletion', variantName: 'Type C · simplified, bulk pin', keywords: 'mosfet depletion simplified bulk body substrate',
      draw: NMOS_DEP_C, ports: 'G:0,30 D:40,0 S:40,60 B:60,30',
    }),
  ),
  ...types(
    sym('pmos-depletion', 'P-MOSFET (depletion)', C, {
      w: 60, h: 60, prefix: 'Q', value: 'BSS84', keywords: 'mosfet depletion standard',
      draw: PMOS_DEP_A, ports: 'G:0,20 S:40,0 D:40,60',
    }),
    sym('pmos-depletion-b', 'P-MOSFET (depletion)', C, {
      w: 60, h: 60, prefix: 'Q', value: 'BSS84', variantOf: 'pmos-depletion', variantName: 'Type B · source arrow', keywords: 'mosfet depletion source arrow',
      draw: PMOS_DEP_B, ports: 'G:0,30 S:40,0 D:40,60',
    }),
    sym('pmos-depletion-c', 'P-MOSFET (depletion)', C, {
      w: 60, h: 60, prefix: 'Q', value: 'BSS84', variantOf: 'pmos-depletion', variantName: 'Type C · simplified, bulk pin', keywords: 'mosfet depletion simplified bulk body substrate',
      draw: PMOS_DEP_C, ports: 'G:0,30 S:40,0 D:40,60 B:60,30',
    }),
  ),
  sym('njfet', 'N-channel JFET', C, { w: 60, h: 60, prefix: 'Q', value: 'J310', keywords: 'jfet fet', draw: 'L 0 30 20 30; GF 20 30 13 26.5 13 33.5; W 3; L 20 14 20 46; W 2; L 20 18 40 18 40 0; L 20 42 40 42 40 60', ports: 'G:0,30 D:40,0 S:40,60' }),
  sym('pjfet', 'P-channel JFET', C, { w: 60, h: 60, prefix: 'Q', value: 'J175', keywords: 'jfet fet', draw: 'L 0 30 20 30; GF 6 30 13 26.5 13 33.5; W 3; L 20 14 20 46; W 2; L 20 18 40 18 40 0; L 20 42 40 42 40 60', ports: 'G:0,30 S:40,0 D:40,60' }),
  sym('igbt', 'IGBT', C, {
    w: 60, h: 60, prefix: 'Q', value: 'IRG4BC30', keywords: 'insulated gate bipolar power',
    draw: 'L 0 40 14 40; W 2.5; L 14 18 14 42; L 20 14 20 46; W 2; L 20 22 40 12 40 0; L 20 38 40 48 40 60; GF 36 46.2 29.3 46.5 31.7 41.1',
    ports: 'G:0,40 C:40,0 E:40,60',
  }),
  sym('scr', 'Thyristor (SCR)', C, { w: 60, h: 40, prefix: 'Q', value: 'BT151', keywords: 'thyristor scr silicon controlled rectifier', draw: `${DIODE}; ${BAR}; L 38 30 50 36 50 40`, ports: 'A:0,20 K:60,20 G:50,40' }),
  sym('triac', 'TRIAC', C, {
    w: 60, h: 60, prefix: 'Q', value: 'BT136', keywords: 'ac switch thyristor',
    draw: 'L 30 0 30 18; W 2.5; L 14 18 46 18; L 14 42 46 42; W 2; GF 14 18 30 18 22 41; GF 30 42 46 42 38 19; L 30 42 30 60; L 22 42 12 52 0 52 0 50',
    ports: 'MT2:30,0 MT1:30,60 G:0,50',
  }),
  sym('ujt', 'UJT', C, { w: 60, h: 60, prefix: 'Q', value: '2N2646', keywords: 'unijunction', draw: 'L 0 40 12 40 28 32; GF 28 32 21 32.4 24 37.3; W 3; L 30 14 30 46; W 2; L 30 18 40 18 40 0; L 30 42 40 42 40 60', ports: 'E:0,40 B2:40,0 B1:40,60' }),
  sym('optocoupler', 'Optocoupler', C, {
    w: 100, h: 80, prefix: 'U', value: 'PC817', keywords: 'opto isolator photocoupler',
    draw: 'W 1.5; R 6 6 88 68 4; W 2; L 0 20 30 20 30 31; GF 22 31 38 31 30 45; W 2.5; L 22 45 38 45; W 2; L 30 45 30 60 0 60; L 42 34 52 34; GF 56 34 50 31 50 37; L 42 44 52 44; GF 56 44 50 41 50 47; W 3; L 64 26 64 54; W 2; L 64 34 82 24 82 20 100 20; L 64 46 82 56 82 60 100 60; GF 79 54.3 72.4 54 74.8 49',
    ports: 'A:0,20 K:0,60 C:100,20 E:100,60',
  }),
  chip('mosfet-driver', 'Gate driver', C, { left: ['VCC', 'IN', 'GND'], right: ['OUT'], title: 'DRV', value: 'TC4420', keywords: 'mosfet gate driver' }),
  sym('tunnel-diode', 'Tunnel diode', C, {
    w: 60, h: 40, prefix: 'D', value: '', keywords: 'tunnel diode resonant negative resistance',
    draw: 'L 0 20 20 20; GF 20 10 20 30 38 20; L 38 20 60 20; W 2.5; L 33 33 38 30 38 10 43 7; W 2; L 22 28 38 20; L 38 12 44 28',
    ports: 'A:0,20 K:60,20',
  }),
  sym('diode-dual-cc', 'Dual diode (common cathode)', C, {
    w: 60, h: 60, prefix: 'D', value: '1N4148', keywords: 'dual diode common cathode rectifier',
    draw: 'L 0 10 18 10; GF 18 2 18 18 34 10; L 34 10 60 10; L 0 50 18 50; GF 18 42 18 58 34 50; L 34 50 60 50; L 34 30 60 30; W 2.5; L 34 2 34 18 34 42 34 58; W 2',
    ports: 'A1:0,10 A2:0,50 K:60,30',
  }),
  sym('triode', 'Triode (vacuum tube)', C, {
    w: 60, h: 80, prefix: 'V', value: '12AX7', keywords: 'vacuum tube triode thermionic',
    draw: 'CB 30 40 24; L 30 0 30 18; L 10 18 50 18; L 30 62 30 80; W 2.5; L 16 30 44 30; W 2; W 2.5; L 22 28 38 28; W 2; GF 30 42 35 38 35 44; GF 30 42 25 38 25 44',
    ports: 'P:30,0 G:0,30 K:30,80',
  }),
  sym('pentode', 'Pentode (vacuum tube)', C, {
    w: 60, h: 80, prefix: 'V', value: 'EL84', keywords: 'vacuum tube pentode thermionic',
    draw: 'CB 30 40 24; L 30 0 30 18; L 10 18 50 18; L 30 62 30 80; W 2.5; L 18 20 42 20; L 20 32 40 32; L 22 44 38 44; W 2; GF 30 58 35 54 35 60; GF 30 58 25 54 25 60',
    ports: 'P:30,0 G1:0,20 G2:0,32 G3:0,44 K:30,80',
  }),
  sym('opto-triac', 'Optocoupler (TRIAC output)', C, {
    w: 100, h: 60, prefix: 'U', value: 'MOC3021', keywords: 'opto optocoupler triac diac output',
    draw: 'W 1.5; R 6 6 88 48 3; W 2; L 0 15 28 15 28 24; GF 20 24 36 24 28 36; W 2.5; L 20 36 36 36; W 2; L 28 36 28 50 0 50; L 40 30 60 30; W 3; L 40 20 40 40; L 60 20 100 20; L 60 40 100 40; W 2; GF 58 36 50 33 50 39',
    ports: 'A:0,15 K:0,50 MT1:100,20 MT2:100,40',
  }),
];
