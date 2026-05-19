/**
 * next-prompt-cues bench — starter cases.
 *
 * Each case: a user-typed prompt. The model returns `{answer, cues}`
 * where `cues` is a list of likely NEXT prompts the user might ask
 * to advance the conversation. No expected-cue ground truth — the
 * judge scores cues on relevance / distinctness / advancing-shape.
 *
 * Categories pin different prediction shapes:
 *   knowledge — flat factual; cues should drill deeper or pivot
 *   how-to    — procedural; cues should advance steps, troubleshoot, or contrast
 *   debug     — failure-shaped; cues should propose hypotheses or workarounds
 *   compare   — A vs B; cues should suggest other comparisons or trade-offs
 *   creative  — open-ended; cues should propose variants, constraints, refinements
 *   code-spec — implementation ask; cues should suggest edge cases or follow-ups
 */

export interface NextPromptCase {
  readonly id: string;
  readonly category: 'knowledge' | 'how-to' | 'debug' | 'compare' | 'creative' | 'code-spec';
  readonly prompt: string;
}

export const CASES: readonly NextPromptCase[] = [
  // Knowledge
  { id: 'k-paris', category: 'knowledge', prompt: 'What is the capital of France?' },
  { id: 'k-rust', category: 'knowledge', prompt: 'What is Rust?' },
  { id: 'k-tcp-vs-udp', category: 'knowledge', prompt: 'What is TCP?' },

  // How-to
  { id: 'h-debounce-js', category: 'how-to', prompt: 'How do I debounce a function in JavaScript?' },
  { id: 'h-sql-join', category: 'how-to', prompt: 'How do I do an INNER JOIN in PostgreSQL?' },
  { id: 'h-dotfiles', category: 'how-to', prompt: 'How do I set up dotfiles on a new machine?' },

  // Debug
  { id: 'd-cors', category: 'debug', prompt: 'My fetch request is getting a CORS error. Why?' },
  { id: 'd-segfault', category: 'debug', prompt: 'My C program is segfaulting on free(). What could it be?' },
  { id: 'd-python-import', category: 'debug', prompt: 'I get "ModuleNotFoundError" for a package I just installed with pip.' },

  // Compare
  { id: 'c-react-vue', category: 'compare', prompt: 'React vs Vue — which should I pick for a new project?' },
  { id: 'c-tcp-udp', category: 'compare', prompt: 'When should I use UDP instead of TCP?' },

  // Creative
  { id: 'cr-bedtime', category: 'creative', prompt: 'Write a 3-sentence bedtime story about a fox.' },
  { id: 'cr-slogan', category: 'creative', prompt: 'Give me a slogan for a coffee shop called Wholebean.' },

  // Code-spec
  { id: 'cs-fizzbuzz-py', category: 'code-spec', prompt: 'Write fizzbuzz in Python.' },
  { id: 'cs-binary-tree', category: 'code-spec', prompt: 'Implement a binary search tree insert in TypeScript.' },
];
