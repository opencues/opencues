#!/usr/bin/env node
/* ============================================================================
   OpenCues Artifact — build script
   ----------------------------------------------------------------------------
   Assembles a self-contained, publishable artifact HTML from three parts:
       <title> + <style>( @font-face + theme.css ) + <body content>

   The fonts are INLINED as base64 data URIs because the artifact CSP blocks
   external font hosts. This script (re)generates that @font-face block from the
   OpenCues website's font files, so the output renders standalone with no
   network access.

   USAGE:
     node build.cjs <body.html> <out.html> "<title>"

     <body.html>  the page CONTENT only — start with <div class="wrap"> … </div>.
                  Do NOT include <!doctype>/<html>/<head>/<body> (the artifact
                  host wraps the file) and do NOT include <style> (this adds it).
     <out.html>   where to write the finished file (publish this with Artifact).
     "<title>"    the <title> text.

   The @font-face block is cached to  ./oc-fontface.css  so a rebuild works even
   if the website repo isn't present. Delete that file to force regeneration.
   ============================================================================ */
const fs = require('fs');
const path = require('path');
const HERE = __dirname;

// Where the OpenCues website (and its fonts) live. Override with OC_WEBSITE.
const WEBSITE = process.env.OC_WEBSITE || path.join(process.env.HOME || '', 'opencues-website');
const FONTS = [
  { fam: 'TWK Lausanne',     weight: 300, file: 'TWKLausanne-300.woff2', fmt: 'woff2',    mime: 'font/woff2' },
  { fam: 'TWK Lausanne 200', weight: 200, file: 'TWKLausanne-200.woff2', fmt: 'woff2',    mime: 'font/woff2' },
  { fam: 'Ufficio Mono',     weight: 300, file: 'UfficioMono-300.otf',   fmt: 'opentype', mime: 'font/otf'   },
];

function buildFontFace() {
  const cache = path.join(HERE, 'oc-fontface.css');
  const dir = path.join(WEBSITE, 'fonts');
  if (FONTS.every(f => fs.existsSync(path.join(dir, f.file)))) {
    const css = FONTS.map(f => {
      const b64 = fs.readFileSync(path.join(dir, f.file)).toString('base64');
      return `  @font-face{font-family:"${f.fam}";font-weight:${f.weight};font-style:normal;font-display:swap;src:url(data:${f.mime};base64,${b64}) format("${f.fmt}")}`;
    }).join('\n');
    fs.writeFileSync(cache, css);
    return css;
  }
  if (fs.existsSync(cache)) {
    console.warn('[build] website fonts not found at ' + dir + ' — using cached oc-fontface.css');
    return fs.readFileSync(cache, 'utf8');
  }
  throw new Error('No fonts at ' + dir + ' and no cached oc-fontface.css. Set OC_WEBSITE or restore the cache.');
}

/* Group each `h2` and everything under it into a <section class="sec">, for
   BOTH targets, so print rules have something to hold on to. Done at build
   time rather than in the source: authors shouldn't have to remember a wrapper,
   and the two targets must not diverge on it. Content before the first h2 (the
   title block, actions, hero) and the trailing .foot stay outside. */
function wrapSections(body) {
  const lines = body.split('\n');
  const out = [];
  let open = false;
  const closeIfOpen = () => { if (open) { out.push('  </section>'); open = false; } };
  for (const line of lines) {
    if (/^\s*<h2[\s>]/.test(line)) {
      closeIfOpen();
      out.push('  <section class="sec">');
      open = true;
    } else if (/class="foot"/.test(line) || /^\s*<\/div>\s*$/.test(line) && open && lines.indexOf(line) === lines.length - 2) {
      closeIfOpen();
    }
    out.push(line);
  }
  closeIfOpen();
  return out.join('\n');
}

function main() {
  const argv = process.argv.slice(2);
  // --site emits a website FRAGMENT instead of a standalone artifact page.
  const site = argv.includes('--site');
  const [bodyPath, outPath, title] = argv.filter(a => a !== '--site');
  if (!bodyPath || !outPath) {
    console.error('usage: node build.cjs [--site] <body.html> <out.html> "<title>"');
    process.exit(1);
  }
  let body = fs.readFileSync(bodyPath, 'utf8').trim();

  // If the body contains a <!--HERO--> marker, splice in the hero animation
  // (hero.html) at that point. Otherwise the body is used verbatim.
  const heroPath = path.join(HERE, 'hero.html');
  if (body.includes('<!--HERO-->') && fs.existsSync(heroPath)) {
    body = body.replace('<!--HERO-->', fs.readFileSync(heroPath, 'utf8').trim());
  }

  // <!--SHADER-BORDER--> splices in the shader ring (shader-border.html) and
  // inlines its GLSL, which is vendored UNMODIFIED from ShaderShop under
  // shaders/. Inlined rather than fetched because the artifact CSP blocks
  // external requests and a file:// fetch fails too — same reason as the fonts.
  if (body.includes('<!--SHADER-BORDER-->')) {
    body = body.replace('<!--SHADER-BORDER-->', buildShaderBorder());
  }

  body = wrapSections(body);

  let out;
  if (site) {
    // ── Site target ────────────────────────────────────────────────────────
    // A fragment to drop into a page in the opencues-website repo. No fonts
    // (the site loads TWK Lausanne + Ufficio Mono already), no theme (the page
    // links `oc-doc.css`), no page shell (the site's .base-grid owns layout).
    // `.wrap` becomes `.oc-doc`, the scope every oc-doc.css rule hangs off.
    //
    // Paste the fragment INTO the page rather than loading it with
    // `data-include`: an include is injected with innerHTML, and innerHTML
    // never executes <script>, so a hero animation would silently not run.
    out = body.replace(/(<div\s+)class="wrap"/, '$1class="oc-doc"');
    if (!/class="oc-doc"/.test(out)) {
      console.warn('[build] warning: no <div class="wrap"> found, nothing was scoped to .oc-doc');
    }
    // Strip HTML comments. They are authoring notes for us (the kit's own
    // warnings, section markers); published page source shouldn't carry them.
    // Safe for the hero script, which comments with /* */ and // only.
    out = out.replace(/<!--[\s\S]*?-->/g, '')
             .replace(/^[ \t]*\n/gm, '')   // collapse the blank lines they leave
             + '\n';
  } else {
    // ── Artifact target (default) ──────────────────────────────────────────
    // A standalone, self-contained page: fonts base64-inlined (the artifact CSP
    // blocks font hosts, so linking one fails silently) + the full theme.
    // Videos are inlined for the standalone page: an artifact has no sibling
    // files to fetch, so a relative path would just 404. The site target leaves
    // the body's relative fallback alone and serves the files from video/.
    // The PDF renderer builds this page and then prints it OVER the very file
    // being inlined here, so each run embedded the previous PDF and the output
    // grew without bound (204 KB -> 564 -> 1045 -> 1687 in four runs). A printed
    // page cannot play a video or open a PDF anyway, so the print build carries
    // neither.
    const skipAssets = process.env.OC_SKIP_INLINE_ASSETS === '1';
    const vids = {};
    for (const [k, file] of [['raw', 'oc-hero-raw.mp4'], ['captioned', 'oc-hero-captioned.mp4']]) {
      const p = path.join(HERE, 'video', file);
      if (!skipAssets && fs.existsSync(p)) vids[k] = 'data:video/mp4;base64,' + fs.readFileSync(p).toString('base64');
    }
    const pdfFile = path.join(HERE, 'pdf', 'oc-actuator-states.pdf');
    const pdfUri = !skipAssets && fs.existsSync(pdfFile)
      ? 'data:application/pdf;base64,' + fs.readFileSync(pdfFile).toString('base64') : '';
    const videoScript =
      (Object.keys(vids).length ? `<script>window.__OC_VIDEO=${JSON.stringify(vids)};</script>\n` : '') +
      (pdfUri ? `<script>window.__OC_PDF=${JSON.stringify(pdfUri)};</script>\n` : '');
    const fontface = buildFontFace();
    const theme = fs.readFileSync(path.join(HERE, 'theme.css'), 'utf8');
    out =
      `<title>${title || 'OpenCues'}</title>\n` +
      `<style>\n/* OpenCues artifact theme — fonts inlined + theme.css */\n${fontface}\n${theme}</style>\n` +
      videoScript + body + '\n';
  }
  fs.writeFileSync(outPath, out);
  console.log(`[build] wrote ${outPath} (${(out.length / 1024).toFixed(0)} KB, target: ${site ? 'site fragment' : 'artifact'})`);
}
if (require.main === module) main();
/** The shader ring, with its GLSL inlined.
 *  Shared by the page build and render-video.cjs's stage, so the video can
 *  never run a different shader from the page it is a recording of. */
function buildShaderBorder() {
  /* Which vendored shader the ring runs. Swap the name (or set OC_SHADER) to
     change the effect; shaders/ holds each one unmodified from ShaderShop.
     A shader with baked-in parameters needs no uniform wiring — one with a
     -params.json needs its uniforms declared in shader-border.html, and
     getting a single name wrong fails the whole compile silently. */
  const shader = process.env.OC_SHADER || 'x-max-shubz';
  const ringPath = path.join(HERE, 'shader-border.html');
  const glslPath = path.join(HERE, 'shaders', shader + '.glsl');
  if (!fs.existsSync(ringPath) || !fs.existsSync(glslPath)) return '';
  const ring = fs.readFileSync(ringPath, 'utf8').trim();
  const glsl = fs.readFileSync(glslPath, 'utf8');
  /* ShaderShop's own source image, inlined. These shaders are image processors
     — they need a real image with structure, not a shape we painted. Inlined
     for the same reason as the fonts: the artifact CSP blocks external fetches
     and a file:// fetch fails too. */
  const imgPath = path.join(HERE, 'shaders', 'img', 'oc-logo-dark.png');
  const imgUri = fs.existsSync(imgPath)
    ? 'data:image/png;base64,' + fs.readFileSync(imgPath).toString('base64') : '';
  // The placeholder sits inside a JS string concatenation, so what replaces it
  // must be a string literal followed by the `+` that continues the chain.
  return ring
    .replace('/*__SHADER_FOXFIRE__*/', JSON.stringify(glsl) + ' +')
    .replace('/*__SHADER_IMAGE__*/', JSON.stringify(imgUri));
}

module.exports = { buildFontFace, buildShaderBorder };
