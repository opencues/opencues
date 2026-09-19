import { describe, it, expect } from 'vitest';
import type { CalcContext } from './types';
import { calculatorById } from './registry';

const ctx = (settings: Record<string, string> = {}): CalcContext => ({ now: () => new Date('2026-09-19T11:30:00.000Z'), timeZone: 'Europe/London', setting: (k) => settings[k], random: () => 0.5, command: '' });
const run = (id: string, arg: string, c: CalcContext = ctx()) => calculatorById(id)!.run(arg, c);

describe('money', () => {
  it('percent forms', () => {
    expect(run('percent-off', '20% off 85')).toBe('68 (saves 17)');
    expect(run('percent-off', '85 with 20% off')).toBe('68 (saves 17)');
    expect(run('percent-of-what', '85 is what percent of 340')).toBe('25%');
    expect(run('percent-of-what', 'what percent of 340 is 85')).toBe('25%');
    expect(run('percent-change', '80 to 92')).toBe('+15% (80 → 92, +12)');
    expect(run('percent-change', 'from 92 to 80')).toBe('-13.04% (92 → 80, -12)');
    expect(run('percent-plus', '85 plus 20%')).toBe('102 (+17)');
    expect(run('percent-plus', '85 minus 20%')).toBe('68 (-17)');
    expect(run('percent-change', 'the risk')).toBeNull();
  });
  it('tips, splits, VAT from the setting', () => {
    expect(run('tip', '15% on 64.20')).toBe('tip 9.63 · total 73.83');
    expect(run('tip', '64.20')).toBe('tip 9.63 (15%) · total 73.83');
    expect(run('tip', '20% on 100 split 4 ways')).toBe('tip 20 · total 120 · 30 each (4 ways)');
    expect(run('split', '143 four ways')).toBe('35.75 each (4 ways)');
    expect(run('split', '143 four ways with 15% tip')).toBe('41.11 each (4 ways, total 164.45 with 15% tip)');
    expect(run('vat', '120 plus vat')).toBe('144 (20% VAT: 24)');
    expect(run('vat', '120 ex vat')).toBe('100 (20% VAT: 20)');
    expect(run('vat', 'vat on 120')).toBe('24 (20% of 120 → 144 inc)');
    expect(run('vat', '120 plus vat', ctx({ 'vat-rate': '5' }))).toBe('126 (5% VAT: 6)');
    expect(run('vat', '120 plus 19% vat')).toBe('142.80 (19% VAT: 22.80)');
  });
  it('interest, loans, growth', () => {
    expect(run('compound', '1000 at 5% for 10 years')).toBe('1,628.89 (interest 628.89, yearly)');
    expect(run('compound', '1000 at 5% for 10 years monthly')).toBe('1,647.01 (interest 647.01, monthly)');
    expect(run('simple-interest', '1000 at 5% for 3 years')).toBe('150 (total 1,150)');
    expect(run('monthly-payment', 'on 250000 at 6% over 30 years')).toBe('1,498.88/month (total 539,595.47, interest 289,595.47)');
    expect(run('apr-to-monthly', '12%')).toBe('1% per month (12.68% effective annual)');
    expect(run('doubling-time', 'at 7%')).toBe('10.24 years (rule of 72: 10.3)');
    expect(run('margin', 'cost 40 sell 60')).toBe('margin 33.33% · markup 50% · profit 20');
    expect(run('break-even', 'fixed 5000 price 25 cost 10')).toBe('334 units (333.3 → revenue 8,350)');
    expect(run('per-hour', '80000 a year per hour')).toBe('38.46/h (40 h/wk, 52 wk)');
    expect(run('per-hour', '80k a year per hour at 37.5 hours a week')).toBe('41.03/h (37.5 h/wk, 52 wk)');
    expect(run('per-year', '35 an hour per year')).toBe('72,800/yr (40 h/wk, 52 wk) · 6,066.67/month');
    expect(run('unit-price', '6 for 4.20')).toBe('0.70 each');
    expect(run('discount-to-reach', '85 from 100')).toBe('15% off');
    expect(run('cagr', '100 to 250 over 5 years')).toBe('20.11%/yr');
  });
});

describe('geometry & physics', () => {
  it('shapes', () => {
    expect(run('area-of', 'a circle radius 4')).toBe('50.27 (π × 4²)');
    expect(run('area-of', 'a circle diameter 8')).toBe('50.27 (π × 4²)');
    expect(run('area-of', 'a rectangle 3 by 4')).toBe('12 (3 × 4)');
    expect(run('area-of', 'a triangle base 3 height 4')).toBe('6 (½ × 3 × 4)');
    expect(run('circumference', 'of a circle radius 4')).toBe('25.13 (2π × 4)');
    expect(run('volume-of', 'a sphere radius 2')).toBe('33.51 (4⁄3 π × 2³)');
    expect(run('volume-of', 'a cylinder radius 2 height 5')).toBe('62.83 (π × 2² × 5)');
    expect(run('volume-of', 'a box 2 by 3 by 4')).toBe('24 (2 × 3 × 4)');
    expect(run('surface-area', 'a sphere radius 2')).toBe('50.27 (4π × 2²)');
    expect(run('hypotenuse', '3 4')).toBe('5');
    expect(run('hypotenuse', 'missing side hypotenuse 5 side 3')).toBe('4');
    expect(run('distance-between', '(1,2) and (4,6)')).toBe('5');
    expect(run('deg-rad', '30 degrees in radians')).toBe('0.5236 (π/6)');
    expect(run('deg-rad', '2 radians in degrees')).toBe('114.59°');
    expect(run('trig', 'sin of 30 degrees')).toBe('0.5');
    expect(run('trig', 'cos 60')).toBe('0.5');
    expect(run('trig', 'tan of 1 rad')).toBe('1.557408');
    expect(run('slope', '3 in 12')).toBe('14.04° (25% grade, 1 in 4)');
    expect(run('slope', '8%')).toBe('4.57° (8% grade, 1 in 12.5)');
    expect(run('area-of', 'the problem')).toBeNull();
  });
  it('body, sport, energy', () => {
    expect(run('bmi', '80kg 1.8m')).toBe('24.7 (normal, 18.5–24.9)');
    expect(run('bmi', '180 lb 5ft 11')).toBe('25.1 (overweight, 25–29.9)');
    expect(run('bmr', 'male 80kg 180cm 35')).toBe('1,755 kcal/day (Mifflin-St Jeor) · ×1.55 moderate 2,720');
    expect(run('bmr', 'female 60kg 165cm age 30')).toBe('1,320 kcal/day (Mifflin-St Jeor) · ×1.55 moderate 2,046');
    expect(run('heart-rate', 'zones at 35')).toBe('max 185 · z1 93–111 · z2 111–130 · z3 130–148 · z4 148–167 · z5 167–185');
    expect(run('pace', '5k in 24:30')).toBe('4:54 /km (7:53 /mi) · 12.24 km/h');
    expect(run('pace', 'marathon in 3:30:00')).toBe('4:59 /km (8:01 /mi) · 12.06 km/h');
    expect(run('speed', '10km in 48 min')).toBe('12.5 km/h (7.77 mph, 4:48 /km)');
    expect(run('fuel', '400 km at 6.5 l/100km')).toBe('26 L (400 km at 6.5 L/100 km)');
    expect(run('mpg', '35 mpg to l/100km')).toBe('6.72 L/100 km (US gallon); 8.07 UK');
    expect(run('mpg', '7 l/100km to mpg')).toBe('33.6 mpg (US); 40.35 mpg (UK)');
    expect(run('kinetic-energy', '2kg at 3m/s')).toBe('9 J (½ × 2 × 3²)');
    expect(run('free-fall', '5 seconds')).toBe('122.63 m, 49.05 m/s (no air resistance)');
    expect(run('free-fall', 'from 20 m')).toBe('2.02 s, lands at 19.81 m/s (no air resistance)');
    expect(run('ohms-law', '12v 4 ohm')).toBe('3 A · 36 W (V = I R)');
    expect(run('watts', '230v 3a')).toBe('690 W (230 V × 3 A)');
    expect(run('kwh-cost', '1500w for 3h at 0.28')).toBe('4.5 kWh = 1.26 (at 0.28/kWh)');
  });
  it('constants, planets, waves, media', () => {
    expect(run('constant', 'speed of light')).toMatch(/^299,792,458 m\/s/);
    expect(run('constant', 'absolute zero')).toBe('−273.15 °C (0 K, −459.67 °F)');
    expect(run('gravity-on', 'gravity on mars')).toBe('3.72 m/s² (0.38 g); escape velocity 5.03 km/s; day 24 h 37 min; year 687 days');
    expect(run('gravity-on', 'escape velocity of earth')).toBe('11.19 km/s');
    expect(run('gravity-on', 'weight on the moon 80kg')).toBe('13.21 kg-equivalent on moon (129.6 N)');
    expect(run('half-life', 'remaining 100g after 3 half-lives')).toBe('12.5 g (100 × ½³)');
    expect(run('half-life', 'half-life 5730 years after 10000 years')).toBe('29.83% remains (1.75 half-lives)');
    expect(run('decibels', '90 plus 90')).toBe('93.01 dB (two equal sources add 3 dB)');
    expect(run('wavelength', '440hz')).toBe('77.95 cm in air (sound); 681.35 km (radio)');
    expect(run('note-for', 'note for 440hz')).toBe('A4 (440 Hz, A = 440)');
    expect(run('note-for', 'frequency of C5')).toBe('523.25 Hz (midi 72)');
    expect(run('bpm', '120')).toBe('500 ms per beat · ¼ 125 ms · bar (4/4) 2 s');
    expect(run('aspect-ratio', '1920x1080')).toBe('16:9 (1.78)');
    expect(run('scale', '1920x1080 to width 1280')).toBe('1280×720');
    expect(run('scale', '1920x1080 to height 540')).toBe('960×540');
    expect(run('dpi', 'dpi 300 at 6x4 inches')).toBe('1800×1200 px');
    expect(run('download-time', '2gb at 50mbps')).toBe('5 min 20 s (2 GB at 50 Mbit/s)');
    expect(run('download-time', '2gb at 50mb/s')).toBe('40 s (2 GB at 50 MB/S)');
  });
});
