/**
 * Every host band must WIRE the shared boot services.
 *
 * ⚠ Why this file exists. Cue dismissals were wired once inside
 * `buildSharedRuntime`, on the belief that every band calls it. Six do; the
 * Claude Code band does not — it predates the helper and assembles its modules
 * by hand, mentioning `buildSharedRuntime` only in comments. A `grep -l` for
 * the name matched those comments, the wiring looked universal, and on CC the
 * `_`-twice gesture fired, logged `cue forget`, and silently degraded to a mute
 * because no writer was registered. Nothing reached `dismissals.json`, and the
 * only symptom was an empty `opencues dismissals`.
 *
 * So: assert on the CALL, never on the mention. A band that opts out of
 * `buildSharedRuntime` has to wire each service itself, and this test is what
 * says so out loud when someone adds the next one.
 */

import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

const ADAPTERS = path.resolve(__dirname, '..', 'adapters');

/** Every band's boot file, as [label, source]. */
function bands(): Array<[string, string]> {
  const out: Array<[string, string]> = [];
  for (const host of fs.readdirSync(ADAPTERS)) {
    const hostDir = path.join(ADAPTERS, host);
    if (!fs.statSync(hostDir).isDirectory()) continue;
    for (const version of fs.readdirSync(hostDir)) {
      const boot = path.join(hostDir, version, 'boot.ts');
      if (fs.existsSync(boot)) out.push([`${host}/${version}`, fs.readFileSync(boot, 'utf8')]);
    }
  }
  return out;
}

/** Strip line + block comments, so a mention can never pass for a call. */
function code(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
}

describe('boot bands wire the shared services', () => {
  it('finds every band (guards against the glob silently matching nothing)', () => {
    const found = bands().map(([label]) => label);
    expect(found.length).toBeGreaterThanOrEqual(6);
    expect(found).toContain('cc/v2.1');
  });

  it.each(bands())('%s wires cue dismissals', (_label, src) => {
    const body = code(src);
    const viaShared = /\bbuildSharedRuntime\s*\(/.test(body);
    const direct = /\bstartCueDismissals\s*\(/.test(body);
    // Either route is fine; having neither means a forget cannot be persisted
    // on that host and the gesture degrades with no visible failure.
    expect(viaShared || direct).toBe(true);
  });

  it('the CC band wires it DIRECTLY — it does not call buildSharedRuntime', () => {
    // Pinned as a fact about this band rather than an assumption elsewhere: if
    // CC ever adopts buildSharedRuntime, this test fails and whoever does it
    // gets to remove the hand wiring deliberately instead of doubling it up.
    const cc = bands().find(([label]) => label === 'cc/v2.1')?.[1] ?? '';
    const body = code(cc);
    expect(/\bbuildSharedRuntime\s*\(/.test(body)).toBe(false);
    expect(/\bstartCueDismissals\s*\(/.test(body)).toBe(true);
  });
});
