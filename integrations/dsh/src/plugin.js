/**
 * The dsh client plugin: takes a seat in the composer's dock, binds the
 * composer to the OpenCues runtime, and drives the runtime's event inputs.
 * All cue behaviour belongs to @opencues/runtime.
 */
import React from 'react'
import { createOpenCuesHost } from './entry.js'
import { OpenCuesSettingsTab } from './settings-tab.js'

const status = { booted: false, error: null, configFiles: 0, keys: [], cues: 0, keyEvents: 0, renders: 0 }
/** Page-level singleton: one runtime, whatever remounts the dock does. */
const singleton = { promise: null, label: 'OpenCues · starting', setDraft: null }
if (typeof window !== 'undefined') { window.__oc = status; window.__ocSingleton = singleton }

export const name = 'opencues'
export const inject = ['slots']

function OpenCuesDock(props) {
  const draft = props.useInput(s => s.draft)
  const actions = props.inputActions
  const rt = React.useRef(null)
  const [label, setLabel] = React.useState(singleton.label)
  // Indirection through the singleton so the one runtime always writes to
  // whichever composer instance is currently mounted.
  const setDraftRef = { get current() { return singleton.setDraft } }
  singleton.setDraft = text => actions.setDraft(text)

  // ONE runtime per page. The dock can mount more than once (remount on
  // session/workspace transitions, React double-invoke in dev), and a second
  // runtime silently aborts the first one's in-flight LLM calls — which
  // presents as blanks that never resolve and keys that "go missing".
  React.useEffect(() => {
    if (singleton.promise) {
      singleton.promise.then(b => { rt.current = b; setLabel(singleton.label) })
      return
    }
    singleton.promise = (async () => {
      const bindings = createOpenCuesHost({ setDraftRef })
      try {
        const cfg = await bindings.loadConfig()
        // `fileCount` is what the node half found ON DISK, which is 0 for a
        // user who has never installed OpenCues. Reporting that number is
        // how the dock and the settings tab came to say "0 config files"
        // while the runtime was happily running on 29 baked defaults with 7
        // sources built — a fresh user reads 0 and concludes the plugin is
        // broken. `mapped` is what the runtime actually loaded.
        status.configFiles = cfg.mapped ?? cfg.fileCount ?? 0
        status.diskFiles = cfg.fileCount ?? 0
        status.usingDefaults = cfg.usingDefaults === true
        status.keys = cfg.hasKeys ?? []
        const result = bindings.boot(bindings.host)
        bindings.attach(result)
        status.booted = true
        status.boot = Object.keys(result ?? {})
        singleton.label = `OpenCues · ${status.configFiles} config file(s)`
          + (status.usingDefaults ? ' (shipped defaults)' : '')
          + (status.keys.length ? '' : ' · no API key')
        console.log('[oc][dsh] booted', status)
        bindings.runRender()
      } catch (err) {
        status.error = String(err?.stack ?? err).slice(0, 400)
        singleton.label = 'OpenCues · boot failed'
        console.error('[oc][dsh] boot failed', err)
      }
      return bindings
    })()
    singleton.promise.then(b => { rt.current = b; setLabel(singleton.label) })
  }, [])

  // The live composer write path always points at the current mount.
  React.useEffect(() => { singleton.setDraft = text => actions.setDraft(text) })

  // Draft changes -> runtime.
  React.useEffect(() => {
    if (!status.booted || !rt.current) return
    rt.current.notifyText('user')
    status.renders += 1
  }, [draft])

  // Caret moves -> runtime (the machine state carries no caret; the textarea does).
  React.useEffect(() => {
    const onSel = () => {
      const ta = document.querySelector('[data-composer-card] textarea')
      if (ta && document.activeElement === ta && rt.current && status.booted) rt.current.notifyCursor()
    }
    document.addEventListener('selectionchange', onSel)
    return () => document.removeEventListener('selectionchange', onSel)
  }, [])

  // Keys -> runtime, in capture so the runtime sees Ctrl+Alt before dsh's
  // composer handler runs. Consumed keys are stopped; everything else passes
  // straight through to dsh untouched.
  React.useEffect(() => {
    const onKey = e => {
      if (!status.booted || !rt.current) return
      const ta = document.querySelector('[data-composer-card] textarea')
      if (document.activeElement !== ta) return
      status.keyEvents += 1
      if (rt.current.notifyKey(e)) { e.preventDefault(); e.stopPropagation() }
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [])

  return React.createElement(
    'div',
    { 'data-opencues-dock': '', style: { padding: '2px 16px', fontSize: '12px', color: 'var(--dsw-alias-label-caption)' } },
    label,
  )
}

export function apply(ctx) {
  ctx.slots.inject('conversation.input.dock', () => ctx.slots.register({
    name: 'conversation.input.dock',
    id: 'opencues',
    order: 5,
  }, OpenCuesDock))

  // Settings surface. Registered through the public slot, so it appears in
  // dsh's own Plugins section rather than as a parallel UI of our own.
  ctx.slots.inject('settings.plugins.tab', () => ctx.slots.register({
    name: 'settings.plugins.tab',
    id: 'opencues',
    order: 20,
    label: () => 'OpenCues',
  }, OpenCuesSettingsTab))
}
