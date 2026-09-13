/**
 * The two render-level bindings a band hands to the event bridge so a dump
 * can expose what would be PAINTED right now: `renderDirectives` (the
 * dim / highlight / inlineNote directives for the live buffer, recomputed
 * through the band's own render emitter — the same pipeline as
 * `collectRenderDirectives`) and `renderedText` (those directives applied to
 * the buffer text, ANSI-stripped, so a scenario can assert the note's
 * aligned splice).
 *
 * ONE implementation on purpose. Until Sep 2026 the OC band carried this
 * inline and the shell / gemini / windows bands, cloned from it, started the
 * bridge without either hook — so `render` was null there and every scenario
 * reading `render.N.inlineNote` failed on those hosts alone, with nothing in
 * the runtime saying why. The CC band keeps its own (it recomputes against
 * a viewport slice — see adapters/cc/v2.1/boot.ts). `boot-bands-wiring.test.ts`
 * pins that every band starting the bridge spreads this in.
 *
 * Hosts whose buffer read strips a render-kick sentinel (gemini's trailing
 * ZWS) do so inside `adapter.getText()`, so the text used here is clean.
 */
import type { RenderContext, RenderDirectives } from './adapter';
import type { BridgeBindings } from './event-bridge';
import { applyDirectives } from './render-directives';

interface RenderCollector {
  collect(ctx: RenderContext, onError: (err: unknown) => void): RenderDirectives[];
}

export function bridgeRenderBindings(
  adapter: { getText(): string; getCursorOffset(): number },
  renderEvents: RenderCollector,
  log: (level: 'error', msg: string, data?: unknown) => void,
): Required<Pick<BridgeBindings, 'renderDirectives' | 'renderedText'>> {
  const collect = (text: string) => renderEvents.collect(
    { text, cursor: adapter.getCursorOffset(), externalHighlights: [] },
    err => log('error', 'render handler threw', err),
  );
  return {
    renderDirectives: () => collect(adapter.getText()),
    renderedText: () => {
      const text = adapter.getText();
      let out = text;
      for (const d of collect(text)) {
        if (d) out = applyDirectives(out, d, 0);
      }
      return out.replace(/\x1b\[[0-9;]*m/g, '');
    },
  };
}
