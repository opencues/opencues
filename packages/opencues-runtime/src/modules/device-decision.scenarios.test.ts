/**
 * A device fill DECIDED on the decision layer (security-audit row #32):
 * the resolver's `_` route names a shipped device blank, core's policy
 * resolves the invocation, and BlankFill synthesizes the slot a shape match
 * would have produced — same script, same clearing — over the writer's own
 * phrase. Fixtures are synthetic (zorb).
 */
import { describe, expect, it, vi } from 'vitest';
import { BlankFill } from './blank-fill';
import { ConfigLoader } from './config-loader';
import { MockAdapter } from '../../testing/mock-adapter';

const TIPS = JSON.stringify({ concepts: [] });
const VOLUME = `---
type: blank
name: volume
blankKeywords: volume
blankStep: 6
blankSuffix: %
blankScript: ./volume-blank.sh
---
`;
const LOCATION = `---
type: blank
name: location
blankKeywords: location, address, map
blankScript: ./location-blank.sh
---
`;

async function setup(text: string) {
  const adapter = new MockAdapter({ cwd: '/proj', files: { '/mock/CUES.md': TIPS, '/proj/blanks/volume/BLANK.md': VOLUME, '/proj/blanks/location/BLANK.md': LOCATION } });
  const loader = new ConfigLoader(adapter);
  await loader.load();
  const bf = new BlankFill(adapter, loader);
  bf.subscribe();
  adapter.pushTextSilently?.(text) ?? adapter.pushText(text);
  return { adapter, bf };
}
const tick = () => new Promise((r) => setTimeout(r, 30));

describe('BlankFill.fillFromDecision — a device verdict fills over the writer\'s phrase', () => {
  it('a decided STEP runs the blank\'s step and renders "<keyword> <value>" over the whole phrase', async () => {
    const { adapter, bf } = await setup('make it louder _');
    adapter.stubBlankInvoke('volume:get', '40\n');
    adapter.stubBlankInvoke('volume:set', '46\n');
    adapter.stubBlankInvoke('volume:step', '46\n');
    const ran = bf.fillFromDecision('make it louder _', { blank: 'volume', keyword: 'volume', action: 'step', value: 'up' }, 0);
    expect(ran).toBe(true);
    await tick(); await tick();
    // the mock's get always answers 40; the real read-back after the step is what renders
    // a step is get + set(current ± blankStep): 40 + 6
    expect(adapter.blankInvokeCalls.some((c) => c.blankName === 'volume' && c.action === 'set' && c.args.includes('46'))).toBe(true);
    const last = adapter.setTextCalls.at(-1) ?? adapter.getText();
    expect(last).toMatch(/^volume 40%?$/);
    expect(last).not.toContain('louder');
  });

  it('a decided SET with a grammar-captured number sets it; the number never came from the model', async () => {
    const { adapter, bf } = await setup('put my sound at 20 _');
    adapter.stubBlankInvoke('volume:get', '40\n');
    adapter.stubBlankInvoke('volume:set', '20\n');
    expect(bf.fillFromDecision('put my sound at 20 _', { blank: 'volume', keyword: 'volume', action: 'set', value: '20' }, 0)).toBe(true);
    await tick(); await tick();
    expect(adapter.blankInvokeCalls.some((c) => c.blankName === 'volume' && c.action === 'set' && c.args.includes('20'))).toBe(true);
    expect(adapter.setTextCalls.at(-1) ?? adapter.getText()).toMatch(/^volume 40%?$/);   // the mock's read-back
  });

  it('a decided bare GET keeps the keyword as the label and consumes the phrase', async () => {
    const { adapter, bf } = await setup('where am i _');
    adapter.stubBlankInvoke('location:get', 'ALT-PLACE\n');
    expect(bf.fillFromDecision('where am i _', { blank: 'location', keyword: 'location', action: 'get' }, 0)).toBe(true);
    await tick(); await tick();
    expect(adapter.setTextCalls.at(-1) ?? adapter.getText()).toBe('location ALT-PLACE');
  });

  it('a phrase after prior prose keeps the prose: only the command span is consumed', async () => {
    const text = 'ok done. make it louder _';
    const { adapter, bf } = await setup(text);
    adapter.stubBlankInvoke('volume:get', '40\n');
    adapter.stubBlankInvoke('volume:step', '46\n');
    expect(bf.fillFromDecision(text, { blank: 'volume', keyword: 'volume', action: 'step', value: 'up' }, 2)).toBe(true);
    await tick(); await tick();
    expect(adapter.setTextCalls.at(-1) ?? adapter.getText()).toMatch(/^ok done\. volume 40%?$/);
  });

  it('an unregistered blank, or no `_`, runs nothing', async () => {
    const { adapter, bf } = await setup('zorb it _');
    expect(bf.fillFromDecision('zorb it _', { blank: 'zorb', keyword: 'zorb', action: 'get' }, 0)).toBe(false);
    expect(bf.fillFromDecision('make it louder', { blank: 'volume', keyword: 'volume', action: 'step', value: 'up' }, 0)).toBe(false);
    expect(adapter.blankInvokeCalls.length).toBe(0);
  });
});

// ── a data fill decided on the layer (data-policy.ts) ─────────────────────
const TABLES = `---
type: blank
name: tables
blankKeywords: hex for, default port for, calc
---
`;
const COUNTRIES = `---
type: blank
name: countries
blankKeywords: capital of
---
`;
async function setupData(text: string) {
  const adapter = new MockAdapter({ cwd: '/proj', files: { '/mock/CUES.md': TIPS, '/proj/blanks/tables/BLANK.md': TABLES, '/proj/blanks/countries/BLANK.md': COUNTRIES }, capabilities: ['render-override', 'dim-ranges', 'highlight-range', 'file-read', 'file-write', 'force-render', 'change-source', 'blank-invoke'] });
  const loader = new ConfigLoader(adapter);
  await loader.load();
  const bf = new BlankFill(adapter, loader);
  bf.subscribe();
  adapter.pushTextSilently?.(text) ?? adapter.pushText(text);
  return { adapter, bf };
}

describe('BlankFill.fillFromDecision — a table verdict is probed, then fills like a shape match', () => {
  it('a hit runs the built-in over the captured argument and consumes the phrase', async () => {
    const text = 'zephyr. what port does postgres use _';
    const { adapter, bf } = await setupData(text);
    adapter.stubBlankInvoke('tables:get', 'ALT-ONE');
    expect(bf.fillFromDecision(text, { blank: 'tables', keyword: 'default port for', action: 'get', value: 'postgres' }, 1)).toBe(true);
    await tick(); await tick();
    expect(adapter.blankInvokeCalls).toHaveLength(1);
    expect(adapter.blankInvokeCalls[0]).toMatchObject({ blankName: 'tables', action: 'get', args: ['default port for', 'postgres'] });
    expect(adapter.setTextCalls.at(-1) ?? adapter.getText()).toBe('zephyr. ALT-ONE');
  });

  it('a miss in the table runs nothing, so the resolver falls through to the chat fan-out', async () => {
    const text = 'what port does zorbd use _';
    const { adapter, bf } = await setupData(text);
    expect(bf.fillFromDecision(text, { blank: 'tables', keyword: 'default port for', action: 'get', value: 'zorbd' }, 0)).toBe(false);
    expect(bf.fillFromDecision('capital of zorbland _', { blank: 'countries', keyword: 'capital of', action: 'get', value: 'zorbland' }, 0)).toBe(false);
    expect(bf.fillFromDecision('calculate the risk _', { blank: 'tables', keyword: 'calc', action: 'get', value: 'the risk' }, 0)).toBe(false);
    expect(adapter.blankInvokeCalls.length).toBe(0);
    expect(adapter.getText()).toBe(text);
  });

  it('a country fact the bundled table holds fills', async () => {
    const text = 'whats the capital of france _';
    const { adapter, bf } = await setupData(text);
    adapter.stubBlankInvoke('countries:get', 'ALT-CITY');
    expect(bf.fillFromDecision(text, { blank: 'countries', keyword: 'capital of', action: 'get', value: 'france' }, 0)).toBe(true);
    await tick(); await tick();
    expect(adapter.setTextCalls.at(-1) ?? adapter.getText()).toBe('ALT-CITY');
  });
});
