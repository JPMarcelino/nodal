import { chip } from '../chip';
import { sym } from '../dsl';
import type { SymbolDef } from '../../types';

const C = 'Connectors & Labels';

function header(n: number): SymbolDef {
  const h = n * 20;
  const draw: string[] = [`RB 12 0 28 ${h} 2`];
  const ports: string[] = [];
  for (let i = 0; i < n; i++) {
    const y = 10 + i * 20;
    draw.push(`L 0 ${y} 20 ${y}`, `RF 20 ${y - 3} 6 6`, `T 34 ${y + 3} 7 m ${i + 1}`);
    ports.push(`${i + 1}:0,${y}`);
  }
  return sym(`header-1x${n}`, `Pin header 1×${n}`, C, { w: 40, h, prefix: 'J', value: `Conn_01x${String(n).padStart(2, '0')}`, keywords: 'connector pin header jumper', draw: draw.join('; '), ports: ports.join(' ') });
}

function terminalBlock(n: number): SymbolDef {
  const h = n * 20;
  const draw: string[] = [`RB 12 0 28 ${h} 2`];
  const ports: string[] = [];
  for (let i = 0; i < n; i++) {
    const y = 10 + i * 20;
    draw.push(`L 0 ${y} 20 ${y}`, `C 26 ${y} 5`, `L 22 ${y + 4} 30 ${y - 4}`);
    ports.push(`${i + 1}:0,${y}`);
  }
  return sym(`terminal-block-${n}`, `Terminal block (${n})`, C, { w: 40, h, prefix: 'J', value: 'Screw terminal', keywords: 'screw terminal connector', draw: draw.join('; '), ports: ports.join(' ') });
}

const LABEL = { hideLabels: true, valueIsLabel: true } as const;

export const connectors = [
  sym('net-label', 'Net label', C, { w: 20, h: 20, prefix: '#NL', value: 'NET', ...LABEL, keywords: 'net label name connection', draw: 'L 0 10 14 10; L 14 6 14 14', ports: 'N:0,10' }),
  sym('global-label', 'Global label', C, { w: 40, h: 20, prefix: '#GL', value: 'SIGNAL', ...LABEL, keywords: 'global net label', draw: 'L 0 10 6 10; GB 6 10 14 2 40 2 40 18 14 18', ports: 'N:0,10' }),
  sym('port-in', 'Input port', C, { w: 40, h: 20, prefix: '#P', value: 'IN', ...LABEL, keywords: 'input port hierarchical', draw: 'GB 2 10 12 2 40 2 40 18 12 18; L 0 10 2 10', ports: 'N:0,10' }),
  sym('port-out', 'Output port', C, { w: 40, h: 20, prefix: '#P', value: 'OUT', ...LABEL, keywords: 'output port hierarchical', draw: 'L 0 10 2 10; GB 2 2 30 2 40 10 30 18 2 18', ports: 'N:0,10' }),
  sym('port-bidir', 'Bidirectional port', C, { w: 40, h: 20, prefix: '#P', value: 'IO', ...LABEL, keywords: 'bidirectional port', draw: 'L 0 10 2 10; GB 2 10 10 2 32 2 40 10 32 18 10 18', ports: 'N:0,10' }),
  sym('off-page', 'Off-page connector', C, { w: 40, h: 20, prefix: '#P', value: 'PAGE2', ...LABEL, keywords: 'off page sheet connector', draw: 'L 0 10 2 10; GB 2 2 24 2 32 10 24 18 2 18; L 30 2 38 10 30 18', ports: 'N:0,10' }),
  sym('no-connect', 'No-connect flag', C, { w: 20, h: 20, prefix: '#NC', value: '', hideLabels: true, keywords: 'not connected nc x', draw: 'W 2; L -5 5 5 15; L -5 15 5 5', ports: 'NC:0,10' }),
  sym('terminal', 'Terminal', C, { w: 20, h: 20, prefix: 'J', keywords: 'terminal connection point pad', draw: 'L 0 10 5 10; CB 11 10 6', ports: '1:0,10' }),
  terminalBlock(2),
  terminalBlock(3),
  terminalBlock(4),
  header(2),
  header(3),
  header(4),
  header(6),
  header(8),
  header(10),
  header(12),
  chip('header-2x3', 'Pin header 2×3', C, { left: ['1', '3', '5'], right: ['2', '4', '6'], prefix: 'J', value: 'Conn_02x03', keywords: 'idc box header', numbers: false, minW: 40 }),
  chip('header-2x5', 'Pin header 2×5', C, { left: ['1', '3', '5', '7', '9'], right: ['2', '4', '6', '8', '10'], prefix: 'J', value: 'Conn_02x05', keywords: 'idc box header', numbers: false, minW: 40 }),
  chip('header-2x8', 'Pin header 2×8', C, { left: ['1', '3', '5', '7', '9', '11', '13', '15'], right: ['2', '4', '6', '8', '10', '12', '14', '16'], prefix: 'J', value: 'Conn_02x08', keywords: 'idc box header', numbers: false, minW: 40 }),
  chip('header-2x10', 'Pin header 2×10', C, { left: ['1', '3', '5', '7', '9', '11', '13', '15', '17', '19'], right: ['2', '4', '6', '8', '10', '12', '14', '16', '18', '20'], prefix: 'J', value: 'Conn_02x10', keywords: 'idc box header', numbers: false, minW: 40 }),
  sym('jack-dc', 'DC barrel jack', C, { w: 60, h: 40, prefix: 'J', value: '5.5×2.1mm', keywords: 'power jack barrel', draw: 'L 0 10 26 10; RB 26 5 28 10 5; L 0 30 34 30 40 24 46 30 60 30', ports: '+:0,10 -:0,30' }),
  sym('jack-audio', 'Audio jack 3.5mm (TRS)', C, {
    w: 60, h: 60, prefix: 'J', value: 'TRS 3.5mm', keywords: 'audio headphone jack stereo trs',
    draw: 'RB 46 4 12 52; L 0 10 30 10 34 4 38 10; L 0 30 24 30 28 24 32 30; L 0 50 46 50',
    ports: 'T:0,10 R:0,30 S:0,50',
  }),
  chip('usb-b', 'USB connector', C, { left: ['VBUS', 'D-', 'D+', 'ID', 'GND'], right: ['SHIELD'], title: 'USB', prefix: 'J', value: 'Micro-USB', keywords: 'usb micro mini connector', numbers: false }),
  chip('usb-c', 'USB-C connector', C, { left: ['VBUS', 'CC1', 'CC2', 'D+', 'D-', 'GND'], right: ['SHIELD'], title: 'USB-C', prefix: 'J', value: 'USB-C', keywords: 'usb type-c connector', numbers: false }),
  chip('rj45', 'RJ45 jack', C, { left: ['1', '2', '3', '4', '5', '6', '7', '8'], title: 'RJ45', prefix: 'J', value: '8P8C', keywords: 'ethernet network', numbers: false }),
  sym('bnc', 'BNC / coax', C, { w: 40, h: 40, prefix: 'J', value: 'BNC', keywords: 'coax rf sma connector', draw: 'L 0 20 20 20; CF 20 20 2.5; C 20 20 7; A 20 20 13 210 510; L 20 33 20 40', ports: 'SIG:0,20 SH:20,40' }),
  sym('plug', 'Plug (male)', C, { w: 40, h: 20, prefix: 'P', keywords: 'connector male', draw: 'L 0 10 18 10; GF 18 4 30 10 18 16', ports: '1:0,10' }),
  sym('socket', 'Socket (female)', C, { w: 40, h: 20, prefix: 'J', keywords: 'connector female receptacle', draw: 'L 0 10 18 10; A 26 10 7 90 270', ports: '1:0,10' }),
  sym('banana-jack', 'Banana jack', C, { w: 40, h: 20, prefix: 'J', keywords: 'test lead banana socket', draw: 'L 0 10 14 10; CB 24 10 8; CF 24 10 3', ports: '1:0,10' }),
  sym('antenna-dipole', 'Dipole antenna', C, { w: 60, h: 40, prefix: 'AE', keywords: 'antenna dipole rf', draw: 'L 20 40 20 20 4 4; L 40 40 40 20 56 4', ports: '1:20,40 2:40,40' }),
  sym('mounting-hole', 'Mounting hole', C, { w: 40, h: 40, prefix: 'H', hideLabels: false, keywords: 'screw hole mechanical', draw: 'C 20 20 14; C 20 20 7', ports: '' }),
  sym('fiducial', 'Fiducial', C, { w: 40, h: 40, prefix: 'FID', keywords: 'fiducial marker pcb', draw: 'CF 20 20 6; W 1.5; C 20 20 14', ports: '' }),
  sym('sma', 'SMA / RF connector', C, { w: 40, h: 40, prefix: 'J', value: 'SMA', keywords: 'sma u.fl mmcx rf coax antenna connector', draw: 'L 0 20 20 20; CF 20 20 2.5; C 20 20 7; A 20 20 13 210 510; L 20 33 20 40', ports: 'SIG:0,20 SH:20,40' }),
  sym('dsub-9', 'D-sub 9 (DE-9)', C, {
    w: 60, h: 200, prefix: 'J', value: 'DE-9', keywords: 'dsub de-9 db9 rs232 serial connector',
    draw: 'W 1.5; G 22 4 52 16 52 184 22 196; W 2; L 0 20 27 20; CB 30 20 3; T 10 17 7 m 1; L 0 40 39 40; CB 42 40 3; T 10 37 7 m 6; L 0 60 27 60; CB 30 60 3; T 10 57 7 m 2; L 0 80 39 80; CB 42 80 3; T 10 77 7 m 7; L 0 100 27 100; CB 30 100 3; T 10 97 7 m 3; L 0 120 39 120; CB 42 120 3; T 10 117 7 m 8; L 0 140 27 140; CB 30 140 3; T 10 137 7 m 4; L 0 160 39 160; CB 42 160 3; T 10 157 7 m 9; L 0 180 27 180; CB 30 180 3; T 10 177 7 m 5; L 52 100 60 100',
    ports: '1:0,20 6:0,40 2:0,60 7:0,80 3:0,100 8:0,120 4:0,140 9:0,160 5:0,180 SH:60,100',
  }),
  sym('bus-entry', 'Bus entry', C, {
    w: 20, h: 20, prefix: '#BE', value: '', hideLabels: true, keywords: 'bus entry wire connection',
    draw: 'L 0 0 20 20',
    ports: '1:0,0 2:20,20',
  }),
];
