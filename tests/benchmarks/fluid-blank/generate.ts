/**
 * Endless test-case generator for the fluid-blank benchmark.
 *
 * Two-stage LLM pipeline:
 *   Stage 1 — generate diverse lookup phrases (topic + syntactic-template
 *             diversity enforced; profession-flavored)
 *   Stage 2 — turn each lookup into a full FluidBlankCase JSON, with
 *             a randomly-rotated SHAPE (plain, ?, ..., what's, how,
 *             no-preamble) and a SPECIFIC profession context for the
 *             preamble (no generic "random chat" openers)
 *
 * Output: cases-generated.jsonl (one JSON per line, append-only).
 *
 * Run:  GROQ_API_KEY=... npx tsx tests/benchmarks/fluid-blank/generate.ts
 *       (Ctrl-C to stop. Output accumulates in cases-generated.jsonl.)
 *
 * Run benchmark on accumulated output at any time:
 *       npx tsx tests/benchmarks/fluid-blank/run.ts --generated --mode answer
 */

import * as fs from 'fs';
import * as path from 'path';
import { chat, sysUser } from './groq';
import { CASES, FluidBlankCase } from './cases';

const OUTPUT_FILE = path.join(__dirname, 'cases-generated.jsonl');
const TOPIC_BATCH_SIZE = 15;
const SLEEP_BETWEEN_BATCHES_MS = 2000;

// ─── SHAPE ROTATION ────────────────────────────────────────────────────
// Each case is randomly assigned a syntactic shape (with weights).
// Stage 2 prompt is conditioned on the chosen shape.

interface Shape {
  name: 'plain' | 'question' | 'ellipsis' | 'whats' | 'how' | 'no-preamble';
  description: string;
  weight: number;
}

const SHAPES: Shape[] = [
  { name: 'plain',       description: 'short profession-context preamble (5–12 words) then the lookup phrase then space-underscore. Example: "writing my paper capital of france _"',  weight: 4 },
  { name: 'question',    description: 'short profession-context preamble then the lookup phrase then question-mark space-underscore. Example: "kids homework capital of france? _"', weight: 2.5 },
  { name: 'ellipsis',    description: 'short profession-context preamble ending in "..." then the lookup phrase then space-underscore. Example: "thinking out loud... capital of france _"', weight: 1.5 },
  { name: 'whats',       description: 'short profession-context preamble then the literal word "what\'s" then the lookup then question-mark space-underscore. Example: "physics class what\'s the speed of light in m/s? _"', weight: 1.5 },
  { name: 'how',         description: 'short profession-context preamble then "how" + interrogative form of the lookup then question-mark space-underscore. Example: "language class how do you say hello in french? _"', weight: 1 },
  { name: 'no-preamble', description: 'JUST the lookup phrase then space-underscore — NO preamble at all. Example: "capital of france _"', weight: 1.5 },
  { name: 'conversational', description: 'a MULTI-SENTENCE chat/text message addressed to someone (planning a meetup, asking about preferences, gossip, casual suggestion). The lookup phrase is GRAMMATICALLY EMBEDDED mid-message as the object of a verb or preposition — NOT just tacked on at the end. The lookup phrase MAY start with "what is", "where is", "name of", "who is", "when did", etc. The input ENDS with the lookup + space-underscore (system fires there); the user has not yet typed what comes after. Examples: "so when are you free tomorrow we can go to what is a club in central london _" / "trip planning email i need to suggest where is a hotel in midtown new york _" / "let me text the team back about who is the keynote speaker at black hat conference _"', weight: 2 },
];

function pickShape(): Shape {
  const total = SHAPES.reduce((s, x) => s + x.weight, 0);
  let r = Math.random() * total;
  for (const sh of SHAPES) {
    r -= sh.weight;
    if (r <= 0) return sh;
  }
  return SHAPES[0];
}

/**
 * Avoid shape-vs-lookup conflicts:
 *   - whats + lookup that starts with wh-word → produces "what's how many..."
 *   - how + lookup that starts with wh-word → produces "how do you what is..."
 * Falls back to 'question' shape (which works with any lookup).
 */
function adjustShape(shape: Shape, lookup: string): Shape {
  const lk = lookup.toLowerCase().trim();
  const startsWithWh = /^(what'?s?|how|where'?s?|who'?s?|when|name of)\b/.test(lk);
  if ((shape.name === 'whats' || shape.name === 'how') && startsWithWh) {
    return SHAPES.find(s => s.name === 'question') ?? SHAPES[0];
  }
  return shape;
}

// ─── STAGE 1 — TOPIC GENERATOR ─────────────────────────────────────────

const TOPIC_PROMPT = `You generate diverse lookup-phrase topics for a Google-search-style benchmark.

A "lookup phrase" is a TERSE query someone might type, with the answer at the end (replaced by _ at use time). Examples: "unicode for ampersand", "capital of france", "atomic mass of nitrogen", "year apollo 11 landed", "default port for postgres".

CRITICAL DIVERSITY RULES — read carefully:

1. Within a batch, USE EACH SYNTACTIC TEMPLATE ONLY ONCE. A batch of 15 phrases must have 15 DIFFERENT templates. Do NOT generate "gestation period of giraffe" AND "gestation period of platypus" in the same batch — pick a different template for the second one.

2. Cover at LEAST 8 distinct domains in each batch. Domains include: science (physics/chem/bio/astro), tech (unicode/colors/HTTP/ports/regex/HTML/MIME), history, geography, culture (languages/myth/religion/art/music/lit/film), sports, trades, cooking, animals/plants, medical/legal/finance/fashion.

3. Mix EASY and OBSCURE — about half should be common Google queries, the other half should be genuinely obscure trivia (Liechtenstein capital, atomic mass of nitrogen, M8 bolt torque, pilcrow unicode, Eswatini currency).

TEMPLATE LIBRARY — use a VARIED selection across the batch (one per template):

- "X of Y"                        e.g. capital of france, founder of microsoft
- "X for Y"                       e.g. hex for red, port for postgres
- "X in Y"                        e.g. hello in french, 5 miles in km
- "X to Y"                        e.g. celsius to fahrenheit
- "year [event] happened"         e.g. year apollo 11 landed on the moon
- "how many X in Y"               e.g. how many tablespoons in a cup
- "what's the X of Y"             e.g. what's the boiling point of mercury
- "name of [possessive] Y"        e.g. name of zeus's wife
- "inventor of X"                 e.g. inventor of penicillin
- "founder of X"                  e.g. founder of facebook
- "height of X in Y"              e.g. height of everest in feet
- "length of X"                   e.g. length of soccer field meters
- "number of X in Y"              e.g. number of bones in human hand
- "when was X invented"           e.g. when was photography invented
- "patron saint of X"             e.g. patron saint of travelers
- "lifespan of X in Y"            e.g. lifespan of goldfish in years
- "atomic mass / atomic number of X"  e.g. atomic number of nitrogen
- "ph of X"                       e.g. ph of stomach acid
- "escape sequence for X"         e.g. escape sequence for newline
- "regex for matching X"          e.g. regex for matching digit
- "mime type for X"               e.g. mime type for png
- "default port for X"            e.g. default port for redis
- "key signature with N sharps/flats"   e.g. key signature with 4 sharps
- "frequency of X in Y"           e.g. frequency of A4 in hz
- "ticker for X"                  e.g. ticker for tesla
- "currency code for X"           e.g. currency code for switzerland
- "country code for X"            e.g. country code for italy
- "subject of X"                  e.g. subject of bayeux tapestry
- "richter magnitude of X"        e.g. richter of sf 1906
- "torque spec for X"             e.g. torque for spark plug
- "wire gauge for X"              e.g. wire gauge for 20 amp circuit
- "color of the year [Y]"         e.g. pantone 2024
- "winner of [award] [year]"      e.g. best picture 2020
- "size of X in Y"                e.g. size of king bed in inches
- "month of X peak in Y"          e.g. cherry blossom peak in tokyo
- "first person to [verb]"        e.g. first person to climb everest
- "gestation period of X"         e.g. gestation period of elephants
- "[place type] in [location]"    e.g. club in central london, hotel in midtown new york, hike near san francisco, restaurant in soho, beach in goa
- "person at [event]"             e.g. keynote at black hat, host of snl, headliner at coachella

AVOID THESE AMBIGUOUS TEMPLATES — they have multiple defensible answers and create benchmark noise:

- "patron saint of X"             (varies by Catholic tradition — multiple saints claim each domain)
- "first person to X"             (depends on criteria — first attempt, first solo, first without oxygen, first verified)
- "X god of Y"                    (varies by mythology — Roman vs Greek vs Norse, multiple deities per domain)
- "torque spec for X bolt"        (depends on bolt grade — 8.8, 10.9, 12.9 etc give different specs)
- "frequency / wavelength of X waves/rays"  (broad ranges, not single values)
- "best/oldest/longest X cheese / X dish / X wine"   (multiple claimants)
- "name of [character]'s [relative]"   (varies by myth tradition or source)
- "subjective preferences"        (best, favorite, most popular, top X — opinion-based)
- "gestation period of X" without species specifier (varies)
- "lifespan of X" without species specifier (varies)
- "color of the year [future year]"   (model knowledge cutoff)
- "winner of [award] [recent year]"   (model knowledge cutoff)

PREFER topics with ONE canonical answer:
- atomic numbers / atomic mass (one element = one number)
- default ports for established services (one canonical)
- specific year events with verified dates
- capital of countries (unambiguous, internationally recognized)
- ISO currency / country codes (standardized)
- founders of well-defined companies
- specific named entities (Mona Lisa painter, Hamlet author)
- HTTP / MIME / unicode codes (standardized)

EXCLUDE list (already covered) — do NOT regenerate these:
<seen list>

Output exactly the requested number of lookup phrases, one per line. No numbering, no quotes, no explanation. Just the phrases.`;

// ─── STAGE 2 — CASE GENERATOR ─────────────────────────────────────────

const CASE_PROMPT = `You generate a single test case for the fluid-blank benchmark.

INPUT (provided by the user message):
- Lookup: the topic to ask about
- Shape: the syntactic shape the input MUST follow

OUTPUT: ONE-LINE JSON, no markdown fences:
{"input":"...","span":"...","question":"...","answer":"...","answerAlternates":[...]}

PREAMBLE RULES — most important:

The preamble must be 3–15 words of REALISTIC casual prose drawn from a SPECIFIC profession or activity context.

FORBIDDEN openers — never use these, they are too generic:
"random chat", "random fact", "random factoid", "just thinking", "just wondering", "just curious", "just browsing", "just checking", "thinking about", "wondering about"

REQUIRED — pick a SPECIFIC profession/activity context. Vary HEAVILY across calls. Do NOT default to "coding" — coding should appear AT MOST 1 time in 8 generations. Pick from this varied list (mix non-tech contexts heavily):

- writing (paper, blog post, novel, email, poem, screenplay, manual, ad copy)
- cooking (recipe testing, meal prep, baking, plating, menu planning)
- parenting (kids' homework, school pickup, bedtime stories, snack time)
- studying (high school class, college lecture, grad school exam prep)
- traveling (trip planning, packing, layover, vacation rental hunt)
- designing (mockup, moodboard, branding, logo, layout)
- training/exercising (gym session, marathon prep, coaching practice)
- shopping (grocery list, online checkout, gift hunt)
- creating (poetry workshop, music recording, painting commission)
- maintaining (DIY project, gardening, plumbing fix, electrical work)
- medical (rotation, patient intake, charting, prescription review)
- legal (drafting brief, court prep, contract review, motion to file)
- financial (audit, model, earnings call notes, tax filing)
- science (lab work, field research, paper writing, experiment setup)
- gaming (lore document, balancing pass, esports practice)
- driving (road trip, car maintenance, route planning)
- working (board meeting, deadline crunch, deck for presentation)
- coding (debugging, refactoring, code review, deployment, on-call) — USE SPARINGLY

For CONVERSATIONAL shape only: the preamble is a multi-sentence chat or text message addressed to someone — about plans, suggestions, gossip, asking for an opinion. Example: "so when are you free tomorrow we can go to what is a club in central london _"

OTHER RULES:

1. input MUST be EXACTLY in the requested SHAPE. The shape rule overrides everything else.
2. input MUST end with " _" (space underscore).
3. span MUST be an exact contiguous substring of input ending with " _".
4. For shape "no-preamble", input has NO words before the lookup phrase — just "[lookup] _".
5. answer must be TERSE — single value, word, code, name, or brief phrase. NEVER a full sentence.
6. include 2–4 answerAlternates with common formatting variations.
7. Use double-quoted JSON. Escape internal quotes/backslashes correctly.

EXAMPLES — note the SPECIFIC profession contexts and varied SHAPES:

Lookup: unicode for em dash | Shape: plain
{"input":"writing my novel chapter unicode for em dash _","span":"unicode for em dash _","question":"What is the Unicode codepoint for the em dash?","answer":"U+2014","answerAlternates":["2014","—","&mdash;"]}

Lookup: capital of france | Shape: question
{"input":"kids homework on europe capital of france? _","span":"capital of france? _","question":"What is the capital of France?","answer":"Paris","answerAlternates":[]}

Lookup: how many bones in adult human | Shape: ellipsis
{"input":"anatomy lab tomorrow morning... how many bones in adult human _","span":"how many bones in adult human _","question":"How many bones are in an adult human body?","answer":"206","answerAlternates":[]}

Lookup: boiling point of mercury celsius | Shape: whats
{"input":"chemistry lab notes what's the boiling point of mercury celsius? _","span":"what's the boiling point of mercury celsius? _","question":"What is the boiling point of mercury in Celsius?","answer":"357","answerAlternates":["356.7","356.73","~357"]}

Lookup: hello in spanish | Shape: how
{"input":"language class today how do you say hello in spanish? _","span":"how do you say hello in spanish? _","question":"How do you say hello in Spanish?","answer":"hola","answerAlternates":["Hola","¡hola!"]}

Lookup: founder of facebook | Shape: no-preamble
{"input":"founder of facebook _","span":"founder of facebook _","question":"Who founded Facebook?","answer":"Mark Zuckerberg","answerAlternates":["Zuckerberg"]}

Lookup: club in central london | Shape: conversational
{"input":"so when are you free tomorrow we can go to what is a club in central london _","span":"what is a club in central london _","question":"What is a good club in central London?","answer":"Fabric","answerAlternates":["Heaven","Ministry of Sound","XOYO","Printworks"]}

Lookup: hotel in midtown new york | Shape: conversational
{"input":"trip planning email i need to suggest where is a hotel in midtown new york _","span":"where is a hotel in midtown new york _","question":"What is a hotel in midtown New York?","answer":"The Knickerbocker","answerAlternates":["Park Hyatt New York","The Plaza","Marriott Marquis"]}

Lookup: keynote speaker at black hat | Shape: conversational
{"input":"team chat about the conference next month who is the keynote speaker at black hat _","span":"who is the keynote speaker at black hat _","question":"Who is the keynote speaker at Black Hat?","answer":"Jeff Moss","answerAlternates":["The Dark Tangent","Jeff \\"Dark Tangent\\" Moss"]}

Output JSON only. No prose before or after.`;

// ─── STATE TRACKING ────────────────────────────────────────────────────

const seenTopics = new Set<string>();
const recentTemplatePatterns: string[] = [];

function normaliseTopic(s: string): string {
  return s.replace(/_/g, '').replace(/\s+/g, ' ').trim().toLowerCase();
}

/**
 * Crude template classifier — extract the first 1-2 distinctive words
 * to detect "gestation period of X", "atomic number of X" etc. patterns.
 */
function classifyTemplate(phrase: string): string {
  const lower = phrase.toLowerCase();
  const patterns: Array<[RegExp, string]> = [
    [/^gestation period of/, 'gestation-of'],
    [/^lifespan of/, 'lifespan-of'],
    [/^atomic (number|mass) of/, 'atomic-of'],
    [/^ph of/, 'ph-of'],
    [/^boiling point of/, 'boiling-of'],
    [/^melting point of/, 'melting-of'],
    [/^molar mass of/, 'molar-of'],
    [/^capital of/, 'capital-of'],
    [/^currency code for/, 'currency-of'],
    [/^country code for/, 'country-code'],
    [/^default port for/, 'port-of'],
    [/^http status (code )?for/, 'http-of'],
    [/^mime type for/, 'mime-of'],
    [/^unicode for/, 'unicode-of'],
    [/^hex (code )?for/, 'hex-of'],
    [/^rgb( value)? for/, 'rgb-of'],
    [/^regex for/, 'regex-of'],
    [/^escape sequence for/, 'escape-of'],
    [/^year (the |of )/, 'year-of'],
    [/^when (was|did)/, 'when-of'],
    [/^how many/, 'how-many'],
    [/^how (long|tall|wide|big|deep)/, 'how-dim'],
    [/^founder of/, 'founder-of'],
    [/^inventor of/, 'inventor-of'],
    [/^creator of/, 'creator-of'],
    [/^director of/, 'director-of'],
    [/^author of/, 'author-of'],
    [/^painter of/, 'painter-of'],
    [/^name of/, 'name-of'],
    [/^number of/, 'number-of'],
    [/^height of/, 'height-of'],
    [/^length of/, 'length-of'],
    [/^width of/, 'width-of'],
    [/^depth of/, 'depth-of'],
    [/^size of/, 'size-of'],
    [/^weight of/, 'weight-of'],
    [/^speed of/, 'speed-of'],
    [/^wavelength of/, 'wavelength-of'],
    [/^frequency of/, 'frequency-of'],
    [/^key signature with/, 'key-sig'],
    [/^patron saint of/, 'patron-of'],
    [/^richter (magnitude|scale)/, 'richter-of'],
    [/^torque (spec )?for/, 'torque-of'],
    [/^wire gauge for/, 'wire-gauge'],
    [/^paint (code|finish)/, 'paint-of'],
    [/^color of the year/, 'pantone-of'],
    [/^winner of/, 'winner-of'],
    [/^subject of/, 'subject-of'],
    [/^month of/, 'month-of'],
    [/^first person to/, 'first-to'],
    [/^first to/, 'first-to'],
    [/^longest/, 'longest-of'],
    [/^shortest/, 'shortest-of'],
    [/^smallest/, 'smallest-of'],
    [/^largest/, 'largest-of'],
    [/^tallest/, 'tallest-of'],
    [/^fastest/, 'fastest-of'],
    [/^national (flower|bird|animal|currency)/, 'national-of'],
    [/^official language of/, 'official-lang'],
    [/^opposite of/, 'opposite-of'],
    [/^synonym for/, 'synonym-for'],
    [/^antonym for/, 'antonym-for'],
    [/^better word for/, 'better-word'],
    [/^plural of/, 'plural-of'],
    [/^abbreviation for/, 'abbrev-of'],
    [/^etymology of/, 'etymology-of'],
    [/^spelling of/, 'spelling-of'],
    [/^rhymes with/, 'rhymes-with'],
    [/in (french|spanish|german|italian|portuguese|japanese|chinese|arabic|russian|korean|hindi|swahili)$/, 'translation'],
  ];
  for (const [re, label] of patterns) {
    if (re.test(lower)) return label;
  }
  return 'other';
}

function loadSeen() {
  for (const c of CASES) {
    seenTopics.add(normaliseTopic(c.expected.span));
  }
  if (fs.existsSync(OUTPUT_FILE)) {
    const lines = fs.readFileSync(OUTPUT_FILE, 'utf8').trim().split('\n').filter(Boolean);
    for (const line of lines) {
      try {
        const c = JSON.parse(line);
        if (c?.expected?.span) seenTopics.add(normaliseTopic(c.expected.span));
      } catch {}
    }
    console.log(`Resumed: ${lines.length} previously generated cases in ${OUTPUT_FILE}`);
  }
  console.log(`Seeded with ${seenTopics.size} known topics.`);
}

async function generateTopics(n: number): Promise<string[]> {
  const seenSample = [...seenTopics].slice(-100).join('\n');
  const result = await chat(sysUser(TOPIC_PROMPT, `Generate ${n} NEW lookup phrases.\n\nEXCLUDE these (already covered):\n${seenSample}`), {
    maxTokens: 1500,
    temperature: 0.95,
    seed: Math.floor(Math.random() * 1_000_000),
  });
  return result.text
    .split('\n')
    .map(l => l.trim().replace(/^[-•*\d.)\s]+/, ''))
    .filter(l => l.length >= 4 && l.length <= 100 && !l.startsWith('#'));
}

async function generateCase(lookup: string, shape: Shape): Promise<FluidBlankCase | null> {
  const userMsg = `Lookup: ${lookup}\nShape: ${shape.name} — ${shape.description}\n\nGenerate the JSON.`;
  const result = await chat(sysUser(CASE_PROMPT, userMsg), {
    maxTokens: 400,
    temperature: 0.9,
    seed: Math.floor(Math.random() * 1_000_000),
  });

  const match = result.text.match(/\{[\s\S]*\}/);
  if (!match) return null;

  let obj: any;
  try {
    obj = JSON.parse(match[0]);
  } catch {
    return null;
  }

  if (typeof obj.input !== 'string' || typeof obj.span !== 'string') return null;
  if (typeof obj.question !== 'string' || typeof obj.answer !== 'string') return null;
  if (!obj.input.match(/_\s*$/)) return null;
  if (!obj.input.includes(obj.span)) return null;
  if (!obj.span.endsWith('_')) return null;
  if (obj.answer.length === 0 || obj.answer.length > 200) return null;

  // Validate forbidden generic openers
  const forbiddenOpeners = /^(random chat|random fact|random factoid|just (thinking|wondering|curious|browsing|checking)|thinking about|wondering about)/i;
  if (forbiddenOpeners.test(obj.input.trim())) {
    return null; // reject — generator fell into the rut
  }

  return {
    id: `gen-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    category: 'inline',
    input: obj.input,
    expected: {
      span: obj.span,
      question: obj.question,
      answer: obj.answer,
      answerAlternates: Array.isArray(obj.answerAlternates) ? obj.answerAlternates : [],
    },
  };
}

function appendCase(c: FluidBlankCase) {
  fs.appendFileSync(OUTPUT_FILE, JSON.stringify(c) + '\n');
}

async function sleep(ms: number) {
  return new Promise(r => setTimeout(r, ms));
}

async function main() {
  loadSeen();
  console.log(`Streaming new cases to ${OUTPUT_FILE} — Ctrl-C to stop.\n`);

  let totalGenerated = 0;
  let batch = 0;

  // Track template usage in recent batches to surface diversity
  const templateCounts = new Map<string, number>();
  const shapeCounts = new Map<string, number>();

  while (true) {
    batch++;
    process.stdout.write(`\nBatch ${batch}: requesting ${TOPIC_BATCH_SIZE} topics... `);
    let topics: string[] = [];
    try {
      topics = await generateTopics(TOPIC_BATCH_SIZE);
    } catch (e: any) {
      console.error(`FAILED (${e.message}); sleeping 10s`);
      await sleep(10_000);
      continue;
    }

    // Dedupe within batch by template (keep first instance per template)
    const seenTemplatesThisBatch = new Set<string>();
    const filteredTopics: string[] = [];
    for (const t of topics) {
      const tmpl = classifyTemplate(t);
      if (seenTemplatesThisBatch.has(tmpl)) continue;
      seenTemplatesThisBatch.add(tmpl);
      filteredTopics.push(t);
    }
    console.log(`got ${topics.length}, kept ${filteredTopics.length} after template-dedupe`);

    for (const topic of filteredTopics) {
      const norm = normaliseTopic(topic);
      if (seenTopics.has(norm)) {
        process.stdout.write(`  · skip dup: ${topic.slice(0, 50)}\n`);
        continue;
      }
      seenTopics.add(norm);
      const tmpl = classifyTemplate(topic);

      const shape = adjustShape(pickShape(), topic);
      try {
        const c = await generateCase(topic, shape);
        if (!c) {
          console.log(`  ✗ malformed/forbidden-opener: ${topic.slice(0, 50)} [${shape.name}]`);
          continue;
        }
        appendCase(c);
        totalGenerated++;
        templateCounts.set(tmpl, (templateCounts.get(tmpl) ?? 0) + 1);
        shapeCounts.set(shape.name, (shapeCounts.get(shape.name) ?? 0) + 1);
        const preview = c.input.length > 60 ? c.input.slice(0, 57) + '...' : c.input;
        console.log(`  \x1b[32m●\x1b[0m [${totalGenerated}] [${shape.name.padEnd(11)}] ${preview} → ${c.expected.answer.slice(0, 30)}`);
      } catch (e: any) {
        console.log(`  ✗ ERROR (${e.message}): ${topic.slice(0, 50)}`);
      }
    }

    // Periodic diversity report
    if (batch % 5 === 0) {
      console.log('\n  --- Diversity check ---');
      console.log('  Top templates:', [...templateCounts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 8).map(([k, v]) => `${k}:${v}`).join(', '));
      console.log('  Shapes:', [...shapeCounts.entries()].map(([k, v]) => `${k}:${v}`).join(', '));
    }

    await sleep(SLEEP_BETWEEN_BATCHES_MS);
  }
}

main().catch((e) => {
  console.error('FATAL:', e);
  process.exit(1);
});
