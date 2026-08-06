#!/usr/bin/env node
/* ============================================================================
   OpenCues Artifact — PDF renderer
   ----------------------------------------------------------------------------
   Produces a real PDF file rather than relying on window.print().

   Why not just print(): a published artifact runs inside a sandboxed iframe
   where print() is blocked, and on mobile browsers it is unreliable even
   outside one. A pre-rendered file downloads the same way everywhere.

   The dark ground survives because theme.css sets print-color-adjust:exact and
   an @page background; Chrome honours both when printing to PDF.

   USAGE
     node render-pdf.cjs <body.html> <out.pdf> "<title>"

   REQUIREMENTS
     Windows Chrome reachable from WSL (same one render-video.cjs uses).
   ============================================================================ */
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const HERE = __dirname;
const WIN_TMP = process.env.OC_WIN_TMP || '/mnt/c/Users/wilfred/AppData/Local/Temp/oc-render';
const WIN_CHROME = process.env.OC_WIN_CHROME || '/mnt/c/Program Files/Google/Chrome/Application/chrome.exe';

function toWin(p) {
  const m = p.match(/^\/mnt\/([a-z])\/(.*)$/);
  if (!m) throw new Error('not a /mnt/<drive> path: ' + p);
  return m[1].toUpperCase() + ':\\' + m[2].replace(/\//g, '\\');
}

function main() {
  const [bodyPath, outPath, title] = process.argv.slice(2);
  if (!bodyPath || !outPath) {
    console.error('usage: node render-pdf.cjs <body.html> <out.pdf> "<title>"');
    process.exit(1);
  }
  const dir = path.join(WIN_TMP, 'pdf');
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(dir, { recursive: true });

  // Print the ARTIFACT build: self-contained, fonts inlined, no site shell.
  const page = path.join(dir, 'page.html');
  execFileSync('node', [path.join(HERE, 'build.cjs'), bodyPath, page, title || 'OpenCues'], { stdio: 'inherit' });

  const winPdf = path.join(dir, 'out.pdf');
  execFileSync(WIN_CHROME, [
    '--headless=new', '--disable-gpu',
    '--no-pdf-header-footer',                 // no "about:blank / 1/3" furniture
    // The hero is an animation, and at t=0 it is an empty box with a caret.
    // Chrome's own virtual clock runs it on before printing so the page shows
    // a filled, meaningful state (volume read, note and hint visible).
    '--virtual-time-budget=5000',
    `--print-to-pdf=${toWin(winPdf)}`,
    'file:///' + toWin(page).replace(/\\/g, '/'),
  ], { stdio: ['ignore', 'ignore', 'ignore'] });

  if (!fs.existsSync(winPdf)) throw new Error('chrome produced no PDF');
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.copyFileSync(winPdf, outPath);
  fs.rmSync(dir, { recursive: true, force: true });
  console.log(`[pdf] wrote ${outPath} (${(fs.statSync(outPath).size / 1024).toFixed(0)} KB)`);
}

if (require.main === module) main();
