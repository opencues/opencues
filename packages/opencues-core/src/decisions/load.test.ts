import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { loadDecisionLegs, resetDecisionPackage, DECISIONS_PATH_ENV } from './load';

describe('loadDecisionLegs', () => {
  const log: string[] = [];
  const saved = process.env[DECISIONS_PATH_ENV];
  beforeEach(() => { log.length = 0; resetDecisionPackage(); });
  afterEach(() => { if (saved === undefined) delete process.env[DECISIONS_PATH_ENV]; else process.env[DECISIONS_PATH_ENV] = saved; resetDecisionPackage(); });

  it('off → nothing, silently', () => {
    expect(loadDecisionLegs({ which: 'off', apiKeys: {}, httpAdapter: {}, log: (m) => log.push(m) })).toBeUndefined();
    expect(log).toEqual([]);
  });

  it('a scalar with no package installed → undefined with one line naming why, every leg on chat', () => {
    process.env[DECISIONS_PATH_ENV] = '/nonexistent/zephyr-decisions';
    expect(loadDecisionLegs({ which: 'typesafe', apiKeys: { TYPESAFE_API_KEY: 'k' }, httpAdapter: {}, log: (m) => log.push(m) })).toBeUndefined();
    expect(log.join('\n')).toMatch(/no decision package is installed/);
  });
});
