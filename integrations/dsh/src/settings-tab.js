/**
 * OpenCues settings tab, contributed into dsh's Plugins settings section
 * via the public `settings.plugins.tab` slot.
 *
 * Two things belong here and nothing else:
 *   1. WHICH MODEL SEES YOUR TEXT. That is the whole reason this tab is not
 *      optional — harness mode inherits the model configured for the user's
 *      agent conversation, and they should be told, plainly, rather than
 *      have it inferred from a provider dropdown they never opened.
 *   2. The routing choice, with the measured latency difference attached,
 *      because the trade-off is real and hiding it would be a disservice.
 *
 * Every other OpenCues scalar stays where it already lives: OPENCUES.md and
 * the in-buffer `_` settings blank. Mirroring forty scalars into a second
 * surface would be a drift surface with no upside.
 */
import React from 'react'
import { MODE_KEY, MODEL_KEY, bakedSettingsMd, readMode, readModel } from './entry.js'
import { getMenuDefinitions } from '@opencues/core'

/**
 * Read the scalars currently set in the user's OPENCUES.md.
 *
 * Parsed from the served file rather than from runtime state so the tab
 * shows what is actually on disk — the same thing the native hosts and the
 * in-buffer `_` settings blank read.
 */
function parseScalars(md) {
  const out = new Map()
  for (const line of (md ?? '').split('\n')) {
    const m = line.match(/^\s*([a-z0-9-]+):\s*(\S.*?)\s*$/i)
    if (m && !m[2].startsWith('|') && !m[2].startsWith('>')) out.set(m[1], m[2])
  }
  return out
}

const T = {
  label: 'var(--dsw-alias-label-primary)',
  dim: 'var(--dsw-alias-label-tertiary)',
  caption: 'var(--dsw-alias-label-caption)',
  border: 'var(--dsw-alias-border-l2)',
  layer: 'var(--dsw-alias-bg-layer-2)',
  accent: 'var(--dsw-alias-state-business-primary)',
  warn: 'var(--dsw-alias-state-warn-label)',
}

const row = { display: 'flex', gap: 10, alignItems: 'flex-start', padding: '10px 0' }

export function OpenCuesSettingsTab() {
  const [mode, setMode] = React.useState(readMode())
  const [model, setModel] = React.useState(readModel())
  const [info, setInfo] = React.useState(null)
  const [status, setStatus] = React.useState(null)

  React.useEffect(() => {
    let dead = false
    ;(async () => {
      try {
        const [i, c] = await Promise.all([
          fetch('/opencues/llm/info').then(r => r.json()),
          fetch('/opencues/config').then(r => r.json()),
        ])
        if (dead) return
        setInfo(i)
        // `c.fileCount` is the ON-DISK count, which is 0 for a fresh user
        // even though the runtime is running on baked defaults. Report what
        // the runtime LOADED, and say where it came from — "0 file(s)" next
        // to a working plugin reads as broken.
        const oc = (typeof window !== 'undefined' && window.__oc) || {}
        setStatus({
          files: oc.configFiles ?? c.fileCount,
          usingDefaults: oc.usingDefaults === true,
          keys: c.hasKeys ?? [],
        })
      } catch (e) { if (!dead) setStatus({ error: String(e.message ?? e) }) }
    })()
    return () => { dead = true }
  }, [])

  const liveProvider = info?.providers?.[0]
  const models = liveProvider ? (info?.models?.[liveProvider.id] ?? []) : []
  const effectiveModel = model || models[0]?.id || '(host default)'

  const persist = (nextMode, nextModel) => {
    try {
      localStorage.setItem(MODE_KEY, nextMode)
      localStorage.setItem(MODEL_KEY, nextModel ?? '')
    } catch { /* private mode: the choice just won't persist */ }
    setMode(nextMode)
    setModel(nextModel ?? '')
  }

  const el = React.createElement
  const heading = (text, sub) => el('div', { style: { marginBottom: 6 } }, [
    el('div', { key: 'h', style: { color: T.label, fontWeight: 600, fontSize: 13 } }, text),
    sub ? el('div', { key: 's', style: { color: T.caption, fontSize: 12, marginTop: 2 } }, sub) : null,
  ])

  const option = (value, title, detail, extra) => el('label', {
    key: value,
    style: {
      ...row, cursor: 'pointer', padding: 10, borderRadius: 8,
      border: `1px solid ${mode === value ? T.accent : T.border}`,
      background: mode === value ? 'color-mix(in srgb, var(--dsw-alias-state-business-primary) 8%, transparent)' : 'transparent',
      marginBottom: 8,
    },
  }, [
    el('input', {
      key: 'r', type: 'radio', name: 'oc-llm-mode', checked: mode === value,
      onChange: () => persist(value, model), style: { marginTop: 3 },
    }),
    el('div', { key: 'b', style: { minWidth: 0 } }, [
      el('div', { key: 't', style: { color: T.label, fontSize: 13 } }, title),
      el('div', { key: 'd', style: { color: T.dim, fontSize: 12, marginTop: 3, lineHeight: 1.45 } }, detail),
      extra ?? null,
    ]),
  ])

  return el('div', { 'data-opencues-settings': '', style: { padding: '4px 2px', maxWidth: 640 } }, [
    heading('Which model writes your suggestions',
      'OpenCues sends the sentence you are typing to a model to get cues and fill blanks. This is where that goes.'),

    el('div', { key: 'opts', style: { marginTop: 10 } }, [
      option('harness',
        'Use this app\'s model',
        el('span', {}, [
          'No API key needed. Your text goes to the same model as your conversation',
          liveProvider ? el('b', { key: 'p', style: { color: T.label } }, ` (${liveProvider.name})`) : null,
          '. Slower for suggestions that appear as you type: measured ~1.0s here against ~0.3s for a dedicated provider.',
        ]),
        mode === 'harness' && models.length > 0
          ? el('div', { key: 'm', style: { marginTop: 8 } }, [
              el('label', { key: 'l', style: { color: T.caption, fontSize: 12, marginRight: 6 } }, 'Model'),
              el('select', {
                key: 's', value: model, onChange: e => persist('harness', e.target.value),
                style: {
                  background: T.layer, color: T.label, border: `1px solid ${T.border}`,
                  borderRadius: 6, padding: '3px 6px', fontSize: 12,
                },
              }, [
                el('option', { key: '', value: '' }, 'Host default'),
                ...models.map(m => el('option', { key: m.id, value: m.id }, m.name ?? m.id)),
              ]),
            ])
          : null),

      option('opencues',
        'Use my own provider',
        el('span', {}, [
          'Routes through OpenCues\' own per-bucket settings in OPENCUES.md, using keys from your environment. Noticeably faster for live suggestions. ',
          status?.keys?.length
            ? el('span', { key: 'k', style: { color: T.label } }, `Detected: ${status.keys.map(k => k.replace('_API_KEY', '').toLowerCase()).join(', ')}.`)
            : el('span', { key: 'k', style: { color: T.warn } }, 'No API keys detected in this environment.'),
        ])),
    ]),

    el(FeatureSettings, { key: 'features' }),

    el('div', {
      key: 'status',
      style: {
        marginTop: 14, paddingTop: 12, borderTop: `1px solid ${T.border}`,
        color: T.caption, fontSize: 12, lineHeight: 1.6,
      },
    }, [
      el('div', { key: 'a' }, status?.usingDefaults
        ? `Config: ${status.files} shipped default(s) — no .cues directory found on this machine, so OpenCues is running on the defaults it ships with`
        : `Config: ${status?.files ?? '…'} file(s) loaded from your .cues directories`),
      el('div', { key: 'b' }, mode === 'harness'
        ? `Sending to: ${liveProvider?.name ?? 'host'} · ${effectiveModel} · reasoning off`
        : 'Sending to: your own provider, per bucket (cues / auditors / blanks)'),
      el('div', { key: 'c' }, 'Everything else is configured in OPENCUES.md, or by typing settings into the composer with an underscore.'),
      status?.error ? el('div', { key: 'e', style: { color: T.warn } }, status.error) : null,
    ]),
  ])
}

/**
 * Every OpenCues feature scalar, generated from the registry.
 *
 * Deliberately NOT a hand-written list: `feature-registry.ts` is the single
 * source of truth for which settings exist, what values each accepts, which
 * values are menu-exposed and which are host-scoped. Hand-listing them here
 * would be a second surface to keep in step, and the registry exists
 * precisely so that adding a feature is one entry and nothing else drifts.
 *
 * Writes go to the real OPENCUES.md, so a choice made here is the same
 * choice the native hosts read and the in-buffer `_` settings blank edits.
 */
function FeatureSettings() {
  const el = React.createElement
  const [defs, setDefs] = React.useState(null)
  const [values, setValues] = React.useState(new Map())
  const [saving, setSaving] = React.useState(null)
  const [error, setError] = React.useState(null)
  const [open, setOpen] = React.useState(false)

  React.useEffect(() => {
    let dead = false
    ;(async () => {
      try {
        const cfg = await fetch('/opencues/config').then(r => r.json())
        // No file on disk → generate from the SHIPPED default instead of an
        // empty map. An empty map drops every row whose presence depends on
        // a current value and shows registry-first values rather than the
        // ones the plugin is actually running on.
        const md = Object.entries(cfg.files ?? {}).find(([p]) => p.endsWith('OPENCUES.md'))?.[1]
          ?? bakedSettingsMd()
        if (dead) return
        const parsed = parseScalars(md)
        setValues(parsed)
        // hostName 'chrome' matches the band this integration runs on, so
        // host-scoped tunables surface exactly as they do in the cycling menu.
        setDefs(getMenuDefinitions('chrome', parsed))
      } catch (e) { if (!dead) setError(String(e.message ?? e)) }
    })()
    return () => { dead = true }
  }, [])

  const write = async (scalar, value) => {
    setSaving(scalar)
    setError(null)
    try {
      const res = await fetch('/opencues/settings', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ updates: { [scalar]: value } }),
      })
      const j = await res.json().catch(() => ({}))
      if (!res.ok || j.error) throw new Error(j.error || `HTTP ${res.status}`)
      setValues(prev => new Map(prev).set(scalar, value))
    } catch (e) { setError(String(e.message ?? e)) } finally { setSaving(null) }
  }

  if (!defs) {
    return el('div', { style: { color: T.caption, fontSize: 12, marginTop: 16 } },
      error ? `Settings unavailable: ${error}` : 'Loading settings…')
  }

  const rows = [...defs.entries()].filter(([, d]) => d.valueOrder.length > 1)

  return el('div', { style: { marginTop: 18, borderTop: `1px solid ${T.border}`, paddingTop: 14 } }, [
    el('button', {
      key: 'toggle', type: 'button', onClick: () => setOpen(o => !o),
      style: {
        background: 'none', border: 'none', padding: 0, cursor: 'pointer',
        color: T.label, fontWeight: 600, fontSize: 13,
      },
    }, `${open ? '▾' : '▸'} All OpenCues settings (${rows.length})`),
    el('div', { key: 'sub', style: { color: T.caption, fontSize: 12, marginTop: 2 } },
      'Written to your OPENCUES.md, so these apply to every OpenCues host, not only this one.'),

    open ? el('div', { key: 'list', style: { marginTop: 12 } }, rows.map(([scalar, d]) =>
      el('div', {
        key: scalar,
        style: { display: 'flex', gap: 12, alignItems: 'flex-start', padding: '7px 0', borderBottom: `1px solid ${T.border}` },
      }, [
        el('div', { key: 'l', style: { flex: 1, minWidth: 0 } }, [
          el('div', { key: 'n', style: { color: T.label, fontSize: 12.5 } }, scalar),
          d.tip ? el('div', { key: 't', style: { color: T.dim, fontSize: 11.5, marginTop: 2, lineHeight: 1.4 } }, d.tip) : null,
        ]),
        el('select', {
          key: 's',
          value: values.get(scalar) ?? d.valueOrder[0],
          disabled: saving === scalar,
          onChange: e => write(scalar, e.target.value),
          style: {
            background: T.layer, color: T.label, border: `1px solid ${T.border}`,
            borderRadius: 6, padding: '3px 6px', fontSize: 12, minWidth: 140,
          },
        }, d.valueOrder.map(v => el('option', { key: v, value: v }, v))),
      ]))) : null,

    error ? el('div', { key: 'e', style: { color: T.warn, fontSize: 12, marginTop: 8 } }, error) : null,
  ])
}
