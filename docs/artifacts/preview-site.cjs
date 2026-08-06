#!/usr/bin/env node
/* ============================================================================
   OpenCues Artifact — site-target preview
   ----------------------------------------------------------------------------
   Builds a standalone, self-contained page that shows what the SITE target
   looks like, without needing the website checked out and served. Useful for
   review away from the machine (publish it as an artifact and open it on a
   phone).

   It is a preview, not the page: it takes the site fragment, the site's own
   :root variables, and oc-doc.css from the website repo, and inlines the fonts.
   It deliberately does NOT include the site's shell (menu, footer, sidebar) —
   only the content column, which is what oc-doc.css is responsible for.

   USAGE
     node preview-site.cjs <body.html> <out.html> "<title>"
   ============================================================================ */
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const { buildFontFace } = require('./build.cjs');

const HERE = __dirname;
const WEBSITE = process.env.OC_WEBSITE || path.join(process.env.HOME || '', 'opencues-website');

/** Pull the site's `:root{ … }` custom properties so the preview resolves the
 *  same variables oc-doc.css maps onto (--code-purple, --off-white, …). */
function siteRootVars() {
  const css = fs.readFileSync(path.join(WEBSITE, 'style.css'), 'utf8');
  const m = css.match(/:root\s*\{[\s\S]*?\}/);
  if (!m) throw new Error('no :root block found in the website style.css');
  return m[0];
}

function main() {
  const [bodyPath, outPath, title] = process.argv.slice(2);
  if (!bodyPath || !outPath) {
    console.error('usage: node preview-site.cjs <body.html> <out.html> "<title>"');
    process.exit(1);
  }
  const frag = path.join(require('os').tmpdir(), 'oc-preview-frag.html');
  execFileSync('node', [path.join(HERE, 'build.cjs'), '--site', bodyPath, frag], { stdio: 'inherit' });

  const out =
`<title>${title || 'OpenCues'}</title>
<style>
${buildFontFace()}
${siteRootVars()}
/* The site's own page ground + body defaults, the bits oc-doc.css inherits. */
html,body{margin:0;background:var(--bg-colour);color:var(--off-white);
  font-family:'TWK Lausanne',sans-serif;font-weight:300}
/* Global <table> rule from the site: oc-doc.css only overrides parts of it. */
table{border-collapse:collapse;width:100%;margin:2.2rem 0;font-size:1rem;line-height:1.7rem;color:var(--base-grey)}
/* Stand-in for .base-grid's content column, so measure matches the real page. */
.preview-col{max-width:56rem;margin:0 auto;padding:3rem 2.4rem 6rem}
${fs.readFileSync(path.join(WEBSITE, 'oc-doc.css'), 'utf8')}
</style>
<div class="preview-col">
${fs.readFileSync(frag, 'utf8')}
</div>
`;
  fs.writeFileSync(outPath, out);
  fs.rmSync(frag, { force: true });
  console.log(`[preview] wrote ${outPath} (${(out.length / 1024).toFixed(0)} KB, target: site preview)`);
}

if (require.main === module) main();
