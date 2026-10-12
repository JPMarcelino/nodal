import { chip } from '../chip';
import { sym } from '../dsl';

const C = 'Output & Sensors';

export const output = [
  sym('lamp', 'Lamp', C, { w: 60, h: 40, prefix: 'LP', value: '12V 5W', keywords: 'bulb light indicator', draw: 'L 0 20 16 20; L 44 20 60 20; CB 30 20 14; L 20 10 40 30; L 40 10 20 30', ports: '1:0,20 2:60,20' }),
  sym('led-rgb', 'RGB LED', C, {
    w: 80, h: 80, prefix: 'D', value: 'RGB', keywords: 'rgb led common cathode colour',
    draw: 'L 0 10 26 10; GF 26 3 26 17 40 10; W 2.5; L 40 3 40 17; W 2; L 0 40 26 40; GF 26 33 26 47 40 40; W 2.5; L 40 33 40 47; W 2; L 0 70 26 70; GF 26 63 26 77 40 70; W 2.5; L 40 63 40 77; W 2; L 40 10 60 10 60 70 40 70; L 40 40 80 40; CF 60 40 2.5; T 12 7 7 m R; T 12 37 7 m G; T 12 67 7 m B',
    ports: 'R:0,10 G:0,40 B:0,70 K:80,40',
  }),
  sym('seven-segment', '7-segment display', C, {
    w: 100, h: 180, prefix: 'DS', value: 'CC', keywords: 'seven segment display digit',
    draw: 'L 0 20 20 20; L 0 40 20 40; L 0 60 20 60; L 0 80 20 80; L 0 100 20 100; L 0 120 20 120; L 0 140 20 140; L 0 160 20 160; L 80 90 100 90; RB 20 4 60 172 3; T 26 23 8 s a; T 26 43 8 s b; T 26 63 8 s c; T 26 83 8 s d; T 26 103 8 s e; T 26 123 8 s f; T 26 143 8 s g; T 26 163 8 s dp; T 74 93 8 e com; W 3; L 50 66 66 66; L 68 70 66 86; L 66 94 64 110; L 46 114 62 114; L 44 94 42 110; L 48 70 46 86; L 48 90 64 90; CF 68 114 2; W 2',
    ports: 'a:0,20 b:0,40 c:0,60 d:0,80 e:0,100 f:0,120 g:0,140 dp:0,160 COM:100,90',
  }),
  sym('buzzer', 'Buzzer', C, { w: 60, h: 60, prefix: 'BZ', value: '5V', keywords: 'beeper sounder piezo alarm', draw: 'L 20 60 20 44; L 40 60 40 44; PB M 8 44 H 52 V 40 A 22 22 0 0 0 8 40 Z; T 13 56 9 m +', ports: '+:20,60 -:40,60' }),
  sym('speaker', 'Speaker', C, { w: 60, h: 60, prefix: 'LS', value: '8Ω', keywords: 'loudspeaker audio sound', draw: 'L 0 20 14 20; L 0 40 14 40; RB 14 16 12 28; GB 26 16 46 2 46 58 26 44', ports: '1:0,20 2:0,40' }),
  sym('microphone', 'Microphone', C, { w: 60, h: 40, prefix: 'MK', value: 'Electret', keywords: 'mic audio sound', draw: 'L 0 10 22 10; L 0 30 22 30; CB 38 20 16; W 3; L 22 4 22 36; W 2', ports: '+:0,10 -:0,30' }),
  sym('piezo', 'Piezo transducer', C, { w: 60, h: 40, prefix: 'BZ', value: '', keywords: 'piezoelectric sounder sensor', draw: 'L 0 20 20 20; W 2.5; L 20 6 20 34; L 40 6 40 34; W 2; RB 25 10 10 20; L 40 20 60 20', ports: '1:0,20 2:60,20' }),
  sym('motor-dc', 'DC motor', C, { w: 40, h: 80, prefix: 'M', value: '12V', keywords: 'motor dc brushed', draw: 'L 20 0 20 20; L 20 60 20 80; CB 20 40 20; T 20 46 17 m M; T 8 12 9 m +', ports: '+:20,0 -:20,80' }),
  sym('motor-ac', 'AC motor', C, { w: 40, h: 80, prefix: 'M', value: '230V', keywords: 'motor ac induction', draw: 'L 20 0 20 20; L 20 60 20 80; CB 20 40 20; T 20 42 15 m M; W 1.5; P M 12 49 Q 16 44 20 49 Q 24 54 28 49; W 2', ports: '1:20,0 2:20,80' }),
  sym('stepper-motor', 'Stepper motor', C, { w: 80, h: 80, prefix: 'M', value: 'NEMA17', keywords: 'stepper bipolar motor', draw: 'L 0 30 20 30; L 0 50 20 50; L 60 30 80 30; L 60 50 80 50; CB 40 40 24; T 40 46 16 m M; W 1.5; L 30 58 34 58 34 54 38 54 38 50 42 50; W 2', ports: 'A+:0,30 A-:0,50 B+:80,30 B-:80,50' }),
  chip('servo', 'Servo', C, { left: ['PWM', 'V+', 'GND'], title: 'SERVO', prefix: 'M', keywords: 'rc servo motor pwm', numbers: false }),
  sym('solenoid', 'Solenoid', C, { w: 80, h: 40, prefix: 'L', value: '12V', keywords: 'actuator coil plunger valve', draw: 'L 0 30 20 30; A 25 30 5 180 360; A 35 30 5 180 360; A 45 30 5 180 360; A 55 30 5 180 360; L 60 30 80 30; W 3; L 28 16 74 16; W 2', ports: '1:0,30 2:80,30' }),
  sym('heater', 'Heater', C, { w: 80, h: 40, prefix: 'HT', value: '100W', keywords: 'heating element resistor', draw: 'L 0 20 20 20; L 60 20 80 20; RB 20 10 40 20; W 1.5; L 26 30 34 10; L 34 30 42 10; L 42 30 50 10; L 50 30 56 15; W 2', ports: '1:0,20 2:80,20' }),
  sym('fan', 'Fan', C, { w: 40, h: 80, prefix: 'FAN', value: '12V', keywords: 'cooling fan blower', draw: 'L 20 0 20 20; L 20 60 20 80; CB 20 40 20; PF M 20 40 Q 14 26 22 24 Q 28 30 20 40 Z; PF M 20 40 Q 34 40 34 48 Q 26 52 20 40 Z; PF M 20 40 Q 12 50 6 44 Q 10 36 20 40 Z', ports: '+:20,0 -:20,80' }),
  sym('bell', 'Bell', C, { w: 60, h: 60, prefix: 'BL', keywords: 'alarm bell ring', draw: 'L 20 60 20 46; L 40 60 40 46; PB M 10 46 Q 10 12 30 12 Q 50 12 50 46 Z; L 4 46 56 46; C 30 8 3', ports: '1:20,60 2:40,60' }),
  sym('headphones', 'Headphones', C, { w: 60, h: 60, prefix: 'J', keywords: 'audio earphones', draw: 'A 30 34 22 180 360; RB 4 30 10 16 3; RB 46 30 10 16 3; L 0 40 4 40; L 56 40 60 40; L 30 60 30 52 9 52 9 46; L 30 52 51 52 51 46', ports: 'L:0,40 R:60,40 G:30,60' }),
  sym('thermocouple', 'Thermocouple', C, { w: 60, h: 40, prefix: 'TC', value: 'K-type', keywords: 'temperature sensor', draw: 'L 0 10 30 10 44 20; W 3; L 0 30 30 30 44 20; W 2; CF 44 20 3; T 10 7 8 m +; T 10 41 8 m −', ports: '+:0,10 -:0,30' }),
  chip('hall-sensor', 'Hall sensor', C, { left: ['VCC', 'GND'], right: ['OUT'], title: 'HALL', prefix: 'U', value: 'A3144', keywords: 'magnetic hall effect', numbers: false }),
  chip('temperature-sensor', 'Temperature sensor', C, { left: ['VDD', 'GND'], right: ['DQ'], title: 'TEMP', prefix: 'U', value: 'DS18B20', keywords: 'thermometer lm35 tmp36', numbers: false }),
  chip('pir-sensor', 'PIR motion sensor', C, { left: ['VCC', 'GND'], right: ['OUT'], title: 'PIR', prefix: 'U', value: 'HC-SR501', keywords: 'motion infrared', numbers: false }),
  chip('ultrasonic', 'Ultrasonic sensor', C, { left: ['VCC', 'TRIG', 'ECHO', 'GND'], title: 'SONAR', prefix: 'U', value: 'HC-SR04', keywords: 'distance ultrasonic', numbers: false }),
  chip('accelerometer', 'Accelerometer / IMU', C, { left: ['VCC', 'GND', 'SCL', 'SDA'], right: ['INT1', 'INT2'], title: 'IMU', prefix: 'U', value: 'MPU-6050', keywords: 'gyro imu motion i2c', numbers: false }),
  chip('lcd-16x2', 'LCD 16×2', C, { left: ['VSS', 'VDD', 'V0', 'RS', 'RW', 'E', 'D0', 'D1', 'D2', 'D3', 'D4', 'D5', 'D6', 'D7', 'A', 'K'], title: 'LCD 16×2', prefix: 'DS', value: 'HD44780', keywords: 'character display', minW: 80 }),
  chip('oled-i2c', 'OLED display (I²C)', C, { left: ['VCC', 'GND', 'SCL', 'SDA'], title: 'OLED', prefix: 'DS', value: 'SSD1306', keywords: 'display screen i2c', numbers: false }),
  sym('neon-lamp', 'Neon lamp', C, {
    w: 60, h: 40, prefix: 'DS', value: '', keywords: 'neon lamp indicator discharge',
    draw: 'L 0 20 16 20; L 44 20 60 20; CB 30 20 14; CF 30 20 2; L 20 10 40 30; L 40 10 20 30',
    ports: '1:0,20 2:60,20',
  }),
  sym('photo-interrupter', 'Photo interrupter (slotted)', C, {
    w: 80, h: 60, prefix: 'U', value: 'TCST2103', keywords: 'optical interrupter photointerrupter slotted slot',
    draw: 'W 1.5; R 10 4 60 52 3; W 2; L 0 20 26 20 26 31; GF 18 31 34 31 26 43; W 2.5; L 18 43 34 43; W 2; L 26 43 26 56 0 56; L 54 26 80 26; GF 66 26 60 23 60 29; L 54 34 80 34; GF 66 34 60 31 60 37; L 40 8 40 4; L 40 52 40 56; L 10 30 50 30',
    ports: 'A:0,20 K:0,56 C:80,26 E:80,34',
  }),
];
