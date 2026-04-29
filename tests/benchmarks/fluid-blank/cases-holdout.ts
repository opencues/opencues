/**
 * HOLDOUT cases for the fluid-blank benchmark.
 *
 * 40 cases the prompt has NEVER seen during iteration. Designed to share
 * NOTHING with the main suite (cases.ts):
 *   - No topic overlap (no atomic-number-of, no icd-code-for, no
 *     default-port-for, no Apollo, no Shakespeare, no rgb/hex, no
 *     synonyms-for, no opposite-of, no translation, no key-signature)
 *   - No template overlap (uses "patron saint of", "inventor of",
 *     "founder of", "torque spec for", "wire gauge for", "dewey decimal
 *     for", "winner of best picture", "norse god with", "subject of",
 *     "richter magnitude of", "value of X in Y", "size of X bed",
 *     "month of X peak", "how often to water X", etc.)
 *   - No profession context overlap (mechanic, baker, librarian, parent,
 *     gardener, art student, casino host, instead of doctor/lawyer/etc.)
 *
 * Used to check whether P1's ~97% on cases.ts is real generalisation
 * or overfitting to the cases I iterated against.
 *
 * Run: npx tsx tests/benchmarks/fluid-blank/run.ts --holdout
 */

import { FluidBlankCase } from './cases';

export const CASES_HOLDOUT: FluidBlankCase[] = [
  // ─── MYTHOLOGY ────────────────────────────────────────────────────────
  {
    id: 'h-medusa-killer',
    category: 'ambient',
    input: 'halloween story brainstorm. _ who killed medusa. for the costume scene.',
    expected: {
      span: '_ who killed medusa',
      question: 'Who killed Medusa?',
      answer: 'Perseus',
    },
  },
  {
    id: 'h-greek-muses',
    category: 'trailing',
    input: 'trivia night planning _ how many muses in greek mythology for round 4',
    expected: {
      span: '_ how many muses in greek mythology',
      question: 'How many muses are there in Greek mythology?',
      answer: '9',
      answerAlternates: ['nine'],
    },
  },
  {
    id: 'h-norse-thor',
    category: 'trailing',
    input: 'writing fantasy novel _ norse god with the hammer for chapter 5',
    expected: {
      span: '_ norse god with the hammer',
      question: 'Which Norse god wields a hammer?',
      answer: 'Thor',
    },
  },
  {
    id: 'h-egypt-bastet',
    category: 'trailing',
    input: 'art history paper _ egyptian goddess with cat head for the slides',
    expected: {
      span: '_ egyptian goddess with cat head',
      question: 'Which Egyptian goddess has a cat head?',
      answer: 'Bastet',
      answerAlternates: ['Bast'],
    },
  },
  {
    id: 'h-saint-patrick',
    category: 'trailing',
    input: 'st patricks day decor _ patron saint of ireland for the banner',
    expected: {
      span: '_ patron saint of ireland',
      question: 'Who is the patron saint of Ireland?',
      answer: 'Saint Patrick',
      answerAlternates: ['Patrick', 'St. Patrick', 'St Patrick'],
    },
  },

  // ─── RELIGIOUS TEXTS ──────────────────────────────────────────────────
  {
    id: 'h-torah-third',
    category: 'trailing',
    input: 'study session _ third book of the torah for sunday school prep',
    expected: {
      span: '_ third book of the torah',
      question: 'What is the third book of the Torah?',
      answer: 'Leviticus',
    },
  },
  {
    id: 'h-quran-suras',
    category: 'trailing',
    input: 'comparative religion class _ how many suras in the quran for the syllabus',
    expected: {
      span: '_ how many suras in the quran',
      question: 'How many suras are in the Quran?',
      answer: '114',
    },
  },
  {
    id: 'h-rosh-hashanah',
    category: 'inline',
    input: 'holiday calendar jewish new year holiday name _ for the company schedule',
    expected: {
      span: 'jewish new year holiday name _',
      question: 'What is the name of the Jewish new year holiday?',
      answer: 'Rosh Hashanah',
    },
  },

  // ─── ART / HISTORY ────────────────────────────────────────────────────
  {
    id: 'h-renaissance-era',
    category: 'inline',
    input: 'art history quiz era of the italian renaissance _ for the date question',
    expected: {
      span: 'era of the italian renaissance _',
      question: 'When was the Italian Renaissance?',
      answer: '14th-17th century',
      answerAlternates: ['1400-1600', '14th to 17th centuries', '1300s-1600s', '15th-16th century'],
    },
  },
  {
    id: 'h-titanic-year',
    category: 'trailing',
    input: 'documentary research _ year the titanic sank for the timeline',
    expected: {
      span: '_ year the titanic sank',
      question: 'What year did the Titanic sink?',
      answer: '1912',
    },
  },
  {
    id: 'h-gutenberg',
    category: 'trailing',
    input: 'history podcast script _ inventor of the printing press for the intro',
    expected: {
      span: '_ inventor of the printing press',
      question: 'Who invented the printing press?',
      answer: 'Johannes Gutenberg',
      answerAlternates: ['Gutenberg'],
    },
  },
  {
    id: 'h-marie-antoinette',
    category: 'trailing',
    input: 'novel research _ last queen of france before the revolution for chapter 2',
    expected: {
      span: '_ last queen of france before the revolution',
      question: 'Who was the last queen of France before the Revolution?',
      answer: 'Marie Antoinette',
    },
  },
  {
    id: 'h-bayeux',
    category: 'trailing',
    input: 'art trip to france _ subject of the bayeux tapestry for the audio guide',
    expected: {
      span: '_ subject of the bayeux tapestry',
      question: 'What is the subject of the Bayeux Tapestry?',
      answer: 'Norman conquest of England',
      answerAlternates: ['1066', 'Battle of Hastings', 'William the Conqueror', 'Norman invasion'],
    },
  },
  {
    id: 'h-magellan',
    category: 'trailing',
    input: 'maritime documentary script _ first explorer to circumnavigate the globe for narration',
    expected: {
      span: '_ first explorer to circumnavigate the globe',
      question: 'Who was the first explorer to circumnavigate the globe?',
      answer: 'Ferdinand Magellan',
      answerAlternates: ['Magellan', "Magellan's expedition", 'Juan Sebastián Elcano'],
    },
  },

  // ─── TRADES ──────────────────────────────────────────────────────────
  {
    id: 'h-spark-torque',
    category: 'trailing',
    input: 'tune up tomorrow _ torque spec for spark plug nm for my civic',
    expected: {
      span: '_ torque spec for spark plug nm',
      question: 'What is the torque spec for a spark plug in Nm?',
      answer: '20-30',
      answerAlternates: ['25', '20', '30', '20-30 Nm', '15-30'],
    },
  },
  {
    id: 'h-wire-20a',
    category: 'trailing',
    input: 'rewire kitchen project _ wire gauge for 20 amp circuit for the run',
    expected: {
      span: '_ wire gauge for 20 amp circuit',
      question: 'What wire gauge is needed for a 20 amp circuit?',
      answer: '12 AWG',
      answerAlternates: ['12', '12 gauge', 'AWG 12', '12 ga'],
    },
  },
  {
    id: 'h-tire-psi',
    category: 'trailing',
    input: 'morning errands _ correct pressure for car tires psi for the inflation stop',
    expected: {
      span: '_ correct pressure for car tires psi',
      question: 'What is the correct pressure for car tires in PSI?',
      answer: '32-35',
      answerAlternates: ['30-35', '32', '35', '32 psi'],
    },
  },
  {
    id: 'h-roller-nap',
    category: 'trailing',
    input: 'diy project today _ paint roller nap for smooth walls choose right one',
    expected: {
      span: '_ paint roller nap for smooth walls',
      question: 'What paint roller nap is best for smooth walls?',
      answer: '1/4 inch',
      answerAlternates: ['3/8', '1/4', '0.25', '6mm', 'short nap'],
    },
  },

  // ─── GARDENING ───────────────────────────────────────────────────────
  {
    id: 'h-tulip-plant',
    category: 'trailing',
    input: 'flower bed prep _ when to plant tulip bulbs for spring bloom',
    expected: {
      span: '_ when to plant tulip bulbs',
      question: 'When should you plant tulip bulbs?',
      answer: 'fall',
      answerAlternates: ['September-October', 'October', 'before frost', 'autumn'],
    },
  },
  {
    id: 'h-snake-water',
    category: 'trailing',
    input: 'houseplant care guide _ how often to water snake plant for the care card',
    expected: {
      span: '_ how often to water snake plant',
      question: 'How often should you water a snake plant?',
      answer: 'every 2-3 weeks',
      answerAlternates: ['every 2 weeks', 'every 3 weeks', 'biweekly', 'sparingly'],
    },
  },
  {
    id: 'h-sakura-peak',
    category: 'trailing',
    input: 'japan trip planning _ month of cherry blossom peak in tokyo for booking flights',
    expected: {
      span: '_ month of cherry blossom peak in tokyo',
      question: 'What month is cherry blossom peak in Tokyo?',
      answer: 'April',
      answerAlternates: ['late March-April', 'early April', 'March-April'],
    },
  },
  {
    id: 'h-tomato-zone',
    category: 'inline',
    input: 'spring garden plan usda zone for growing tomatoes outdoors _ for the seedling chart',
    expected: {
      span: 'usda zone for growing tomatoes outdoors _',
      question: 'What USDA zone is suitable for growing tomatoes outdoors?',
      answer: '5-10',
      answerAlternates: ['3-11', '5-9', 'most zones'],
    },
  },

  // ─── FOOD / EVERYDAY ─────────────────────────────────────────────────
  {
    id: 'h-roquefort',
    category: 'ambient',
    input: 'cheese platter for dinner. _ cheese aged in caves of roquefort. for the menu card.',
    expected: {
      span: '_ cheese aged in caves of roquefort',
      question: 'What cheese is aged in the caves of Roquefort?',
      answer: 'Roquefort',
      answerAlternates: ['blue cheese', 'sheep milk blue cheese'],
    },
  },
  {
    id: 'h-toddler-age',
    category: 'trailing',
    input: 'daycare paperwork _ age range of a toddler in years for the form',
    expected: {
      span: '_ age range of a toddler in years',
      question: 'What is the age range of a toddler in years?',
      answer: '1-3',
      answerAlternates: ['1 to 3 years', '12 months to 3 years', '1-3 years'],
    },
  },
  {
    id: 'h-king-bed',
    category: 'trailing',
    input: 'furniture shopping today _ size of king bed in inches for the bedroom dimensions',
    expected: {
      span: '_ size of king bed in inches',
      question: 'What is the size of a king bed in inches?',
      answer: '76x80',
      answerAlternates: ['76 x 80', '76 by 80', '76"x80"', '76 by 80 inches'],
    },
  },
  {
    id: 'h-soccer-field',
    category: 'inline',
    input: 'youth coach prep length of a regulation soccer field meters _ for the diagram',
    expected: {
      span: 'length of a regulation soccer field meters _',
      question: 'What is the length of a regulation soccer field in meters?',
      answer: '100-110',
      answerAlternates: ['90-120', '100m', '105', '100 to 110 meters'],
    },
  },
  {
    id: 'h-sandwich-inv',
    category: 'trailing',
    input: 'food history article draft _ inventor of the sandwich for the headline',
    expected: {
      span: '_ inventor of the sandwich',
      question: 'Who invented the sandwich?',
      answer: 'Earl of Sandwich',
      answerAlternates: ['John Montagu', '4th Earl of Sandwich', 'Montagu'],
    },
  },

  // ─── LIBRARY / REFERENCE ─────────────────────────────────────────────
  {
    id: 'h-dewey-poetry',
    category: 'trailing',
    input: 'library shelf reorg _ dewey decimal section for poetry for the cart sorting',
    expected: {
      span: '_ dewey decimal section for poetry',
      question: 'What is the Dewey Decimal section for poetry?',
      answer: '811',
      answerAlternates: ['800s', '810s', '800', '810', '821'],
    },
  },
  {
    id: 'h-etcetera',
    category: 'trailing',
    input: 'academic paper edits _ abbreviation for et cetera for the citation footnote',
    expected: {
      span: '_ abbreviation for et cetera',
      question: 'What is the abbreviation for "et cetera"?',
      answer: 'etc.',
      answerAlternates: ['etc', '&c.'],
    },
  },
  {
    id: 'h-apa-citation',
    category: 'trailing',
    input: 'thesis style guide _ citation style used in psychology for my final chapters',
    expected: {
      span: '_ citation style used in psychology',
      question: 'What citation style is used in psychology?',
      answer: 'APA',
      answerAlternates: ['APA style', 'American Psychological Association', 'APA 7'],
    },
  },

  // ─── EVENTS / PEOPLE ─────────────────────────────────────────────────
  {
    id: 'h-best-picture-2020',
    category: 'trailing',
    input: 'oscar party trivia _ winner of best picture 2020 academy awards for the prize round',
    expected: {
      span: '_ winner of best picture 2020 academy awards',
      question: 'Who won Best Picture at the 2020 Academy Awards?',
      answer: 'Parasite',
    },
  },
  {
    id: 'h-microsoft-founder',
    category: 'trailing',
    input: 'biography section draft _ founder of microsoft for the entry header',
    expected: {
      span: '_ founder of microsoft',
      question: 'Who founded Microsoft?',
      answer: 'Bill Gates',
      answerAlternates: ['Gates', 'Bill Gates and Paul Allen', 'Paul Allen'],
    },
  },
  {
    id: 'h-snoopy-peanuts',
    category: 'trailing',
    input: "kids party planning _ name of the dog from peanuts comic for the cake topper order",
    expected: {
      span: '_ name of the dog from peanuts comic',
      question: 'What is the name of the dog in Peanuts?',
      answer: 'Snoopy',
    },
  },
  {
    id: 'h-hp-owl',
    category: 'trailing',
    input: "kids party theme _ name of harry potter's owl for the invitations",
    expected: {
      span: "_ name of harry potter's owl",
      question: "What is the name of Harry Potter's owl?",
      answer: 'Hedwig',
    },
  },

  // ─── WEATHER / EARTH ─────────────────────────────────────────────────
  {
    id: 'h-strongest-hurricane',
    category: 'trailing',
    input: 'weather class lesson _ category of strongest hurricane on saffir simpson scale for the chart',
    expected: {
      span: '_ category of strongest hurricane on saffir simpson scale',
      question: 'What is the strongest hurricane category on the Saffir-Simpson scale?',
      answer: '5',
      answerAlternates: ['category 5', 'Cat 5', 'Category Five'],
    },
  },
  {
    id: 'h-sf-1906-quake',
    category: 'trailing',
    input: 'history homework _ richter magnitude of san francisco 1906 earthquake for my essay',
    expected: {
      span: '_ richter magnitude of san francisco 1906 earthquake',
      question: 'What was the Richter magnitude of the 1906 San Francisco earthquake?',
      answer: '7.9',
      answerAlternates: ['7.8', '8.0', '7.9 magnitude', '~8'],
    },
  },

  // ─── GAME / SPORT RULES ──────────────────────────────────────────────
  {
    id: 'h-blackjack-ace',
    category: 'trailing',
    input: 'casino night planning _ value of ace in blackjack for the dealer brief sheet',
    expected: {
      span: '_ value of ace in blackjack',
      question: 'What is the value of the ace in blackjack?',
      answer: '1 or 11',
      answerAlternates: ['1/11', '11', 'either 1 or 11'],
    },
  },
  {
    id: 'h-hoop-height',
    category: 'inline',
    input: 'playground design notes height of regulation basketball hoop in feet _ for the court drawing',
    expected: {
      span: 'height of regulation basketball hoop in feet _',
      question: 'What is the height of a regulation basketball hoop in feet?',
      answer: '10',
      answerAlternates: ['10 feet', '10 ft'],
    },
  },

  // ─── LONG CROSS-DOMAIN (40+ words) ───────────────────────────────────
  {
    id: 'h-long-mechanic-saint',
    category: 'trailing',
    input: 'thursday afternoon shop the corolla on lift 3 needs new plugs and an oil change customer waiting in the lobby and the prius hybrid battery diagnostic still pending from this morning _ patron saint of travelers',
    expected: {
      span: '_ patron saint of travelers',
      question: 'Who is the patron saint of travelers?',
      answer: 'Saint Christopher',
      answerAlternates: ['Christopher', 'St. Christopher', 'St Christopher'],
    },
  },
  {
    id: 'h-long-baker-richter',
    category: 'trailing',
    input: 'morning bake quotas done four sourdough boules two whole wheat loaves and the croissants are proofing in the walk-in for the brunch service tomorrow weekend rush expected so we should batch double _ richter scale threshold for major earthquake',
    expected: {
      span: '_ richter scale threshold for major earthquake',
      question: 'What is the Richter scale threshold for a major earthquake?',
      answer: '7.0',
      answerAlternates: ['7', '7.0+', 'above 7', 'magnitude 7+'],
    },
  },
];
