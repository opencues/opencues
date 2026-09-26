import { describe, it, expect } from 'vitest';
import type { CalcContext } from './types';
import { calculatorById } from './registry';
import { cronFor, cronExplain } from './reference';

const ctx: CalcContext = { now: () => new Date('2026-09-19T11:30:00.000Z'), timeZone: 'Europe/London', setting: () => undefined, random: () => 0.5, command: '' };
const run = (id: string, arg: string) => calculatorById(id)!.run(arg, ctx);

describe('reference tables', () => {
  it('alphabets', () => {
    expect(run('nato', 'wilfred')).toBe('Whiskey India Lima Foxtrot Romeo Echo Delta');
    expect(run('nato', 'a1 b2')).toBe('Alfa One · Bravo Two');
    expect(run('morse', 'sos')).toBe('... --- ...');
    expect(run('morse', 'hi there')).toBe('.... .. / - .... . .-. .');
    expect(run('morse', '... --- ...')).toBe('SOS');
    expect(run('morse', '.... .. / - .... . .-. .')).toBe('HI THERE');
    expect(run('greek', 'sigma')).toBe('σ Σ (sigma, 18th of 24; latin s)');
    expect(run('greek', 'alpha')).toBe('α Α (alpha, 1st of 24; latin a)');
    expect(run('greek', '')).toMatch(/^αΑ βΒ/);
    expect(run('greek', 'zorb')).toBeNull();
  });
  it('countries', () => {
    expect(run('country-code', 'germany')).toBe('DE · DEU · +49 · .de (EUR)');
    expect(run('country-code', 'the uk')).toBe('GB · GBR · +44 · .uk (GBP)');
    expect(run('dialling-code', 'brazil')).toBe('+55 (Brazil, BR)');
    expect(run('driving-side', 'japan')).toBe('Japan drives on the left');
    expect(run('driving-side', 'the united states')).toBe('United States drives on the right');
    expect(run('plug-type', 'australia')).toBe('Australia: type I (230 V, 50 Hz)');
    expect(run('plug-type', 'usa')).toBe('United States: type A, B (120 V, 60 Hz)');
    expect(run('tld', 'germany')).toBe('.de (Germany)');
    expect(run('country-code', 'zorbland')).toBeNull();
  });
  it('keys, cron, exit codes', () => {
    expect(run('keycode', 'enter')).toBe('Enter: keyCode 13 · key "Enter" · code "Enter"');
    expect(run('keycode', 'a')).toBe('A: keyCode 65 · key "a" · code "KeyA"');
    expect(run('keycode', 'f5')).toBe('F5: keyCode 116 · key "F5" · code "F5"');
    expect(run('keycode', 'escape key')).toBe('Escape: keyCode 27 · key "Escape" · code "Escape"');
    expect(cronFor('every 5 minutes')).toBe('*/5 * * * *');
    expect(cronFor('every day at 9')).toBe('0 9 * * *');
    expect(cronFor('every monday at 9:30')).toBe('30 9 * * 1');
    expect(cronFor('weekdays at 8am')).toBe('0 8 * * 1-5');
    expect(cronFor('first of the month at midnight')).toBe('0 0 1 * *');
    expect(cronFor('every 6 hours')).toBe('0 */6 * * *');
    expect(cronFor('twice a day at 6')).toBe('0 6,18 * * *');
    expect(cronFor('the risk')).toBeNull();
    expect(cronExplain('0 9 * * 1')).toBe('at 09:00 on Monday');
    expect(cronExplain('*/15 * * * *')).toBe('every 15 minutes');
    expect(cronExplain('30 8 1 * *')).toBe('at 08:30 on day 1 of the month');
    expect(run('cron', 'every monday at 9')).toBe('0 9 * * 1 (at 09:00 on Monday)');
    expect(run('cron', '0 9 * * 1-5')).toBe('0 9 * * 1-5: at 09:00 on Monday–Friday');
    expect(run('cron', 'what does 0 9 * * 1-5 mean')).toBe('0 9 * * 1-5: at 09:00 on Monday–Friday');
    expect(run('exit-code', 'exit code 137')).toBe('137: killed (SIGKILL, 128+9) — often the OOM killer or `kill -9`');
    expect(run('exit-code', 'exit code 0')).toBe('0: success');
    expect(run('exit-code', 'exit code 3')).toBe('3: program-defined (1–125 are the program\'s own error codes)');
    expect(run('exit-code', 'signal 15')).toBe('signal 15: SIGTERM terminate, the polite kill (exit code 143)');
    expect(run('exit-code', 'what does sigsegv mean')).toBe('SIGSEGV = signal 11 (segmentation fault); exit code 139 when it kills a process');
  });
  it('kitchen and sizes', () => {
    expect(run('cup-grams', '1 cup of flour in grams')).toBe('120 g (US cup, 240 ml)');
    expect(run('cup-grams', '2 cups sugar')).toBe('400 g (US cup, 480 ml)');
    expect(run('cup-grams', 'half a cup of butter in oz')).toBe('114 g (4 oz) (US cup, 120 ml)');
    expect(run('cup-grams', 'grams in a cup of rice')).toBe('185 g (US cup, 240 ml)');
    expect(run('oven', '350f fan oven')).toBe('350 °F = 180 °C conventional, 160 °C fan, 350 °F, gas mark 4');
    expect(run('oven', 'gas mark 6')).toBe('gas mark 6 = 200 °C conventional, 180 °C fan, 400 °F, gas mark 6');
    expect(run('oven', '180c in fan')).toBe('180 °C fan = 200 °C conventional, 180 °C fan, 400 °F, gas mark 6');
    expect(run('paper-size', 'a4 in inches')).toBe('A4: 210 × 297 mm = 8.27 × 11.69 in (2480 × 3508 px at 300 dpi)');
    expect(run('paper-size', 'letter size')).toBe('Letter: 216 × 279 mm = 8.50 × 10.98 in (2551 × 3295 px at 300 dpi)');
    expect(run('shoe-size', 'uk shoe size 9 in eu')).toBe('UK 9 (men) = US 10 = EU 43');
    expect(run('shoe-size', 'us women shoe size 8')).toBe('US 8 (women) = UK 6 = EU 39');
    expect(run('bed-size', 'king size bed in cm')).toBe('UK king 150 × 200 cm (5′ × 6′6″) · US king 193 × 203 cm (76 × 80 in) · EU king 160 × 200 cm');
    expect(run('bed-size', 'us queen bed size')).toBe('US queen 152 × 203 cm (60 × 80 in)');
  });
  it('signs and years', () => {
    expect(run('zodiac', '3 march')).toBe('Pisces ♓ (19 Feb – 20 Mar)');
    expect(run('zodiac', 'december 25')).toBe('Capricorn ♑ (22 Dec – 19 Jan)');
    expect(run('zodiac', '1 january')).toBe('Capricorn ♑ (22 Dec – 19 Jan)');
    expect(run('zodiac', 'august 23')).toBe('Virgo ♍ (23 Aug – 22 Sep)');
    expect(run('chinese-zodiac', 'chinese zodiac for 1990')).toMatch(/^1990: Metal Horse/);
    expect(run('chinese-zodiac', 'year of the 2000')).toMatch(/^2000: Metal Dragon/);
    expect(run('chinese-zodiac', 'chinese zodiac for 1985')).toMatch(/^1985: Wood Ox/);
    expect(run('dog-years', 'dog years for 7')).toMatch(/^7 dog years ≈ 49 human years/);
    expect(run('dog-years', 'cat years for 3')).toMatch(/^3 cat years ≈ 28 human years/);
  });
});
