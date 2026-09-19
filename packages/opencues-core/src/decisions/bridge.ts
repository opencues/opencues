/**
 * Bridged decision legs — the `DecisionLegs` contract over a message channel.
 *
 * A browser host (chrome's content script, dsh's client half) has no
 * filesystem, no environment and no decision package: the package and its
 * key live in a native process on the machine (chrome's native-messaging
 * host). `createBridgedDecisionLegs` gives the page a `DecisionLegs` whose
 * every leg is one message out and one verdict back; `serveDecisionLeg` is
 * the other end, run by the native process over the legs it loaded.
 *
 * What crosses the channel is DATA only: the leg name, its arguments (the
 * draft, catalogue entries, watchlist statements, sentence units, the
 * cue's gate line) and the verdict. No question, no template, no key.
 *
 * PII: `dispatchDecision`'s floor runs in the native process, where no
 * identity catalog is registered. So the floor runs HERE, on the page side,
 * over every string in the arguments before anything leaves the page — the
 * same walk the dispatch floor does over a request's state.
 *
 * Failures come back typed (`{ ok: false, error: { kind, message } }`) and
 * are rethrown as `DecisionError` with that kind, so the caller's breaker
 * classifies an auth failure on the host exactly as it would locally.
 */
import { DecisionError, type DecisionErrorKind } from './types';
import type { DecisionLegs, DecisionLegContext, PauseInput, PauseVerdict, TipsEntryForDecision, TipsVerdict, CommitmentForDecision, DecisionUnit, ContradictionVerdict, UnderscoreRouting, RouteContext, ReplaceVerdict, SettingsVerdict, DeviceVerdict, TableVerdict, ClaimSentence, ClaimVerdict } from './legs';
import { getOutboundDehydrationGuard } from '../llm-provider';

export type DecisionLegName = 'pause' | 'askGate' | 'tipsMatch' | 'contradictionGate' | 'sentenceGate' | 'route' | 'replace' | 'settings' | 'device' | 'table' | 'claims' | 'availability';
export const DECISION_LEG_NAMES: ReadonlyArray<DecisionLegName> = ['pause', 'askGate', 'tipsMatch', 'contradictionGate', 'sentenceGate', 'route', 'replace', 'settings', 'device', 'table', 'claims', 'availability'];

/** The wire shapes. `args` are the leg's positional arguments, made JSON-safe. */
export interface DecisionBridgeRequest { readonly leg: DecisionLegName; readonly args: ReadonlyArray<unknown> }
export type DecisionBridgeReply =
  | { readonly ok: true; readonly verdict: unknown; readonly id?: string; readonly model?: string }
  | { readonly ok: false; readonly error: { readonly kind: DecisionErrorKind | string; readonly message: string } };

export type DecisionBridgeSend = (req: DecisionBridgeRequest) => Promise<DecisionBridgeReply>;

const KINDS: ReadonlySet<string> = new Set(['auth', 'budget', 'shape', 'overloaded', 'transport', 'malformed']);

function mapStringsDeep(v: unknown, fn: (s: string) => string): unknown {
  if (typeof v === 'string') return fn(v);
  if (Array.isArray(v)) return v.map((x) => mapStringsDeep(x, fn));
  if (v instanceof Map) return { __map: [...v.entries()].map(([k, x]) => [k, mapStringsDeep(x, fn)]) };
  if (v && typeof v === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, x] of Object.entries(v)) out[k] = mapStringsDeep(x, fn);
    return out;
  }
  return v;
}

/** JSON-safe args: Maps become `{ __map: entries }`, strings pass through `fn` (the PII floor). */
export function serializeLegArgs(args: ReadonlyArray<unknown>, fn: (s: string) => string = (s) => s): unknown[] {
  return args.map((a) => mapStringsDeep(a, fn));
}

function reviveDeep(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(reviveDeep);
  if (v && typeof v === 'object') {
    const o = v as Record<string, unknown>;
    if (Array.isArray(o.__map) && Object.keys(o).length === 1) return new Map((o.__map as Array<[unknown, unknown]>).map(([k, x]) => [k, reviveDeep(x)]));
    const out: Record<string, unknown> = {};
    for (const [k, x] of Object.entries(o)) out[k] = reviveDeep(x);
    return out;
  }
  return v;
}

/** The page-side PII floor: every string in the args through the registered dehydrator, if any. */
function pageFloor(): (s: string) => string {
  try {
    const guard = getOutboundDehydrationGuard()?.();
    if (!guard || guard.size === 0) return (s) => s;
    return (s) => { const d = guard.dehydrate(s); return d.changed ? d.text : s; };
  } catch { return (s) => s; }
}

/** A `DecisionLegs` whose legs are messages over `send`. `id` / `model` update from the first reply that carries them. */
export function createBridgedDecisionLegs(send: DecisionBridgeSend, init: { id?: string; model?: string } = {}): DecisionLegs {
  const self = { id: init.id ?? 'bridge', model: init.model ?? 'host' };
  const provider = { get id() { return self.id; }, get model() { return self.model; }, async ask(): Promise<never> { throw new DecisionError('shape', 'bridged legs answer legs, not raw requests'); } };
  async function call<T>(leg: DecisionLegName, args: ReadonlyArray<unknown>, ctx?: DecisionLegContext): Promise<T> {
    if (ctx?.signal?.aborted) throw new DecisionError('transport', 'decision: aborted');
    const floor = pageFloor();
    // the ctx never crosses: no signal, no log; the caller keeps both
    const wire = serializeLegArgs(args, floor);
    let reply: DecisionBridgeReply;
    try { reply = await send({ leg, args: wire }); }
    catch (e) { throw new DecisionError('transport', `decision bridge: ${(e as Error)?.message ?? String(e)}`, e); }
    if (!reply || typeof reply !== 'object') throw new DecisionError('malformed', 'decision bridge: empty reply');
    if (!reply.ok) {
      const kind = KINDS.has(reply.error?.kind) ? (reply.error.kind as DecisionErrorKind) : 'transport';
      throw new DecisionError(kind, `decision bridge: ${reply.error?.message ?? 'failed'}`);
    }
    if (reply.id) self.id = reply.id;
    if (reply.model) self.model = reply.model;
    if (ctx?.signal?.aborted) throw new DecisionError('transport', 'decision: aborted');
    ctx?.log?.(`[decision][${leg}] via ${self.id}/${self.model}`);
    return reviveDeep(reply.verdict) as T;
  }
  return {
    provider,
    get id() { return self.id; },
    get model() { return self.model; },
    pause: (input: PauseInput, ctx?: DecisionLegContext) => call<PauseVerdict>('pause', [input], ctx),
    askGate: (text: string, ctx?: DecisionLegContext) => call<number>('askGate', [text], ctx),
    tipsMatch: (text: string, entries: ReadonlyArray<TipsEntryForDecision>, ctx?: DecisionLegContext) => call<TipsVerdict | null>('tipsMatch', [text, entries], ctx),
    contradictionGate: (text: string, commitments: ReadonlyArray<CommitmentForDecision>, units: ReadonlyArray<DecisionUnit>, ctx?: DecisionLegContext) => call<ContradictionVerdict>('contradictionGate', [text, commitments, units], ctx),
    sentenceGate: (gate: string, sentences: ReadonlyArray<string>, ctx?: DecisionLegContext) => call<ReadonlyArray<readonly [number, number]>>('sentenceGate', [gate, sentences], ctx),
    route: (text: string, ctx?: RouteContext) => call<UnderscoreRouting>('route', [text, ctx ? { threshold: ctx.threshold, identityContext: ctx.identityContext, tables: ctx.tables } : {}], ctx),
    replace: (input: string, ctx?: DecisionLegContext) => call<ReplaceVerdict | null>('replace', [input], ctx),
    settings: (input: string, ctx?: DecisionLegContext) => call<SettingsVerdict | null>('settings', [input], ctx),
    device: (input: string, ctx?: DecisionLegContext) => call<DeviceVerdict | null>('device', [input], ctx),
    table: (input: string, ctx?: DecisionLegContext) => call<TableVerdict | null>('table', [input], ctx),
    claims: (sentences: ReadonlyArray<ClaimSentence>, ctx?: DecisionLegContext) => call<ReadonlyArray<ClaimVerdict>>('claims', [sentences], ctx),
    availability: (sentences: ReadonlyArray<ClaimSentence>, ctx?: DecisionLegContext) => call<ReadonlyArray<number>>('availability', [sentences], ctx),
  };
}

/**
 * The host side: run one leg over real legs and answer in the wire shape.
 * Never throws — a failure is a typed reply so the page's breaker sees it.
 */
export async function serveDecisionLeg(legs: DecisionLegs, req: DecisionBridgeRequest, log?: (m: string) => void): Promise<DecisionBridgeReply> {
  const leg = req.leg;
  if (!DECISION_LEG_NAMES.includes(leg)) return { ok: false, error: { kind: 'shape', message: `unknown leg ${String(leg)}` } };
  const args = (Array.isArray(req.args) ? req.args : []).map(reviveDeep);
  try {
    let verdict: unknown;
    switch (leg) {
      case 'pause': verdict = await legs.pause(args[0] as PauseInput, { log }); break;
      case 'askGate': verdict = await legs.askGate(args[0] as string, { log }); break;
      case 'tipsMatch': verdict = await legs.tipsMatch(args[0] as string, args[1] as TipsEntryForDecision[], { log }); break;
      case 'contradictionGate': verdict = await legs.contradictionGate(args[0] as string, args[1] as CommitmentForDecision[], args[2] as DecisionUnit[], { log }); break;
      case 'sentenceGate': verdict = await legs.sentenceGate(args[0] as string, args[1] as string[], { log }); break;
      case 'route': { const c = (args[1] ?? {}) as RouteContext; verdict = await legs.route(args[0] as string, { threshold: c.threshold, identityContext: c.identityContext, log }); break; }
      case 'replace': verdict = await legs.replace(args[0] as string, { log }); break;
      case 'settings': {
        if (!legs.settings) return { ok: false, error: { kind: 'shape', message: 'the host package has no settings leg' } };
        verdict = await legs.settings(args[0] as string, { log }); break;
      }
      case 'device': {
        if (!legs.device) return { ok: false, error: { kind: 'shape', message: 'the host package has no device leg' } };
        verdict = await legs.device(args[0] as string, { log }); break;
      }
      case 'table': {
        if (!legs.table) return { ok: false, error: { kind: 'shape', message: 'the host package has no table leg' } };
        verdict = await legs.table(args[0] as string, { log }); break;
      }
      case 'claims': {
        if (!legs.claims) return { ok: false, error: { kind: 'shape', message: 'the host package has no claims leg' } };
        verdict = await legs.claims(args[0] as ClaimSentence[], { log }); break;
      }
      case 'availability': {
        if (!legs.availability) return { ok: false, error: { kind: 'shape', message: 'the host package has no availability leg' } };
        verdict = await legs.availability(args[0] as ClaimSentence[], { log }); break;
      }
    }
    return { ok: true, verdict: serializeLegArgs([verdict])[0], id: legs.id, model: legs.model };
  } catch (e) {
    const err = e as { kind?: string; message?: string };
    return { ok: false, error: { kind: KINDS.has(err?.kind ?? '') ? (err.kind as string) : 'transport', message: err?.message ?? String(e) } };
  }
}
