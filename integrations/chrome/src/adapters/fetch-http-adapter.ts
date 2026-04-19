import type { HttpAdapter } from '@opencues/core';

/**
 * Browser fetch()-based HTTP adapter for cues-core.
 * Replaces NodeHttpAdapter for Chrome extension use.
 */
export class FetchHttpAdapter implements HttpAdapter {
  async post(url: string, body: string, headers: Record<string, string>): Promise<string> {
    // Debug: log the prompt sent to LLM
    try {
      const parsed = JSON.parse(body);
      const content = parsed.messages?.[0]?.content || '';
      const lastLine = content.split('\n').filter((l: string) => l.trim()).pop() || '';
      console.log('[OpenCues] LLM prompt tail:', lastLine.slice(0, 200));
    } catch { /* ignore */ }

    const response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...headers },
      body,
    });
    if (!response.ok) {
      throw new Error(`HTTP ${response.status}: ${response.statusText}`);
    }
    const text = await response.text();

    // Debug: log the raw LLM response
    try {
      const data = JSON.parse(text);
      const raw = data.choices?.[0]?.message?.content || '';
      console.log('[OpenCues] LLM raw response:', raw);

      // Normalize space-separated INDEX:alts to pipe-separated
      // Some models return "1:a,b 2:c,d" instead of "1:a,b|2:c,d"
      // Insert | before space-separated INDEX: patterns so cues-core's parser handles them
      if (raw && /\d+\s*[:=]/.test(raw)) {
        const normalized = raw.replace(/\s+(\d+\s*[:=])/g, '|$1');
        if (normalized !== raw) {
          data.choices[0].message.content = normalized;
          return JSON.stringify(data);
        }
      }
    } catch { /* ignore */ }

    return text;
  }

  async get(url: string, headers?: Record<string, string>): Promise<string> {
    const response = await fetch(url, { headers });
    if (!response.ok) {
      throw new Error(`HTTP ${response.status}: ${response.statusText}`);
    }
    return response.text();
  }
}
