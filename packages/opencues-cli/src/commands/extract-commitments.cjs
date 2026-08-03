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
  const transcriptPath = args.find((a) => !a.startsWith('-'));

  const done = (obj, code = 0) => {
    if (json) console.log(JSON.stringify(obj));
    else if (!quiet && obj.skipped && obj.reason && code === 0) { /* silent skip on the hot path */ }
    return code;
  };

  if (!transcriptPath) {
    if (json) console.log(JSON.stringify({ ok: false, error: 'missing transcript path' }));
    else console.error('opencues extract-commitments: usage: opencues extract-commitments <transcript_path>');
    return 2;
  }

  const dir = cuesDir();
  let transcriptStat;
  try { transcriptStat = fs.statSync(transcriptPath); }
  catch { return done({ skipped: true, reason: 'transcript not found' }); }

  const core = loadCore(ctx);
  if (!core || typeof core.extractTranscriptTurns !== 'function') {
    return done({ skipped: true, reason: '@opencues/core unavailable (run pnpm build)' });
  }

  // Mode gate — don't spend LLM calls unless the user enabled the feature.
  if (!force) {
    try {
      const settingsFile = path.join(dir, core.CORE_SETTINGS_FILE || 'OPENCUES.md');
      const scalars = fs.existsSync(settingsFile) ? readScalars(fs.readFileSync(settingsFile, 'utf8')) : new Map();
      // The distilled session feeds BOTH session-contradiction (the watchlist)
      // AND ask-cues (the summary + decisions as grounding context), so run the
      // producer when EITHER is on.
      const sc = (scalars.get('session-contradiction-mode') || 'off').toLowerCase() === 'on';
      const ac = (scalars.get('ask-cues-mode') || 'off').toLowerCase() === 'on';
      if (!sc && !ac) return done({ skipped: true, reason: 'session-contradiction + ask-cues both off' });
    } catch { /* unreadable settings → treat as off */ return done({ skipped: true, reason: 'settings unreadable' }); }
  }

  // Debounce marker.
  const markerPath = path.join(dir, '.session-commitments.marker.json');
  if (!force) {
    try {
      const m = JSON.parse(fs.readFileSync(markerPath, 'utf8'));
      const now = Date.now();
      const sameFile = m.transcriptPath === transcriptPath;
      const unchanged = sameFile && m.mtimeMs === transcriptStat.mtimeMs;
      const tooSoon = typeof m.extractedAt === 'number' && (now - m.extractedAt) < MIN_INTERVAL_MS;
      if (unchanged || (sameFile && tooSoon)) return done({ skipped: true, reason: unchanged ? 'transcript unchanged' : 'debounced' });
    } catch { /* no/invalid marker → proceed */ }
  }

  // Lock — best-effort, O_EXCL. A stale lock (dead kick) is reclaimed.
  const lockPath = path.join(dir, '.session-commitments.lock');
  let locked = false;
  try {
    try { fs.mkdirSync(dir, { recursive: true }); } catch { /* exists */ }
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

    // Parse the transcript tail → turns → bounded prompt input.
    let turns;
    try { turns = core.extractTranscriptTurns(readTail(transcriptPath, TAIL_BYTES).text); }
    catch { return done({ skipped: true, reason: 'transcript unreadable' }); }
    if (!turns || turns.length === 0) {
      writeMarker(markerPath, transcriptPath, transcriptStat.mtimeMs);
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
      raw = core.parseProviderResponse(ex.provider.id, await resp.text());
    } catch (e) {
      return done({ skipped: true, reason: `LLM call failed: ${(e && e.message) || e}` });
    }

    const ext = core.parseExtractionResult(raw);
    const snapshot = core.buildSessionCommitmentsSnapshot(ext.commitments, {
      summary: ext.summary,
      ingestedAt: new Date().toISOString(),
      sessionId: path.basename(transcriptPath).replace(/\.jsonl$/i, ''),
    });

    // Atomic write of the snapshot.
    const outPath = path.join(dir, 'session-commitments.json');
    const tmp = `${outPath}.tmp-${process.pid}`;
    fs.writeFileSync(tmp, JSON.stringify(snapshot, null, 2));
    fs.renameSync(tmp, outPath);
    writeMarker(markerPath, transcriptPath, transcriptStat.mtimeMs);

    if (!quiet && !json) console.log(`opencues: distilled ${snapshot.commitments.length} session commitment(s) (${ex.provider.id}/${ex.model})`);
    return done({ ok: true, count: snapshot.commitments.length, summary: snapshot.summary || '', provider: ex.provider.id, model: ex.model, source: ex.why, path: outPath });
  } finally {
    if (locked) { try { fs.unlinkSync(lockPath); } catch { /* already gone */ } }
  }
};

// Extraction reads the WHOLE transcript tail — a large context — every ~8s of
// activity, so it should run on a cheap, big-context model, NOT burn the
// realtime cues-bucket provider. Preference order:
//   1. OPENCUES_EXTRACT_PROVIDER + OPENCUES_EXTRACT_MODEL (power-user override)
//   2. Claude Haiku (anthropic/claude-haiku-4-5) when ANTHROPIC_API_KEY is set —
//      cheap + fast on long context, and keeps the matcher's provider free.
//   3. the cues bucket (whatever the user configured) as the fallback.
const HAIKU_MODEL = 'claude-haiku-4-5-20251001';
function resolveExtractionLLM(core, apiKeys, routing) {
  const key = (p) => (p && p.envKeyName ? apiKeys[p.envKeyName] : undefined);
  const ovP = process.env.OPENCUES_EXTRACT_PROVIDER;
  const ovM = process.env.OPENCUES_EXTRACT_MODEL;
  if (ovP && ovM) {
    const p = core.getProvider(ovP.toLowerCase());
    if (p) return { provider: p, model: ovM, apiKey: key(p), why: 'env-override' };
  }
  if (apiKeys.ANTHROPIC_API_KEY) {
    const p = core.getProvider('anthropic');
    if (p) return { provider: p, model: ovM || HAIKU_MODEL, apiKey: apiKeys.ANTHROPIC_API_KEY, why: 'haiku' };
  }
  const cues = routing && routing.cues;
  if (cues && cues.provider && cues.model && cues.keyPresent) {
    return { provider: cues.provider, model: cues.model, apiKey: key(cues.provider), why: 'cues-bucket' };
  }
  return null;
}

function writeMarker(markerPath, transcriptPath, mtimeMs) {
  try { fs.writeFileSync(markerPath, JSON.stringify({ transcriptPath, mtimeMs, extractedAt: Date.now() })); }
  catch { /* marker is an optimization; a failed write just means we re-check next tick */ }
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
