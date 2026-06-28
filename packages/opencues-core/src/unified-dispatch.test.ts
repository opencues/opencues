/**
 * Unit tests for the unified-dispatch engine (Stage 1, pure).
 */

import { describe, it } from 'node:test';
import * as assert from 'node:assert';
import {
  buildDispatchSystem,
  renderDispatchCatalog,
  parseDispatchDecision,
  type DispatchBlankSpec,
} from './unified-dispatch';

const BLANKS: DispatchBlankSpec[] = [
  { name: 'weather', description: 'current weather for a city', actions: ['get'], readOnly: true },
  { name: 'volume',  description: 'system volume', actions: ['get', 'set', 'step'], readOnly: false },
  { name: 'stocks',  description: 'live share price', actions: ['get'], readOnly: true },
];

describe('renderDispatchCatalog / buildDispatchSystem', () => {
  it('lists each blank with its actions + read-only flag', () => {
    const c = renderDispatchCatalog(BLANKS);
    assert.match(c, /- weather \[get, read-only data\] — current weather/);
    assert.match(c, /- volume \[get\/set\/step, action\] — system volume/);
  });
  it('empty catalog → empty string', () => {
    assert.strictEqual(renderDispatchCatalog([]), '');
  });
  it('system prompt carries the routing rules + catalog', () => {
    const s = buildDispatchSystem(BLANKS);
    assert.match(s, /ROUTE: action \| lookup \| transform \| none/);
    assert.match(s, /conversational sentence is NOT an action/);
    assert.match(s, /AVAILABLE BLANKS/);
  });
});

const fmt = (o: Partial<Record<string, string>>) =>
  `ROUTE: ${o.ROUTE ?? ''}\nBLANK: ${o.BLANK ?? ''}\nACTION: ${o.ACTION ?? ''}\nARG: ${o.ARG ?? ''}\nREPLACE: ${o.REPLACE ?? ''}`;

describe('parseDispatchDecision — routes', () => {
  it('lookup — conversational query keeps the sentence (model picks the span)', () => {
    // "what's the weather like in oslo _" (len 33) → replace just the _ (32-33)
    const d = parseDispatchDecision(fmt({ ROUTE: 'lookup', REPLACE: '32-33' }), 33);
    assert.strictEqual(d.route, 'lookup');
    assert.strictEqual(d.replaceStart, 32);
    assert.strictEqual(d.replaceEnd, 33);
  });

  it('action — terse command resolves blank+action+arg', () => {
    const d = parseDispatchDecision(fmt({ ROUTE: 'action', BLANK: 'volume', ACTION: 'set', ARG: '50', REPLACE: '0-9' }), 9);
    assert.deepStrictEqual(d, { route: 'action', blank: 'volume', action: 'set', arg: '50', replaceStart: 0, replaceEnd: 9 });
  });

  it('action — step', () => {
    const d = parseDispatchDecision(fmt({ ROUTE: 'action', BLANK: 'volume', ACTION: 'step', ARG: 'up' }), 12);
    assert.strictEqual(d.route, 'action');
    assert.strictEqual(d.action, 'step');
    assert.strictEqual(d.arg, 'up');
  });

  it('transform', () => {
    const d = parseDispatchDecision(fmt({ ROUTE: 'transform' }), 20);
    assert.strictEqual(d.route, 'transform');
  });
});

describe('parseDispatchDecision — validate-and-degrade', () => {
  it('explicit none → none', () => {
    assert.deepStrictEqual(parseDispatchDecision(fmt({ ROUTE: 'none' }), 10), { route: 'none' });
  });
  it('unknown route → none', () => {
    assert.deepStrictEqual(parseDispatchDecision(fmt({ ROUTE: 'banana' }), 10), { route: 'none' });
  });
  it('action without a blank → none (meaningless)', () => {
    assert.deepStrictEqual(parseDispatchDecision(fmt({ ROUTE: 'action', ACTION: 'set', ARG: '50' }), 10), { route: 'none' });
  });
  it('action without an action verb → none', () => {
    assert.deepStrictEqual(parseDispatchDecision(fmt({ ROUTE: 'action', BLANK: 'volume', ARG: '50' }), 10), { route: 'none' });
  });
  it('garbage / empty → none (never throws)', () => {
    assert.doesNotThrow(() => parseDispatchDecision('not labelled output at all', 10));
    assert.strictEqual(parseDispatchDecision('not labelled output at all', 10).route, 'none');
  });
  it('clamps an out-of-bounds REPLACE span to the buffer length (no OOB splice)', () => {
    const d = parseDispatchDecision(fmt({ ROUTE: 'lookup', REPLACE: '500-9999' }), 20);
    assert.strictEqual(d.replaceStart, 20);
    assert.strictEqual(d.replaceEnd, 20);
  });
  it('end < start in REPLACE is normalised (end >= start)', () => {
    const d = parseDispatchDecision(fmt({ ROUTE: 'lookup', REPLACE: '10-3' }), 20);
    assert.ok((d.replaceEnd ?? 0) >= (d.replaceStart ?? 0));
  });
});
