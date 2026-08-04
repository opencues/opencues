// `opencues usage` — aggregate LLM token usage + estimated cost across every
// running (and recently-run) host. Each host process writes a
// /tmp/opencues-usage-<pid>.json snapshot from the runtime's UsageMeter
// (fed by dispatchChat — every cue/blank LLM call funnels through it). This
// command merges those snapshots, prices them with @opencues/core's
// MODEL_PRICING, and prints per-model calls / tokens / cache-hit / cost + a
// total. It answers "what is OpenCues actually costing me, with all my features
// stacked?" — the number the per-feature estimates couldn't give.

'use strict';

const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { bold, dim, green, yellow, red, brightWhite, banner, rule, cliVersion, G } = require('../lib/style.cjs');

function printHelp() {
  console.log(`${bold('opencues usage')} — aggregate LLM token usage + estimated cost

Merges the per-host usage snapshots (/tmp/opencues-usage-*.json) that each
running OpenCues host writes, prices them, and prints the total.

  opencues usage            per-model calls / tokens / cache / cost + total
  opencues usage --json     machine-readable {rows, totalUSD, ...}
  opencues usage --reset    delete the snapshot files (start a fresh tally)

Notes:
  - Counts LLM calls made INSIDE host processes (cues + blanks). The
    session-contradiction PRODUCER runs out-of-process and isn't counted yet.
  - Prices: cerebras/gpt-oss-120b is confirmed; other providers use
    approximate rates (shown with ~). Unlisted models show tokens but no cost.`);
  return 0;
}

function loadCore(ctx) {
  const tries = [];
  if (ctx && ctx.REPO_ROOT) tries.push(path.join(ctx.REPO_ROOT, 'packages/opencues-core/dist/index.js'));
  tries.push('@opencues/core');
  for (const t of tries) { try { return require(t); } catch { /* next */ } }
  return null;
}

function readSnapshots(dir) {
  const snaps = [];
  let files;
  try { files = fs.readdirSync(dir); } catch { return snaps; }
  for (const f of files) {
    if (!/^opencues-usage-\d+\.json$/.test(f)) continue;
    try { snaps.push({ file: path.join(dir, f), ...JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')) }); }
    catch { /* skip corrupt/partial */ }
  }
  return snaps;
}

const fmtTok = (n) => (n >= 1_000_000 ? `${(n / 1_000_000).toFixed(2)}M` : n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n));
const fmtUSD = (n) => (n == null ? '—' : n < 0.01 ? `$${n.toFixed(4)}` : `$${n.toFixed(2)}`);
const pad = (s, n) => String(s).padEnd(n);
const padL = (s, n) => String(s).padStart(n);

module.exports = function usage(argv, ctx) {
  if (argv.includes('--help') || argv.includes('-h')) return printHelp();
  const json = argv.includes('--json');
  const dir = os.tmpdir();

  const snaps = readSnapshots(dir);

  if (argv.includes('--reset')) {
    let n = 0;
    for (const s of snaps) { try { fs.unlinkSync(s.file); n++; } catch { /* ignore */ } }
    if (!json) console.log(`${G.ringOn} cleared ${n} usage snapshot(s).`);
    else console.log(JSON.stringify({ ok: true, cleared: n }));
    return 0;
  }

  const core = loadCore(ctx);
  if (!core || typeof core.mergeSnapshots !== 'function' || typeof core.estimateCost !== 'function') {
    console.error('opencues usage: @opencues/core lacks the usage meter (run `pnpm build`).');
    return 1;
  }

  const rows = core.mergeSnapshots(snaps);
  const report = core.estimateCost(rows);

  if (json) {
    console.log(JSON.stringify({
      hosts: snaps.map((s) => ({ host: s.host, pid: s.pid, startedAt: s.startedAt, updatedAt: s.updatedAt })),
      rows: report.rows, totalUSD: report.totalUSD, hasUnpriced: report.hasUnpriced, hasApprox: report.hasApprox,
    }, null, 2));
    return 0;
  }

  console.log(banner('usage', `LLM tokens + estimated cost · ${cliVersion()}`));

  if (snaps.length === 0) {
    console.log(dim('  No usage snapshots found in ' + dir + '.'));
    console.log(dim('  Run a host (e.g. `opencues run claude-code`), use it, then re-run this.'));
    return 0;
  }

  // Which hosts contributed.
  const hostList = snaps.map((s) => `${s.host || '?'}·${s.pid}`).join('  ');
  console.log(dim(`  hosts: ${hostList}`));
  console.log('');

  if (report.rows.length === 0) {
    console.log(dim('  No LLM calls recorded yet.'));
    return 0;
  }

  // Table header.
  console.log('  ' + dim(pad('provider / model', 34) + padL('calls', 7) + padL('in', 9) + padL('cached', 8) + padL('out', 8) + padL('cost', 11)));
  console.log('  ' + dim(rule(76)));
  for (const r of report.rows) {
    const cachePct = r.promptTokens > 0 ? Math.round((r.cachedTokens / r.promptTokens) * 100) : 0;
    const approx = r.price && r.price.approx ? '~' : '';
    // Pad the PLAIN string, then colour — padding a string with ANSI escapes
    // counts the escape bytes and breaks alignment.
    const costPlain = r.costUSD == null ? 'unpriced' : `${approx}${fmtUSD(r.costUSD)}`;
    const costCell = padL(costPlain, 11);
    const costColored = r.costUSD == null ? dim(costCell) : costCell;
    const name = `${r.providerId}/${r.model}`;
    console.log('  ' + pad(name.length > 33 ? name.slice(0, 32) + '…' : name, 34)
      + padL(String(r.calls), 7)
      + padL(fmtTok(r.promptTokens), 9)
      + padL(cachePct ? `${cachePct}%` : '·', 8)
      + padL(fmtTok(r.completionTokens), 8)
      + costColored);
  }
  console.log('  ' + dim(rule(76)));

  // Total — right-align the plain cost across the numeric columns, then colour.
  const totalStr = fmtUSD(report.totalUSD);
  const suffix = [report.hasApprox && 'incl. ~approx rates', report.hasUnpriced && 'excl. unpriced models'].filter(Boolean).join(', ');
  const totalCostCell = padL(totalStr, 7 + 9 + 8 + 8 + 11);
  console.log('  ' + bold(pad('TOTAL (estimated)', 34)) + brightWhite(bold(totalCostCell)));
  if (suffix) console.log('  ' + dim(`  ${suffix}`));
  console.log('');
  console.log(dim('  Note: the session-contradiction producer runs out-of-process and is not yet counted.'));
  console.log(dim('  `opencues usage --reset` to start a fresh tally · `--json` for raw numbers.'));
  return 0;
};
