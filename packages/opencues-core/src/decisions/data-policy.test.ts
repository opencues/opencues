import { describe, expect, it } from 'vitest';
import { DATA_POLICY, captureDataArg, resolveDataInvocation, dataArgWithinFloor, dataCanonicalCommand, DATA_ARG_MAX } from './data-policy';

describe('data-policy: what a table verdict may invoke (security-audit row #32)', () => {
  it('names only the two shipped offline built-ins, never a user blank', () => {
    for (const e of Object.values(DATA_POLICY)) expect(['tables', 'countries']).toContain(e.blank);
    expect(resolveDataInvocation({ table: 'zorb-script', confidence: 0.9, top: '' }, 'zorb it _')).toBeNull();
  });

  it.each([
    ['hex', "what's the hex for cornflower blue _", 'hex for', 'cornflower blue'],
    ['rgb', 'rgb value of #1e90ff _', 'rgb for', '#1e90ff'],
    ['http', 'which http code for not found _', 'http status for', 'not found'],
    ['http', 'what does 418 mean _', 'http status for', '418'],
    ['mime', "what's the content type for json _", 'mime type for', 'json'],
    ['port', 'what port does postgres use _', 'default port for', 'postgres'],
    ['unicode', 'how do i type an em dash _', 'unicode for', 'em dash'],
    ['convert', 'how many feet in a mile _', 'convert', 'how many feet in a mile'],
    ['convert', 'whats 100f in celsius _', 'convert', '100f in celsius'],
    ['calc', 'whats 17 times 23 _', 'calc', '17 times 23'],
    ['calc', 'what is (2+3)*4 _', 'calc', '(2+3)*4'],
    ['atomic-number', 'atomic number of gold _', 'atomic number of', 'gold'],
    ['boiling-point', 'at what temperature does water boil _', 'boiling point of', 'water'],
    ['ph', 'how acidic is lemon juice _', 'ph of', 'lemon juice'],
    ['capital', "what's the capital of france _", 'capital of', 'france'],
    ['population', 'how many people live in japan _', 'population of', 'japan'],
    ['currency', 'what currency does brazil use _', 'currency of', 'brazil'],
    ['languages', 'what languages do they speak in india _', 'languages of', 'india'],
  ])('%s: "%s" → %s "%s" (the argument is captured by grammar, never a model string)', (table, draft, keyword, arg) => {
    const inv = resolveDataInvocation({ table, confidence: 0.9, top: '' }, draft);
    expect(inv).toEqual({ blank: DATA_POLICY[table].blank, keyword, action: 'get', value: arg });
    expect(dataCanonicalCommand(inv!)).toBe(`${keyword} ${arg} _`);
  });

  it('captures from the segment holding the `_` only: prior prose is not the argument', () => {
    expect(captureDataArg('hex', 'hi there. whats the hex for tomato _')).toBe('tomato');
    expect(captureDataArg('port', 'lots of prose here\nthe postgres port _')).toBe('postgres');
  });

  it('the floor: URL structure, control chars, length; an expression needs a number', () => {
    expect(captureDataArg('port', 'what port for http://evil _')).toBeNull();
    expect(dataArgWithinFloor('a' + String.fromCharCode(7) + 'b', false)).toBe(false);
    expect(dataArgWithinFloor('x'.repeat(DATA_ARG_MAX + 1), false)).toBe(false);
    expect(dataArgWithinFloor('the risk', true)).toBe(false);
    expect(dataArgWithinFloor('how many feet in a mile', true)).toBe(true);
    expect(dataArgWithinFloor('process.exit(1)', true)).toBe(false);
    expect(captureDataArg('calc', 'calculate the risk _')).toBeNull();
  });

  it('an empty argument resolves to nothing', () => {
    expect(resolveDataInvocation({ table: 'capital', confidence: 0.9, top: '' }, 'what is the capital _')).toBeNull();
  });
});
