export * from './adapter';
// Overlay wire mapping — shared by every host that paints OVER a foreign app's
// glyphs (windows shim, mac AX overlay) rather than rendering text itself.
export { mergeRenderDirectives } from './render-wire';
export type { RenderWire, WireRange } from './render-wire';
export { Runtime } from './runtime';
export type { RuntimeConfig } from './runtime';
export {
  shouldSynthesizeMacDoubleEscCtrl,
  buildOpenTuiModifiers,
  rewriteMacDoubleEscArrows,
  rewriteMacDoubleEscArrowsString,
  installMacDoubleEscStdinRewrite,
} from './modules/mac-keyboard';
export type { MacKeyboardRawEvent, OpenTuiKeyEvent, NormalisedModifiers } from './modules/mac-keyboard';
