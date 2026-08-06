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
    out = body.replace(/(<div\s+)class="wrap"/, '$1class="oc-doc"') + '\n';
    if (!/class="oc-doc"/.test(out)) {
      console.warn('[build] warning: no <div class="wrap"> found — nothing was scoped to .oc-doc');
    }
  } else {
    // ── Artifact target (default) ──────────────────────────────────────────
    // A standalone, self-contained page: fonts base64-inlined (the artifact CSP
    // blocks font hosts, so linking one fails silently) + the full theme.
    const fontface = buildFontFace();
    const theme = fs.readFileSync(path.join(HERE, 'theme.css'), 'utf8');
    out =
      `<title>${title || 'OpenCues'}</title>\n` +
      `<style>\n/* OpenCues artifact theme — fonts inlined + theme.css */\n${fontface}\n${theme}</style>\n` +
      body + '\n';
  }
  fs.writeFileSync(outPath, out);
  console.log(`[build] wrote ${outPath} (${(out.length / 1024).toFixed(0)} KB, target: ${site ? 'site fragment' : 'artifact'})`);
}
main();
