import { chip } from '../chip';
import { sym } from '../dsl';

const C = 'ICs & Analog';
const TRI = 'L 0 20 16 20; L 0 60 16 60; L 72 40 80 40; GB 16 4 16 76 72 40; L 21 20 27 20; L 21 60 27 60; L 24 57 24 63';
const SUPPLY = 'L 40 0 40 19.4; L 40 80 40 60.6';
const DIP = (n: number) => {
  const half = n / 2;
  const left = Array.from({ length: half }, (_, i) => String(i + 1));
  const right = Array.from({ length: half }, (_, i) => String(n - i));
  return { left, right };
};

export const ics = [
  sym('opamp', 'Op-amp', C, { w: 80, h: 80, prefix: 'U', value: 'LM358', fields: 'Supply=±15V, GBW=1MHz', keywords: 'operational amplifier opamp', draw: `${SUPPLY}; ${TRI}`, ports: '-:0,20 +:0,60 OUT:80,40 V+:40,0 V-:40,80' }),
  sym('opamp-simple', 'Op-amp (no supply pins)', C, { w: 80, h: 80, prefix: 'U', value: 'TL072', keywords: 'operational amplifier opamp', draw: TRI, ports: '-:0,20 +:0,60 OUT:80,40' }),
  sym('opamp-inverted', 'Op-amp (+ on top)', C, {
    w: 80, h: 80, prefix: 'U', value: 'LM358', keywords: 'operational amplifier opamp',
    draw: 'L 0 20 16 20; L 0 60 16 60; L 72 40 80 40; GB 16 4 16 76 72 40; L 21 60 27 60; L 21 20 27 20; L 24 17 24 23',
    ports: '+:0,20 -:0,60 OUT:80,40',
  }),
  sym('comparator', 'Comparator', C, { w: 80, h: 80, prefix: 'U', value: 'LM393', keywords: 'compare threshold', draw: `${SUPPLY}; ${TRI}; W 1.5; L 34 46 40 46 40 34 46 34; W 2`, ports: '-:0,20 +:0,60 OUT:80,40 V+:40,0 V-:40,80' }),
  sym('inamp', 'Instrumentation amp', C, {
    w: 80, h: 80, prefix: 'U', value: 'INA128', keywords: 'instrumentation amplifier in-amp',
    draw: 'L 0 10 16 10; L 0 30 16 30; L 0 50 16 50; L 0 70 16 70; L 72 40 80 40; GB 16 2 16 78 72 40; L 21 10 27 10; L 21 70 27 70; L 24 67 24 73; T 25 33 7 s RG; T 25 53 7 s RG',
    ports: '-:0,10 RG1:0,30 RG2:0,50 +:0,70 OUT:80,40',
  }),
  chip('ne555', 'NE555 timer', C, { top: ['VCC', 'RST'], left: ['TRIG', 'THR', 'DIS'], right: ['OUT'], bottom: ['GND', 'CTRL'], title: '555', value: 'NE555', keywords: 'timer oscillator astable monostable' }),
  chip('regulator', 'Voltage regulator', C, { left: ['IN'], right: ['OUT'], bottom: ['GND'], title: '78xx', value: 'LM7805', keywords: 'linear regulator ldo 7805 ams1117', numbers: false }),
  chip('regulator-adj', 'Adjustable regulator', C, { left: ['IN'], right: ['OUT'], bottom: ['ADJ'], title: '317', value: 'LM317', keywords: 'linear regulator adjustable lm317', numbers: false }),
  chip('buck', 'Buck converter', C, { left: ['VIN', 'EN', 'GND'], right: ['SW', 'FB'], title: 'BUCK', value: 'MP1584', keywords: 'dc-dc switching step down smps' }),
  chip('ic-dip8', 'Generic IC (8 pins)', C, { ...DIP(8), title: 'U', value: 'IC', keywords: 'dip soic chip', numbers: false }),
  chip('ic-dip14', 'Generic IC (14 pins)', C, { ...DIP(14), title: 'U', value: 'IC', keywords: 'dip soic chip', numbers: false }),
  chip('ic-dip16', 'Generic IC (16 pins)', C, { ...DIP(16), title: 'U', value: 'IC', keywords: 'dip soic chip', numbers: false }),
  chip('mcu-atmega328', 'Microcontroller (ATmega328P)', C, {
    left: ['~RESET', 'VCC', 'GND', 'XTAL1', 'XTAL2', 'AREF', 'AVCC', 'PD0', 'PD1', 'PD2', 'PD3', 'PD4', 'PD5', 'PD6', 'PD7'],
    right: ['PC0', 'PC1', 'PC2', 'PC3', 'PC4', 'PC5', 'PB0', 'PB1', 'PB2', 'PB3', 'PB4', 'PB5'],
    title: 'ATmega328P', value: 'ATmega328P', keywords: 'arduino avr microcontroller mcu', minW: 100,
  }),
  chip('mcu-generic', 'Microcontroller (generic)', C, { left: ['VCC', 'GND', '~RST', 'TX', 'RX', 'SDA', 'SCL'], right: ['IO0', 'IO1', 'IO2', 'IO3', 'IO4', 'IO5', 'ADC'], title: 'MCU', value: 'ESP32', keywords: 'esp32 stm32 rp2040 microcontroller', minW: 80 }),
  chip('eeprom', 'I²C EEPROM', C, { left: ['A0', 'A1', 'A2', 'GND'], right: ['VCC', 'WP', 'SCL', 'SDA'], title: '24C', value: '24LC256', keywords: 'memory i2c' }),
  chip('adc', 'ADC', C, { left: ['IN0', 'IN1', 'IN2', 'IN3', 'GND'], right: ['VDD', 'SCL', 'SDA', 'ALRT'], title: 'ADC', value: 'ADS1115', keywords: 'analog digital converter' }),
  chip('dac', 'DAC', C, { left: ['VDD', 'SCL', 'SDA', 'GND'], right: ['OUT'], title: 'DAC', value: 'MCP4725', keywords: 'digital analog converter' }),
  chip('motor-driver', 'H-bridge driver', C, { left: ['IN1', 'IN2', 'EN', 'VCC', 'GND'], right: ['OUT1', 'OUT2', 'VS'], title: 'H-BRIDGE', value: 'L298N', keywords: 'motor driver h bridge' }),
  chip('usb-uart', 'USB-UART bridge', C, { left: ['D+', 'D-', 'VBUS', 'GND'], right: ['TXD', 'RXD', '~RTS', '~CTS'], title: 'UART', value: 'CH340G', keywords: 'ftdi cp2102 serial usb' }),
  sym('tl431', 'TL431 (shunt reference)', C, {
    w: 60, h: 60, prefix: 'U', value: 'TL431', keywords: 'tl431 shunt voltage reference zener',
    draw: 'CB 30 30 20; L 30 0 30 14; L 0 30 18 30; L 30 46 30 60; GF 32 28 32 32 38 30; W 2.5; L 24 14 32 14 30 22; W 2',
    ports: 'K:30,0 A:30,60 REF:0,30',
  }),
  chip('opamp-dual', 'Op-amp (dual)', C, {
    left: ['OUTA', '-INA', '+INA', 'V-'],
    right: ['+INB', '-INB', 'OUTB', 'V+'],
    title: 'LM358',
    value: 'LM358',
    prefix: 'U',
    keywords: 'opamp operational amplifier dual',
    minW: 60,
  }),
  chip('ldo-en', 'LDO regulator (enable)', C, {
    left: ['IN', 'EN'],
    right: ['OUT', 'ADJ'],
    bottom: ['GND'],
    title: 'LDO',
    value: 'AP2112K-3.3',
    prefix: 'U',
    keywords: 'ldo regulator voltage enable adjust',
  }),
  chip('osc-module', 'Oscillator module', C, {
    left: ['EN'],
    right: ['OUT'],
    top: ['VCC'],
    bottom: ['GND'],
    title: 'OSC',
    value: '16MHz',
    prefix: 'Y',
    keywords: 'oscillator clock crystal module',
  }),
  chip('vref', 'Voltage reference', C, {
    left: ['IN'],
    right: ['OUT'],
    bottom: ['GND'],
    title: 'REF',
    value: 'REF3030',
    prefix: 'U',
    keywords: 'voltage reference precision vref',
  }),
];
