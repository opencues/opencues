import { describe, it, expect } from 'vitest';
import { TablesBlank, tableFor, lookupUnicode, lookupColour, lookupHttp, lookupMime, lookupPort, convertUnits, evalMath, lookupChemistry } from './tables';
import { BUILTIN_BLANKS } from './index';

describe('tables: keyword → table', () => {
  it('routes every shipped keyword phrase', () => {
    expect(tableFor('unicode for')).toBe('unicode');
    expect(tableFor('hex for')).toBe('colour');
    expect(tableFor('rgb for')).toBe('colour');
    expect(tableFor('http status for')).toBe('http');
    expect(tableFor('mime type')).toBe('mime');
    expect(tableFor('default port for')).toBe('port');
    expect(tableFor('port for')).toBe('port');
    expect(tableFor('convert')).toBe('convert');
    expect(tableFor('calculate')).toBe('math');
    expect(tableFor('atomic mass of')).toBe('chemistry');
    expect(tableFor('ph of')).toBe('chemistry');
    expect(tableFor('weather')).toBeNull();
  });
});

describe('tables: lookups are data, never generation', () => {
  it('unicode', () => {
    expect(lookupUnicode('em dash')).toBe('— U+2014');
    expect(lookupUnicode('the copyright symbol')).toBe('© U+00A9');
    expect(lookupUnicode('zorbflux')).toBeNull();
  });
  it('colour: name, hex, short hex, hex-only / rgb-only', () => {
    expect(lookupColour('tomato')).toBe('#ff6347 · rgb(255, 99, 71)');
    expect(lookupColour('#1e90ff', 'rgb')).toBe('rgb(30, 144, 255)');
    expect(lookupColour('fff', 'hex')).toBe('#ffffff');
    expect(lookupColour('zorb')).toBeNull();
  });
  it('http: by code, by phrase, by alias, by fragment', () => {
    expect(lookupHttp('404')).toBe('404 Not Found');
    expect(lookupHttp('not found')).toBe('404 Not Found');
    expect(lookupHttp('teapot')).toBe("418 I'm a teapot");
    expect(lookupHttp('999')).toBeNull();
  });
  it('mime + port', () => {
    expect(lookupMime('png')).toBe('image/png');
    expect(lookupMime('.json file')).toBe('application/json');
    expect(lookupPort('postgres')).toBe('postgres: 5432');
    expect(lookupPort('the redis server')).toBe('redis: 6379');
    expect(lookupPort('zorb')).toBeNull();
  });
  it('convert: length, temperature, "how many X in a Y", family mismatch', () => {
    expect(convertUnits('5 miles to km')).toBe('5 miles = 8.04672 km');
    expect(convertUnits('100 celsius to fahrenheit')).toBe('100 celsius = 212 fahrenheit');
    expect(convertUnits('how many feet in a mile')).toBe('1 mile = 5280 feet');
    expect(convertUnits('3 kg to miles')).toBeNull();
  });
  it('math: precedence, parentheses, unary minus, percent, sqrt, pi, and no eval()', () => {
    expect(evalMath('17 * 23')).toBe('391');
    expect(evalMath('2 + 3 * 4')).toBe('14');
    expect(evalMath('(2 + 3) * 4')).toBe('20');
    expect(evalMath('-3 + 5')).toBe('2');
    expect(evalMath('2 ^ 10')).toBe('1024');
    expect(evalMath('15% of 240')).toBe('36');
    expect(evalMath('sqrt 2')).toBe('1.41421');
    expect(evalMath('pi to 4 decimals')).toBe('3.1416');
    expect(evalMath('1 / 0')).toBeNull();
    expect(evalMath('process.exit(1)')).toBeNull();
    expect(evalMath('the risk')).toBeNull();
  });
  it('chemistry: element by name or symbol, substance constants', () => {
    expect(lookupChemistry('atomic number of', 'gold')).toBe('Gold (Au): atomic number 79');
    expect(lookupChemistry('atomic mass of', 'Au')).toMatch(/^Gold \(Au\): 196\.9\d* u$/);
    expect(lookupChemistry('boiling point of', 'water')).toBe('water: boils at 100 °C');
    expect(lookupChemistry('melting point of', 'iron')).toBe('iron: melts at 1538 °C');
    expect(lookupChemistry('ph of', 'zorb')).toBeNull();
  });
});

describe('TablesBlank (the registered built-in)', () => {
  const blank = new TablesBlank();
  it('is registered under `tables`, read-only', () => {
    const spec = BUILTIN_BLANKS.find((b) => b.name === 'tables');
    expect(spec).toBeDefined();
    expect(blank.readOnly).toBe(true);
  });
  it('renders the argument with its answer, so the consumed command span reads as a fact', async () => {
    expect(await blank.get('hex for', ['tomato'])).toBe('tomato: #ff6347');
    expect(await blank.get('rgb for', ['tomato'])).toBe('tomato: rgb(255, 99, 71)');
    expect(await blank.get('http status for', ['not', 'found'])).toBe('404 Not Found');
    expect(await blank.get('calc', ['17', '*', '23'])).toBe('17 * 23 = 391');
    expect(await blank.get('convert', ['5', 'miles', 'to', 'km'])).toBe('5 miles = 8.04672 km');
    expect(await blank.get('atomic number of', ['gold'])).toBe('Gold (Au): atomic number 79');
  });
  it('a miss says so, in the table\'s own words, never a guess', async () => {
    expect(await blank.get('hex for', ['zorb'])).toBe('zorb: not a CSS colour');
    expect(await blank.get('calc', ['the', 'risk'])).toBe('the risk: cannot compute');
    expect(await blank.get('weather', ['london'])).toBe('');
  });
});
