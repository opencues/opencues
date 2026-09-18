import { describe, it, expect, afterEach } from 'vitest';
import { createBridgedDecisionLegs, serveDecisionLeg, serializeLegArgs, type DecisionBridgeRequest } from './bridge';
import { fakeLegs } from './fake-legs.test-helper';
import { DecisionError } from './types';
import { setOutboundDehydrationGuard } from '../llm-provider';
import { compileDehydrator } from '../dehydrate';

/** a page ↔ host pair wired directly: the page's send is the host's serve over JSON */
function pair(plan: Parameters<typeof fakeLegs>[0] = {}) {
  const host = fakeLegs(plan);
  const wire: DecisionBridgeRequest[] = [];
  const page = createBridgedDecisionLegs(async (req) => {
    const json = JSON.parse(JSON.stringify(req)) as DecisionBridgeRequest;   // what native messaging does
    wire.push(json);
    return JSON.parse(JSON.stringify(await serveDecisionLeg(host, json)));
  });
  return { host, page, wire };
}

describe('bridged decision legs', () => {
  afterEach(() => setOutboundDehydrationGuard(null));

  it('every leg round-trips as data: the host sees the arguments, the page gets the verdict, id/model follow the host', async () => {
    const { host, page, wire } = pair({ tips: { choice: 't1', confidence: 0.9 }, contradiction: { choice: 'c1', confidence: 0.8, unit: { choice: 's2', confidence: 0.7 } }, ask: 0.6, sentenceGate: [[0.9, 0.1]], route: { route: 'lookup' }, replace: { target: 'zephyr', command: 'zap _', kind: 'replace', confidence: 0.9, summary: 's' } });
    const v = await page.pause({ text: 'zephyr quark', words: ['zephyr', 'quark'], tips: [{ id: 't1', tip: 'ALT-ONE', command: '/zap' }], contradiction: { commitments: [{ id: 'c1', statement: 'ALT-RULE' }], units: [{ id: 's1', text: 'zephyr quark', start: 0, end: 12 }] }, ask: true });
    expect(v.tips?.id).toBe('t1'); expect(v.contradiction?.unit?.choice).toBe('s2'); expect(v.ask).toBe(0.6);
    expect(host.pauseInputs[0].tips?.[0].command).toBe('/zap');
    expect(page.id).toBe('fake'); expect(page.model).toBe('fake-1');
    expect(await page.askGate('x')).toBe(0.6);
    expect((await page.tipsMatch('x', [{ id: 't1', tip: 'ALT-ONE' }]))?.id).toBe('t1');
    expect((await page.contradictionGate('x', [{ id: 'c1', statement: 'r' }], [])).choice).toBe('c1');
    expect(await page.sentenceGate('Q?', ['a.'])).toEqual([[0.9, 0.1]]);
    expect((await page.route('capital of zorbland _')).sourceId).toBe('fluid-blank');
    expect((await page.replace('alpha zephyr zap _'))?.target).toBe('zephyr');
    expect(wire.map((w) => w.leg)).toEqual(['pause', 'askGate', 'tipsMatch', 'contradictionGate', 'sentenceGate', 'route', 'replace']);
  });

  it('the identity catalog on the route context survives the wire as a Map', async () => {
    const { host, page } = pair({ route: { route: 'lookup' } });
    await page.route('email Quarkle _', { identityContext: { mode: 'safe', catalog: new Map([['[ZEPHYR_NAME]', 'Quarkle']]) } });
    const ctx = host.calls[0].args[1] as { identityContext: { catalog: Map<string, string> } };
    expect(ctx.identityContext.catalog).toBeInstanceOf(Map);
    expect(ctx.identityContext.catalog.get('[ZEPHYR_NAME]')).toBe('Quarkle');
  });

  it('the PAGE floor dehydrates every string in the arguments before they leave (the host has no catalog)', async () => {
    setOutboundDehydrationGuard(() => compileDehydrator(new Map([['FIRST_NAME', 'Zephyrina']])));
    const { host, page } = pair({});
    await page.pause({ text: 'Zephyrina is pending', words: ['Zephyrina', 'is', 'pending'], tips: [{ id: 't1', tip: 'call Zephyrina' }] });
    const input = host.pauseInputs[0];
    expect(input.text).not.toContain('Zephyrina'); expect(input.text).toContain('FIRST_NAME');
    expect(input.words[0]).toContain('FIRST_NAME');
    expect(input.tips?.[0].tip).toContain('FIRST_NAME');
  });

  it('a host failure comes back typed and is rethrown with its kind (the breaker classifies auth)', async () => {
    const { page } = pair({ throws: new DecisionError('auth', 'typesafe: Unauthorized') });
    await expect(page.askGate('x')).rejects.toMatchObject({ name: 'DecisionError', kind: 'auth' });
    const dead = createBridgedDecisionLegs(async () => { throw new Error('no host'); });
    await expect(dead.askGate('x')).rejects.toMatchObject({ kind: 'transport' });
    const refused = createBridgedDecisionLegs(async () => ({ ok: false, error: { kind: 'zorb', message: 'x' } }));
    await expect(refused.askGate('x')).rejects.toMatchObject({ kind: 'transport' });
  });

  it('an aborted context never sends; an unknown leg is a shape reply', async () => {
    const sent: unknown[] = [];
    const page = createBridgedDecisionLegs(async (r) => { sent.push(r); return { ok: true, verdict: 1 }; });
    const ctl = new AbortController(); ctl.abort();
    await expect(page.askGate('x', { signal: ctl.signal })).rejects.toMatchObject({ kind: 'transport' });
    expect(sent).toEqual([]);
    const r = await serveDecisionLeg(fakeLegs(), { leg: 'zorb' as never, args: [] });
    expect(r).toMatchObject({ ok: false, error: { kind: 'shape' } });
  });

  it('serializeLegArgs is JSON-safe: Maps become tagged entries', () => {
    expect(JSON.parse(JSON.stringify(serializeLegArgs([new Map([['a', 1]])])))).toEqual([{ __map: [['a', 1]] }]);
  });
});
