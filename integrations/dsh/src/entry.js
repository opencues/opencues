/**
 * OpenCues on DeepSeek Harness — the real integration.
 *
 * No reimplemented cue logic. This file is only a HOST BINDING LAYER: it
 * hands the runtime a way to read/write dsh's composer, feed it keys and
 * config, and paint whatever RenderDirectives come back. Navigation,
 * Cycling, DimRender, DynDefs, BlankFill and the Resolver are the real
 * modules from @opencues/runtime, so cue lifetime (including re-selecting a
 * word you already changed) is OpenCues' behaviour, not ours.
 *
 * The band used is chrome/v1, whose adapter is explicitly DOM-agnostic and
 * takes callback bindings. A dedicated adapters/dsh/v0.1 band would be a
 * near-clone of it, the same way shell/v1 clones oc/v1.14.
 */
// Built output of the repo checkout. A shipped package would depend on
// @opencues/runtime normally; the probe points at dist directly so it always
// bundles the tree we just built.
import { boot } from '@opencues/runtime/dist/adapters/chrome/v1/boot.js'
import { createSourceReclassifier } from '@opencues/runtime/dist/src/boot-common.js'
import { claimPage, registerHarnessDispatch } from '@opencues/core'
import { createDefaultBlanksRegistry, createBlankInvoke } from '@opencues/runtime/dist/src/blanks/index.js'

/**
 * `fetch` for the built-in data blanks, routed through the node half.
 *
 * Two reasons it cannot be the page's own fetch:
 *   1. CORS — stocks, weather, dictionary and friends call third-party
 *      APIs that do not permit a browser cross-origin read, so from the
 *      page they simply fail.
 *   2. Credentials — stocks needs a Finnhub key, and the page is never
 *      given one. It sends the placeholder and the proxy substitutes.
 *
 * Anything the proxy does not allowlist is refused there, not here.
 */
function makeProxyFetch() {
  return async (input, init = {}) => {
    const url = typeof input === 'string' ? input : input?.url ?? String(input)
    const res = await window.fetch('/opencues/llm/proxy', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        url,
        method: init.method ?? 'GET',
        body: init.body,
        headers: init.headers ?? {},
      }),
    })
    const text = await res.text()
    // Present the upstream reply the way a blank expects from fetch.
    return {
      ok: res.ok,
      status: res.status,
      statusText: res.statusText,
      text: async () => text,
      json: async () => JSON.parse(text),
    }
  }
}

/**
 * Shipped OpenCues defaults, inlined at build time (see build.mjs). Keyed
 * to the virtual config paths the browser half serves, so they drop into
 * the same VFS a real `.cues` tree would populate.
 */
// eslint-disable-next-line no-undef
const BAKED_DEFAULTS = typeof __OC_DEFAULTS__ !== 'undefined' ? __OC_DEFAULTS__ : {}

/**
 * The shipped default OPENCUES.md, verbatim.
 *
 * The settings tab needs it when the user has no file on disk: without it
 * the scalar list is generated from an EMPTY value map, which silently
 * drops the rows whose presence depends on a current value (32 controls
 * instead of 35) and shows registry-first values that are not the shipped
 * ones. Deliberately the raw default, NOT the harness-composed copy in the
 * VFS — that one has every provider rewritten to `harness` and would
 * present a routing decision this host made as if the user had made it.
 */
export function bakedSettingsMd() {
  const hit = Object.entries(BAKED_DEFAULTS).find(([k]) => k.endsWith('OPENCUES.md'))
  return hit ? hit[1] : ''
}

/** Stand-in for a credential. The node half substitutes the real value. */
export const PROXY_PLACEHOLDER = '__OPENCUES_PROXY__'

/** Where the LLM mode lives. Client-side so the tab applies it instantly. */
export const MODE_KEY = 'opencues.llm.mode'
export const MODEL_KEY = 'opencues.llm.model'
export const readMode = () => {
  try { return localStorage.getItem(MODE_KEY) === 'opencues' ? 'opencues' : 'harness' } catch { return 'harness' }
}
export const readModel = () => {
  try { return localStorage.getItem(MODEL_KEY) ?? '' } catch { return '' }
}

const LOG = (...a) => console.log('[oc][dsh]', ...a)

// ─────────────────────────────────────────────────────────── composer access
const card = () => document.querySelector('[data-composer-card]')
const textarea = () => document.querySelector('[data-composer-card] textarea')
const backdrop = () => document.querySelector('[data-input-backdrop]')

/**
 * Draft offsets -> DOM ranges. The backdrop is dsh's visible glyph layer
 * (the textarea itself is transparent); it mixes raw text nodes with <mark>
 * decorations and chip <span>s whose one draft char (U+FFFC) is drawn by a
 * ::before and owns no text node.
 */
function segments() {
  const root = backdrop()
  if (!root) return []
  const out = []
  let off = 0
  const walk = node => {
    for (const child of node.childNodes) {
      if (child.nodeType === 3) { out.push({ node: child, start: off, end: off + child.nodeValue.length }); off += child.nodeValue.length }
      else if (child.getAttribute?.('data-decoration') === 'chip') { off += 1 }
      else if (child.getAttribute?.('data-decoration') === 'hint') { /* ghost text is not draft */ }
      else walk(child)
    }
  }
  walk(root)
  return out
}

function rangeFor(start, end) {
  const segs = segments()
  const r = document.createRange()
  let anchored = false
  for (const s of segs) {
    if (!anchored && start >= s.start && start <= s.end) { r.setStart(s.node, start - s.start); anchored = true }
    if (anchored && end >= s.start && end <= s.end) { r.setEnd(s.node, end - s.start); return r }
  }
  return null
}

// ─────────────────────────────────────────────────────────────────── paint
const STYLE_ID = 'opencues-styles'
function ensureStyles() {
  if (document.getElementById(STYLE_ID)) return
  const style = document.createElement('style')
  style.id = STYLE_ID
  // Every colour is a dsh --dsw-alias-* token: the composer is themed and a
  // fixed colour is unreadable in the other theme.
  style.textContent = [
    '::highlight(oc-dim)       { color: var(--dsw-alias-label-tertiary); }',
    '::highlight(oc-highlight) { color: var(--dsw-alias-state-warn-label);',
    '                            background-color: color-mix(in srgb, var(--dsw-alias-state-warn-label) 18%, transparent); }',
    '::highlight(oc-bold)      { font-weight: 700; }',
    '::highlight(oc-italic)    { font-style: italic; }',
    '::highlight(oc-code)      { color: var(--dsw-alias-markdown-inline-code, var(--dsw-alias-state-business-primary)); }',
  ].join('\n')
  document.head.append(style)
}

function paint(name, ranges) {
  if (!('highlights' in CSS)) return
  const built = (ranges ?? []).map(r => rangeFor(r.start, r.end)).filter(Boolean)
  if (built.length) CSS.highlights.set(name, new Highlight(...built))
  else CSS.highlights.delete(name)
}

let noteEl = null
function noteNode() {
  if (noteEl) return noteEl
  noteEl = document.createElement('div')
  noteEl.setAttribute('data-opencues-note', '')
  Object.assign(noteEl.style, {
    position: 'fixed', zIndex: '2147483000', pointerEvents: 'none', opacity: '0',
    font: '12px/1.45 var(--dsw-font-family, system-ui)',
    padding: '6px 10px', borderRadius: '8px', maxWidth: '520px',
    background: 'var(--dsw-alias-bg-layer-3, #fff)',
    color: 'var(--dsw-alias-label-secondary, #222)',
    border: '1px solid var(--dsw-alias-border-l2, rgba(0,0,0,.12))',
    boxShadow: '0 6px 20px var(--dsw-alias-bg-mask-drop, rgba(0,0,0,.18))',
    transition: 'opacity .12s ease', whiteSpace: 'nowrap',
  })
  document.body.append(noteEl)
  // The composer grows as the draft wraps and the page scrolls under it, so
  // the anchor moves without the runtime emitting anything. Re-place on the
  // frame those happen rather than leaving the note behind.
  // Deliberately NOT gated on `opacity === '1'`: the occlusion check hides
  // the note by setting opacity 0 while keeping its anchor, so a guard on
  // visible-only would make that state terminal and the note would never
  // return after a modal closed.
  const replace = () => { if (noteEl && noteAnchor) requestAnimationFrame(placeNote) }
  window.addEventListener('scroll', replace, true)
  window.addEventListener('resize', replace)
  if (typeof ResizeObserver !== 'undefined') {
    const card_ = card()
    if (card_) new ResizeObserver(replace).observe(card_)
  }
  // Opening a modal fires neither scroll nor resize nor a card resize, so
  // occlusion needs its own poll. Only runs while a note is anchored, and
  // one elementFromPoint every 300ms is not a cost worth optimising.
  setInterval(() => { if (noteAnchor) placeNote() }, 300)
  return noteEl
}

/** The note's last anchor, so scroll/resize can re-place it without the runtime. */
let noteAnchor = null

/**
 * Paint the runtime's InlineNote anchored to its span.
 *
 * Order matters: measure and POSITION first, reveal second. Setting opacity
 * before top/left lets the browser paint one frame at the element's previous
 * position — or at 0,0 on the very first show — which reads as the note
 * jumping in from the left every time the text changes.
 */
function showNote(note) {
  if (!note) { hideNote(); return }
  if (composerOccluded()) { hideNote(); return }
  const el = noteNode()
  const next = note.hint ? `${note.text}   ${note.hint}` : note.text
  if (el.textContent !== next) el.textContent = next
  noteAnchor = { start: note.spanStart, end: note.spanEnd }
  placeNote()
  el.style.opacity = '1'
}

/**
 * Is the composer covered by something, or off screen?
 *
 * The note is a `document.body` overlay, which is what lets it float above
 * the composer without touching dsh's DOM — and also what let it float
 * above dsh's SETTINGS MODAL, where it appeared as a stray tooltip over
 * unrelated UI (caught in a screenshot of the settings tab, which is a
 * pleasing way to find it: the bug was visible in a shot taken to check
 * something else).
 *
 * Hit-testing the anchor rather than sniffing for a dialog selector keeps
 * this out of dsh's internals and covers every occluder for the same
 * price — modal, drawer, scrolled out of view, collapsed panel.
 */
function composerOccluded() {
  const c = card()
  if (!c) return true
  const r = c.getBoundingClientRect()
  if (r.width === 0 || r.height === 0) return true
  const x = Math.round(r.left + Math.min(24, r.width / 2))
  const y = Math.round(r.top + Math.min(12, r.height / 2))
  if (x < 0 || y < 0 || x > window.innerWidth || y > window.innerHeight) return true
  const hit = document.elementFromPoint(x, y)
  return !hit || !(c === hit || c.contains(hit))
}

/** Re-place the note against its anchor span. Safe to call at any time. */
function placeNote() {
  if (!noteEl || !noteAnchor) return
  // Hide without clearing the anchor, so closing the modal brings the note
  // back on the next re-place instead of waiting for another keystroke.
  if (composerOccluded()) { noteEl.style.opacity = '0'; return }
  const r = rangeFor(noteAnchor.start, noteAnchor.end)
  const anchorRect = r ? r.getBoundingClientRect() : card()?.getBoundingClientRect()
  if (!anchorRect) return
  // offsetWidth/Height are valid while opacity is 0 — the element is laid
  // out, just not painted — so the first show measures correctly too.
  const w = noteEl.offsetWidth
  const h = noteEl.offsetHeight
  const top = Math.max(8, anchorRect.top - h - 8)
  const left = Math.max(8, Math.min(anchorRect.left, window.innerWidth - w - 8))
  const nextTop = `${Math.round(top)}px`
  const nextLeft = `${Math.round(left)}px`
  if (noteEl.style.top !== nextTop) noteEl.style.top = nextTop
  if (noteEl.style.left !== nextLeft) noteEl.style.left = nextLeft
  // Anchored and unoccluded means visible. Set AFTER top/left so an
  // un-hide cannot paint one frame at the stale position — the same
  // ordering rule showNote documents, which is why this is not
  // `opacity = '1'` at the top of the function.
  // A note the runtime genuinely retracted has no anchor (hideNote clears
  // it), so this cannot resurrect one.
  if (noteEl.style.opacity !== '1') noteEl.style.opacity = '1'
}

function hideNote() {
  if (noteEl) noteEl.style.opacity = '0'
  noteAnchor = null
}

// ──────────────────────────────────────────────────────── binding plumbing
export function createOpenCuesHost({ setDraftRef, log = LOG }) {
  // Claim the document BEFORE anything else, so the window in which the
  // chrome extension can act on this page unopposed is as short as possible.
  // The extension injects at `document_end` and re-reads the claim on every
  // text change and keypress, so it stands down as soon as this lands —
  // without it, a user with both installed gets two hosts writing the same
  // buffer, and the keyless one can overwrite good output with a missing-key
  // error. See @opencues/core/page-ownership.
  claimPage('dsh')

  const keyHandlers = new Set()
  const textHandlers = new Set()
  const cursorHandlers = new Set()
  const renderHandlers = new Set()
  const eventHandlers = new Set()
  let vfs = new Map()
  let apiKeys = {}
  let lastText = ''
  let usingDefaults = false
  // Distinguishes the runtime's own writes (loading frames, substitutions)
  // from real user edits when they echo back through dsh's input machine.
  const reclassifier = createSourceReclassifier()
  /** Built-in data blanks, every network call routed through the proxy. */
  const builtinBlanks = createDefaultBlanksRegistry({
    fetchFn: makeProxyFetch(),
    finnhubApiKey: PROXY_PLACEHOLDER,
    hostName: 'chrome',
    getLlmApiKeys: () => apiKeys,
  })

  // dsh's setDraft is asynchronous: the value goes through the input machine
  // and React before the textarea reflects it. A runtime that writes and then
  // immediately reads would see its own write missing, and every
  // write-then-compare check ("live text changed since resolve") would fail.
  // The shadow makes reads consistent with writes until the echo lands.
  let shadow = null
  const SHADOW_TTL_MS = 2000
  const getText = () => {
    if (shadow && Date.now() - shadow.at < SHADOW_TTL_MS) return shadow.text
    shadow = null
    return textarea()?.value ?? ''
  }
  const getCursorOffset = () => textarea()?.selectionStart ?? 0

  /** The runtime's only write path into the composer. */
  const setText = text => {
    const fn = setDraftRef.current
    const w = (typeof window !== 'undefined' && window.__oc) || null
    if (w) { w.setTextCalls = (w.setTextCalls ?? 0) + 1; w.lastSetText = text.slice(0, 80) }
    if (!fn) { log('setText with no composer bound'); if (w) w.setTextUnbound = (w.setTextUnbound ?? 0) + 1; return }
    // Mark BEFORE the write: dsh echoes the new draft straight back through
    // useInput, and an unmarked echo reads as a user edit — which makes the
    // resolver discard its own in-flight result ("live text changed since
    // resolve"). The loading animator writes a frame every ~75ms, so this
    // fires constantly, not just on substitution.
    reclassifier.markRuntimeWrite(text)
    shadow = { text, at: Date.now() }
    fn(text)
    lastText = text
  }
  const setCursorOffset = offset => {
    // The draft lands through dsh's input machine on its own tick, so the
    // caret has to be re-applied after that commit, not before it.
    requestAnimationFrame(() => {
      const ta = textarea()
      if (ta) { ta.focus(); ta.setSelectionRange(offset, offset) }
    })
  }

  /** BootResult — the host-facing API the runtime returns from boot(). */
  let rt = null

  /** Run the runtime's render pass and paint whatever it returns. */
  const runRender = () => {
    ensureStyles()
    let merged = null
    const directives = rt
      ? rt.collectRenderDirectives(getText(), getCursorOffset())
      : (() => {
          const ctx = { text: getText(), cursor: getCursorOffset(), externalHighlights: [] }
          return [...renderHandlers].map(h => h(ctx)).filter(Boolean)
        })()
    for (const d of directives ?? []) if (d) merged = { ...(merged ?? {}), ...d }
    if (!merged) {
      for (const n of ['oc-dim', 'oc-highlight', 'oc-bold', 'oc-italic', 'oc-code']) CSS.highlights?.delete(n)
      showNote(null)
      return
    }
    paint('oc-dim', merged.dimRanges)
    paint('oc-highlight', merged.highlight ? [merged.highlight] : [])
    paint('oc-bold', merged.boldRanges)
    paint('oc-italic', merged.italicRanges)
    paint('oc-code', merged.codeRanges)
    showNote(merged.inlineNote ?? null)
  }

  // Session-commitments watchlist. The chrome band takes a MUTABLE HOLDER and
  // re-reads its fields every resolve pass, so refreshing means mutating this
  // object in place — replacing it would leave the resolver holding the old one.
  //
  // The node half distils the dsh session and serves the result; this side only
  // polls. That split is what makes the feature possible here at all: reading
  // `$DSH_HOME/sessions/**` needs a filesystem, which the browser does not have.
  const sessionCommitments = { commitments: [], summary: undefined, ingestedAt: undefined, sessionId: undefined }
  const refreshCommitments = async () => {
    try {
      const snap = await window.fetch('/opencues/session-commitments').then(r => r.json())
      if (!snap || !Array.isArray(snap.commitments)) return
      const changed = snap.commitments.length !== sessionCommitments.commitments.length
        || snap.sessionId !== sessionCommitments.sessionId
      sessionCommitments.commitments = snap.commitments
      sessionCommitments.summary = snap.summary
      sessionCommitments.ingestedAt = snap.ingestedAt
      sessionCommitments.sessionId = snap.sessionId
      if (changed) log(`session commitments: ${snap.commitments.length} decision(s) on the watchlist`)
    } catch { /* route absent or offline — stay with what we have */ }
  }
  // Poll on the same order as the producer's kick; the producer self-debounces,
  // so a poll that finds nothing new is just a cheap 200.
  refreshCommitments()
  setInterval(refreshCommitments, 20_000)

  const host = {
    sessionCommitments,
    hostVersion: '0.1.0',
    cwd: '/dsh',
    getText,
    getCursorOffset,
    setText,
    setCursorOffset,
    forceRender: () => runRender(),
    pushText: (text, cursor) => { setText(text); if (typeof cursor === 'number') setCursorOffset(cursor) },
    registerKeyHandler: cb => { keyHandlers.add(cb); return () => keyHandlers.delete(cb) },
    registerTextChangeHandler: cb => { textHandlers.add(cb); return () => textHandlers.delete(cb) },
    registerCursorChangeHandler: cb => { cursorHandlers.add(cb); return () => cursorHandlers.delete(cb) },
    registerRenderHandler: cb => { renderHandlers.add(cb); return () => renderHandlers.delete(cb) },
    registerEventHandler: cb => { eventHandlers.add(cb); return () => eventHandlers.delete(cb) },
    emitEvent: (type, body) => { for (const h of eventHandlers) h(type, body) },
    // The config tree is served by the node half over dsh's own web server;
    // ConfigLoader reads it through these, exactly as chrome reads its bundle.
    readFile: async path => vfs.get(path) ?? null,
    readDir: async path => {
      const prefix = path.endsWith('/') ? path : path + '/'
      const names = new Set()
      for (const k of vfs.keys()) {
        if (!k.startsWith(prefix)) continue
        const rest = k.slice(prefix.length)
        const cut = rest.indexOf('/')
        names.add(cut === -1 ? rest : rest.slice(0, cut))
        if (cut !== -1) continue
      }
      if (!names.size) return null
      return [...names].map(name => ({
        name,
        isDirectory: [...vfs.keys()].some(k => k.startsWith(prefix + name + '/')),
      }))
    },
    writeFile: async () => { /* dsh browser half is read-only for config */ },
    log: (level, msg, data) => log(`[${level}]`, msg, data ?? ''),
    supportsCycling: () => true,
    httpAdapter: makeProxyHttpAdapter(),
    // Built-in data blanks (stocks, weather, hackernews, dictionary,
    // crypto, location). Every one reaches its API through the proxy: the
    // page can neither read those origins (CORS) nor hold the Finnhub key.
    // BOTH bindings are needed and they are not the same thing: `blanks`
    // feeds the blank-as-context catalog, while `blankInvoke` is what
    // BlankFill and Cycling actually call to run one. Supplying only the
    // former registers the blanks and then never invokes them.
    blanks: builtinBlanks,
    blankInvoke: createBlankInvoke(builtinBlanks),
    // Contradiction-cue world data (bank holidays, weather, TfL). Same
    // detached-fetch caveat: hand over a closure, not the function object.
    worldDataFetch: async url => {
      const res = await window.fetch(url)
      return { ok: res.ok, json: () => res.json() }
    },
  }

  /**
   * Feed the fetched config + keys in before boot.
   *
   * The browser band roots config at the virtual `/chrome-storage/.cues`, so
   * the real on-disk tree is re-rooted there. Search-path precedence
   * (project before user) is applied here, since collapsing several roots
   * into one namespace means ConfigLoader can no longer do it: the first
   * writer for a given relative path wins.
   */
  const VROOT = '/chrome-storage/.cues'
  const loadConfig = async () => {
    const res = await fetch('/opencues/config', { cache: 'no-store' })
    const data = await res.json()
    // The page is never given a real credential, in either mode. The
    // runtime still needs a key to be PRESENT for a provider to be
    // selectable and for buildRequest to populate its auth header, so it
    // gets a placeholder; the node half's proxy swaps in the real secret,
    // for an allowlisted destination only.
    apiKeys = Object.fromEntries((data.hasKeys ?? []).map(k => [k, PROXY_PLACEHOLDER]))
    vfs = new Map()
    const files = data.files ?? {}
    for (const root of data.searchPaths ?? []) {
      const prefix = root.endsWith('/') ? root : root + '/'
      for (const [abs, content] of Object.entries(files)) {
        if (!abs.startsWith(prefix)) continue
        const key = VROOT + '/' + abs.slice(prefix.length)
        if (!vfs.has(key)) vfs.set(key, content)
      }
    }
    // A user who has never installed OpenCues has no `.cues` tree at all.
    // Without a fallback that is a SILENT no-op: zero cue entries, zero
    // blanks, no sources built, and typing `_` does nothing forever, with
    // no error to explain it. Fall back to the shipped defaults baked in at
    // build time, so the plugin works on its own — the same answer chrome's
    // bake-time bundle gives. A real `.cues` directory always wins.
    //
    // The trigger is "no cue or blank DEFINITIONS on disk", not "no files at
    // all". `vfs.size === 0` was the obvious condition and it was a
    // landmine: the settings tab writes `~/.cues/OPENCUES.md`, so a fresh
    // user who changed ONE setting made the tree non-empty, which disabled
    // the whole fallback and left the plugin with `Resolver: no
    // cuesConfig/blanksConfig, skipping build` — every cue and blank dead,
    // no error, caused by using the feature. Settings are not content.
    //
    // Gap-filling (rather than replacing) is what keeps the user's own
    // OPENCUES.md authoritative when the defaults do land, and gating on
    // definitions means a user with a real tree never has a default they
    // deliberately deleted resurrected under them.
    const definesContent = k => /(^|\/)CUES\.md$|\/CUE\.md$|\/BLANK\.md$/.test(k)
    if (![...vfs.keys()].some(definesContent)) {
      const before = vfs.size
      for (const [k, v] of Object.entries(BAKED_DEFAULTS)) if (!vfs.has(k)) vfs.set(k, v)
      usingDefaults = true
      log(before === 0
        ? `config: none found on disk — using ${vfs.size} shipped default(s)`
        : `config: ${before} settings file(s) on disk but no cue/blank definitions — filling in ${vfs.size - before} shipped default(s)`)
    }

    // Harness mode has to beat the per-bucket scalars, not just the global
    // one: the resolver's precedence is per-source > per-feature > bucket >
    // global, and `providerOverride` only replaces the global tier. So the
    // effective OPENCUES.md this host composes points every LLM route at
    // the bridge. The user's file on disk is untouched; switching back to
    // OpenCues mode serves it verbatim again.
    if (readMode() === 'harness') {
      const settingsKey = `${VROOT}/OPENCUES.md`
      const original = vfs.get(settingsKey)
      if (original !== undefined) vfs.set(settingsKey, forceHarnessRouting(original))
    }

    host.cwd = '/chrome-storage'
    host.llmApiKeys = apiKeys
    log(`config: ${vfs.size} file(s) under ${VROOT}, keys: ${Object.keys(apiKeys).join(',') || 'none'}`)
    configureLlm()
    return { ...data, mapped: vfs.size, usingDefaults, mode: readMode(), model: readModel() }
  }

  /**
   * Point the runtime's LLM at either the host's model or OpenCues' own
   * providers. Must run BEFORE boot(): the resolver reads host.llmProvider
   * when it builds sources.
   *
   * Harness mode binds a dispatch that posts the neutral ChatRequest to the
   * node half, which calls ctx.llm.stream(). No credential is present in
   * this page at all — the browser cannot see one even in principle.
   */
  function configureLlm() {
    const mode = readMode()
    const model = readModel()
    if (mode === 'harness') {
      host.llmProvider = 'harness'
      host.llmDefaultModel = model || ''
      registerHarnessDispatch(async req => {
        const res = await window.fetch('/opencues/llm', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            model: req.model || model || '',
            messages: req.messages,
            maxTokens: req.maxTokens,
            temperature: req.temperature,
            reasoningEffort: req.reasoningEffort,
          }),
        })
        const j = await res.json().catch(() => ({}))
        if (!res.ok || j.error) throw new Error(j.error || `harness bridge HTTP ${res.status}`)
        const w = (typeof window !== 'undefined' && window.__oc) || null
        if (w) { w.llmCalls = (w.llmCalls ?? 0) + 1; w.lastLlmMs = j.ms; w.lastLlmModel = j.model }
        return j.text ?? ''
      }, { host: 'DeepSeek Harness', model: model || undefined })
      log(`llm: harness mode${model ? ` (${model})` : ' (host default model)'}`)
    } else {
      // OpenCues mode: the runtime's own per-bucket routing from
      // OPENCUES.md, using the keys the node half forwarded.
      host.llmProvider = undefined
      log(`llm: opencues mode (own providers; ${Object.keys(apiKeys).length} key(s))`)
    }
  }

  // Host events go through the BootResult API — that is the runtime's
  // documented entry surface. The register*Handler bindings above exist for
  // the adapter's own internal subscriptions, not as a driving path.
  const attach = result => { rt = result }

  // Dedupe: a repeated notification for text that has not changed makes the
  // resolver supersede (and abort) its own in-flight LLM call, so a blank
  // never lands. dsh re-renders the composer often, so this matters.
  let lastCursor = -1
  const notifyText = source => {
    // The echo has landed: drop the shadow so reads track the real composer
    // again (and a user edit is never masked by a stale optimistic value).
    const real = textarea()?.value ?? ''
    if (shadow && real === shadow.text) shadow = null
    else if (shadow && source === 'user') shadow = null
    const text = getText()
    const cursor = getCursorOffset()
    if (text === lastText && cursor === lastCursor) { runRender(); return }
    lastText = text
    lastCursor = cursor
    rt?.notifyTextChange(text, cursor, reclassifier.reclassify(text, source))
    runRender()
  }
  const notifyCursor = () => {
    const text = getText()
    const cursor = getCursorOffset()
    if (cursor === lastCursor && text === lastText) return
    lastCursor = cursor
    if (text !== lastText) { lastText = text; rt?.notifyTextChange(text, cursor, reclassifier.reclassify(text, 'user')); runRender(); return }
    rt?.notifyCursorChange(text, cursor, 'user')
    runRender()
  }
  /** @returns true when the runtime consumed the key. */
  const notifyKey = e => {
    if (!rt) return false
    const w = (typeof window !== 'undefined' && window.__oc) || null
    if (w && (e.ctrlKey && e.altKey)) {
      w.ctrlAltKeys = (w.ctrlAltKeys ?? 0) + 1
      w.lastCtrlAlt = e.key
    }
    const consumed = rt.dispatchKey({
      key: normalizeKey(e.key),
      modifiers: { ctrl: e.ctrlKey, alt: e.altKey, shift: e.shiftKey, meta: e.metaKey },
      text: getText(),
      cursorOffset: getCursorOffset(),
    })
    if (w && (e.ctrlKey && e.altKey)) w.lastCtrlAltConsumed = consumed
    runRender()
    return consumed
  }

  return { host, loadConfig, attach, notifyText, notifyCursor, notifyKey, runRender, boot }
}

/**
 * Rewrite every LLM provider/model scalar in an OPENCUES.md so the whole
 * runtime routes through the harness bridge.
 *
 * Covers the global pair, the three buckets (cues / auditors / blanks) and
 * the per-aspect advanced overrides, because any one of them left pointing
 * at a real provider would silently send that bucket's traffic somewhere
 * the user did not choose — and, without a key, fail.
 *
 * Model scalars are dropped rather than rewritten: the host owns model
 * selection in this mode, and the node half validates anything we send
 * against the provider's own catalogue anyway.
 */
export function forceHarnessRouting(md) {
  const out = []
  for (const line of md.split('\n')) {
    const provider = line.match(/^(\s*)([a-z0-9-]*-?llm-provider|llm-provider):/i)
    if (provider) { out.push(`${provider[1]}${provider[2]}: harness`); continue }
    const aspectProvider = line.match(/^(\s*)([a-z0-9-]+-provider):/i)
    if (aspectProvider) { out.push(`${aspectProvider[1]}${aspectProvider[2]}: harness`); continue }
    if (/^\s*([a-z0-9-]*-?llm-model|llm-model|[a-z0-9-]+-model):/i.test(line)) continue
    out.push(line)
  }
  return out.join('\n')
}

/**
 * DOM KeyboardEvent.key -> the runtime's key vocabulary. Navigation and
 * Cycling filter on `['left','right','up','down']`, so passing the DOM's
 * `ArrowUp` means the filter silently never matches and every gesture is
 * declined with no error anywhere.
 */
const KEY_ALIASES = {
  ArrowUp: 'up', ArrowDown: 'down', ArrowLeft: 'left', ArrowRight: 'right',
  Escape: 'escape', Enter: 'enter', Tab: 'tab', Backspace: 'backspace', Delete: 'delete',
  Home: 'home', End: 'end', PageUp: 'pageup', PageDown: 'pagedown', ' ': 'space',
}
function normalizeKey(key) {
  return KEY_ALIASES[key] ?? key
}

/**
 * HttpAdapter that never holds a credential.
 *
 * OpenCues mode has the runtime dispatch to providers itself, which would
 * normally require the API key in the page. dsh is a plugin host, so the
 * page context is shared with third-party plugin code and a key there is a
 * key for all of them. Instead the runtime is given PLACEHOLDER keys, and
 * every provider request is posted to the node half, which validates the
 * destination against an allowlist and substitutes the real secret on the
 * way out. Nothing secret is ever present in this page.
 *
 * fetch goes through a closure rather than by reference: a detached `fetch`
 * throws "Illegal invocation".
 */
function makeProxyHttpAdapter() {
  const call = (url, init) => window.fetch(url, init)
  const via = async (method, url, body, headers, options) => {
    const res = await call('/opencues/llm/proxy', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ url, method, body, headers: headers ?? {} }),
      signal: options?.signal,
    })
    const text = await res.text()
    if (!res.ok) {
      throw Object.assign(new Error(`HTTP ${res.status}: ${text.slice(0, 200)}`), {
        statusCode: res.status, status: res.status, body: text,
      })
    }
    return text
  }
  return {
    post: (url, body, headers, options) => via('POST', url, body, headers, options),
    get: (url, headers) => via('GET', url, undefined, headers),
  }
}

export { boot }
