#!/usr/bin/env node
/* ============================================================================
   OpenCues Artifact — hero video renderer
   ----------------------------------------------------------------------------
   Renders the hero animation to a 16:9 MP4, so a demo written once as HTML can
   also be posted as a video (Twitter/X, decks) without re-animating it anywhere.

   Two cuts, from the same animation:
     raw        the demo alone on the OpenCues ground. Nothing but the thing.
     captioned  the same, with a title and one line of description above it.

   USAGE
     node render-video.cjs [--out <dir>] [--seconds <n>] [--width <px>]

   OUTPUT (default <repo>/docs/artifacts/video/)
     oc-hero-raw.mp4         1280x720, H.264, yuv420p  (the "raw button")
     oc-hero-captioned.mp4   same, with title + description

   HOW
     Playwright renders a 16:9 stage containing the real hero (same markup, same
     script, same theme.css — never a re-implementation, or the video and the
     page would drift) and records it for one full loop. ffmpeg then normalises
     the recording to constant-frame-rate H.264 with yuv420p, which is what
     social platforms actually accept.

   REQUIREMENTS
     ffmpeg on PATH, and Playwright's chromium (resolved from
     integrations/chrome/node_modules — the repo's existing browser install).
   ============================================================================ */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const { buildFontFace } = require('./build.cjs');

const HERE = __dirname;
const REPO = path.resolve(HERE, '..', '..');

/* One loop of the hero is ~17.2s (see hero.html): 0.9s idle + 8 typed chars at
   0.145s + 1.9s + 3.4s + (2+2+2+3.8)s. Record a shade over that so the capture
   contains exactly one whole cycle. */
const LOOP_SECONDS = 17.6;

const TITLE = 'Adjust your volume from the line you are typing on';
const DESCRIPTION =
  'Type volume _ to read the current level, then press _ to nudge it up. OpenCues.';

/** The 16:9 stage. Reuses theme.css + the real hero, then scales the terminal
 *  up so it stays legible in a muted, thumbnail-sized social feed. */
function stageHtml({ captioned }) {
  const fontface = buildFontFace();
  const theme = fs.readFileSync(path.join(HERE, 'theme.css'), 'utf8');
  const hero = fs.readFileSync(path.join(HERE, 'hero.html'), 'utf8');
  return `<!doctype html><html><head><meta charset="utf-8"><style>
${fontface}
${theme}
/* ── Stage: 16:9, OpenCues ground, nothing else on screen ─────────────────── */
html,body{margin:0;padding:0;background:#111;height:100%;overflow:hidden}
.stage{height:100vh;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:34px;padding:0 70px;box-sizing:border-box}
.cap{max-width:1040px;text-align:left;width:100%}
.cap h1{font-family:"TWK Lausanne 200","TWK Lausanne",sans-serif;font-weight:200;font-size:46px;line-height:1.1;color:#fff;margin:0 0 14px}
.cap p{font-family:"TWK Lausanne",sans-serif;font-weight:300;font-size:22px;line-height:1.5;color:#8a8a8a;margin:0;max-width:none}
/* The hero, scaled for video. Same component, bigger type. */
.stage .hero{width:100%;max-width:1040px;margin:0;border-radius:10px}
.stage .hero .term{font-size:30px;line-height:1.85;padding:40px 40px 26px}
.stage .hero-cap{font-size:20px;padding:20px 40px 26px}
.stage .hero-cap .hkey{min-width:26px;height:30px;padding:0 9px;font-size:19px;border-radius:5px}
</style>

<script>
/* ── Virtual time ────────────────────────────────────────────────────────────
   Rendering has to be deterministic and headless-Chrome's one-shot --screenshot
   gives one frame per process, so we cannot race a wall clock. Instead we
   replace setTimeout/rAF with a queue and step it: '?mode=frame&n=K' advances
   the REAL hero code by exactly K callbacks and freezes there. No timings are
   duplicated here, so the video can never drift from the animation.
   '?mode=schedule' runs the whole loop and reports each callback's virtual time,
   which becomes each frame's duration in the final cut. */
(function(){
  var P = new URLSearchParams(location.search);
  if (!P.get('mode')) return;                 // live page: leave timers alone
  /* Headless Chrome reports prefers-reduced-motion: reduce, which would make
     the hero skip its typewriter. The video should show the full animation. */
  var mm = window.matchMedia.bind(window);
  window.matchMedia = function(qy){
    if (/prefers-reduced-motion/.test(qy)) return { matches: false, media: qy, addListener: function(){}, removeListener: function(){}, addEventListener: function(){}, removeEventListener: function(){} };
    return mm(qy);
  };
  var q = [], vt = 0, seq = 0, times = [];
  window.setTimeout = function(fn, ms){ q.push({fn: fn, due: vt + (ms || 0), seq: seq++}); return 0; };
  window.requestAnimationFrame = function(fn){ q.push({fn: function(){ fn(vt); }, due: vt, seq: seq++}); return 0; };
  window.__ocRun = function(count){
    for (var n = 0; n < count && q.length; n++){
      q.sort(function(a,b){ return (a.due - b.due) || (a.seq - b.seq); });
      var t = q.shift();
      vt = Math.max(vt, t.due);
      times.push(vt);
      try { t.fn(); } catch (e) {}
    }
  };
  window.__ocTimes = function(){ return times; };
})();
</script>
</head><body>
<div class="stage">
${captioned ? `  <div class="cap"><h1>${TITLE}</h1><p>${DESCRIPTION}</p></div>` : ''}
${hero}
</div>
<script>
(function(){
  var P = new URLSearchParams(location.search);
  var mode = P.get('mode'); if (!mode) return;
  var n = parseInt(P.get('n') || '0', 10);
  /* The hero also inits on DOMContentLoaded and registered first, so by the
     time this runs its first state is already applied and its timers queued. */
  function go(){
    window.__ocRun(mode === 'schedule' ? 400 : n);
    if (mode === 'schedule') document.title = JSON.stringify(window.__ocTimes());
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', go); else go();
})();
</script>

</body></html>`;
}

/* ── Capture ─────────────────────────────────────────────────────────────────
   Headless capture inside WSL is broken on this class of machine (page
   screenshots hang on both chromium and chrome-headless-shell, even for a
   trivial page), and Chrome ignores --remote-debugging-address, so CDP from
   WSL is not available either. What does work is Windows Chrome's one-shot
   --screenshot. One process gives one frame, so frames are addressed by the
   virtual-time shim in the stage: `?mode=frame&n=K` advances the real hero code
   by exactly K callbacks. Deterministic, and no timing is restated here. */
const WIN_TMP = process.env.OC_WIN_TMP || '/mnt/c/Users/wilfred/AppData/Local/Temp/oc-render';
const WIN_CHROME = process.env.OC_WIN_CHROME || '/mnt/c/Program Files/Google/Chrome/Application/chrome.exe';

/** /mnt/c/Users/x/... → C:\Users\x\... */
function toWin(p) {
  const m = p.match(/^\/mnt\/([a-z])\/(.*)$/);
  if (!m) throw new Error('not a /mnt/<drive> path: ' + p);
  return m[1].toUpperCase() + ':\\' + m[2].replace(/\//g, '\\');
}
function chrome(args, opts = {}) {
  return execFileSync(WIN_CHROME, ['--headless=new', '--disable-gpu', '--hide-scrollbars', ...args],
    { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], ...opts });
}

async function record({ captioned, outFile, seconds, width, height }) {
  const dir = path.join(WIN_TMP, captioned ? 'captioned' : 'raw');
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(dir, { recursive: true });
  const stage = path.join(dir, 'stage.html');
  fs.writeFileSync(stage, stageHtml({ captioned }));
  const url = 'file:///' + toWin(stage).replace(/\\/g, '/');

  // Pass 1 — ask the animation itself when each frame changes.
  const dom = chrome(['--dump-dom', url + '?mode=schedule'], { maxBuffer: 64 * 1024 * 1024 });
  const m = dom.match(/<title>(\[[^<]*\])<\/title>/);
  if (!m) throw new Error('no schedule reported by the stage (is the virtual-time shim present?)');
  const times = JSON.parse(m[1]);

  // Frame i is on screen from times[i-1] to times[i]; keep frames until the
  // requested duration is covered.
  const budget = seconds * 1000;
  const durations = [];
  for (let i = 0; i < times.length; i++) {
    const from = i === 0 ? 0 : times[i - 1];
    if (from >= budget) break;
    durations.push(Math.max(1, Math.min(times[i], budget) - from) / 1000);
  }

  // Pass 2 — one process per frame.
  process.stdout.write(`[video]   ${durations.length} distinct frames\n`);
  for (let i = 0; i < durations.length; i++) {
    const png = path.join(dir, String(i).padStart(4, '0') + '.png');
    chrome([`--screenshot=${toWin(png)}`, `--window-size=${width},${height}`, `${url}?mode=frame&n=${i}`]);
    if (!fs.existsSync(png)) throw new Error('chrome produced no frame ' + i);
  }

  // Each frame is held for exactly as long as the animation holds it.
  const list = durations.map((d, i) =>
    `file '${String(i).padStart(4, '0')}.png'\nduration ${d.toFixed(3)}`).join('\n')
    + `\nfile '${String(durations.length - 1).padStart(4, '0')}.png'\n`;
  const listFile = path.join(dir, 'frames.txt');
  fs.writeFileSync(listFile, list);

  fs.mkdirSync(path.dirname(outFile), { recursive: true });
  execFileSync('ffmpeg', [
    '-y', '-loglevel', 'error',
    '-f', 'concat', '-safe', '0', '-i', listFile,
    '-r', '30',
    '-vf', 'scale=' + width + ':' + height + ':flags=lanczos,format=yuv420p',
    '-c:v', 'libx264', '-preset', 'slow', '-crf', '20',
    '-movflags', '+faststart', '-an',
    outFile,
  ], { stdio: 'inherit' });

  fs.rmSync(dir, { recursive: true, force: true });
  return outFile;
}

async function main() {
  const argv = process.argv.slice(2);
  const arg = (name, dflt) => {
    const i = argv.indexOf('--' + name);
    return i >= 0 && argv[i + 1] ? argv[i + 1] : dflt;
  };
  const outDir = path.resolve(arg('out', path.join(HERE, 'video')));
  const seconds = parseFloat(arg('seconds', LOOP_SECONDS));
  const width = parseInt(arg('width', '1280'), 10);
  const height = Math.round(width * 9 / 16);   // 16:9, always

  for (const [captioned, name] of [[false, 'oc-hero-raw.mp4'], [true, 'oc-hero-captioned.mp4']]) {
    const out = path.join(outDir, name);
    process.stdout.write(`[video] rendering ${name} (${width}x${height}, ${seconds}s)…\n`);
    await record({ captioned, outFile: out, seconds, width, height });
    const kb = (fs.statSync(out).size / 1024).toFixed(0);
    process.stdout.write(`[video] wrote ${out} (${kb} KB)\n`);
  }
}

if (require.main === module) {
  main().catch(e => { console.error('[video] failed:', e.message); process.exit(1); });
}
module.exports = { stageHtml, record };
