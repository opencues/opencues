// `opencues extract-commitments <transcript_path>` — Stage A of the
// session-contradiction feature (docs/architecture/session-contradiction.md).
//
// Distils a Claude Code session transcript into a terse COMMITMENTS watchlist
// (~/.cues/session-commitments.json) that SessionContradictionSource matches
// each draft against in realtime. Kicked fire-and-forget by the CC statusline
// when the transcript grows (highlight-statusline.sh); also runnable by hand.
//
// SCRIPTABLE + SILENT by design — it runs on a hot path, so every "not now"
// exit (feature off, debounced, no key, no turns) is a quiet exit 0. It NEVER
// throws into the statusline. Pass --force to bypass the debounce + mode gate,
// --json for a machine-readable summary, --quiet to suppress the one info line.
//
// Debounce: a marker (~/.cues/.session-commitments.marker.json) records the
// transcript path + mtime + last-extraction time. An extraction fires only when
// the transcript changed AND at least MIN_INTERVAL_MS elapsed — so a burst of CC
// turns yields at most one LLM call per interval. A lock file guards against
// concurrent kicks.

'use strict';

const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { readScalars } = require('../lib/opencues-md.cjs');

const MIN_INTERVAL_MS = 8_000;    // batch-window floor: at most one extraction
                                  // per 8s of activity. This is the effective
                                  // watchlist cadence — the statusline spawn-gate
                                  // (5s) is deliberately shorter so it never adds
                                  // a second beat. cerebras extraction is ~0.8s.
const STALE_LOCK_MS = 120_000;    // a lock older than this is assumed dead
const TAIL_BYTES = 256 * 1024;    // only the transcript tail is parsed (recent turns win)

function cuesDir() {
  const override = process.env.OPENCUES_HOME;
  return override && override.trim() ? override.trim() : path.join(os.homedir(), '.cues');
}

/** Read only the last `maxBytes` of a file, dropping a leading partial line. */
function readTail(file, maxBytes) {
  const st = fs.statSync(file);
  const start = Math.max(0, st.size - maxBytes);
  const fd = fs.openSync(file, 'r');
  try {
    const len = st.size - start;
    const buf = Buffer.alloc(len);
    fs.readSync(fd, buf, 0, len, start);
    let text = buf.toString('utf8');
    if (start > 0) { const nl = text.indexOf('\n'); if (nl >= 0) text = text.slice(nl + 1); }
    return { text, mtimeMs: st.mtimeMs };
  } finally { fs.closeSync(fd); }
}

/** Load @opencues/core from the repo dist first, then a bundled resolution.
 *  Returns null (never throws) so a missing build is a quiet skip. */
function loadCore(ctx) {
  const candidates = [];
  if (ctx && ctx.REPO_ROOT) candidates.push(path.join(ctx.REPO_ROOT, 'packages/opencues-core/dist/index.js'));
  candidates.push('@opencues/core');
  for (const c of candidates) {
    try { return require(c); } catch { /* try next */ }
  }
  return null;
}

module.exports = async function extractCommitments(argv, ctx) {
  const args = Array.isArray(argv) ? argv : [];
  if (args.includes('--help') || args.includes('-h')) return printHelp();
  const force = args.includes('--force');
  const json = args.includes('--json');
  const quiet = args.includes('--quiet');
  const valFlag = (name) => { const i = args.indexOf(name); return i >= 0 && i + 1 < args.length ? args[i + 1] : null; };
  // --format cc|gemini|opencode|dsh (default cc) selects the transcript parser; --turns-file
  // <path> supplies pre-parsed {turns:[{role,text}]} JSON (OpenCode reads its
  // own conversation via the SDK and hands us turns directly). The positional
  // arg is the transcript path — but must not swallow a valued-flag's value.
  const format = (valFlag('--format') || 'cc').toLowerCase();
  const turnsFile = valFlag('--turns-file');
  const ocCwd = valFlag('--cwd');   // OpenCode: which session (session.directory)
  const flagValues = new Set([format === 'cc' ? null : format, turnsFile, ocCwd].filter(Boolean));
  const transcriptPath = args.find((a) => !a.startsWith('-') && !flagValues.has(a));

  const done = (obj, code = 0) => {
    if (json) console.log(JSON.stringify(obj));
    else if (!quiet && obj.skipped && obj.reason && code === 0) { /* silent skip on the hot path */ }
    return code;
  };

  // The "source" we stat for debounce/mtime is the turns-file (OpenCode) or the
  // transcript path (CC/Gemini).
  const sourcePath = turnsFile || transcriptPath;
  if (!sourcePath) {
    if (json) console.log(JSON.stringify({ ok: false, error: 'missing transcript path' }));
    else console.error('opencues extract-commitments: usage: opencues extract-commitments <transcript_path> [--format cc|gemini|opencode|dsh] [--turns-file <path>]');
    return 2;
  }

  const dir = cuesDir();
  let transcriptStat;
  try { transcriptStat = fs.statSync(sourcePath); }
  catch { return done({ skipped: true, reason: 'transcript not found' }); }

  const core = loadCore(ctx);
  if (!core || typeof core.extractTranscriptTurns !== 'function') {
    return done({ skipped: true, reason: '@opencues/core unavailable (run pnpm build)' });
  }
  // Scope the watchlist + debounce state by cwd so concurrent sessions/hosts in
  // different projects don't clobber each other (see sessionCommitmentsKey).
  const scKey = typeof core.sessionCommitmentsKey === 'function' ? core.sessionCommitmentsKey(ocCwd) : '_default';
  // Per-cwd files live under <cues>/session-commitments/<key>.{json,marker,lock}.
  // When no cwd is known (--cwd omitted), fall back to the legacy flat files so
  // hand runs + tests keep working.
  const scDir = path.join(dir, 'session-commitments');
  const outPath = ocCwd ? path.join(scDir, scKey + '.json') : path.join(dir, 'session-commitments.json');
  const markerPath = ocCwd ? path.join(scDir, scKey + '.marker.json') : path.join(dir, '.session-commitments.marker.json');
  const lockPath = ocCwd ? path.join(scDir, scKey + '.lock') : path.join(dir, '.session-commitments.lock');

  // Mode gate — don't spend LLM calls unless the user enabled the feature.
  if (!force) {
    try {
      const settingsFile = path.join(dir, core.CORE_SETTINGS_FILE || 'OPENCUES.md');
      const scalars = fs.existsSync(settingsFile) ? readScalars(fs.readFileSync(settingsFile, 'utf8')) : new Map();
      // The distilled session feeds BOTH session-contradiction (the watchlist)
      // AND ask-cues (the summary + decisions as grounding context), so run the
      // producer when EITHER is on.
      // Defaults DIFFER by scalar: session-contradiction is on unless 'off'
      // (its output is verified against checkable data); ask-cues is OFF
      // unless 'on' (the August 2026 sweep measured its ceiling at ~20-35%
      // useful — see tests/benchmarks/ask-cues/EXPERIMENTS.md). This is the
      // THIRD independent read of these scalars; it must agree with
      // resolver.ts and config-loader.ts's DEFAULT_STATE or the feature
      // half-works in a way nothing reports — it already did once, when the
      // resolver forwarded a watchlist to a source it had not built.
      const sc = (scalars.get('session-contradiction-mode') || 'on').toLowerCase() !== 'off';
      const ac = (scalars.get('ask-cues-mode') || 'off').toLowerCase() === 'on';
      if (!sc && !ac) return done({ skipped: true, reason: 'session-contradiction + ask-cues both off' });
      // An unreadable settings file is NOT consent to read the session. The
      // default applies to a file that simply doesn't mention these scalars,
      // not to one we failed to parse — a user whose `off` we cannot see is a
      // user whose `off` we must assume.
    } catch { return done({ skipped: true, reason: 'settings unreadable' }); }
  }

  // Debounce marker (path scoped above).
  if (!force) {
    try {
      const m = JSON.parse(fs.readFileSync(markerPath, 'utf8'));
      const now = Date.now();
      const sameFile = m.transcriptPath === sourcePath;
      const unchanged = sameFile && m.mtimeMs === transcriptStat.mtimeMs;
      const tooSoon = typeof m.extractedAt === 'number' && (now - m.extractedAt) < MIN_INTERVAL_MS;
      if (unchanged || (sameFile && tooSoon)) return done({ skipped: true, reason: unchanged ? 'transcript unchanged' : 'debounced' });
    } catch { /* no/invalid marker → proceed */ }
  }

  // Lock — best-effort, O_EXCL. A stale lock (dead kick) is reclaimed (path scoped above).
  let locked = false;
  try {
    try { fs.mkdirSync(path.dirname(lockPath), { recursive: true }); } catch { /* exists */ }
    try {
      fs.writeFileSync(lockPath, String(process.pid), { flag: 'wx' });
      locked = true;
    } catch {
      // Lock held — reclaim if stale, else another kick is running.
      try {
        const st = fs.statSync(lockPath);
        if (Date.now() - st.mtimeMs > STALE_LOCK_MS) { fs.writeFileSync(lockPath, String(process.pid)); locked = true; }
        else return done({ skipped: true, reason: 'another extraction in progress' });
      } catch { return done({ skipped: true, reason: 'lock contended' }); }
    }

    // Parse into {role,text} turns — per host format, or a pre-parsed turns-file.
    let turns;
    try {
      if (turnsFile) {
        // OpenCode: the plugin read its own conversation via the SDK and wrote
        // {turns:[{role,text}]} — trust it, but normalize + drop empties.
        const parsed = JSON.parse(fs.readFileSync(turnsFile, 'utf8'));
        const raw = Array.isArray(parsed) ? parsed : Array.isArray(parsed?.turns) ? parsed.turns : [];
        turns = raw
          .filter((t) => t && typeof t.text === 'string' && t.text.trim())
          .map((t) => ({ role: t.role === 'assistant' ? 'assistant' : 'user', text: core.stripHarnessFraming(t.text) }))
          .filter((t) => t.text);
      } else if (format === 'dsh') {
        // dsh stores each session as concatenated zstd frames; decode here in
        // the Node CLI rather than in the browser half, which has no zlib.
        turns = readDshTurns(sourcePath, core);
        if (turns === null) return done({ skipped: true, reason: 'dsh session unreadable (node<22.15 lacks zstd?)' });
      } else if (format === 'opencode') {
        // OpenCode stores messages in a SQLite DB; read it here in the Node CLI
        // (node:sqlite) rather than in OpenCode's Bun runtime, which lacks it.
        turns = readOpenCodeTurns(sourcePath, ocCwd);
        if (turns === null) return done({ skipped: true, reason: 'opencode DB unreadable (node:sqlite unavailable? node<22)' });
      } else {
        const tail = readTail(sourcePath, TAIL_BYTES).text;
        turns = format === 'gemini' ? core.extractGeminiTranscriptTurns(tail) : core.extractTranscriptTurns(tail);
      }
    }
    catch { return done({ skipped: true, reason: 'transcript unreadable' }); }
    if (!turns || turns.length === 0) {
      writeMarker(markerPath, sourcePath, transcriptStat.mtimeMs);
      return done({ skipped: true, reason: 'no text turns' });
    }
    const transcriptText = core.renderTranscriptForExtraction(turns);

    // Resolve the CUES bucket LLM (same walk build-sources / doctor use).
    const apiKeys = typeof core.buildBootApiKeys === 'function' ? core.buildBootApiKeys() : envKeyBag(core);
    let scalarsMap = new Map();
    try {
      const settingsFile = path.join(dir, core.CORE_SETTINGS_FILE || 'OPENCUES.md');
      if (fs.existsSync(settingsFile)) scalarsMap = readScalars(fs.readFileSync(settingsFile, 'utf8'));
    } catch { /* empty scalars */ }
    const routing = core.resolveEffectiveRouting({ scalars: (n) => scalarsMap.get(n), apiKeys });
    const ex = resolveExtractionLLM(core, apiKeys, routing);
    if (!ex) {
      return done({ skipped: true, reason: 'no extraction LLM resolvable (no key / provider)' });
    }

    // Wire call (raw fetch — mirrors `opencues review`). No temperature/seed:
    // Anthropic 4.x rejects temperature and has no seed; determinism isn't
    // essential for a terse extraction.
    const wire = core.buildProviderRequest(
      ex.provider.id,
      {
        messages: [
          { role: 'system', content: core.SESSION_COMMITMENTS_EXTRACT_SYSTEM },
          { role: 'user', content: `TRANSCRIPT:\n${transcriptText}` },
        ],
        model: ex.model,
        maxTokens: 1024,
      },
      { apiKey: ex.apiKey },
    );
    let raw;
    try {
      const resp = await fetch(wire.url, { method: 'POST', headers: wire.headers, body: typeof wire.body === 'string' ? wire.body : JSON.stringify(wire.body) });
      if (!resp.ok) { return done({ skipped: true, reason: `LLM http ${resp.status} (${ex.provider.id}/${ex.model})` }); }
      const bodyText = await resp.text();
      recordProducerUsage(ex.provider.id, ex.model, bodyText);   // out-of-process → `opencues usage`
      raw = core.parseProviderResponse(ex.provider.id, bodyText);
    } catch (e) {
      return done({ skipped: true, reason: `LLM call failed: ${(e && e.message) || e}` });
    }

    const ext = core.parseExtractionResult(raw);
    // Session identity. For CC/Gemini the FILENAME is the session id. dsh names
    // every session file `session.jsonl.zstd` and carries the id in the parent
    // directory (`session-<uuid>/`), so the filename rule would make every dsh
    // session look like the same one — `sameSession` always true, and a prior,
    // unrelated conversation's commitments merged into the new watchlist
    // instead of resetting. That is precisely the clobber the cwd-scoping
    // elsewhere exists to prevent.
    const currentSessionId = format === 'dsh'
      ? path.basename(path.dirname(sourcePath))
      : path.basename(sourcePath).replace(/\.(jsonl|json)$/i, '');

    // ── Incremental distillation ──────────────────────────────────────────
    // The tail read only sees recent turns, so early decisions age out of every
    // fresh distillation. ACCUMULATE: merge the fresh tail decisions into the
    // watchlist we already built THIS session, dropping only what a newer
    // decision supersedes. Preservation is deterministic (mergeSessionCommitments);
    // supersession is its own small LLM call so a revised decision ("switch to X")
    // doesn't leave a stale entry that would false-alarm the matcher. Reset on a
    // new session (different transcript) — the watchlist is per-session, not
    // cross-session. See RESULTS-real-transcripts.txt for why this matters.
    let mergedCommitments = ext.commitments;
    let mergedSummary = ext.summary;
    let priorSnapshot = null;
    try {
      if (fs.existsSync(outPath)) priorSnapshot = JSON.parse(fs.readFileSync(outPath, 'utf8'));
    } catch { priorSnapshot = null; }
    const priorCommitments = priorSnapshot && Array.isArray(priorSnapshot.commitments) ? priorSnapshot.commitments : [];
    const sameSession = priorSnapshot && priorSnapshot.sessionId === currentSessionId;
    if (sameSession && priorCommitments.length > 0) {
      let superseded = [];
      // Only pay for the supersession call when there's something fresh that
      // could replace a prior decision; a no-new-decisions tick just re-affirms.
      if (Array.isArray(ext.commitments) && ext.commitments.length > 0) {
        try {
          const priorList = priorCommitments.map((c) => `- ${c.statement}`).join('\n');
          const freshList = ext.commitments.map((c) => `- ${c.statement}`).join('\n');
          const swWire = core.buildProviderRequest(ex.provider.id, {
            messages: [
              { role: 'system', content: core.SESSION_COMMITMENTS_SUPERSEDE_SYSTEM },
              { role: 'user', content: `PRIOR:\n${priorList}\n\nFRESH:\n${freshList}` },
            ],
            model: ex.model, maxTokens: 512,
          }, { apiKey: ex.apiKey });
          const swResp = await fetch(swWire.url, { method: 'POST', headers: swWire.headers, body: typeof swWire.body === 'string' ? swWire.body : JSON.stringify(swWire.body) });
          if (swResp.ok) { const swBody = await swResp.text(); recordProducerUsage(ex.provider.id, ex.model, swBody); superseded = core.parseSupersededResult(core.parseProviderResponse(ex.provider.id, swBody)); }
        } catch { /* supersession is best-effort — fall back to pure preservation */ }
      }
      mergedCommitments = core.mergeSessionCommitments(priorCommitments, ext.commitments, superseded);
      // Keep the freshest summary; fall back to the prior one on an empty tick.
      mergedSummary = ext.summary || priorSnapshot.summary;
    }

    const snapshot = core.buildSessionCommitmentsSnapshot(mergedCommitments, {
      summary: mergedSummary,
      ingestedAt: new Date().toISOString(),
      sessionId: currentSessionId,
    });

    // Atomic write of the snapshot.
    const tmp = `${outPath}.tmp-${process.pid}`;
    fs.writeFileSync(tmp, JSON.stringify(snapshot, null, 2));
    fs.renameSync(tmp, outPath);
    writeMarker(markerPath, sourcePath, transcriptStat.mtimeMs);

    if (!quiet && !json) console.log(`opencues: distilled ${snapshot.commitments.length} session commitment(s) (${ex.provider.id}/${ex.model})`);
    return done({ ok: true, count: snapshot.commitments.length, summary: snapshot.summary || '', provider: ex.provider.id, model: ex.model, source: ex.why, path: outPath });
  } finally {
    if (locked) { try { fs.unlinkSync(lockPath); } catch { /* already gone */ } }
  }
};

// Extraction reads the transcript tail every ~8s of activity, so it wants a
// fast, cheap model. The real-transcript benchmark
// (tests/benchmarks/session-contradiction/RESULTS-real-transcripts.txt) settled
// the model choice: on real, messy sessions the cues-bucket default (cerebras/
// gemma) extracts in ~0.5s and never comes back empty, while Claude Haiku is
// ~4× slower for a modest recall edge — not worth it for a background read. So
// the cues bucket is now the DEFAULT; Haiku is a fallback / opt-in, not the
// auto-route it used to be. Preference order:
//   1. OPENCUES_EXTRACT_PROVIDER + OPENCUES_EXTRACT_MODEL (power-user override,
//      e.g. set provider=anthropic to force Haiku for its recall edge).
//   2. the cues bucket (whatever the user configured — cerebras by default).
//   3. Claude Haiku (anthropic/claude-haiku-4-5) as a fallback when the cues
//      bucket isn't resolvable but ANTHROPIC_API_KEY is set.
const HAIKU_MODEL = 'claude-haiku-4-5-20251001';
function resolveExtractionLLM(core, apiKeys, routing) {
  const key = (p) => (p && p.envKeyName ? apiKeys[p.envKeyName] : undefined);
  const ovP = process.env.OPENCUES_EXTRACT_PROVIDER;
  const ovM = process.env.OPENCUES_EXTRACT_MODEL;
  if (ovP && ovM) {
    const p = core.getProvider(ovP.toLowerCase());
    if (p) return { provider: p, model: ovM, apiKey: key(p), why: 'env-override' };
  }
  const cues = routing && routing.cues;
  if (cues && cues.provider && cues.model && cues.keyPresent) {
    return { provider: cues.provider, model: cues.model, apiKey: key(cues.provider), why: 'cues-bucket' };
  }
  if (apiKeys.ANTHROPIC_API_KEY) {
    const p = core.getProvider('anthropic');
    if (p) return { provider: p, model: ovM || HAIKU_MODEL, apiKey: apiKeys.ANTHROPIC_API_KEY, why: 'haiku-fallback' };
  }
  return null;
}

/**
 * Reconstruct {role,text} turns from OpenCode's SQLite DB. Finds the newest
 * session for `cwd` (session.directory), reads its messages (role in
 * message.data) + text parts (part.data type:"text"), dropping reasoning/tool
 * parts. Read-only open so it's safe against the live WAL DB. Returns null when
 * node:sqlite is unavailable (node < 22) or the DB can't be opened.
 */
/**
 * Read a DeepSeek Harness session into {role,text} turns.
 *
 * The file is NOT one zstd stream: dsh appends each record as its OWN zstd
 * frame, so the file is a run of concatenated frames. Both
 * `zstdDecompressSync` and `createZstdDecompress()` stop after the first frame
 * and return only the session header — which decodes cleanly, parses as one
 * record, and looks exactly like an empty conversation. Frames are located by
 * their magic number and decoded individually.
 *
 * Node >= 22.15 ships zstd in `node:zlib`, so this needs no dependency; older
 * runtimes return null and the caller skips rather than crashing.
 */
function readDshTurns(sessionPath, core, maxBytes = 8 * 1024 * 1024) {
  let zlib;
  try { zlib = require('node:zlib'); } catch { return null; }
  if (typeof zlib.zstdDecompressSync !== 'function') return null;   // node < 22.15

  let buf;
  try { buf = fs.readFileSync(sessionPath); } catch { return null; }
  if (!buf.length || buf.length > maxBytes) return null;

  // zstd frame magic: 28 B5 2F FD.
  const starts = [];
  for (let i = 0; i + 3 < buf.length; i++) {
    if (buf[i] === 0x28 && buf[i + 1] === 0xB5 && buf[i + 2] === 0x2F && buf[i + 3] === 0xFD) starts.push(i);
  }
  if (!starts.length) return null;
  starts.push(buf.length);

  let jsonl = '';
  for (let i = 0; i < starts.length - 1; i++) {
    try { jsonl += zlib.zstdDecompressSync(buf.subarray(starts[i], starts[i + 1])).toString('utf8'); }
    catch { /* a torn trailing frame (session still being written) — keep what decoded */ }
  }
  if (!jsonl) return null;

  // `core` is passed in: loadCore() without a ctx cannot resolve
  // `@opencues/core` from packages/opencues-cli (it is not in its
  // node_modules), so re-resolving here silently returned null and the reader
  // reported the file as unreadable.
  return core && typeof core.extractDshTranscriptTurns === 'function'
    ? core.extractDshTranscriptTurns(jsonl)
    : null;
}

function readOpenCodeTurns(dbPath, cwd, maxMessages = 400) {
  let DatabaseSync;
  try { ({ DatabaseSync } = require('node:sqlite')); } catch { return null; }
  let db;
  try { db = new DatabaseSync(dbPath, { readOnly: true }); } catch { return null; }
  try {
    // When a cwd is given it is AUTHORITATIVE — only that project's newest
    // session. Never fall back to a random other session (that would distil,
    // and clobber the watchlist with, an unrelated conversation). The global
    // fallback applies ONLY when no cwd was passed.
    let sess = cwd
      ? db.prepare('SELECT id FROM session WHERE directory = ? ORDER BY time_updated DESC LIMIT 1').get(cwd)
      : db.prepare('SELECT id FROM session ORDER BY time_updated DESC LIMIT 1').get();
    if (!sess) return [];
    const msgs = db.prepare('SELECT id, data FROM message WHERE session_id = ? ORDER BY time_created DESC LIMIT ?').all(sess.id, maxMessages);
    msgs.reverse();
    const partStmt = db.prepare('SELECT data FROM part WHERE message_id = ? ORDER BY time_created');
    const turns = [];
    for (const m of msgs) {
      let role;
      try { role = JSON.parse(m.data).role; } catch { continue; }
      if (role !== 'user' && role !== 'assistant') continue;
      const texts = [];
      for (const p of partStmt.all(m.id)) {
        try { const d = JSON.parse(p.data); if (d.type === 'text' && typeof d.text === 'string' && d.text.trim()) texts.push(d.text.trim()); } catch { /* skip part */ }
      }
      const text = texts.join('\n').trim();
      if (text) turns.push({ role, text });
    }
    return turns;
  } catch { return null; }
  finally { try { db.close(); } catch { /* already closed */ } }
}

function writeMarker(markerPath, transcriptPath, mtimeMs) {
  try { fs.writeFileSync(markerPath, JSON.stringify({ transcriptPath, mtimeMs, extractedAt: Date.now() })); }
  catch { /* marker is an optimization; a failed write just means we re-check next tick */ }
}

/**
 * Record one producer LLM call's usage so `opencues usage` can count it. The
 * producer is a separate short-lived process making raw fetch calls (not
 * dispatchChat), so it can't reach the host's in-process UsageMeter. Instead it
 * APPENDS one JSON line to /tmp/opencues-usage-producer.jsonl. Append is atomic
 * for small writes on POSIX (O_APPEND, < PIPE_BUF), so concurrent producers
 * across hosts/cwds never corrupt it and no lock is needed. `opencues usage`
 * sums the lines into a synthetic "producer" host. Best-effort — usage
 * accounting must never break the producer.
 */
function recordProducerUsage(providerId, model, bodyText) {
  try {
    const j = JSON.parse(bodyText);
    let promptTokens = 0, cachedTokens = 0, completionTokens = 0;
    if (providerId === 'anthropic') {
      promptTokens = j.usage?.input_tokens || 0;
      completionTokens = j.usage?.output_tokens || 0;
      cachedTokens = j.usage?.cache_read_input_tokens || 0;
    } else if (providerId === 'gemini') {
      promptTokens = j.usageMetadata?.promptTokenCount || 0;
      completionTokens = j.usageMetadata?.candidatesTokenCount || 0;
    } else { // openai-compatible (cerebras, groq, openai, openrouter)
      promptTokens = j.usage?.prompt_tokens || 0;
      completionTokens = j.usage?.completion_tokens || 0;
      cachedTokens = j.usage?.prompt_tokens_details?.cached_tokens || 0;
    }
    if (!promptTokens && !completionTokens) return;
    const line = JSON.stringify({ providerId, model, promptTokens, cachedTokens, completionTokens }) + '\n';
    fs.appendFileSync(path.join(os.tmpdir(), 'opencues-usage-producer.jsonl'), line);
  } catch { /* best effort — never break the producer for accounting */ }
}

/** Fallback key bag when core has no buildBootApiKeys export. */
function envKeyBag(core) {
  const bag = {};
  try { for (const a of core.listProviders()) if (a.envKeyName) bag[a.envKeyName] = process.env[a.envKeyName]; }
  catch { /* no listProviders */ }
  return bag;
}

function printHelp() {
  console.log(`opencues extract-commitments <transcript_path> [--force] [--json] [--quiet]

Stage A of session-contradiction cues: distils a Claude Code session transcript
into ~/.cues/session-commitments.json for the realtime matcher.

Normally kicked automatically by the CC statusline; run by hand to force a
refresh. Requires session-contradiction-mode: on (bypass with --force).`);
  return 0;
}
