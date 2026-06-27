// Local harness for the OpenCues image-gen integration prototype.
//   /            -> index.html (a contenteditable "input box")
//   /classify    -> language-invariant intent classifier (GENERATE | EDIT | CEDE) via a fast LLM
//   /generate    -> fal flux/schnell (image bytes inline, sync_mode)
//   /edit        -> fal flux-kontext/dev (image-to-image edit; server returns inline bytes)
//
// Run:  source ~/.bashrc && node research/image-gen-demo/server.mjs   (needs FAL_KEY + CEREBRAS_API_KEY)
// Open: http://localhost:8788
//
// Research harness on research/image-generation-notes — touches no host adapter.

import http from 'node:http';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PORT = process.env.PORT || 8788;
const FAL_KEY = process.env.FAL_KEY;
const CEREBRAS_KEY = process.env.CEREBRAS_API_KEY;

const GEN_MODEL = { 'flux/schnell': 'fal-ai/flux/schnell', 'flux/dev': 'fal-ai/flux/dev', 'fast-sdxl': 'fal-ai/fast-sdxl' };
const EDIT_MODEL = 'fal-ai/flux-kontext/dev';

function snap16(n) { return Math.max(16, Math.round(n / 16) * 16); }
function json(res, obj) { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(obj)); }
function readBody(req) {
  return new Promise((resolve) => {
    let d = ''; req.on('data', c => { d += c; if (d.length > 8e6) req.destroy(); });
    req.on('end', () => { try { resolve(JSON.parse(d || '{}')); } catch { resolve({}); } });
  });
}

// ---- language-invariant intent classifier (fast LLM) -----------------------
const CLASSIFY_SYSTEM = `You classify text a user typed into an image-capable input box. The text ended with "_" (an OpenCues blank trigger), already stripped.

Decide the intent:
- GENERATE: user wants to CREATE a new image. Put a concise image description in "prompt".
- EDIT: user wants to MODIFY an existing image. Put the change in "instruction". If they indicate WHICH image (an ordinal like "first/second/last", or a description like "the red one"), set "target" to that image's ordinal NUMBER; otherwise set "target" to null.
- CEDE: the text is not an image request.

You understand every language; classify by meaning, never by keywords. If there are no existing images, never choose EDIT.

Existing images (ordinal: label):
{IMAGES}

Respond with ONLY a JSON object, no prose:
{"verdict":"GENERATE|EDIT|CEDE","prompt":"","instruction":"","target":null}`;

async function classify({ text, images }) {
  if (!CEREBRAS_KEY) return { verdict: 'CEDE', error: 'CEREBRAS_API_KEY not set' };
  const list = (images && images.length) ? images.map(i => `${i.ordinal}: ${i.label}`).join('\n') : 'none';
  const sys = CLASSIFY_SYSTEM.replace('{IMAGES}', list);
  try {
    const r = await fetch('https://api.cerebras.ai/v1/chat/completions', {
      method: 'POST', headers: { Authorization: `Bearer ${CEREBRAS_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: 'gpt-oss-120b', temperature: 0, max_tokens: 300, reasoning_effort: 'low',
        messages: [{ role: 'system', content: sys }, { role: 'user', content: text }] }),
    });
    const j = await r.json();
    if (!r.ok) return { verdict: 'CEDE', error: `classify HTTP ${r.status}` };
    let txt = j.choices?.[0]?.message?.content || '';
    const m = txt.match(/\{[\s\S]*\}/); if (m) txt = m[0];
    const out = JSON.parse(txt);
    return { verdict: out.verdict || 'CEDE', prompt: out.prompt || '', instruction: out.instruction || '', target: out.target ?? null };
  } catch (e) { return { verdict: 'CEDE', error: 'classify: ' + e.message }; }
}

// ---- fal image calls -------------------------------------------------------
async function falGenerate({ prompt, size = 512, model = 'flux/schnell' }) {
  if (!FAL_KEY) return { ok: false, error: 'FAL_KEY not set' };
  const id = GEN_MODEL[model] || GEN_MODEL['flux/schnell'];
  const steps = model === 'flux/dev' ? 28 : 4;
  const t0 = Date.now();
  const r = await fetch(`https://fal.run/${id}`, { method: 'POST',
    headers: { Authorization: `Key ${FAL_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ prompt, image_size: { width: snap16(size), height: snap16(size) }, num_inference_steps: steps, format: 'png', sync_mode: true, seed: Math.floor(Math.random() * 1e9) }) });
  const j = await r.json(); const ms = Date.now() - t0;
  if (!r.ok) return { ok: false, status: r.status, error: (j.detail || j.error?.message || JSON.stringify(j)).slice(0, 180), ms };
  const im = j.images?.[0]; if (!im?.url) return { ok: false, error: 'no image', ms };
  return { ok: true, dataUrl: im.url, width: im.width, height: im.height, ms, seed: j.seed };
}

async function falEdit({ imageDataUrl, instruction }) {
  if (!FAL_KEY) return { ok: false, error: 'FAL_KEY not set' };
  const t0 = Date.now();
  const r = await fetch(`https://fal.run/${EDIT_MODEL}`, { method: 'POST',
    headers: { Authorization: `Key ${FAL_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ prompt: instruction, image_url: imageDataUrl, num_inference_steps: 12 }) });
  const j = await r.json(); const ms = Date.now() - t0;
  if (!r.ok) return { ok: false, status: r.status, error: (j.detail || j.error?.message || JSON.stringify(j)).slice(0, 180), ms };
  const im = j.images?.[0]; if (!im?.url) return { ok: false, error: 'no image', ms };
  // kontext returns a hosted URL; fetch it server-side and inline it (avoids browser CORS)
  let dataUrl = im.url;
  if (!dataUrl.startsWith('data:')) {
    try { const buf = Buffer.from(await (await fetch(im.url)).arrayBuffer()); dataUrl = `data:image/png;base64,${buf.toString('base64')}`; }
    catch (e) { return { ok: false, error: 'edit download: ' + e.message, ms }; }
  }
  return { ok: true, dataUrl, width: im.width, height: im.height, ms };
}

// ---- routes ----------------------------------------------------------------
const server = http.createServer(async (req, res) => {
  if (req.method === 'GET' && (req.url === '/' || req.url === '/index.html')) {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    return res.end(readFileSync(join(__dirname, 'index.html'), 'utf8'));
  }
  if (req.method === 'POST' && req.url === '/classify') return json(res, await classify(await readBody(req)));
  if (req.method === 'POST' && req.url === '/generate') return json(res, await falGenerate(await readBody(req)));
  if (req.method === 'POST' && req.url === '/edit')     return json(res, await falEdit(await readBody(req)));
  res.writeHead(404); res.end('not found');
});

server.listen(PORT, () => {
  console.log(`image-gen harness on http://localhost:${PORT}`);
  console.log(`FAL_KEY: ${FAL_KEY ? 'present' : 'MISSING'} | CEREBRAS_API_KEY: ${CEREBRAS_KEY ? 'present' : 'MISSING'}`);
});
