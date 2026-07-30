// Minimal cerebras chat helper (OpenAI-compatible).
const KEY = process.env.CEREBRAS_API_KEY;
if (!KEY) { console.error('CEREBRAS_API_KEY not set'); process.exit(1); }

export async function chat(system, user, { model = 'gpt-oss-120b', temperature = 0 } = {}) {
  const res = await fetch('https://api.cerebras.ai/v1/chat/completions', {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${KEY}` },
    body: JSON.stringify({
      model, temperature, seed: 7,
      messages: [
        { role: 'system', content: system },
        { role: 'user', content: user },
      ],
    }),
  });
  if (!res.ok) throw new Error(`LLM ${res.status}: ${await res.text()}`);
  const j = await res.json();
  return j.choices[0].message.content.trim();
}

// Strip an optional ```json fence and parse.
export function parseJson(text) {
  const m = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  return JSON.parse(m ? m[1] : text);
}
