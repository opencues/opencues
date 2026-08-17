/**
 * OpenCues, node half.
 *
 * dsh's browser client has no filesystem and no process.env, so the real
 * runtime's ConfigLoader (which reads `.cues/` through the adapter's
 * readFile/readDir) needs someone to hand it the tree. That is this plugin:
 * it walks the OpenCues config search paths on the machine and serves them,
 * plus the LLM keys, over one route on dsh's own web server.
 *
 * This is the same job chrome's native-messaging host does, except dsh
 * already gives us an in-process HTTP seam (`ctx.webServer.register`), so
 * there is no separate host process, no native-messaging manifest, and no
 * mirrored directory.
 */
import { mkdir, readdir, readFile, stat, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'

export const name = 'opencues'
export const inject = ['webServer', 'llm']

/** Env vars the runtime's provider resolver looks for. */
const KEY_NAMES = [
  'CEREBRAS_API_KEY', 'GROQ_API_KEY', 'GEMINI_API_KEY', 'ANTHROPIC_API_KEY',
  'OPENAI_API_KEY', 'OPENROUTER_API_KEY', 'FINNHUB_API_KEY',
]

const MAX_FILES = 400
const MAX_BYTES = 2 * 1024 * 1024

/**
 * Read a `.cues` tree into a flat {path: content} map the browser adapter
 * replays as a virtual filesystem. Only text config files; bounded so a
 * pathological directory can't wedge boot.
 */
async function readCuesTree(root, budget) {
  const out = {}
  const walk = async dir => {
    if (budget.files >= MAX_FILES || budget.bytes >= MAX_BYTES) return
    let entries
    try { entries = await readdir(dir, { withFileTypes: true }) } catch { return }
    for (const e of entries) {
      if (budget.files >= MAX_FILES || budget.bytes >= MAX_BYTES) return
      if (e.name.startsWith('.') && e.name !== '.env') continue
      const full = join(dir, e.name)
      if (e.isDirectory()) { await walk(full); continue }
      if (!/\.(md|json|txt)$/i.test(e.name)) continue
      try {
        const st = await stat(full)
        if (st.size > 256 * 1024) continue
        out[full] = await readFile(full, 'utf8')
        budget.files += 1
        budget.bytes += st.size
      } catch { /* unreadable file: skip, the runtime degrades gracefully */ }
    }
  }
  await walk(root)
  return out
}

export function apply(ctx, config = {}) {
  const cwd = config.cwd ?? process.cwd()
  // Same precedence as every native host: $OPENCUES_HOME, then project, then user.
  const searchPaths = [
    process.env.OPENCUES_HOME,
    join(resolve(cwd), '.cues'),
    join(homedir(), '.cues'),
  ].filter(Boolean)

  const dispose = ctx.webServer.register({
    kind: 'exact',
    path: '/opencues/config',
    async handler(req, res) {
      try {
        const budget = { files: 0, bytes: 0 }
        const files = {}
        for (const p of searchPaths) Object.assign(files, await readCuesTree(p, budget))
        // This route NEVER returns a credential value, in any mode, under
        // any parameter. Only the NAMES of the keys present, so a surface
        // can report "cerebras, groq detected" without holding secrets.
        //
        // There is deliberately no opt-in flag: dsh is a plugin host, the
        // page context is shared with third-party plugin code, and any flag
        // that can produce a secret is a flag that code can also set. The
        // runtime is handed placeholders instead and its provider requests
        // go out through /opencues/llm/proxy, which substitutes the real
        // value here, for an allowlisted destination only.
        const present = KEY_NAMES.filter(k => process.env[k])
        const body = JSON.stringify({
          searchPaths, files, cwd,
          apiKeys: {},
          fileCount: Object.keys(files).length,
          hasKeys: present,
          keysWithheld: true,
        })
        res.writeHead(200, {
          'content-type': 'application/json',
          'cache-control': 'no-store',
        })
        res.end(body)
      } catch (err) {
        res.writeHead(500, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ error: String(err) }))
      }
    },
  })

  // ── LLM bridge probe ──────────────────────────────────────────────────
  // `ctx.llm` is a HOST service, so routing OpenCues' calls through the
  // user's own configured model means the browser never sees a credential.
  // These two routes exist to find out what is live and how fast it is.

  const json = (res, code, body) => {
    res.writeHead(code, { 'content-type': 'application/json', 'cache-control': 'no-store' })
    res.end(JSON.stringify(body))
  }

  const disposeInfo = ctx.webServer.register({
    kind: 'exact',
    path: '/opencues/llm/info',
    async handler(req, res) {
      try {
        const providers = ctx.llm.listProviders?.() ?? []
        const configurable = ctx.llm.listConfigurableProviders?.() ?? []
        const models = {}
        for (const p of providers) {
          const route = typeof p === 'string' ? p : p.id ?? p.provider ?? p.name
          if (!route) continue
          try {
            const list = await ctx.llm.listModels(route)
            models[route] = []
            for (const m of list) {
              let info = null
              try { info = await ctx.llm.resolveModelInfo(route, m.id) }
              catch (e) { info = { error: String(e?.message ?? e).slice(0, 120) } }
              models[route].push({ ...m, info })
            }
          } catch (e) { models[route] = { error: String(e?.message ?? e).slice(0, 160) } }
        }
        json(res, 200, { providers, configurable, models })
      } catch (err) {
        json(res, 500, { error: String(err?.stack ?? err).slice(0, 500) })
      }
    },
  })

  // ── The LLM bridge ────────────────────────────────────────────────────
  // OpenCues' `harness` provider posts a neutral ChatRequest here; we
  // dispatch it through the user's own configured model and return the
  // assistant text. Credentials never leave this process.

  /** Pick the route to serve with: explicit config, else the live one. */
  async function resolveRoute(requestedModel) {
    const live = ctx.llm.listProviders?.() ?? []
    const provider = config.provider ?? live[0]?.id
    if (!provider) throw new Error('no LLM provider is registered in the harness')
    // A requested model is only honoured if this provider actually
    // advertises it. OpenCues carries its own model scalar (e.g.
    // `gemma-4-31b`), and forwarding that to the host's provider would ask
    // DeepSeek for a Cerebras model — adapters are told not to reject
    // unlisted ids, so it would be served as *something* rather than fail
    // loudly. Validate here, where the catalogue is known.
    let models = []
    try { models = await ctx.llm.listModels(provider) } catch { /* catalogue unavailable */ }
    const known = new Set(models.map(m => m.id))
    const wanted = requestedModel || config.model
    let model = wanted && known.has(wanted) ? wanted : undefined
    const fellBack = Boolean(wanted) && model === undefined
    if (!model) model = (config.model && known.has(config.model) ? config.model : undefined) ?? models[0]?.id
    if (!model) throw new Error(`provider "${provider}" advertises no models`)
    return { provider, model, fellBack, wanted }
  }

  /**
   * Map OpenCues' effort vocabulary onto whatever this exact model
   * advertises. Efforts are adapter-owned opaque strings, so the only safe
   * source is resolveModelInfo.
   *
   * Default is the CHEAPEST tier, not the model's own default. Measured on
   * DeepSeek: the default effort costs ~400ms and streams chain-of-thought
   * as ordinary text, which for OpenCues lands in the user's document.
   */
  async function resolveEffort(provider, model, requested) {
    let advertised = []
    try {
      const info = await ctx.llm.resolveModelInfo(provider, model)
      advertised = (info?.reasoning?.efforts ?? []).map(e => e.id)
    } catch { return undefined }
    if (advertised.length === 0) return undefined
    const off = advertised.find(id => /^(off|none|minimal|low)$/i.test(id))
    if (config.reasoning !== 'auto') return off ?? advertised[0]
    if (requested === 'none') return off ?? advertised[0]
    if (requested === 'high') return advertised[advertised.length - 1]
    return off ?? advertised[0]
  }

  const disposeLlm = ctx.webServer.register({
    kind: 'exact',
    path: '/opencues/llm',
    async handler(req, res) {
      if (req.method !== 'POST') return json(res, 405, { error: 'POST only' })
      try {
        // `done` rather than `resolve`: node:path's resolve is in scope here.
        const body = await new Promise((done, reject) => {
          let raw = ''
          req.on('data', c => {
            raw += c
            if (raw.length > 2_000_000) { reject(new Error('request too large')); req.destroy() }
          })
          req.on('end', () => { try { done(JSON.parse(raw)) } catch (e) { reject(e) } })
          req.on('error', reject)
        })

        const { provider, model, fellBack, wanted } = await resolveRoute(body.model)
        const reasoningEffort = await resolveEffort(provider, model, body.reasoningEffort)

        // OpenCues sends a flat role/content list; the harness wants the
        // system slot separated and content as typed blocks.
        const system = (body.messages ?? []).filter(m => m.role === 'system').map(m => m.content).join('\n\n')
        const messages = (body.messages ?? [])
          .filter(m => m.role !== 'system')
          .map(m => ({ role: m.role, content: [{ type: 'text', text: String(m.content ?? '') }] }))

        let text = ''
        let usage = null
        const t0 = Date.now()
        const stream = ctx.llm.stream({
          provider,
          model,
          ...(system ? { system } : {}),
          messages,
          ...(reasoningEffort ? { reasoningEffort } : {}),
          ...(typeof body.temperature === 'number' ? { temperature: body.temperature } : {}),
          ...(typeof body.maxTokens === 'number' ? { maxTokens: body.maxTokens } : {}),
        })
        for await (const chunk of stream) {
          // ONLY text-delta. `reasoning-delta` is chain-of-thought and
          // OpenCues splices whatever it gets straight into the buffer.
          if (chunk.type === 'text-delta') text += chunk.text
          else if (chunk.type === 'usage') usage = chunk.usage
          else if (chunk.type === 'finish' && chunk.reason && chunk.reason !== 'stop' && chunk.reason !== 'end_turn') {
            if (chunk.reason === 'error' || chunk.reason === 'aborted') {
              throw new Error(`harness stream ${chunk.reason}`)
            }
          }
        }
        json(res, 200, { text, usage, provider, model, reasoningEffort: reasoningEffort ?? null, ms: Date.now() - t0, ...(fellBack ? { modelFallbackFrom: wanted } : {}) })
      } catch (err) {
        json(res, 502, { error: String(err?.message ?? err).slice(0, 400) })
      }
    },
  })

  // ── Settings writes ───────────────────────────────────────────────────
  // The settings tab edits real OPENCUES.md scalars, so the same file the
  // native hosts read, and the same file the in-buffer `_` settings blank
  // writes. One source of truth; a user who later installs OpenCues
  // natively inherits every choice they made here.

  /** Where a scalar write lands: the first search path that has the file. */
  /**
   * The shipped default OPENCUES.md, emitted next to this file at build
   * time (see build.mjs). Read on demand rather than at load so a package
   * missing it degrades to a usable stub instead of failing to boot — but
   * note the stub is the state that silently disables features, so the
   * fallback logs rather than passing quietly.
   */
  async function defaultSettingsMd() {
    try {
      return await readFile(join(import.meta.dirname ?? '.', 'default-opencues.md'), 'utf8')
    } catch {
      console.warn('[opencues][dsh] default-opencues.md missing — seeding a bare frontmatter stub, '
        + 'which will leave features that the shipped default enables explicitly turned off')
      return '---\n---\n'
    }
  }

  async function settingsFilePath() {
    for (const p of searchPaths) {
      const f = join(p, 'OPENCUES.md')
      try { await stat(f); return f } catch { /* keep looking */ }
    }
    return join(homedir(), '.cues', 'OPENCUES.md')
  }

  /**
   * Apply `{scalar: value}` to an OPENCUES.md, in place.
   *
   * Rewrites an existing key rather than appending a duplicate — a second
   * `voice-mode:` line would shadow the first and make the UI look like it
   * had failed. Keys absent from the file are appended inside the
   * frontmatter block, which is where the parser looks.
   */
  function applyScalars(md, updates) {
    const lines = md.split('\n')
    const remaining = new Map(Object.entries(updates))
    for (let i = 0; i < lines.length; i++) {
      const m = lines[i].match(/^(\s*)([a-z0-9-]+):\s*(.*)$/i)
      if (!m) continue
      if (!remaining.has(m[2])) continue
      lines[i] = `${m[1]}${m[2]}: ${remaining.get(m[2])}`
      remaining.delete(m[2])
    }
    if (remaining.size > 0) {
      // Append inside the frontmatter: after the opening `---`, before its close.
      const close = lines.indexOf('---', lines[0]?.trim() === '---' ? 1 : 0)
      const add = [...remaining].map(([k, v]) => `${k}: ${v}`)
      if (close > 0) lines.splice(close, 0, ...add)
      else lines.unshift('---', ...add, '---')
    }
    return lines.join('\n')
  }

  const disposeSettings = ctx.webServer.register({
    kind: 'exact',
    path: '/opencues/settings',
    async handler(req, res) {
      if (req.method !== 'POST') return json(res, 405, { error: 'POST only' })
      try {
        const body = await new Promise((done, reject) => {
          let raw = ''
          req.on('data', c => { raw += c; if (raw.length > 200_000) { reject(new Error('too large')); req.destroy() } })
          req.on('end', () => { try { done(JSON.parse(raw)) } catch (e) { reject(e) } })
          req.on('error', reject)
        })
        const updates = body?.updates
        if (!updates || typeof updates !== 'object') return json(res, 400, { error: 'updates object required' })
        // Scalars are kebab-case keys with simple values; refuse anything
        // that could inject a second line into the frontmatter.
        for (const [k, v] of Object.entries(updates)) {
          if (!/^[a-z0-9-]+$/i.test(k)) return json(res, 400, { error: `bad scalar name: ${k}` })
          if (typeof v !== 'string' || /[\r\n]/.test(v)) return json(res, 400, { error: `bad value for ${k}` })
        }
        const path = await settingsFilePath()
        let current = ''
        let created = false
        try {
          current = await readFile(path, 'utf8')
        } catch {
          // A user who has never installed OpenCues has no `.cues`
          // directory at all, so this is the FIRST write — the missing
          // file was already handled here, but the missing PARENT was
          // not, and `writeFile` answered ENOENT. Every setting in the
          // tab was unsaveable for exactly the users the shipped
          // defaults exist to serve.
          //
          // Seed from the SHIPPED default rather than a bare `---\n---`.
          // A stub is on disk, and anything on disk wins over the baked
          // defaults, so a stub silently turns off every feature the
          // default enables explicitly — changing one setting switched
          // off word-cues and transform-blank, with no error and no way
          // for the user to connect cause to effect.
          current = await defaultSettingsMd()
          created = true
          await mkdir(dirname(path), { recursive: true })
        }
        const next = applyScalars(current, updates)
        await writeFile(path, next, 'utf8')
        json(res, 200, { ok: true, path, applied: Object.keys(updates), created })
      } catch (err) {
        json(res, 500, { error: String(err?.message ?? err).slice(0, 300) })
      }
    },
  })

  // ── Credential-injecting proxy (OpenCues mode) ────────────────────────
  //
  // In OpenCues mode the runtime dispatches to providers itself, which
  // normally means the page needs the API key. dsh is a PLUGIN HOST, so
  // that page context is shared with third-party plugin code: a key handed
  // to the page is handed to every plugin installed. So the page never
  // gets one. It sends the request here with a placeholder, and this
  // process substitutes the real credential on the way out.
  //
  // What this does and does not buy, stated plainly: a hostile plugin can
  // still ASK this route to spend the user's quota — but so can it simply
  // use the harness model. What it can no longer do is read the key and
  // use it elsewhere, forever, off this machine. Exfiltration is the harm
  // being closed here.

  /**
   * Destinations the proxy will contact, and which credential (if any) it
   * substitutes for each. Anything absent is refused.
   *
   * The data hosts carry no key and are here for a second reason: a
   * page-context fetch to a third-party API is CORS-blocked, so the
   * built-in data blanks cannot reach them from the browser at all
   * without this hop.
   */
  const PROVIDER_HOSTS = Object.freeze({
    // LLM providers — credential substituted.
    'api.cerebras.ai': 'CEREBRAS_API_KEY',
    'api.groq.com': 'GROQ_API_KEY',
    'api.openai.com': 'OPENAI_API_KEY',
    'api.anthropic.com': 'ANTHROPIC_API_KEY',
    'generativelanguage.googleapis.com': 'GEMINI_API_KEY',
    'openrouter.ai': 'OPENROUTER_API_KEY',
    // Data blanks — credential substituted.
    'finnhub.io': 'FINNHUB_API_KEY',
    // Data blanks — keyless, proxied only to clear CORS.
    'hacker-news.firebaseio.com': null,
    'api.open-meteo.com': null,
    'geocoding-api.open-meteo.com': null,
    'nominatim.openstreetmap.org': null,
    'api.dictionaryapi.dev': null,
    'api.coingecko.com': null,
    'status.anthropic.com': null,
  })

  /** What the page sends in place of a secret. Never a real credential. */
  const PLACEHOLDER = '__OPENCUES_PROXY__'

  const disposeProxy = ctx.webServer.register({
    kind: 'exact',
    path: '/opencues/llm/proxy',
    async handler(req, res) {
      if (req.method !== 'POST') return json(res, 405, { error: 'POST only' })
      try {
        const payload = await new Promise((done, reject) => {
          let raw = ''
          req.on('data', c => {
            raw += c
            if (raw.length > 4_000_000) { reject(new Error('request too large')); req.destroy() }
          })
          req.on('end', () => { try { done(JSON.parse(raw)) } catch (e) { reject(e) } })
          req.on('error', reject)
        })

        let target
        try { target = new URL(payload.url) } catch { return json(res, 400, { error: 'bad url' }) }
        if (target.protocol !== 'https:') return json(res, 403, { error: 'https only' })
        if (!Object.prototype.hasOwnProperty.call(PROVIDER_HOSTS, target.hostname)) {
          return json(res, 403, { error: `destination not allowed: ${target.hostname}` })
        }
        const envName = PROVIDER_HOSTS[target.hostname]
        let secret = ''
        if (envName) {
          secret = process.env[envName] ?? ''
          if (!secret) return json(res, 502, { error: `${envName} is not set in this environment` })
        }

        // Substitute the placeholder wherever this destination expects auth.
        // Never echo the value back. A keyless data host substitutes
        // nothing, so a placeholder sent to one stays a placeholder.
        const headers = {}
        for (const [k, v] of Object.entries(payload.headers ?? {})) {
          if (typeof v !== 'string') continue
          headers[k] = secret && v.includes(PLACEHOLDER) ? v.split(PLACEHOLDER).join(secret) : v
        }
        if (secret) {
          // Keys ride the query string on some APIs rather than a header:
          // gemini uses `key`, finnhub uses `token`.
          for (const param of ['key', 'token']) {
            if (target.searchParams.get(param) === PLACEHOLDER) target.searchParams.set(param, secret)
          }
        }

        const upstream = await fetch(target.toString(), {
          method: payload.method ?? 'POST',
          headers,
          body: payload.body,
        })
        const text = await upstream.text()
        res.writeHead(upstream.status, { 'content-type': 'application/json', 'cache-control': 'no-store' })
        res.end(text)
      } catch (err) {
        json(res, 502, { error: String(err?.message ?? err).slice(0, 300) })
      }
    },
  })

  /** A stable ~4.5k-token system prompt: OpenCues' real prompts are that
   *  size, and what we are measuring is TTFT against a repeated prefix. */
  const benchSystem = (() => {
    const para = 'You are a writing assistant embedded in a text editor. You suggest precise, minimal edits. You never explain your reasoning. You never add commentary. You answer with the requested value only, and nothing else. Prefer the shortest correct answer. Preserve the user\'s voice, register, and formatting exactly as given. '
    return ('RULES.\n' + para.repeat(90)).slice(0, 18000)
  })()

  const disposeBench = ctx.webServer.register({
    kind: 'prefix',
    path: '/opencues/llm/bench',
    async handler(req, res) {
      const url = new URL(req.url, 'http://127.0.0.1')
      const provider = url.searchParams.get('provider')
      const model = url.searchParams.get('model')
      const runs = Math.min(Number(url.searchParams.get('n') ?? 5), 20)
      const effort = url.searchParams.get('effort') || undefined
      if (!provider || !model) return json(res, 400, { error: 'provider and model required' })

      const results = []
      try {
        for (let i = 0; i < runs; i++) {
          const t0 = Date.now()
          let ttftAny = null
          let ttftText = null
          let text = ''
          let usage = null
          const stream = ctx.llm.stream({
            provider,
            model,
            ...(effort ? { reasoningEffort: effort } : {}),
            system: benchSystem,
            messages: [{ role: 'user', content: [{ type: 'text', text: 'The capital of Iceland is _\n\nReplace the underscore. Answer with the value only.' }] }],
            temperature: 0,
            maxTokens: 32,
          })
          for await (const chunk of stream) {
            if (ttftAny === null) ttftAny = Date.now() - t0
            const t = chunk?.delta?.text ?? chunk?.text ?? (chunk?.type === 'text-delta' ? chunk.textDelta : undefined)
            if (typeof t === 'string' && t.length > 0) {
              if (ttftText === null) ttftText = Date.now() - t0
              text += t
            }
            if (chunk?.usage) usage = chunk.usage
            if (chunk?.type === 'finish' && chunk?.finish) usage = usage ?? chunk.finish.usage ?? null
          }
          results.push({ run: i + 1, ttftAny, ttftText, total: Date.now() - t0, out: text.trim().slice(0, 60), usage })
        }
        const nums = results.map(r => r.ttftText ?? r.ttftAny).filter(n => typeof n === 'number')
        const totals = results.map(r => r.total)
        const median = a => a.length ? [...a].sort((x, y) => x - y)[Math.floor(a.length / 2)] : null
        json(res, 200, {
          provider, model, runs,
          ttft: { median: median(nums), min: Math.min(...nums), max: Math.max(...nums), all: nums },
          total: { median: median(totals), min: Math.min(...totals), max: Math.max(...totals) },
          results,
        })
      } catch (err) {
        json(res, 500, { provider, model, error: String(err?.stack ?? err).slice(0, 700), partial: results })
      }
    },
  })

  // ctx.effect RUNS its callback and treats the RETURN as the disposer, so
  // this must return a teardown function, not call the disposers inline.
  ctx.effect?.(() => () => { dispose(); disposeInfo(); disposeBench(); disposeLlm(); disposeProxy(); disposeSettings() }, 'opencues: routes')
}
