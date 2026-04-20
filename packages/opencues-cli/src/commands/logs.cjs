// `opencues logs` — read or tail /tmp/opencues.log.

'use strict';

const fs = require('node:fs');
const { spawnSync, spawn } = require('node:child_process');

const LOG_PATH = '/tmp/opencues.log';

module.exports = function logs(argv) {
  if (argv.includes('--help') || argv.includes('-h')) return printHelp();
  const tail = argv.includes('--tail') || argv.includes('-f');
  const lines = parseInt(argvValue(argv, '--lines') || '50', 10);

  if (!fs.existsSync(LOG_PATH)) {
    console.error(`No log file at ${LOG_PATH}.`);
    console.error('It\'s created the first time the runtime emits a message during a session.');
    process.exit(1);
  }

  if (tail) {
    // Follow mode. Use `tail -f` (POSIX, present everywhere).
    const child = spawn('tail', ['-n', String(lines), '-f', LOG_PATH], { stdio: 'inherit' });
    process.on('SIGINT',  () => { child.kill('SIGINT');  process.exit(0); });
    process.on('SIGTERM', () => { child.kill('SIGTERM'); process.exit(0); });
    child.on('exit', code => process.exit(code ?? 0));
    return;
  }

  // One-shot last-N print.
  const r = spawnSync('tail', ['-n', String(lines), LOG_PATH], { stdio: 'inherit' });
  process.exit(r.status ?? 0);
};

function argvValue(argv, flag) {
  const i = argv.indexOf(flag);
  return i >= 0 ? argv[i + 1] : null;
}

function printHelp() {
  console.log('opencues logs [--tail] [--lines N]');
  console.log('');
  console.log(`Show ${LOG_PATH} contents. The runtime writes diagnostics here regardless`);
  console.log('of whether the host swallows stderr (CC\'s TUI does, OC\'s does too).');
  console.log('');
  console.log('  --tail        Follow mode (Ctrl+C to stop). Aliased as -f.');
  console.log('  --lines N     Show last N lines (default 50)');
  console.log('  --help        Show this message');
}
