/**
 * Synthetic cases for the ambient-context benchmark.
 *
 * Each case has:
 *   - SPAN: the lookup with the trailing `_` (or NONE for fail-soft)
 *   - CONTEXT: surrounding free-form text the user typed (often empty)
 *   - AMBIENT: synthetic field+page metadata (label/placeholder/aria/page-*)
 *   - expected.answer + expected.answerAlternates: accepted answers
 *
 * Three case classes:
 *
 *   ambient-helps    — ambient meaningfully disambiguates the SPAN; the answer
 *                      WITHOUT ambient would differ from the answer WITH it.
 *                      Used to measure whether the model leverages ambient.
 *
 *   ambient-neutral  — the SPAN is unambiguous; ambient should NOT change the
 *                      answer. Used to measure whether ambient introduces
 *                      noise that DEGRADES otherwise-correct answers.
 *
 *   ambient-anti     — ambient is irrelevant or misleading; a good model
 *                      should ignore it. Probes overreliance on ambient.
 */

export type AmbientContext = {
  label?: string;
  placeholder?: string;
  ariaLabel?: string;
  ariaDescription?: string;
  inputType?: string;
  pageTitle?: string;
  pageUrl?: string;
  pageDescription?: string;
};

export interface AmbientCase {
  id: string;
  klass: 'ambient-helps' | 'ambient-neutral' | 'ambient-anti';
  span: string;
  context: string;
  ambient: AmbientContext | undefined;
  expected: {
    answer: string;
    alternates?: string[];
    /** Free-form note about what we're testing here. */
    note?: string;
  };
}

export const CASES: AmbientCase[] = [
  // ────────────────────────────────────────────────────────────────────
  // ambient-helps — ambient changes the right answer
  // ────────────────────────────────────────────────────────────────────
  {
    id: 'helps-flights-destination',
    klass: 'ambient-helps',
    span: 'paris _',
    context: '',
    ambient: {
      label: 'Where to?',
      placeholder: 'Enter destination',
      pageTitle: 'Flight Search · Skyscanner',
      pageUrl: 'https://www.skyscanner.com/flights',
      pageDescription: 'Compare flights and book your trip',
    },
    expected: { answer: 'Paris', alternates: ['Paris, France', 'CDG', 'PAR'], note: 'destination field — Paris IS the answer (the city), not France (the country)' },
  },
  {
    id: 'helps-linkedin-name',
    klass: 'ambient-helps',
    span: 'paris _',
    context: '',
    ambient: {
      label: 'Full name',
      placeholder: 'e.g. Jane Smith',
      pageTitle: 'Sign up · LinkedIn',
      pageUrl: 'https://www.linkedin.com/signup',
    },
    expected: { answer: 'Paris', alternates: ['Paris Hilton'], note: 'name field — Paris should stay literal as a first name, NOT capital lookup' },
  },
  {
    id: 'helps-trivia-capital',
    klass: 'ambient-helps',
    span: 'paris _',
    context: '',
    ambient: {
      label: 'Capital of:',
      pageTitle: 'Geography Quiz',
      pageUrl: 'https://geoquiz.example.com/europe',
    },
    expected: { answer: 'France', alternates: ['France 🇫🇷'], note: 'asking which country Paris is capital of — answer is France' },
  },
  {
    id: 'helps-currency-form-eur',
    klass: 'ambient-helps',
    span: 'paris _',
    context: '',
    ambient: {
      label: 'Currency for destination',
      pageTitle: 'Travel Money Calculator',
      pageUrl: 'https://wise.com/converter',
    },
    expected: { answer: 'EUR', alternates: ['€', 'Euro', 'EUR (Euro)'], note: 'currency field — Paris uses EUR' },
  },
  {
    id: 'helps-recipe-search',
    klass: 'ambient-helps',
    span: 'quick recipe _',
    context: '',
    ambient: {
      label: 'Search recipes',
      pageTitle: 'AllRecipes — Easy Dinner',
      pageUrl: 'https://www.allrecipes.com',
    },
    expected: { answer: 'pasta', alternates: ['stir fry', 'omelette', 'grilled cheese', 'pasta carbonara', 'spaghetti aglio e olio'], note: 'dish-name expected, not a generic web-search answer' },
  },
  {
    id: 'helps-color-css',
    klass: 'ambient-helps',
    span: 'red _',
    context: '',
    ambient: {
      label: 'Color value',
      placeholder: '#hex or rgb()',
      pageTitle: 'CodePen Editor',
      pageUrl: 'https://codepen.io/pen',
    },
    expected: { answer: '#FF0000', alternates: ['#ff0000', '#f00', 'rgb(255, 0, 0)', 'red'], note: 'color picker — expects hex/rgb, not "the color red"' },
  },
  {
    id: 'helps-stock-ticker',
    klass: 'ambient-helps',
    span: 'apple _',
    context: '',
    ambient: {
      label: 'Stock symbol',
      pageTitle: 'Robinhood — Search',
      pageUrl: 'https://robinhood.com/stocks',
    },
    expected: { answer: 'AAPL', alternates: ['AAPL (Apple Inc.)'], note: 'stock ticker, not the company description or the fruit' },
  },
  {
    id: 'helps-iso-country',
    klass: 'ambient-helps',
    span: 'germany _',
    context: '',
    ambient: {
      label: 'Country code (ISO 3166)',
      placeholder: 'DE',
      pageTitle: 'Shipping Address Form',
      pageUrl: 'https://shop.example.com/checkout',
    },
    expected: { answer: 'DE', alternates: ['DEU', 'de'], note: 'ISO code, not the country name' },
  },
  {
    id: 'helps-airport-code',
    klass: 'ambient-helps',
    span: 'paris _',
    context: '',
    ambient: {
      label: 'Airport code',
      placeholder: 'e.g. JFK',
      pageTitle: 'Airline Booking',
      pageUrl: 'https://booking.example.com',
    },
    expected: { answer: 'CDG', alternates: ['ORY', 'PAR', 'CDG (Charles de Gaulle)', 'CDG/ORY'], note: 'IATA airport code for Paris (CDG or ORY)' },
  },
  {
    id: 'helps-tz-city',
    klass: 'ambient-helps',
    span: 'london _',
    context: '',
    ambient: {
      label: 'Timezone',
      pageTitle: 'Calendar Event',
      pageUrl: 'https://calendar.google.com',
    },
    expected: { answer: 'GMT', alternates: ['BST', 'Europe/London', 'UTC+0', 'UTC', 'UTC+1', 'GMT (UTC+0)'], note: 'timezone abbreviation, not the city info' },
  },
  // ────────────────────────────────────────────────────────────────────
  // ambient-neutral — ambient should NOT change the answer
  // ────────────────────────────────────────────────────────────────────
  {
    id: 'neutral-unicode-amp',
    klass: 'ambient-neutral',
    span: 'unicode for ampersand _',
    context: '',
    ambient: {
      label: 'Email',
      pageTitle: 'Newsletter Signup',
      pageUrl: 'https://example.com/newsletter',
    },
    expected: { answer: 'U+0026', alternates: ['0026', '&', '&amp;', '0x26', 'U+0026 (&)'], note: 'unambiguous unicode lookup; field is unrelated' },
  },
  {
    id: 'neutral-math',
    klass: 'ambient-neutral',
    span: '8 * 9 = _',
    context: '',
    ambient: {
      label: 'Your message',
      pageTitle: 'Customer Support Chat',
      pageUrl: 'https://support.example.com',
    },
    expected: { answer: '72', note: 'math is unambiguous regardless of where typed' },
  },
  {
    id: 'neutral-capital',
    klass: 'ambient-neutral',
    span: 'capital of japan _',
    context: '',
    ambient: {
      label: 'Comment',
      pageTitle: 'Blog Post Comments',
      pageUrl: 'https://blog.example.com/post/42',
    },
    expected: { answer: 'Tokyo', note: 'unambiguous factual lookup' },
  },
  {
    id: 'neutral-hex-blue',
    klass: 'ambient-neutral',
    span: 'hex for blue _',
    context: '',
    ambient: {
      label: 'Username',
      pageTitle: 'Forum Profile',
      pageUrl: 'https://forum.example.com',
    },
    expected: { answer: '#0000FF', alternates: ['#0000ff', '#00f', '0000FF', 'rgb(0, 0, 255)'], note: 'hex is unambiguous; profile context is irrelevant' },
  },
  {
    id: 'neutral-roman',
    klass: 'ambient-neutral',
    span: '14 in roman numerals _',
    context: '',
    ambient: {
      label: 'Search',
      pageTitle: 'Amazon',
      pageUrl: 'https://www.amazon.com',
    },
    expected: { answer: 'XIV', note: 'numeric conversion is unambiguous' },
  },
  // ────────────────────────────────────────────────────────────────────
  // ambient-anti — ambient is irrelevant/misleading; model should ignore it
  // ────────────────────────────────────────────────────────────────────
  {
    id: 'anti-misleading-page-title',
    klass: 'ambient-anti',
    span: 'capital of france _',
    context: '',
    ambient: {
      label: 'Search',
      pageTitle: 'Italy Tourism Guide',
      pageUrl: 'https://italy-tourism.example.com',
    },
    expected: { answer: 'Paris', note: 'span explicitly says "france" — ambient about Italy is misleading; model should answer France, not Rome' },
  },
  {
    id: 'anti-empty-ambient',
    klass: 'ambient-anti',
    span: 'pi to 4 decimals _',
    context: '',
    ambient: {
      pageUrl: 'https://example.com',
      // intentionally minimal — nothing useful for disambiguation
    },
    expected: { answer: '3.1416', alternates: ['3.14159', '3.1415', 'π ≈ 3.1416', '3.1416 (π)'], note: 'sparse ambient should not nudge the answer either way' },
  },
  {
    id: 'anti-noisy-label',
    klass: 'ambient-anti',
    span: 'atomic number of oxygen _',
    context: '',
    ambient: {
      label: 'Lorem ipsum dolor sit amet',
      placeholder: 'placeholder',
      pageTitle: 'untitled',
      pageUrl: 'https://example.com',
    },
    expected: { answer: '8', note: 'unambiguous chemistry lookup; ambient is meaningless noise' },
  },
];
