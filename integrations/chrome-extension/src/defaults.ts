/** Default config content baked into the build. Overridden by user config in popup. */

export const DEFAULT_CUES_MD = `---
ignore:
  - the
  - a
  - an
  - is
  - are
  - was
  - were
  - be
  - been
  - to
  - of
  - in
  - at
  - on
  - for
  - and
  - but
  - or
  - not
  - it

sources:
  grammar:
    scope: words
    parser: alternatives
    prompt: |
      For each numbered word, suggest 2-3 alternative words that could replace it in context.
      Keep the same part of speech and meaning. Format: INDEX: alt1, alt2, alt3
      Only include words where meaningful alternatives exist. Skip function words.
---`;

export const DEFAULT_TIPS_JSON = JSON.stringify([
  {
    id: 'grammar',
    words: {
      big: { tip: 'Size/scale', alts: ['large', 'huge', 'enormous', 'massive'] },
      small: { tip: 'Size/scale', alts: ['tiny', 'little', 'miniature', 'compact'] },
      good: { tip: 'Quality', alts: ['great', 'excellent', 'superb', 'fine'] },
      bad: { tip: 'Quality', alts: ['poor', 'terrible', 'awful', 'dreadful'] },
      happy: { tip: 'Emotion', alts: ['joyful', 'pleased', 'cheerful', 'delighted'] },
      sad: { tip: 'Emotion', alts: ['unhappy', 'sorrowful', 'gloomy', 'melancholy'] },
      fast: { tip: 'Speed', alts: ['quick', 'rapid', 'swift', 'speedy'] },
      slow: { tip: 'Speed', alts: ['sluggish', 'gradual', 'leisurely', 'unhurried'] },
      beautiful: { tip: 'Appearance', alts: ['gorgeous', 'stunning', 'lovely', 'elegant'] },
      ugly: { tip: 'Appearance', alts: ['hideous', 'unattractive', 'unsightly', 'grotesque'] },
    },
    groups: [
      { synonyms: ['boy', 'lad', 'young man'], tip: 'Male youth', alts: ['girl', 'child', 'kid'] },
      { synonyms: ['girl', 'lass', 'young woman'], tip: 'Female youth', alts: ['boy', 'child', 'kid'] },
      { synonyms: ['his', 'him'], tip: 'Male pronoun', alts: ['her', 'their', 'its'], linked: ['boy', 'lad', 'man'] },
      { synonyms: ['her', 'she'], tip: 'Female pronoun', alts: ['his', 'their', 'its'], linked: ['girl', 'lass', 'woman'] },
    ],
  },
]);
