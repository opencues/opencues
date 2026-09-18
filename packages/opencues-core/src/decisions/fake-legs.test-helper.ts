/**
 * A scripted DecisionLegs for the sources' tests: every leg returns what the
 * plan says and records what it was asked with. The package's own tests pin
 * the questions; these pin what a source DOES with a verdict.
 */
import type {
  DecisionLegs, DecisionLegContext, PauseInput, PauseVerdict, TipsVerdict, TipsEntryForDecision,
  ContradictionVerdict, CommitmentForDecision, DecisionUnit, UnderscoreRouting, RouteContext, ReplaceVerdict, SpellingVerdict, SettingsVerdict, DeviceVerdict, TableVerdict,
} from './legs';
import type { DecisionProvider } from './types';

export interface FakeLegsPlan {
  /** the tips verdict: id + confidence, or 'none'; `null` = every entry pre-checked out */
  tips?: { choice: string; confidence: number } | null;
  /** a function of the call index for scripted confidences */
  tipsScript?: number[];
  contradiction?: { choice: string; confidence: number; unit?: { choice: string; confidence: number } };
  ask?: number;
  spelling?: SpellingVerdict | null;
  sentenceGate?: ReadonlyArray<readonly [number, number]> | ((sentences: ReadonlyArray<string>) => ReadonlyArray<readonly [number, number]>);
  route?: Partial<UnderscoreRouting>;
  replace?: ReplaceVerdict | null;
  settings?: SettingsVerdict | null;
  device?: DeviceVerdict | null;
  table?: TableVerdict | null;
  /** throw from every leg */
  throws?: Error;
  /** throw from these legs only */
  throwFrom?: ReadonlyArray<keyof DecisionLegs>;
  /** answer after this many ms */
  delayMs?: number;
}

export interface FakeLegs extends DecisionLegs {
  readonly calls: Array<{ leg: string; args: unknown[] }>;
  readonly pauseInputs: PauseInput[];
}

export function fakeLegs(plan: FakeLegsPlan = {}): FakeLegs {
  const calls: Array<{ leg: string; args: unknown[] }> = [];
  const pauseInputs: PauseInput[] = [];
  let tipsCalls = 0;
  const provider: DecisionProvider = { id: 'fake', model: 'fake-1', async ask() { throw new Error('the fake legs never ask a provider'); } };
  const fail = (leg: keyof DecisionLegs): void => {
    if (plan.throws) throw plan.throws;
    if (plan.throwFrom?.includes(leg)) throw new Error(`fake ${leg} failed`);
  };
  const wait = async (): Promise<void> => { if (plan.delayMs) await new Promise((r) => setTimeout(r, plan.delayMs)); };
  const tipsVerdict = (): TipsVerdict | null => {
    if (plan.tips === null) return null;
    let choice = plan.tips?.choice ?? 'none';
    let confidence = plan.tips?.confidence ?? 0.9;
    if (plan.tipsScript) { confidence = plan.tipsScript[Math.min(tipsCalls++, plan.tipsScript.length - 1)]; choice = confidence >= 0.34 ? (plan.tips?.choice ?? 't1') : 'none'; }
    return { id: choice, confidence, p: confidence, top: `${choice} ${confidence.toFixed(2)}` };
  };
  const contradictionVerdict = (): ContradictionVerdict => {
    const c = plan.contradiction ?? { choice: 'none', confidence: 0.95 };
    return { choice: c.choice, confidence: c.confidence, top: `${c.choice} ${c.confidence.toFixed(2)}`, unit: c.unit };
  };
  return {
    provider, id: 'fake', model: 'fake-1', calls, pauseInputs,
    async pause(input: PauseInput, _ctx?: DecisionLegContext): Promise<PauseVerdict> {
      calls.push({ leg: 'pause', args: [input] }); pauseInputs.push(input);
      await wait(); fail('pause');
      const tips = input.tips ? tipsVerdict() : null;
      const contradiction = input.contradiction ? contradictionVerdict() : null;
      const ask = input.ask ? (plan.ask ?? 0) : null;
      const spelling = input.spelling ? (plan.spelling ?? null) : null;
      const empty = !input.tips && !input.contradiction && !input.ask && !input.spelling;
      return { tips, contradiction, ask, spelling, empty };
    },
    async askGate(text: string): Promise<number> { calls.push({ leg: 'askGate', args: [text] }); await wait(); fail('askGate'); return plan.ask ?? 0; },
    async tipsMatch(text: string, entries: ReadonlyArray<TipsEntryForDecision>): Promise<TipsVerdict | null> {
      calls.push({ leg: 'tipsMatch', args: [text, entries] }); await wait(); fail('tipsMatch');
      const v = tipsVerdict();
      // the real leg only offers entries not pre-checked out; mirror that so a plan naming an absent id reads as none
      if (v && v.id !== 'none' && !entries.some((e) => e.id === v.id)) return { ...v, id: 'none' };
      return v;
    },
    async contradictionGate(text: string, commitments: ReadonlyArray<CommitmentForDecision>, units: ReadonlyArray<DecisionUnit>): Promise<ContradictionVerdict> {
      calls.push({ leg: 'contradictionGate', args: [text, commitments, units] }); await wait(); fail('contradictionGate'); return contradictionVerdict();
    },
    async sentenceGate(gate: string, sentences: ReadonlyArray<string>): Promise<ReadonlyArray<readonly [number, number]>> {
      calls.push({ leg: 'sentenceGate', args: [gate, sentences] }); await wait(); fail('sentenceGate');
      const g = plan.sentenceGate;
      if (typeof g === 'function') return g(sentences);
      return g ?? sentences.map(() => [1, 1] as const);
    },
    async route(text: string, ctx?: RouteContext): Promise<UnderscoreRouting> {
      calls.push({ leg: 'route', args: [text, ctx] }); await wait(); fail('route');
      const r = plan.route ?? {};
      const route = r.route ?? null;
      return { route, sourceId: r.sourceId ?? (route === 'settings' ? 'config-intent' : route === 'transform' ? 'transform-blank' : route === 'lookup' ? 'fluid-blank' : null), choice: r.choice ?? (route ?? 'other'), confidence: r.confidence ?? 0.9, agreement: r.agreement ?? 0.9, probabilities: r.probabilities ?? {}, ms: r.ms ?? 1 };
    },
    async replace(input: string): Promise<ReplaceVerdict | null> { calls.push({ leg: 'replace', args: [input] }); await wait(); fail('replace'); return plan.replace ?? null; },
    async settings(input: string): Promise<SettingsVerdict | null> { calls.push({ leg: 'settings', args: [input] }); await wait(); fail('settings'); return plan.settings ?? null; },
    async device(input: string): Promise<DeviceVerdict | null> { calls.push({ leg: 'device', args: [input] }); await wait(); fail('device'); return plan.device ?? null; },
    async table(input: string): Promise<TableVerdict | null> { calls.push({ leg: 'table', args: [input] }); await wait(); fail('table'); return plan.table ?? null; },
  };
}
