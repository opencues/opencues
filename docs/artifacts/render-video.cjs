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
</style></head><body>
<div class="stage">
${captioned ? `  <div class="cap"><h1>${TITLE}</h1><p>${DESCRIPTION}</p></div>` : ''}
${hero}
</div>
</body></html>`;
}

/* Frames are grabbed on a wall-clock schedule rather than with Playwright's own
   recordVideo. That recording is variable-frame-rate, and converting it gave a
   ~1s file out of a 17.6s capture: the container's timing is not something to
   build on. Screenshotting to a fixed cadence, and *waiting until* each frame's
   scheduled moment, keeps the video's clock equal to the animation's. */
const FPS = 15;   // the hero holds each state for seconds; 15 is ample and keeps
                  // the grab (~40ms at 720p) comfortably inside the interval

async function record({ captioned, outFile, seconds, width, height }) {
  const { chromium } = require(path.join(REPO, 'integrations/chrome/node_modules/@playwright/test'));
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'oc-video-'));
  const stage = path.join(tmp, 'stage.html');
  const frames = path.join(tmp, 'frames');
  fs.mkdirSync(frames);
  fs.writeFileSync(stage, stageHtml({ captioned }));

  const browser = await chromium.launch();
  const ctx = await browser.newContext({
    viewport: { width, height },
    deviceScaleFactor: 1,
    // The hero deliberately still plays under reduced motion, but pin the
    // preference so a capture never depends on the renderer's default.
    reducedMotion: 'no-preference',
  });
  const page = await ctx.newPage();
  await page.goto('file://' + stage);
  await page.waitForTimeout(500);           // let the fonts settle before the loop starts

  /* Capture through the DevTools protocol rather than page.screenshot().
     Playwright's screenshot waits for the page to go "stable", and this page
     never does: a setTimeout loop is mutating the DOM the whole time, so every
     grab hit its timeout. Page.captureScreenshot just returns the frame. */
  const cdp = await ctx.newCDPSession(page);
  const total = Math.round(seconds * FPS);
  const t0 = Date.now();
  let late = 0;
  for (let i = 0; i < total; i++) {
    const due = t0 + (i * 1000) / FPS;
    const now = Date.now();
    if (now < due) await page.waitForTimeout(due - now); else if (i) late++;
    const { data } = await cdp.send('Page.captureScreenshot', { format: 'png' });
    fs.writeFileSync(path.join(frames, String(i).padStart(5, '0') + '.png'), Buffer.from(data, 'base64'));
  }
  await browser.close();
  if (late > total * 0.1) {
    console.warn(`[video] warning: ${late}/${total} frames were grabbed late; the clip may run fast`);
  }

  fs.mkdirSync(path.dirname(outFile), { recursive: true });
  // yuv420p + even dimensions + faststart: what social platforms actually accept.
  execFileSync('ffmpeg', [
    '-y', '-loglevel', 'error',
    '-framerate', String(FPS),
    '-i', path.join(frames, '%05d.png'),
    '-r', '30',                       // 30fps output, frames duplicated evenly
    '-vf', 'scale=' + width + ':' + height + ':flags=lanczos,format=yuv420p',
    '-c:v', 'libx264', '-preset', 'slow', '-crf', '20',
    '-movflags', '+faststart',
    '-an',
    outFile,
  ], { stdio: 'inherit' });

  fs.rmSync(tmp, { recursive: true, force: true });
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
