// Deterministic mock LLM for the extension E2E suite.
//
// Every OpenCues LLM call in chrome is a POST proxied through the
// service worker (`chrome.runtime.sendMessage({type:'opencues:fetch'})`
// → background.ts → fetch()). Because the request originates in the SW,
// NOT the page, we intercept with `context.route()` (which covers all
// contexts incl. the extension SW) on the provider host — never
// `page.route()`.
//
// Keep the selected provider OpenAI-shaped (groq / cerebras / openai /
// openrouter) so `parseOpenAIResponse` reads `choices[0].message.content`.
// The mock ignores the (dummy) Authorization header.

import type { BrowserContext } from '@playwright/test';

// Default endpoints of the OpenAI-shape providers (llm-provider.ts
// PROVIDERS[*].defaultEndpoint). We route the hosts, not full paths, so
// a bucket/endpoint override still matches as long as it stays on-host.
const PROVIDER_HOST_RE =
  /^https:\/\/api\.(groq\.com|cerebras\.ai|openai\.com|openrouter\.ai)\//;

export type MockReply = string | ((reqBody: OpenAiRequest) => string);

/** FluidBlankSource's fused output is {span, answer, mode} (see
 *  fluid-blank-source.ts parseFused / parseFusedJson). Groq + gpt-oss
 *  (the pinned provider/model) uses strict-JSON mode, so the response
 *  content must be a JSON object, not the `SPAN:`/`ANSWER:` text form.
 *  SPAN is the FULL contiguous substring of the input including `_`;
 *  MODE FILL keeps the surrounding words and fills the `_`, WIPE
 *  replaces the whole span. */
export function fluidBlankReply(
  span: string,
  answer: string,
  mode: 'FILL' | 'WIPE' = 'FILL',
): string {
  return JSON.stringify({ span, answer, mode });
}

interface OpenAiRequest {
  model?: string;
  messages?: Array<{ role: string; content: string }>;
}

/**
 * Register canned replies keyed by a regex matched against the combined
 * message content (system + user, which carries the user's buffer text
 * like "what is 2+2 _"). First matching rule wins; else the fallback.
 */
export class MockLlm {
  private rules: Array<{ match: RegExp; reply: MockReply }> = [];
  private fallback: MockReply = 'MOCKED';
  private calls: OpenAiRequest[] = [];

  reply(match: RegExp, reply: MockReply): this {
    this.rules.push({ match, reply });
    return this;
  }

  setFallback(reply: MockReply): this {
    this.fallback = reply;
    return this;
  }

  /** Every request the mock served, for asserting the LLM was actually hit. */
  get callCount(): number {
    return this.calls.length;
  }

  /** True if any served request's message content matched — e.g. a
   *  marker embedded in a specific source's prompt, to detect whether
   *  that source's LLM call fired at all. */
  sawContent(re: RegExp): boolean {
    return this.calls.some((c) => re.test((c.messages ?? []).map((m) => m.content).join('\n')));
  }

  async install(context: BrowserContext): Promise<void> {
    await context.route(PROVIDER_HOST_RE, async (route) => {
      let body: OpenAiRequest = {};
      try {
        body = JSON.parse(route.request().postData() ?? '{}');
      } catch {
        /* non-JSON body — leave empty */
      }
      this.calls.push(body);

      const content = (body.messages ?? [])
        .map((m) => m.content)
        .join('\n');

      let chosen: MockReply = this.fallback;
      for (const r of this.rules) {
        if (r.match.test(content)) {
          chosen = r.reply;
          break;
        }
      }
      const replyText = typeof chosen === 'function' ? chosen(body) : chosen;

      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ choices: [{ message: { content: replyText } }] }),
      });
    });
  }
}
