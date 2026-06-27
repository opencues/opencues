// Local harness for the OpenCues image-gen integration prototype.
// - serves index.html (a contenteditable "input box")
// - POST /generate proxies to fal.ai so the FAL_KEY never reaches the browser
//
// Run:  source ~/.bashrc && node research/image-gen-demo/server.mjs
// Open: http://localhost:8788
//
// This is a RESEARCH HARNESS on the research/image-generation-notes branch.
// It mirrors the real integration's hard path (async generate -> insert into a
// rich input) without touching any host adapter, so we can observe side effects.

import http from 'node:http';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PORT = process.env.PORT || 8788;
const FAL_KEY = process.env.FAL_KEY;

const MODELS = {
  'flux/schnell': { id: 'fal-ai/flux/schnell', steps: 4 },
  'flux/dev':     { id: 'fal-ai/flux/dev',     steps: 28 },
  'fast-sdxl':    { id: 'fal-ai/fast-sdxl',    steps: 4 }, // intentionally available to SEE the bad output
};

function snap16(n) { return Math.max(16, Math.round(n / 16) * 16); }

async function generate({ prompt, width = 512, height = 512, model = 'flux/schnell', seed }) {
  if (!FAL_KEY) return { ok: false, status: 0, error: 'FAL_KEY not set in server env (source ~/.bashrc before launching)' };
  const m = MODELS[model] || MODELS['flux/schnell'];
  const body = {
    prompt,
    image_size: { width: snap16(width), height: snap16(height) },
    num_inference_steps: m.steps,
    format: 'png',
    sync_mode: true,
    seed: seed ?? Math.floor(Math.random() * 1e9),
  };
  const t0 = Date.now();
  let r, j;
  try {
    r = await fetch(`https://fal.run/${m.id}`, {
      method: 'POST',
      headers: { Authorization: `Key ${FAL_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    j = await r.json();
  } catch (e) {
    return { ok: false, status: -1, error: `network: ${e.message}`, ms: Date.now() - t0 };
  }
  const ms = Date.now() - t0;
  if (!r.ok) return { ok: false, status: r.status, error: (j?.detail || j?.error?.message || JSON.stringify(j)).slice(0, 200), ms };
  const im = j.images?.[0];
  if (!im?.url) return { ok: false, status: r.status, error: 'no image in response', ms };
  return { ok: true, dataUrl: im.url, width: im.width, height: im.height, ms, model: m.id, seed: body.seed };
}

const server = http.createServer(async (req, res) => {
  if (req.method === 'GET' && (req.url === '/' || req.url === '/index.html')) {
    const html = readFileSync(join(__dirname, 'index.html'), 'utf8');
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    return res.end(html);
  }
  if (req.method === 'POST' && req.url === '/generate') {
    let data = '';
    req.on('data', c => { data += c; if (data.length > 1e5) req.destroy(); });
    req.on('end', async () => {
      let payload = {};
      try { payload = JSON.parse(data || '{}'); } catch {}
      const result = await generate(payload);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(result));
    });
    return;
  }
  res.writeHead(404); res.end('not found');
});

server.listen(PORT, () => {
  console.log(`image-gen harness on http://localhost:${PORT}`);
  console.log(FAL_KEY ? 'FAL_KEY: present' : 'FAL_KEY: MISSING — run `source ~/.bashrc` first');
});
