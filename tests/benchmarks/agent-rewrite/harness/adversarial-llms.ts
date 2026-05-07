/**
 * Adversarial mock LLMs. Each one simulates a specific class of LLM
 * misbehaviour we've seen in the wild (or that we want to defend
 * against). Reused across scenarios so the same misbehaviour can
 * stress different typing patterns.
 *
 * Add a new one whenever you spot a real-LLM pattern that breaks
 * expectations — the existing scenarios will start exercising it
 * automatically.
 */
import type { LlmMode } from './types';

/** Trims any trailing whitespace from the snapshot. */
export function adversarialTrimTrailingWS(): LlmMode {
  return { kind: 'mock', respond: (s) => s.replace(/\s+$/, '') };
}

/** Collapses every \n\n+ run into a single \n. */
export function adversarialCollapseParagraphs(): LlmMode {
  return { kind: 'mock', respond: (s) => s.replace(/\n{2,}/g, '\n') };
}

/** Removes all newlines (joins paragraphs). */
export function adversarialJoinAllParagraphs(): LlmMode {
  return { kind: 'mock', respond: (s) => s.replace(/\n+/g, ' ').trim() };
}

/** Adds period to any sentence-end fragment without one. */
export function adversarialTerminatorEager(): LlmMode {
  return {
    kind: 'mock',
    respond: (s) => s.replace(/(\S+)(\s*)$/, (_, last, ws) =>
      /[.!?]$/.test(last) ? `${last}${ws}` : `${last}.${ws}`,
    ),
  };
}

/** Replaces ALL whitespace runs with a single space. */
export function adversarialCanonicaliseWhitespace(): LlmMode {
  return { kind: 'mock', respond: (s) => s.replace(/\s+/g, ' ').trim() };
}

/** Emits an END marker mid-output + trailing junk. */
export function adversarialEndMarkerLeak(): LlmMode {
  return { kind: 'mock', respond: (s) => `${s}\nEND\nfooter junk\nMORE STUFF` };
}

/** Echoes the cursor sentinel back into output (parser must strip). */
export function adversarialEchoCursorSentinel(): LlmMode {
  return { kind: 'mock', respond: (s) => `[CURSOR]${s}[CURSOR]` };
}

/** Returns the snapshot verbatim — no edits. */
export function adversarialEcho(): LlmMode {
  return { kind: 'mock', respond: (s) => s };
}

/** Spelling-fixer that handles a small dictionary. */
export function spellingFix(): LlmMode {
  const dict: Record<string, string> = {
    rite: 'write', teh: 'the', recieve: 'receive', recieved: 'received',
    namee: 'name', namme: 'name', hii: 'Hi', wilfred: 'Wilfred',
    abotu: 'about', tommz: 'tomorrow', tomorow: 'tomorrow',
    youll: "you'll", dont: "don't", cant: "can't",
    boi: 'boy', dooing: 'doing',
  };
  return {
    kind: 'mock',
    respond: (s) => s.replace(/\b\w+\b/g, (w) => dict[w.toLowerCase()] ?? w),
  };
}

/** Adds a salutation comma after greetings. */
export function adversarialAddSalutationCommas(): LlmMode {
  return {
    kind: 'mock',
    respond: (s) => s.replace(/^(Hi|Hello|Hey|Dear|Greetings)(\s)([A-Z]\w+)/, '$1,$2$3'),
  };
}

/** Capitalises every sentence start and proper noun (heuristic). */
export function adversarialCapitalise(): LlmMode {
  return {
    kind: 'mock',
    respond: (s) => {
      let out = s.replace(/(^|[.!?]\s+|\n\n)([a-z])/g, (_, pre, ch) => pre + ch.toUpperCase());
      // Capitalise standalone "i".
      out = out.replace(/\bi\b/g, 'I');
      return out;
    },
  };
}

/** Drops a random word from the buffer (exercises hunk dedupe). */
export function adversarialDropWord(): LlmMode {
  return {
    kind: 'mock',
    respond: (s) => {
      const words = s.split(/(\s+)/);
      // Drop the first word.
      if (words.length > 2) return words.slice(2).join('');
      return s;
    },
  };
}

/** Adds extra blank lines (newline doubling). */
export function adversarialDoubleNewlines(): LlmMode {
  return { kind: 'mock', respond: (s) => s.replace(/\n/g, '\n\n') };
}

/** Replaces the buffer with a totally different document. */
export function adversarialFullReplace(text: string): LlmMode {
  return { kind: 'mock', respond: () => text };
}

/** Returns nothing (empty rewrite). */
export function adversarialEmpty(): LlmMode {
  return { kind: 'mock', respond: () => '' };
}

/** Returns just whitespace. */
export function adversarialJustWhitespace(): LlmMode {
  return { kind: 'mock', respond: () => '   \n\n   ' };
}

/** Truncates the rewrite at half the snapshot's length. */
export function adversarialTruncate(): LlmMode {
  return { kind: 'mock', respond: (s) => s.slice(0, Math.floor(s.length / 2)) };
}

/**
 * Two-state oscillating LLM: alternates between two responses on
 * consecutive ticks. Used to test no-flicker invariants.
 */
export function adversarialOscillate(stateA: string, stateB: string): LlmMode {
  return {
    kind: 'mock',
    respond: (_, __, idx) => idx % 2 === 0 ? stateA : stateB,
  };
}

/**
 * "Make formal" — adds commas after greetings, capitalises proper
 * nouns. Composite to test cross-cutting prompt-rule violations.
 */
export function adversarialMakeFormal(): LlmMode {
  return {
    kind: 'mock',
    respond: (s) => {
      let out = s;
      out = out.replace(/^(hi|hello|hey)(\s)/i, (_, w, sp) => `${w[0].toUpperCase()}${w.slice(1)},${sp}`);
      out = out.replace(/\bboy\b/g, 'Sir');
      out = out.replace(/\bguys\b/g, 'gentlemen');
      return out;
    },
  };
}

/**
 * English → German translator with a small dictionary. Preserves
 * whitespace structure (so paragraph breaks survive). Any word not
 * in the dictionary stays untouched — that's the realistic "model
 * misses some words on first pass" pattern.
 */
export function translateToGerman(): LlmMode {
  const dict: Record<string, string> = {
    // Greetings + polite
    hi: 'hallo', hello: 'hallo', hey: 'hallo',
    bye: 'tschüss', goodbye: 'auf wiedersehen',
    yes: 'ja', no: 'nein', please: 'bitte', thanks: 'danke',
    // Pronouns
    i: 'ich', you: 'du', he: 'er', she: 'sie', we: 'wir', they: 'sie',
    my: 'mein', your: 'dein', our: 'unser',
    // Common verbs
    am: 'bin', is: 'ist', are: 'sind', was: 'war', were: 'waren',
    have: 'habe', has: 'hat', had: 'hatte',
    will: 'werde', go: 'gehen', going: 'gehe', went: 'ging',
    eat: 'essen', drink: 'trinken', read: 'lesen', write: 'schreiben',
    think: 'denken', thinking: 'denke', say: 'sagen', see: 'sehen',
    want: 'möchte', need: 'brauche', like: 'mag', love: 'liebe',
    work: 'arbeite', live: 'lebe', come: 'kommen', do: 'mache',
    // Time
    today: 'heute', tomorrow: 'morgen', yesterday: 'gestern',
    now: 'jetzt', soon: 'bald', later: 'später',
    // Conjunctions / prep
    and: 'und', but: 'aber', or: 'oder', so: 'also',
    with: 'mit', without: 'ohne', for: 'für', from: 'von', to: 'nach', in: 'in',
    // Nouns
    food: 'essen', water: 'wasser', book: 'buch', house: 'haus',
    home: 'zuhause', friend: 'freund', name: 'name',
    day: 'tag', night: 'nacht', time: 'zeit',
    // Q-words
    what: 'was', who: 'wer', when: 'wann', where: 'wo', why: 'warum', how: 'wie',
    // Misc adverbs/adj
    good: 'gut', bad: 'schlecht', nice: 'schön', cool: 'cool',
    very: 'sehr', much: 'viel', many: 'viele', some: 'einige',
    really: 'wirklich', here: 'hier', there: 'dort',
    // Articles
    the: 'der', a: 'ein', an: 'ein',
  };
  return {
    kind: 'mock',
    respond: (s) => s.replace(/[A-Za-z']+/g, (w) => {
      const lower = w.toLowerCase();
      const tr = dict[lower];
      if (!tr) return w;
      // Preserve original word's leading-capital style.
      if (w[0] === w[0].toUpperCase()) {
        return tr[0].toUpperCase() + tr.slice(1);
      }
      return tr;
    }),
  };
}

/**
 * Imperfect translator — translates only ~70% of words on each pass,
 * randomly missing some. Forces the harness to test convergence:
 * does it eventually settle into all-German with progressive rounds?
 */
export function translateToGermanImperfect(missRate: number = 0.3): LlmMode {
  const full = translateToGerman();
  return {
    kind: 'mock',
    respond: (s, t, idx) => {
      // Deterministic miss; varies by (word index, round, word content)
      // so the same word doesn't always miss. After enough rounds every
      // word should get translated.
      const result: string[] = [];
      let wordIdx = 0;
      const re = /[A-Za-z']+/g;
      let lastEnd = 0;
      let m: RegExpExecArray | null;
      while ((m = re.exec(s)) !== null) {
        result.push(s.slice(lastEnd, m.index));
        const word = m[0];
        // Hash by (wordIdx, idx, word.length) for variety.
        const hash = (wordIdx * 13 + idx * 17 + word.length * 19) % 100;
        const shouldMiss = hash < (missRate * 100);
        if (shouldMiss) {
          result.push(word);
        } else {
          const translated = (full as { kind: 'mock'; respond: (a: string, b: string, c: number) => string }).respond(word, t, idx);
          result.push(translated);
        }
        wordIdx += 1;
        lastEnd = m.index + word.length;
      }
      result.push(s.slice(lastEnd));
      return result.join('');
    },
  };
}

/**
 * Composite: "fix everything" — combines spelling, capitalisation, and
 * over-eager terminator addition. Reproduces the production over-eager
 * behaviour all in one rewrite.
 */
export function adversarialKitchenSink(): LlmMode {
  const spell = spellingFix();
  const cap = adversarialCapitalise();
  const term = adversarialTerminatorEager();
  return {
    kind: 'mock',
    respond: (s, t, i) => {
      let out = (spell as { kind: 'mock'; respond: (a: string, b: string, c: number) => string }).respond(s, t, i);
      out = (cap as { kind: 'mock'; respond: (a: string, b: string, c: number) => string }).respond(out, t, i);
      out = (term as { kind: 'mock'; respond: (a: string, b: string, c: number) => string }).respond(out, t, i);
      return out;
    },
  };
}
