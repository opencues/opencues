import { describe, expect, it, vi } from 'vitest';
import { BlankFill } from './blank-fill';
import { ConfigLoader } from './config-loader';
import { MockAdapter, wrapTipsAsCuesMd } from '../../testing/mock-adapter';
import { SpanFillState } from '../state/span-fill';
import { DynDefs } from '../state/dyn-defs';
import { WEAVE_VALUE_TOKEN, type BlankWeaver } from './blank-weave';

// SCENARIO test for the integration-weave data-loss bug the LIVE agentic run
// caught: a `clearOnEdit` blank wove its output, then the whole line got wiped.
// Root cause: the static fill's span/clearOnEdit watcher reacted to the weave's
// setText as a foreign edit and wiped the pair. Pinned here deterministically
// with a mock weaver (no live LLM). Fill commits via `pushText`, so the buffer
// is read with `getText()`.

const TIPS = wrapTipsAsCuesMd({ concepts: [] });

// A clearOnEdit script-blank with an integration exemplar + weave opt-in —
// the exact shape that reproduced the wipe.
const DIM_CUE = `---
type: blank
name: dim
blankKeywords: dim
blankScript: ./dim.sh
blankSuffix: %
integration: set to {value}
integration-weave: true
blankClearOnEdit: true
---
`;

const flush = async () => { for (let i = 0; i < 8; i++) await new Promise(r => setTimeout(r, 0)); };

async function setupWeave(weaver: BlankWeaver, weaveMode = 'on', extraSettings = '') {
  const adapter = new MockAdapter({
    cwd: '/proj',
    files: {
      '/mock/CUES.md': TIPS,
      '/proj/blanks/dim/BLANK.md': DIM_CUE,
      '/proj/.cues/OPENCUES.md': `---\nintegration-weave-mode: ${weaveMode}\n${extraSettings}\n---\n`,
    },
  });
  adapter.stubBlankInvoke('dim:get', '30\n');
  const loader = new ConfigLoader(adapter, { settingsFile: '/proj/.cues/OPENCUES.md' });
  await loader.load();
  const spanFillState = new SpanFillState();
  const dynDefs = new DynDefs();
  const bf = new BlankFill(adapter, loader, spanFillState, undefined, undefined, dynDefs, undefined, weaver);
  bf.subscribe();
  return { adapter, loader, bf, spanFillState, dynDefs };
}

describe('integration-weave — clearOnEdit wipe regression', () => {
  it('weave on a clearOnEdit blank preserves prior content + splices value (NO wipe)', async () => {
    const weaver = vi.fn(async () => `we set it to ${WEAVE_VALUE_TOKEN} now`);
    const { adapter, spanFillState } = await setupWeave(weaver);

    adapter.pushText('lights ready.\ndim _');
    await flush();

    const finalText = adapter.getText();
    // THE BUG: this used to become just 'lights ready.\n' (whole line wiped).
    expect(finalText).toBe('lights ready.\nwe set it to 30% now');
    expect(finalText).not.toBe('lights ready.\n');
    expect(finalText).toContain('lights ready.'); // prior content preserved
    expect(finalText).toContain('30%');           // value spliced deterministically

    // The clearOnEdit/span watcher was retired so it can't wipe the woven prose.
    expect(spanFillState.current).toBeNull();
    expect(weaver).toHaveBeenCalledOnce();
  });

  it('the weaver NEVER receives the real value — only the exemplar + prior context', async () => {
    const weaver = vi.fn(async () => `it is ${WEAVE_VALUE_TOKEN}`);
    const { adapter } = await setupWeave(weaver);
    adapter.pushText('mood lighting.\ndim _');
    await flush();
    expect(weaver).toHaveBeenCalledOnce();
    const req = weaver.mock.calls[0]![0] as Record<string, unknown>;
    expect(req).not.toHaveProperty('value');     // structural privacy guarantee
    expect(req.exemplar).toBe('set to {value}'); // exemplar carries {value}, not the value
    expect(typeof req.priorContext).toBe('string');
  });

  it('weave failure (returns null) keeps the static fill — never blocks or corrupts', async () => {
    const weaver = vi.fn(async () => null);
    const { adapter } = await setupWeave(weaver);
    adapter.pushText('lights ready.\ndim _');
    await flush();
    const out = adapter.getText();
    expect(out).toContain('lights ready.'); // prior content intact
    expect(out).toContain('set to 30%');    // static template stays
    expect(out).not.toContain('_');         // the _ was filled, not stranded
  });

  it('mode off → no weave call at all (pure static template)', async () => {
    const weaver = vi.fn(async () => `woven ${WEAVE_VALUE_TOKEN}`);
    const { adapter } = await setupWeave(weaver, 'off');
    adapter.pushText('lights ready.\ndim _');
    await flush();
    expect(weaver).not.toHaveBeenCalled();
    expect(adapter.getText()).toContain('set to 30%');
  });
});

describe('integration-weave — wait-first, single-change contract', () => {
  // A weaver whose promise we resolve by hand, to inspect the buffer WHILE the
  // weave is in flight.
  function deferredWeaver() {
    let resolve!: (v: string | null) => void;
    const promise = () => new Promise<string | null>(r => { resolve = r; });
    const fn = vi.fn(promise);
    return { fn, resolve: (v: string | null) => resolve(v) };
  }

  it('does NOT commit the static fill before the weave — buffer changes ONCE', async () => {
    const d = deferredWeaver();
    const { adapter } = await setupWeave(d.fn);

    adapter.pushText('lights ready.\ndim _');
    await flush(); // dispatch + get done; weave is now in flight (unresolved)

    // The whole point of wait-first: the static template must NOT have landed.
    expect(d.fn).toHaveBeenCalledOnce();
    expect(adapter.getText()).not.toContain('set to 30%');

    d.resolve(`we set it to ${WEAVE_VALUE_TOKEN} now`);
    await flush();

    // Exactly one content change: straight to the woven text, no static stop.
    expect(adapter.getText()).toBe('lights ready.\nwe set it to 30% now');
  });

  it('drops the fill if the user edits during the weave wait (no clobber)', async () => {
    const d = deferredWeaver();
    const { adapter } = await setupWeave(d.fn);

    adapter.pushText('lights ready.\ndim _');
    await flush(); // weave in flight

    // User keeps typing while the LLM call is outstanding.
    adapter.pushText('changed my mind entirely');
    await flush();

    d.resolve(`we set it to ${WEAVE_VALUE_TOKEN} now`);
    await flush();

    // The late weave must not splice into the user's new buffer.
    expect(adapter.getText()).not.toContain('30%');
    expect(adapter.getText()).not.toContain('we set it to');
  });

  it('falls back to the static template when the weave exceeds the timeout', async () => {
    // Weaver resolves at ~250ms; timeout pinned to 30ms via the setting.
    const slow = vi.fn(() => new Promise<string | null>(r => setTimeout(() => r(`woven ${WEAVE_VALUE_TOKEN}`), 250)));
    const { adapter } = await setupWeave(slow, 'on', 'integration-weave-timeout-ms: 30');

    adapter.pushText('lights ready.\ndim _');
    // Wait past the 30ms timeout (but before the 250ms weave would resolve).
    await new Promise(r => setTimeout(r, 90));
    await flush();

    // Timeout fired → static template landed (one change), the `_` is filled.
    expect(adapter.getText()).toContain('set to 30%');
    expect(adapter.getText()).not.toContain('_');
  });
});
