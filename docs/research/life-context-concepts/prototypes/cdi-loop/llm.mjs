// Minimal cerebras chat helper (OpenAI-compatible).
const KEY = process.env.CEREBRAS_API_KEY;
if (!KEY) { console.error('CEREBRAS_API_KEY not set'); process.exit(1); }

export async function chat(system, user, { model = 'gpt-oss-120b', temperature = 0, reasoningEffort } = {}) {
  let lastErr;
  for (let attempt = 0; attempt < 4; attempt++) {
    if (attempt) await new Promise(r => setTimeout(r, 2000 * attempt));
    try {
      const res = await fetch('https://api.cerebras.ai/v1/chat/completions', {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${KEY}` },
        body: JSON.stringify({
          model, temperature, seed: 7,
          max_completion_tokens: Number(process.env.CDI_MAX_TOKENS ?? 20000),
          ...(reasoningEffort && { reasoning_effort: reasoningEffort }),
          messages: [
            { role: 'system', content: system },
            { role: 'user', content: user },
          ],
        }),
      });
      if (!res.ok) throw new Error(`LLM ${res.status}: ${await res.text()}`);
      const j = await res.json();
      const content = j.choices[0].message.content;
      if (content == null) throw new Error(`empty content (finish_reason=${j.choices[0].finish_reason})`);
      return content.trim();
    } catch (e) { lastErr = e; }
  }
  throw lastErr;
}

// Strip an optional ```json fence and parse.
export function parseJson(text) {
  const m = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  return JSON.parse(m ? m[1] : text);
}
