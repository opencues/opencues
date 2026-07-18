// Tests for `opencues calendar`. Hermetic — HOME is pointed at a temp dir
// BEFORE requiring the command (its module-scope FEEDS_PATH captures homedir at
// require time), and network is avoided with --no-verify / --no-fetch.

const { test, before, after, beforeEach } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

const realHome = process.env.HOME;
const realUserProfile = process.env.USERPROFILE;
const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'oc-calendar-test-'));
process.env.HOME = tmpHome;
process.env.USERPROFILE = tmpHome;

const calendar = require('./calendar.cjs');

after(() => {
  if (realHome === undefined) delete process.env.HOME; else process.env.HOME = realHome;
  if (realUserProfile === undefined) delete process.env.USERPROFILE; else process.env.USERPROFILE = realUserProfile;
  try { fs.rmSync(tmpHome, { recursive: true, force: true }); } catch {}
});

beforeEach(() => { try { fs.rmSync(path.join(tmpHome, '.cues'), { recursive: true, force: true }); } catch {} });

const feedsPath = () => path.join(tmpHome, '.cues', 'life-context-feeds.txt');
const feedsText = () => { try { return fs.readFileSync(feedsPath(), 'utf8'); } catch { return null; } };

async function run(argv) {
  const logs = [], errs = [];
  const oLog = console.log, oErr = console.error;
  const oW = process.stdout.write.bind(process.stdout);
  console.log = (...a) => logs.push(a.join(' '));
  console.error = (...a) => errs.push(a.join(' '));
  process.stdout.write = (s) => { logs.push(String(s)); return true; };
  let code;
  try { code = await calendar(argv); } finally { console.log = oLog; console.error = oErr; process.stdout.write = oW; }
  return { code: code ?? 0, out: logs.join('\n'), err: errs.join('\n') };
}

const URL_A = 'https://example.com/a.ics';
const URL_B = 'webcal://example.com/b.ics';

test('add --no-verify creates the file and appends the URL', async () => {
  const r = await run(['add', URL_A, '--no-verify']);
  assert.equal(r.code, 0);
  assert.ok(feedsText().includes(URL_A), 'url written');
  assert.ok(/added/.test(r.out));
});

test('add rejects a non-URL', async () => {
  const r = await run(['add', 'not-a-url']);
  assert.equal(r.code, 2);
  assert.equal(feedsText(), null, 'no file created on bad input');
});

test('add accepts webcal:// and is idempotent (dup guard)', async () => {
  await run(['add', URL_B, '--no-verify']);
  const r = await run(['add', URL_B, '--no-verify']);
  assert.equal(r.code, 0);
  assert.ok(/already added/.test(r.out));
  const count = feedsText().split('\n').filter(l => l.trim() === URL_B).length;
  assert.equal(count, 1, 'not duplicated');
});

test('list --json --no-fetch reports feeds without network', async () => {
  await run(['add', URL_A, '--no-verify']);
  await run(['add', URL_B, '--no-verify']);
  const r = await run(['list', '--json', '--no-fetch']);
  assert.equal(r.code, 0);
  const j = JSON.parse(r.out);
  assert.deepEqual(j.feeds, [URL_A, URL_B]);
  assert.equal(j.present, true);
});

test('remove by index drops the right feed', async () => {
  await run(['add', URL_A, '--no-verify']);
  await run(['add', URL_B, '--no-verify']);
  const r = await run(['remove', '1']);
  assert.equal(r.code, 0);
  const j = JSON.parse((await run(['list', '--json', '--no-fetch'])).out);
  assert.deepEqual(j.feeds, [URL_B]);
});

test('remove by URL, and a missing target errors', async () => {
  await run(['add', URL_A, '--no-verify']);
  const miss = await run(['remove', URL_B]);
  assert.equal(miss.code, 1);
  const hit = await run(['remove', URL_A]);
  assert.equal(hit.code, 0);
  const j = JSON.parse((await run(['list', '--json', '--no-fetch'])).out);
  assert.deepEqual(j.feeds, []);
});

test('comments in the file are ignored as feeds', async () => {
  fs.mkdirSync(path.join(tmpHome, '.cues'), { recursive: true });
  fs.writeFileSync(feedsPath(), `# a comment\n${URL_A}\n# another\n`);
  const j = JSON.parse((await run(['list', '--json', '--no-fetch'])).out);
  assert.deepEqual(j.feeds, [URL_A]);
});

test('refresh writes the trigger file when feeds exist', async () => {
  await run(['add', URL_A, '--no-verify']);
  const r = await run(['refresh']);
  assert.equal(r.code, 0);
  assert.ok(fs.existsSync(path.join(tmpHome, '.cues', '.life-context-refresh')), 'trigger written');
  assert.ok(/refresh requested/.test(r.out));
});

test('refresh is a no-op (no trigger) when there are no feeds', async () => {
  const r = await run(['refresh']);
  assert.equal(r.code, 0);
  assert.ok(!fs.existsSync(path.join(tmpHome, '.cues', '.life-context-refresh')), 'no trigger without feeds');
});

test('unknown subcommand exits 2', async () => {
  const r = await run(['frobnicate']);
  assert.equal(r.code, 2);
});
