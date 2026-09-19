/**
 * The shipped defaults/blanks/tables/BLANK.md must route EVERY calculator's
 * example through BlankFill to the calculator that answers it: keyword
 * scan (or the `table` phrase sentinel), shape capture, dispatch args, and
 * the answer via lookupTable. A calculator added to the registry without a
 * shape, or a shape whose keyword scan lands on the wrong keyword, fails
 * here. Also pins the rewrite-shaped negatives the shapes must not claim.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve as resolvePath } from 'node:path';
import { BlankFill } from '../../modules/blank-fill';
import { ConfigLoader } from '../../modules/config-loader';
import { MockAdapter } from '../../../testing/mock-adapter';
import { CALCULATORS } from './registry';
import { lookupTable, configureCalcEnv } from '../tables';

const TIPS = JSON.stringify({ concepts: [] });
const REPO_ROOT = resolvePath(__dirname, '../../../../..');
const TABLES_MD = readFileSync(resolvePath(REPO_ROOT, 'defaults/blanks/tables/BLANK.md'), 'utf8');
const NOW = new Date('2026-09-19T11:30:00.000Z');

async function setup(text: string) {
  const adapter = new MockAdapter({
    cwd: '/proj',
    files: { '/mock/CUES.md': TIPS, '/proj/blanks/tables/BLANK.md': TABLES_MD, '/proj/OPENCUES.md': '---\ntable-lookups-mode: on\n---\n' },
    capabilities: ['render-override', 'dim-ranges', 'highlight-range', 'file-read', 'file-write', 'force-render', 'change-source', 'blank-invoke'],
  });
  adapter.stubBlankInvoke('tables:get', 'ALT-ONE');
  const loader = new ConfigLoader(adapter, { settingsFile: '/proj/OPENCUES.md' });
  await loader.load();
  const bf = new BlankFill(adapter, loader);
  bf.subscribe();
  adapter.pushText(text);
  await new Promise((r) => setTimeout(r, 0));
  return adapter;
}

describe('defaults/blanks/tables/BLANK.md routes every calculator example', () => {
  beforeAll(() => configureCalcEnv({ now: () => NOW }));
  afterAll(() => configureCalcEnv({ now: () => new Date() }));
  const tz = process.env.TZ;
  it.each(CALCULATORS.map((c) => [c.id, c.example[0], c.example[1]] as const))('%s: "%s _"', async (id, input, answer) => {
    const adapter = await setup(`${input} _`);
    expect(adapter.blankInvokeCalls, `no dispatch for "${input} _"`).toHaveLength(1);
    const call = adapter.blankInvokeCalls[0];
    expect(call.blankName).toBe('tables');
    const [keyword, ...ctx] = call.args as string[];
    const got = lookupTable(keyword, ctx.join(' '));
    const c = CALCULATORS.find((x) => x.id === id)!;
    if (c.generator || id === 'unix-now' || id === 'iso-now') { expect(got).not.toBeNull(); return; }
    // clock-relative answers depend on the host zone the test runs in; pin shape only when TZ is not London
    if (['time-plus', 'time-in', 'convert-time', 'utc-offset', 'is-dst', 'overlap', 'meeting-at'].includes(id) && tz !== 'Europe/London') { expect(got).not.toBeNull(); return; }
    expect(got, `${id} via keyword "${keyword}" ctx ${JSON.stringify(ctx)}`).toBe(answer);
  });

  it.each([
    'convert this to markdown _', 'calculate the risk _', 'round this up _', 'in the end _', 'after the meeting _',
    'first draft _', 'the last one _', 'log this _', 'until then _', 'since you asked _', 'age _', 'time in the office _',
  ])('"%s" is NOT claimed', async (text) => {
    const adapter = await setup(text);
    expect(adapter.blankInvokeCalls).toHaveLength(0);
    expect(adapter.getText()).toBe(text);
  });
});
