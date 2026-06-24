import { describe, it, expect } from 'vitest';
import { CountriesBlank } from './countries';
import type { CountryFacts } from './countries-data';

// Small fixture dataset (matches the bundled-table shape). Keys are
// normalised (lowercase, alnum + single spaces) like the generator emits.
const DATA: Record<string, CountryFacts> = {
  france: { name: 'France', capital: 'Paris', population: 67750000, region: 'Europe', area: 551695, currency: { code: 'EUR', name: 'Euro' }, languages: ['French'] },
  india: { name: 'India', capital: 'New Delhi', population: 1428000000, region: 'Asia', area: 3287590, currency: { code: 'INR', name: 'Indian rupee' }, languages: ['Hindi', 'English', 'Tamil', 'Telugu'] },
  'united states': { name: 'United States', capital: 'Washington D.C.', population: 331000000, region: 'Americas', area: 9372610, currency: { code: 'USD', name: 'US Dollar' }, languages: ['English'] },
};
const fixture = () => new CountriesBlank({ data: DATA });

describe('CountriesBlank (bundled dataset)', () => {
  it('returns "<fact>: no country" when keyword has no country context', async () => {
    expect(await fixture().get('population of', [])).toBe('population: no country');
  });

  it('extracts country from context + formats population in M', async () => {
    expect(await fixture().get('population of', ['france'])).toBe('France population: 67.8M');
  });

  it('extracts capital correctly', async () => {
    expect(await fixture().get('capital of', ['france'])).toBe('France capital: Paris');
  });

  it('formats currency as "<name> (<code>)"', async () => {
    expect(await fixture().get('currency of', ['france'])).toBe('France currency: Euro (EUR)');
  });

  it('formats area with km² suffix', async () => {
    expect(await fixture().get('area of', ['france'])).toBe('France area: 551,695 km²');
  });

  it('returns first 3 languages joined', async () => {
    expect(await fixture().get('languages of', ['india'])).toBe('India languages: Hindi, English, Tamil');
  });

  it('returns "<country>: not found" for an unknown country', async () => {
    expect(await fixture().get('population of', ['atlantis'])).toBe('atlantis: not found');
  });

  it('handles multi-word country names ("united states")', async () => {
    expect(await fixture().get('capital of', ['united', 'states'])).toBe('United States capital: Washington D.C.');
  });

  it('formats population >= 1B as "X.YB"', async () => {
    expect(await fixture().get('population of', ['india'])).toBe('India population: 1.4B');
  });

  // Pins that the BUNDLED table is wired + loads. Uses stable facts that
  // won't change (Paris is France's capital; Japan's currency is JPY).
  describe('real bundled data', () => {
    it('resolves a stable capital from the bundle', async () => {
      expect(await new CountriesBlank().get('capital of', ['france'])).toBe('France capital: Paris');
    });
    it('resolves an alias (usa) + a stable currency code', async () => {
      expect(await new CountriesBlank().get('currency of', ['japan'])).toContain('(JPY)');
      expect(await new CountriesBlank().get('capital of', ['usa'])).toBe('United States capital: Washington D.C.');
    });
  });
});
