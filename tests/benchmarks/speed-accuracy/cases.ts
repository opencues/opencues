/**
 * Speed-vs-accuracy benchmark cases — typical OpenCues surfaces with
 * BOTH short and long-form (~200+ word) context.
 *
 * Cells: {word-cue, fluid-blank, transform} × {short, long}, 3 cases each.
 *
 * Accept functions are deterministic regex/substring checks — NO LLM
 * judge — so pass-rate is reproducible run to run. Latency comes from
 * the chat clients' wall-clock measurements.
 */

export type Kind = 'word-cue' | 'fluid-blank' | 'transform';
export type Length = 'short' | 'long';

export interface Case {
  id: string;
  kind: Kind;
  length: Length;
  system: string;
  user: string;
  maxTokens: number;
  accept: (out: string) => boolean;
}

// ── Long-form passages (each 200-250 words) — reused across cells ──

const PASSAGE_INDUSTRIAL = `The Industrial Revolution did not arrive in England as a single sudden event but as a slow tide that pulled rural households out of their cottage workshops and into the factories springing up along the canal-fed river valleys. For more than a century before the first power loom clattered into operation, families across the Midlands had spun wool and woven cloth in their own homes, paid by piece-rates from middlemen who collected the finished bolts on horseback. The pattern fractured first along the Severn and the Trent, where coal was cheap and water was abundant, then spread outward as canal infrastructure caught up with demand. Women, who had managed the spinning while tending to children, were drawn first to the new mills; the children followed, then the men, and entire villages reformed themselves around the rhythm of factory bells. Public health collapsed in the rapidly thickening industrial towns. Sanitation lagged decades behind population growth, and cholera outbreaks in the 1830s and 1840s exposed the gap between civic ambition and engineering reality. Parliamentary committees of inquiry produced reams of evidence; reform came in fragments. The story is not one of progress alone, but of pressure: pressure on land, on lungs, on traditional patterns of work, and on a parliament slowly forced to legislate for conditions it had long preferred to ignore.`;

const PASSAGE_DATABASES = `Modern relational databases owe their dominance to a small set of design choices made in the early 1970s. Codd's original twelve rules, drafted at IBM's San Jose lab, separated the logical view of data from its physical storage in a way that proved unusually durable. The rules were never implemented strictly anywhere, but they fixed the vocabulary the industry would argue about for the next five decades. Joins, normal forms, and the relational algebra became the lingua franca of enterprise software. The hierarchical and network databases that preceded them were faster on the hardware of the day, but they exposed pointer chasing as the developer's problem rather than the engine's. Codd argued that querying should be declarative, that the user should describe what they wanted rather than how to retrieve it, and that an optimizer should bridge the gap. That bet paid off in stages: first as commercial relational systems matured through the 1980s, then as standardization around SQL collapsed a fractured market, and finally as the rise of the internet workload pushed query optimizers from clever to indispensable. Critics insisted for years that relational engines could not scale, and for some workloads they were right, but the model itself proved adaptable. Even today, after a decade of nosql experimentation, most operational data still lives in tables that would be recognizable to Codd.`;

const PASSAGE_CLIMATE = `Climate models began as small fluid-dynamics experiments on room-sized mainframes, simulating a single column of atmosphere over a few hours of model time. The shift to global circulation models in the 1960s required engineers to discretize the entire Earth as a coarse grid of cells, each one a thermodynamic state vector that exchanged heat, moisture, and momentum with its neighbours every simulated minute. Resolution improved as computing power did, but the underlying equations stayed close to Navier-Stokes plus radiative transfer plus a long list of empirical parameterizations for processes the grid was too coarse to resolve directly. Clouds proved the most stubborn. A cumulus tower might be ten kilometres tall but only one kilometre wide; in a model with hundred-kilometre cells, the tower lives entirely inside the parameterization. Different research groups made different choices about how to represent that hidden physics, and those choices propagated forward into differences between projections, especially of regional rainfall. The Intergovernmental Panel on Climate Change addressed this by treating the spread of models as itself a quantity to be reported: not a single forecast, but an ensemble whose disagreement was part of the message. The strategy was honest, but it complicated communication for policymakers expecting a single number.`;

// ── word-cue prompts ──

const SYS_WORD_CUE_SHORT =
  'You produce word alternatives. Output ONLY index:alt1,alt2,alt3 format (e.g. 0:big,large,huge). No prose, no quotes.';

const SYS_WORD_CUE_LONG = (passage: string) =>
  `You produce word alternatives that fit the surrounding context. Given a passage and a target word, output ONLY the line "0:alt1,alt2,alt3" with three context-appropriate one-word alternatives. No prose.\n\nPassage:\n"""\n${passage}\n"""`;

const acceptThreeAlts = (out: string): boolean =>
  /0\s*:\s*\S+\s*,\s*\S+\s*,\s*\S+/i.test(out);

// ── fluid-blank prompts ──

const SYS_FLUID =
  'Answer the fill-in-the-blank with a single short answer (one word or short phrase). Output ONLY the answer. No prose, no punctuation, no quotes.';

const SYS_FLUID_LONG = (passage: string) =>
  `Answer the fill-in-the-blank using ONLY information from the passage. Output the single short answer (one word or short phrase). No prose, no quotes.\n\nPassage:\n"""\n${passage}\n"""`;

// ── transform prompts ──

const SYS_TRANSFORM_SHORT =
  'Apply the imperative edit and output ONLY the rewritten text. No prose, no quotes, no commentary.';

const SYS_TRANSFORM_LONG =
  'Apply the imperative edit faithfully to the passage. Output ONLY the rewritten passage. No prose, no quotes, no commentary, no headers.';

// ── cases ──

export const CASES: Case[] = [
  // word-cue × short
  {
    id: 'word-short-1',
    kind: 'word-cue', length: 'short',
    system: SYS_WORD_CUE_SHORT,
    user: '0=happy',
    maxTokens: 120,
    accept: acceptThreeAlts,
  },
  {
    id: 'word-short-2',
    kind: 'word-cue', length: 'short',
    system: SYS_WORD_CUE_SHORT,
    user: '0=quick',
    maxTokens: 120,
    accept: acceptThreeAlts,
  },
  {
    id: 'word-short-3',
    kind: 'word-cue', length: 'short',
    system: SYS_WORD_CUE_SHORT,
    user: '0=meeting',
    maxTokens: 120,
    accept: acceptThreeAlts,
  },

  // word-cue × long
  {
    id: 'word-long-1',
    kind: 'word-cue', length: 'long',
    system: SYS_WORD_CUE_LONG(PASSAGE_INDUSTRIAL),
    user: '0=fractured',
    maxTokens: 160,
    accept: acceptThreeAlts,
  },
  {
    id: 'word-long-2',
    kind: 'word-cue', length: 'long',
    system: SYS_WORD_CUE_LONG(PASSAGE_DATABASES),
    user: '0=dominance',
    maxTokens: 160,
    accept: acceptThreeAlts,
  },
  {
    id: 'word-long-3',
    kind: 'word-cue', length: 'long',
    system: SYS_WORD_CUE_LONG(PASSAGE_CLIMATE),
    user: '0=stubborn',
    maxTokens: 160,
    accept: acceptThreeAlts,
  },

  // fluid-blank × short
  {
    id: 'fluid-short-1',
    kind: 'fluid-blank', length: 'short',
    system: SYS_FLUID,
    user: 'The capital of France is _',
    maxTokens: 80,
    accept: (s) => /paris/i.test(s),
  },
  {
    id: 'fluid-short-2',
    kind: 'fluid-blank', length: 'short',
    system: SYS_FLUID,
    user: '100 degrees celsius is _ in fahrenheit',
    maxTokens: 80,
    accept: (s) => /\b212\b/.test(s),
  },
  {
    id: 'fluid-short-3',
    kind: 'fluid-blank', length: 'short',
    system: SYS_FLUID,
    user: 'The largest planet in the solar system is _',
    maxTokens: 80,
    accept: (s) => /jupiter/i.test(s),
  },

  // fluid-blank × long
  {
    id: 'fluid-long-1',
    kind: 'fluid-blank', length: 'long',
    system: SYS_FLUID_LONG(PASSAGE_INDUSTRIAL),
    user: 'Cholera outbreaks struck industrial towns in the _ and 1840s.',
    maxTokens: 120,
    accept: (s) => /1830s|1830/.test(s),
  },
  {
    id: 'fluid-long-2',
    kind: 'fluid-blank', length: 'long',
    system: SYS_FLUID_LONG(PASSAGE_DATABASES),
    user: "Codd drafted his twelve rules at IBM's _ lab.",
    maxTokens: 120,
    accept: (s) => /san\s*jose/i.test(s),
  },
  {
    id: 'fluid-long-3',
    kind: 'fluid-blank', length: 'long',
    system: SYS_FLUID_LONG(PASSAGE_CLIMATE),
    user: 'A cumulus tower might be _ kilometres tall.',
    maxTokens: 120,
    accept: (s) => /\bten\b|\b10\b/i.test(s),
  },

  // transform × short
  {
    id: 'trans-short-1',
    kind: 'transform', length: 'short',
    system: SYS_TRANSFORM_SHORT,
    user: 'Edit: change boy to girl.\nPassage: The boy ran fast.',
    maxTokens: 120,
    accept: (s) => /the\s+girl\s+ran\s+fast/i.test(s),
  },
  {
    id: 'trans-short-2',
    kind: 'transform', length: 'short',
    system: SYS_TRANSFORM_SHORT,
    user: 'Edit: rewrite in past tense.\nPassage: She walks home every evening.',
    maxTokens: 120,
    accept: (s) => /she\s+walked\s+home/i.test(s),
  },
  {
    id: 'trans-short-3',
    kind: 'transform', length: 'short',
    system: SYS_TRANSFORM_SHORT,
    user: 'Edit: remove all adjectives.\nPassage: The quick brown fox jumps.',
    maxTokens: 120,
    accept: (s) => /the\s+fox\s+jumps/i.test(s) && !/quick|brown/i.test(s),
  },

  // transform × long
  {
    id: 'trans-long-1',
    kind: 'transform', length: 'long',
    system: SYS_TRANSFORM_LONG,
    user: `Edit: replace every occurrence of "cottage" with "cabin" (preserve case).\nPassage:\n${PASSAGE_INDUSTRIAL}`,
    maxTokens: 700,
    accept: (s) => /\bcabin/i.test(s) && !/\bcottage/i.test(s),
  },
  {
    id: 'trans-long-2',
    kind: 'transform', length: 'long',
    system: SYS_TRANSFORM_LONG,
    user: `Edit: condense the passage to ONE sentence (max 40 words) that preserves the central claim.\nPassage:\n${PASSAGE_DATABASES}`,
    maxTokens: 200,
    accept: (s) => {
      const trimmed = s.trim();
      if (trimmed.length === 0 || trimmed.length > 400) return false;
      const words = trimmed.split(/\s+/).filter(Boolean).length;
      if (words > 60) return false;
      const sentences = trimmed.split(/[.!?]+/).filter(seg => seg.trim().length > 3).length;
      return sentences <= 2 && /codd|relational|database|sql/i.test(trimmed);
    },
  },
  {
    id: 'trans-long-3',
    kind: 'transform', length: 'long',
    system: SYS_TRANSFORM_LONG,
    user: `Edit: replace every occurrence of "climate models" / "climate model" with "weather simulators" / "weather simulator" (match case-insensitively).\nPassage:\n${PASSAGE_CLIMATE}`,
    maxTokens: 700,
    accept: (s) => /weather\s+simulator/i.test(s) && !/climate\s+model/i.test(s),
  },
];
