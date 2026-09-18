import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as os from 'node:os';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { loadDecisionLegs, resetDecisionPackage, DECISIONS_PATH_ENV } from './load';

describe('loadDecisionLegs', () => {
  const log: string[] = [];
  const saved = process.env[DECISIONS_PATH_ENV];
  const savedHome = process.env.HOME;
  // an empty HOME so a package installed at ~/opencues-decisions on the dev machine is not found
  beforeEach(() => { log.length = 0; resetDecisionPackage(); process.env.HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'oc-load-')); });
  afterEach(() => { if (saved === undefined) delete process.env[DECISIONS_PATH_ENV]; else process.env[DECISIONS_PATH_ENV] = saved; process.env.HOME = savedHome; resetDecisionPackage(); });

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
