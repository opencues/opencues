// Tests for the F9 runtime warn on missing sandbox: declaration
// (INFOSEC F9 Option B, runtime side).
//
// Install-time refusal lives in `opencues review`. This file pins the
// runtime warn for pre-existing installs where the blank slipped past
// review.

import { describe, expect, it, vi } from 'vitest';
import { BlankFill } from './blank-fill';
import { ConfigLoader } from './config-loader';
import { MockAdapter } from '../../testing/mock-adapter';

const TIPS = `
## alternatives

\`\`\`json
{ "id": "x", "match": "x" }
\`\`\`
`;

describe('F9 — runtime warn when blankScript has no sandbox declaration', () => {
  it('warns once when a blankScript: blank lacks sandbox: and still runs (back-compat)', async () => {
    const SCRIPT_NO_SANDBOX = `---
type: blank
name: stocks
blankKeywords: stock
blankProximity: 10
blankScript: ./stocks.sh
---
`;
    const adapter = new MockAdapter({
      cwd: '/proj',
      files: { '/mock/CUES.md': TIPS, '/proj/blanks/stocks/BLANK.md': SCRIPT_NO_SANDBOX },
    });
    const logSpy = vi.spyOn(adapter, 'log');
    const loader = new ConfigLoader(adapter);
    await loader.load();
    const bf = new BlankFill(adapter, loader);
    bf.subscribe();
    const spawnSpy = vi.spyOn(adapter, 'spawnProcess');

    adapter.pushText('stock _');
    adapter.pushText('stock _ '); // second underscore-bearing change

    // Back-compat: the script DID spawn (we don't refuse pre-existing
    // installs).
    expect(spawnSpy).toHaveBeenCalled();
    // F9 warn should have fired AT LEAST once with the INFOSEC F9 tag.
    const f9Warns = logSpy.mock.calls.filter(c => c[0] === 'warn' && /F9/.test(String(c[1])));
    expect(f9Warns.length).toBeGreaterThanOrEqual(1);
    // Warn-once: dedup'd to one per blank-name per process.
    expect(f9Warns.length).toBe(1);
  });

  it('does NOT warn when blankScript declares sandbox: strict', async () => {
    const SCRIPT_STRICT = `---
type: blank
name: stocks
blankKeywords: stock
blankProximity: 10
blankScript: ./stocks.sh
sandbox: strict
---
`;
    const adapter = new MockAdapter({
      cwd: '/proj',
      files: { '/mock/CUES.md': TIPS, '/proj/blanks/stocks/BLANK.md': SCRIPT_STRICT },
    });
    const logSpy = vi.spyOn(adapter, 'log');
    const loader = new ConfigLoader(adapter);
    await loader.load();
    const bf = new BlankFill(adapter, loader);
    bf.subscribe();

    adapter.pushText('stock _');

    const f9Warns = logSpy.mock.calls.filter(c => c[0] === 'warn' && /F9/.test(String(c[1])));
    expect(f9Warns.length).toBe(0);
  });

  it('does NOT warn when blankScript declares sandbox: off (explicit acknowledgement)', async () => {
    const SCRIPT_OFF = `---
type: blank
name: volume
blankKeywords: volume
blankProximity: 10
blankScript: ./volume.sh
sandbox: off
---
`;
    const adapter = new MockAdapter({
      cwd: '/proj',
      files: { '/mock/CUES.md': TIPS, '/proj/blanks/volume/BLANK.md': SCRIPT_OFF },
    });
    const logSpy = vi.spyOn(adapter, 'log');
    const loader = new ConfigLoader(adapter);
    await loader.load();
    const bf = new BlankFill(adapter, loader);
    bf.subscribe();

    adapter.pushText('volume _');

    const f9Warns = logSpy.mock.calls.filter(c => c[0] === 'warn' && /F9/.test(String(c[1])));
    expect(f9Warns.length).toBe(0);
  });
});
