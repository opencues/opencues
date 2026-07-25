// App-aware output steering smoke — proves the NATIVE `app` ambient field
// reshapes the fluid-blank answer (File Explorer search box → a file-search
// -valid token instead of a prose answer). The standard fused-bench has no
// `app` cases (its renderAmbientMinimal predates the field), so this smoke
// drives the PRODUCTION renderAmbientBlock + FUSED_SYSTEM_PROMPT directly.
//
//   OPENCUES_BENCH_PROVIDER=cerebras-gpt-oss \
//     npx tsx tests/benchmarks/fluid-blank-ambient/app-steer-smoke.ts
//
// Not a pass/fail gate (output shape is model-dependent) — it prints the
// answer WITH vs WITHOUT the app context so a human can eyeball that the
// app field is actually steering. Pair it with the fused-bench (system-
// prompt regression) for the full picture.
import { FUSED_SYSTEM_PROMPT, renderAmbientBlock } from '../../../packages/opencues-core/src/sources/fluid-blank-source';
import { chat, sysUser, MODEL } from '../fluid-blank/groq';

interface Case { id: string; input: string; withApp: Parameters<typeof renderAmbientBlock>[0]; }

// Each case runs twice: once with the app/window context, once with the
// same field metadata but NO app — so the delta is attributable to `app`.
const CASES: Case[] = [
  {
    id: 'explorer-tax-pdfs',
    input: 'my tax pdfs _',
    withApp: { label: 'Search Box', pageTitle: 'Documents - File Explorer', app: 'explorer' },
  },
  {
    id: 'explorer-downloads-folder',
    input: 'the downloads folder _',
    withApp: { label: 'Search Box', pageTitle: 'This PC - File Explorer', app: 'explorer' },
  },
  {
    id: 'explorer-photos-2023',
    input: 'photos from 2023 _',
    withApp: { label: 'Search Box', pageTitle: 'Pictures - File Explorer', app: 'explorer' },
  },
];

function answerOf(text: string): string {
  const m = text.match(/^ANSWER:\s*([\s\S]*?)\s*$/im);
  return (m ? m[1] : text).trim();
}

async function ask(input: string, ambient: Parameters<typeof renderAmbientBlock>[0]): Promise<string> {
  const userMsg = `INPUT: ${input}${renderAmbientBlock(ambient)}`;
  const r = await chat(sysUser(FUSED_SYSTEM_PROMPT, userMsg), { maxTokens: 256, temperature: 0, seed: 42 });
  return answerOf(r.text);
}

async function main(): Promise<void> {
  console.log(`App-steer smoke — model: ${MODEL}\n`);
  for (const c of CASES) {
    const noApp = { ...c.withApp, app: undefined };
    const [withApp, without] = await Promise.all([ask(c.input, c.withApp), ask(c.input, noApp)]);
    console.log(`■ ${c.id}   input: "${c.input}"`);
    console.log(`   with app=explorer : ${JSON.stringify(withApp)}`);
    console.log(`   without app       : ${JSON.stringify(without)}`);
    console.log(`   steered?          : ${withApp !== without ? 'YES (differs)' : 'no change'}\n`);
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
