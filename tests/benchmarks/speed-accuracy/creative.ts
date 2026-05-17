/**
 * Creative-task A/B: same prompt, both providers, full output captured
 * for human judgment. No accept(), no pass/fail — the eye scores it.
 */

import * as fs from 'fs';
import * as groq from '../transform-blank/groq-impl';
import * as gemini from '../transform-blank/gemini';

interface Prompt { id: string; system: string; user: string; maxTokens: number; }

const PROMPTS: Prompt[] = [
  {
    id: 'poem-autumn',
    system: 'You are a poet. Output ONLY the poem text. No commentary, no title unless integral.',
    user: 'Write a short poem (8-12 lines) about the first morning of autumn after a hot summer. Use concrete imagery; avoid clichés like "leaves falling" and "crisp air".',
    maxTokens: 400,
  },
  {
    id: 'email-resignation',
    system: 'You write professional emails. Output ONLY the email body (subject + body, no headers like "From:"). No commentary.',
    user: 'Draft a resignation email from a senior software engineer named Sam to their manager Priya, after 4 years at the company. Leaving for a startup. Warm but professional. 120-180 words.',
    maxTokens: 500,
  },
  {
    id: 'love-letter',
    system: 'You are a thoughtful letter writer. Output ONLY the letter. No commentary.',
    user: 'Write a love letter from a person who has known their partner for 12 years to mark their wedding anniversary. Specific to the relationship — reference something they\'ve survived together (a hard year, a move). Avoid romance-novel clichés. ~200 words.',
    maxTokens: 600,
  },
  {
    id: 'short-story-opener',
    system: 'You are a fiction writer. Output ONLY the prose. No title, no commentary.',
    user: 'Write the opening 150 words of a literary short story set in a small coastal town in winter. A woman returns home after twenty years. Show, don\'t tell. Strong first sentence.',
    maxTokens: 500,
  },
  {
    id: 'birthday-toast',
    system: 'You write speeches. Output ONLY the toast. No stage directions, no commentary.',
    user: 'Write a 4-paragraph birthday toast for a friend turning 40. Funny but tender, no clichés about getting old. Reference a specific shared memory (you invent the detail).',
    maxTokens: 500,
  },
];

async function runProvider(name: string, chat: typeof groq.chat, p: Prompt): Promise<{ text: string; latencyMs: number }> {
  const r = await chat(
    [{ role: 'system', content: p.system }, { role: 'user', content: p.user }],
    { temperature: 0.7, maxTokens: p.maxTokens },
  );
  return { text: r.text, latencyMs: r.latencyMs };
}

async function main() {
  const outPath = process.argv[2] ?? '/tmp/sa-creative.md';
  const lines: string[] = ['# Creative A/B — Groq gpt-oss-120b vs Gemini 3.1 Flash Lite\n'];
  lines.push(`Generated: ${new Date().toISOString()}\nTemperature: 0.7 (both)\n`);

  for (const p of PROMPTS) {
    console.log(`Running ${p.id}…`);
    const [g, ge] = await Promise.all([
      runProvider('groq', groq.chat, p),
      runProvider('gemini', gemini.chat, p),
    ]);

    lines.push(`\n---\n\n## ${p.id}\n`);
    lines.push(`**Prompt:** ${p.user}\n`);
    lines.push(`### Groq · gpt-oss-120b · ${g.latencyMs} ms\n\n\`\`\`\n${g.text.trim()}\n\`\`\`\n`);
    lines.push(`### Gemini · 3.1 Flash Lite (think:low) · ${ge.latencyMs} ms\n\n\`\`\`\n${ge.text.trim()}\n\`\`\`\n`);
  }

  fs.writeFileSync(outPath, lines.join('\n'));
  console.log(`Wrote ${outPath}`);
}

main().catch(e => { console.error(e); process.exit(1); });
