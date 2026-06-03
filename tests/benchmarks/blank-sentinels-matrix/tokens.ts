/**
 * Token generator for the blank-sentinels matrix.
 *
 * Two structurally different "kinds" of context tokens we want to compare
 * for LLM-resolution reliability:
 *
 *   1. 'sentinel' — static identity fields (name, email, home_city, …).
 *      Single-segment field name. Bound to the user, not to a parameter.
 *      Token shape: `[FIRST NAME]`.
 *
 *   2. 'blank' — parameterised dynamic data (weather per city, stocks per
 *      ticker, dictionary per word, …). Multi-segment token name encodes
 *      both the blank and the parameter binding. We test TWO sub-shapes:
 *
 *        a. FIELD-CODED   `[WEATHER HOME TEMP]` — the parameter slot
 *                          (HOME) comes from a bound sentinel field name.
 *                          Token names never carry user values.
 *
 *        b. VALUE-CODED   `[STOCK AAPL PRICE]` — the parameter slot
 *                          (AAPL) is a value fragment (e.g. ticker
 *                          symbol). Used when a sentinel field is
 *                          split-bound (`portfolio: AAPL,NVDA`).
 *
 * The bench exposes both sub-shapes so we can quantify the cost of the
 * split-naming carve-out (the only place the safe-mode invariant bends).
 *
 * We need to scale up to 64 tokens, so the catalogs are generated, not
 * hand-curated.
 */

export type TokenKind = 'sentinel' | 'blank';
export type BlankNaming = 'field' | 'value';

export interface MatrixToken {
  /** Verbatim token the LLM should emit, e.g. `[FIRST NAME]`. */
  token: string;
  /** Catalog description shown in the system prompt. */
  description: string;
  /** Synthetic plausible value (post-LLM substitution target). */
  value: string;
  /** Provenance: a static personal field or a parameterised blank? */
  kind: TokenKind;
  /** For 'blank' tokens: which naming sub-shape was used. */
  blankNaming?: BlankNaming;
  /** For 'blank' tokens: the source blank name (`weather`, `stocks`, …). */
  blankSource?: string;
  /** For 'blank' tokens: the sentinel field the parameter binds to
   *  (`home_city`, `portfolio`, …). Tracked for transparency even when
   *  the bench doesn't put both in the same catalog. */
  bindsToField?: string;
}

/** Pool A — pure sentinels. Hand-curated to mirror what a real user
 *  would put in `~/.cues/SENTINELS.md`. Ordered so the first 16
 *  exactly match the existing user-context bench; subsequent entries
 *  extend the surface to 64 with realistic-but-synthetic fields. */
const SENTINEL_POOL: ReadonlyArray<Omit<MatrixToken, 'kind'>> = [
  // identity (existing 16)
  { token: '[FIRST NAME]',    description: "user's first name",                   value: 'Wilfred' },
  { token: '[LAST NAME]',     description: "user's last name",                    value: 'Kasekende' },
  { token: '[FULL NAME]',     description: "user's first + last name combined",   value: 'Wilfred Kasekende' },
  { token: '[EMAIL]',         description: "user's primary email address",        value: 'wilfred@example.com' },
  { token: '[PHONE]',         description: "user's phone number (E.164)",         value: '+44 7700 900123' },
  { token: '[PRONOUNS]',      description: "user's preferred pronouns",           value: 'he/him' },
  { token: '[JOB TITLE]',     description: "user's job title",                    value: 'Software Engineer' },
  { token: '[COMPANY]',       description: "user's current employer",             value: 'Acme Corp' },
  { token: '[WORK CITY]',     description: "city where user works",               value: 'London' },
  { token: '[HOME CITY]',     description: "city where user lives",               value: 'London' },
  { token: '[HOME COUNTRY]',  description: "country where user lives",            value: 'United Kingdom' },
  { token: '[HOME POSTCODE]', description: "user's home postcode/ZIP",            value: 'SW1A 1AA' },
  { token: '[GITHUB]',        description: "user's GitHub profile URL",           value: 'https://github.com/wkasekende' },
  { token: '[LINKEDIN]',      description: "user's LinkedIn profile URL",         value: 'https://linkedin.com/in/wkasekende' },
  { token: '[TWITTER]',       description: "user's Twitter/X handle (with @)",    value: '@wkasekende' },
  { token: '[WEBSITE]',       description: "user's personal website URL",         value: 'https://wkasekende.com' },
  // extended surface (16 → 64)
  { token: '[BIRTHDAY]',      description: "user's birthday (MM-DD)",             value: '07-14' },
  { token: '[BIRTH YEAR]',    description: "user's birth year",                   value: '1991' },
  { token: '[NICKNAME]',      description: "user's preferred informal name",      value: 'Wil' },
  { token: '[MIDDLE NAME]',   description: "user's middle name",                  value: 'James' },
  { token: '[WORK EMAIL]',    description: "user's work email address",           value: 'wilfred@acme.example' },
  { token: '[WORK PHONE]',    description: "user's work phone number",            value: '+44 20 7946 0001' },
  { token: '[WORK ADDRESS]',  description: "user's work street address",          value: '1 Acme Way, London' },
  { token: '[HOME ADDRESS]',  description: "user's home street address",          value: '42 Sample St, London' },
  { token: '[MANAGER]',       description: "name of user's direct manager",       value: 'Priya Patel' },
  { token: '[TEAM NAME]',     description: "name of user's team at work",         value: 'Platform' },
  { token: '[COMMUTE START]', description: "user's typical work-start time",      value: '09:30' },
  { token: '[TIMEZONE]',      description: "user's local timezone (IANA)",        value: 'Europe/London' },
  { token: '[NATIONALITY]',   description: "user's nationality",                  value: 'British' },
  { token: '[LANGUAGE]',      description: "user's primary spoken language",      value: 'English' },
  { token: '[SECOND LANGUAGE]', description: "user's secondary language",         value: 'French' },
  { token: '[PARTNER NAME]',  description: "name of user's partner",              value: 'Sam' },
  { token: '[CHILD NAME]',    description: "name of user's child",                value: 'Ada' },
  { token: '[PET NAME]',      description: "name of user's pet",                  value: 'Mochi' },
  { token: '[PET KIND]',      description: "kind of pet user has",                value: 'cat' },
  { token: '[CAR MAKE]',      description: "make of user's car",                  value: 'Toyota' },
  { token: '[CAR MODEL]',     description: "model of user's car",                 value: 'Corolla' },
  { token: '[FAVOURITE FOOD]', description: "user's favourite food",              value: 'pasta' },
  { token: '[FAVOURITE COLOUR]', description: "user's favourite colour",          value: 'forest green' },
  { token: '[FAVOURITE BOOK]', description: "user's favourite book",              value: 'Dune' },
  { token: '[FAVOURITE FILM]', description: "user's favourite film",              value: 'Lawrence of Arabia' },
  { token: '[FAVOURITE BAND]', description: "user's favourite band",              value: 'Radiohead' },
  { token: '[ALMA MATER]',    description: "user's university",                   value: 'UCL' },
  { token: '[DEGREE]',        description: "user's degree subject",               value: 'Computer Science' },
  { token: '[GRADUATION YEAR]', description: "user's year of graduation",         value: '2013' },
  { token: '[SHIRT SIZE]',    description: "user's shirt size",                   value: 'M' },
  { token: '[SHOE SIZE]',     description: "user's shoe size (UK)",               value: '9' },
  { token: '[BLOOD TYPE]',    description: "user's blood type",                   value: 'O+' },
  { token: '[ALLERGIES]',     description: "user's allergies",                    value: 'pollen' },
  { token: '[MEDICATIONS]',   description: "user's medications",                  value: 'none' },
  { token: '[EMERGENCY CONTACT]', description: "user's emergency contact name",   value: 'Sam Kasekende' },
  { token: '[EMERGENCY PHONE]', description: "emergency contact phone number",    value: '+44 7700 900200' },
  { token: '[DOCTOR]',        description: "user's primary care doctor",          value: 'Dr Lee' },
  { token: '[GP CLINIC]',     description: "user's GP clinic",                    value: 'Sample St Surgery' },
  { token: '[BANK]',          description: "name of user's primary bank",         value: 'Monzo' },
  { token: '[INVESTMENT BROKER]', description: "user's investment broker",        value: 'Trading 212' },
  { token: '[ACCOUNTANT]',    description: "user's accountant",                   value: 'TaxScout' },
  { token: '[TAX RESIDENCE]', description: "user's tax residence",                value: 'United Kingdom' },
  { token: '[CITIZENSHIP]',   description: "user's citizenship",                  value: 'British' },
  { token: '[PASSPORT EXPIRY]', description: "user's passport expiry (year)",     value: '2030' },
  { token: '[NHS NUMBER]',    description: "user's NHS number (last 4)",          value: '7841' },
  { token: '[LICENCE NUMBER]', description: "driving licence number (last 4)",    value: '9023' },
  { token: '[LICENCE EXPIRY]', description: "driving licence expiry year",        value: '2031' },
  { token: '[DIETARY]',       description: "user's dietary preference",           value: 'pescetarian' },
  // ─── Distractor families (65-128) ──────────────────────────────────────
  // These intentionally crowd the same-prefix space to stress
  // disambiguation. A real user with multiple emails / phone numbers
  // would have exactly this structure.
  { token: '[WORK EMAIL]',      description: "user's work email",                     value: 'wilfred@acme.example' }, // duplicate-prefix
  { token: '[PERSONAL EMAIL]',  description: "user's personal email (not main)",      value: 'wilf@protonmail.example' },
  { token: '[BACKUP EMAIL]',    description: "user's backup recovery email",          value: 'recovery@wkasekende.com' },
  { token: '[OLD EMAIL]',       description: "user's archived previous email",        value: 'wkasekende@old-uni.example' },
  { token: '[MOBILE PHONE]',    description: "user's mobile phone (not work line)",   value: '+44 7700 900111' },
  { token: '[HOME PHONE]',      description: "user's home landline",                  value: '+44 20 7946 0123' },
  { token: '[FAX]',             description: "user's fax number (legacy)",            value: '+44 20 7946 0888' },
  { token: '[BIRTH CITY]',      description: "city where user was born",              value: 'Cambridge' },
  { token: '[HOMETOWN]',        description: "user's hometown",                       value: 'Cambridge' },
  { token: '[CURRENT CITY]',    description: "city user is currently in",             value: 'London' },
  { token: '[MAILING CITY]',    description: "city of user's mailing address",        value: 'London' },
  { token: '[OFFICE FLOOR]',    description: "floor of user's office",                value: '4' },
  { token: '[DESK NUMBER]',     description: "user's desk number",                    value: 'D-42' },
  { token: '[BADGE NUMBER]',    description: "user's office badge number",            value: 'A-9087' },
  { token: '[PARKING SPOT]',    description: "user's parking spot",                   value: 'P-12' },
  { token: '[GITHUB ORG]',      description: "user's primary GitHub org",             value: 'opencues' },
  { token: '[GITLAB]',          description: "user's GitLab profile URL",             value: 'https://gitlab.com/wkasekende' },
  { token: '[BITBUCKET]',       description: "user's Bitbucket profile URL",          value: 'https://bitbucket.org/wkasekende' },
  { token: '[STACK OVERFLOW]',  description: "user's Stack Overflow profile",         value: 'https://stackoverflow.com/u/12345' },
  { token: '[HACKERNEWS]',      description: "user's Hacker News handle",             value: 'wkasekende' },
  { token: '[REDDIT]',          description: "user's Reddit handle",                  value: 'u/wkasekende' },
  { token: '[YOUTUBE]',         description: "user's YouTube channel URL",            value: 'https://youtube.com/@wkasekende' },
  { token: '[TIKTOK]',          description: "user's TikTok handle",                  value: '@wkasekende' },
  { token: '[INSTAGRAM]',       description: "user's Instagram handle",               value: '@wkasekende' },
  { token: '[MASTODON]',        description: "user's Mastodon handle",                value: '@wkasekende@mas.to' },
  { token: '[BLUESKY]',         description: "user's Bluesky handle",                 value: '@wkasekende.bsky.social' },
  { token: '[BANK ACCOUNT]',    description: "user's bank account last-4",            value: '4421' },
  { token: '[SORT CODE]',       description: "user's bank sort code",                 value: '04-00-04' },
  { token: '[PAYPAL]',          description: "user's PayPal email",                   value: 'wilfred@pp.example' },
  { token: '[STRIPE CUSTOMER]', description: "user's Stripe customer ID",             value: 'cus_AB12CD' },
  { token: '[REVOLUT]',         description: "user's Revolut tag",                    value: '@wkasekende' },
  { token: '[WISE TAG]',        description: "user's Wise pay tag",                   value: '@wkasekende' },
  { token: '[INSURANCE PROVIDER]', description: "user's health insurance provider",   value: 'Bupa' },
  { token: '[INSURANCE POLICY]',description: "user's health insurance policy number", value: 'POL-7782' },
  { token: '[GYM]',             description: "user's gym",                            value: 'PureGym Victoria' },
  { token: '[LIBRARY CARD]',    description: "user's library card number",            value: 'LC-9981' },
  { token: '[VOTER REGION]',    description: "user's voter region",                   value: 'Westminster' },
  { token: '[COUNCIL]',         description: "user's local council",                  value: 'Westminster Council' },
  { token: '[BIRTH HOSPITAL]',  description: "hospital where user was born",          value: 'Addenbrookes' },
  { token: '[SCHOOL]',          description: "user's secondary school",               value: 'Hills Road Sixth Form' },
  { token: '[FIRST JOB]',       description: "user's first job",                      value: 'Barista at Costa' },
  { token: '[FAVOURITE PODCAST]', description: "user's favourite podcast",            value: 'Dwarkesh Patel' },
  { token: '[FAVOURITE GAME]',  description: "user's favourite video game",           value: 'Outer Wilds' },
  { token: '[FAVOURITE DRINK]', description: "user's favourite drink",                value: 'oat flat white' },
  { token: '[FAVOURITE SPORT]', description: "user's favourite sport",                value: 'cycling' },
  { token: '[FAVOURITE TEAM]',  description: "user's favourite sports team",          value: 'Arsenal' },
  { token: '[BICYCLE]',         description: "make/model of user's bicycle",          value: 'Brompton M6L' },
  { token: '[HEADPHONES]',      description: "make of user's headphones",             value: 'AirPods Pro' },
  { token: '[LAPTOP]',          description: "make/model of user's laptop",           value: 'MacBook Pro 14"' },
  { token: '[KEYBOARD]',        description: "make of user's keyboard",               value: 'HHKB Pro' },
  { token: '[EDITOR]',          description: "user's primary code editor",            value: 'Claude Code' },
  { token: '[SHELL]',           description: "user's primary shell",                  value: 'zsh' },
  { token: '[OS]',              description: "user's primary operating system",       value: 'macOS' },
  { token: '[TIMEZONE OFFSET]', description: "user's UTC offset (e.g. +01:00)",       value: '+01:00' },
  { token: '[ALARM TIME]',      description: "user's typical alarm time",             value: '07:00' },
  { token: '[BEDTIME]',         description: "user's typical bedtime",                value: '23:30' },
  { token: '[MEETING DAY]',     description: "user's preferred meeting day",          value: 'Tuesday' },
  { token: '[DEEP WORK START]', description: "user's deep-work block start",          value: '10:00' },
  { token: '[DEEP WORK END]',   description: "user's deep-work block end",            value: '12:30' },
  { token: '[LUNCH]',           description: "user's typical lunch time",             value: '13:00' },
  { token: '[STAND UP]',        description: "user's daily standup time",             value: '09:45' },
  { token: '[ONE ON ONE]',      description: "user's 1:1 cadence with manager",       value: 'weekly Tue 14:00' },
  { token: '[VACATION DAYS]',   description: "user's vacation days remaining this year", value: '14' },
  { token: '[SECRET SANTA]',    description: "user's office secret-santa name",       value: 'Priya' },
];

interface BlankSpec {
  /** Blank source name shown in token. */
  source: string;
  /** Sentinel field the parameter binds to (for documentation). */
  bindsToField: string;
  /** Naming sub-shape. */
  naming: BlankNaming;
  /** The parameter slots that produce one token each. For 'field' naming
   *  each entry is a sentinel-field-derived discriminator (HOME, WORK, …).
   *  For 'value' naming each entry is a value fragment (AAPL, NVDA, …). */
  slots: ReadonlyArray<{ slot: string; valueLabel: string; value: string }>;
  /** Sub-fields of the snapshot (TEMP, CONDITIONS, PRICE, …). */
  fields: ReadonlyArray<{ field: string; descShape: (slotValueLabel: string) => string; value: (slotValueLabel: string) => string }>;
}

/** Pool B — parameterised blank-derived tokens. Each (slot × field) pair
 *  produces one token. Ordered so the first ~16 cover the common shapes
 *  (weather/stocks/crypto/countries/dictionary) and later entries extend
 *  the surface to 64 without straining plausibility. */
const BLANK_SPECS: BlankSpec[] = [
  {
    source: 'WEATHER', bindsToField: 'home_city', naming: 'field',
    slots: [
      { slot: 'HOME', valueLabel: 'home city',  value: 'London' },
      { slot: 'WORK', valueLabel: 'work city',  value: 'Manchester' },
    ],
    fields: [
      { field: 'TEMP',       descShape: l => `current temperature in user's ${l}`, value: () => '14°C' },
      { field: 'CONDITIONS', descShape: l => `current weather conditions in user's ${l}`, value: () => 'overcast' },
    ],
  },
  {
    source: 'STOCK', bindsToField: 'portfolio', naming: 'value',
    slots: [
      { slot: 'AAPL', valueLabel: 'AAPL', value: 'AAPL' },
      { slot: 'NVDA', valueLabel: 'NVDA', value: 'NVDA' },
      { slot: 'GOOG', valueLabel: 'GOOG', value: 'GOOG' },
      { slot: 'MSFT', valueLabel: 'MSFT', value: 'MSFT' },
    ],
    fields: [
      { field: 'PRICE',  descShape: l => `current share price of ${l}`,           value: () => '$245.12' },
      { field: 'CHANGE', descShape: l => `today's % change for ${l}`,             value: () => '+1.4%' },
    ],
  },
  {
    source: 'CRYPTO', bindsToField: 'watchlist', naming: 'value',
    slots: [
      { slot: 'BTC', valueLabel: 'BTC', value: 'BTC' },
      { slot: 'ETH', valueLabel: 'ETH', value: 'ETH' },
      { slot: 'SOL', valueLabel: 'SOL', value: 'SOL' },
    ],
    fields: [
      { field: 'PRICE',  descShape: l => `current USD price of ${l}`,             value: () => '$68,401' },
      { field: 'CHANGE', descShape: l => `today's % change for ${l}`,             value: () => '-0.8%' },
    ],
  },
  {
    source: 'COUNTRY', bindsToField: 'travel_list', naming: 'value',
    slots: [
      { slot: 'UK',  valueLabel: 'the UK', value: 'United Kingdom' },
      { slot: 'JP',  valueLabel: 'Japan',  value: 'Japan' },
      { slot: 'BR',  valueLabel: 'Brazil', value: 'Brazil' },
    ],
    fields: [
      { field: 'CAPITAL',    descShape: l => `capital of ${l}`,                    value: l => l === 'the UK' ? 'London' : (l === 'Japan' ? 'Tokyo' : 'Brasília') },
      { field: 'POPULATION', descShape: l => `population of ${l}`,                  value: l => l === 'the UK' ? '67M' : (l === 'Japan' ? '125M' : '215M') },
    ],
  },
  {
    source: 'DICT', bindsToField: 'word_list', naming: 'value',
    slots: [
      { slot: 'SERENDIPITY', valueLabel: 'serendipity', value: 'serendipity' },
      { slot: 'EPHEMERAL',   valueLabel: 'ephemeral',   value: 'ephemeral' },
      { slot: 'PETRICHOR',   valueLabel: 'petrichor',   value: 'petrichor' },
    ],
    fields: [
      { field: 'DEF', descShape: l => `dictionary definition of "${l}"`,          value: () => 'a pleasant surprise' },
    ],
  },
  {
    source: 'CALENDAR', bindsToField: 'tracked_calendars', naming: 'field',
    slots: [
      { slot: 'WORK',     valueLabel: 'work calendar',     value: 'work' },
      { slot: 'PERSONAL', valueLabel: 'personal calendar', value: 'personal' },
    ],
    fields: [
      { field: 'NEXT EVENT', descShape: l => `next event in user's ${l}`,         value: () => 'Standup, 10:00' },
      { field: 'FREE SLOT',  descShape: l => `next 30-min free slot in user's ${l}`, value: () => '13:30 today' },
    ],
  },
  {
    source: 'EMAIL', bindsToField: 'inbox_accounts', naming: 'field',
    slots: [
      { slot: 'WORK',     valueLabel: 'work inbox',     value: 'work' },
      { slot: 'PERSONAL', valueLabel: 'personal inbox', value: 'personal' },
    ],
    fields: [
      { field: 'UNREAD COUNT', descShape: l => `unread count in user's ${l}`,     value: () => '17' },
      { field: 'TOP SENDER',   descShape: l => `most-frequent sender in user's ${l}`, value: () => 'GitHub Notifications' },
    ],
  },
  {
    source: 'FX', bindsToField: 'fx_pairs', naming: 'value',
    slots: [
      { slot: 'GBPUSD', valueLabel: 'GBP/USD', value: 'GBPUSD' },
      { slot: 'EURUSD', valueLabel: 'EUR/USD', value: 'EURUSD' },
      { slot: 'USDJPY', valueLabel: 'USD/JPY', value: 'USDJPY' },
    ],
    fields: [
      { field: 'RATE', descShape: l => `current exchange rate for ${l}`,          value: () => '1.2685' },
    ],
  },
  {
    source: 'NEWS', bindsToField: 'feed_list', naming: 'field',
    slots: [
      { slot: 'TECH',    valueLabel: 'tech feed',    value: 'tech' },
      { slot: 'FINANCE', valueLabel: 'finance feed', value: 'finance' },
      { slot: 'LOCAL',   valueLabel: 'local feed',   value: 'local' },
    ],
    fields: [
      { field: 'TOP HEADLINE', descShape: l => `top headline in user's ${l}`,     value: () => 'Markets rally on inflation data' },
      { field: 'STORY COUNT',  descShape: l => `unread stories in user's ${l}`,   value: () => '42' },
    ],
  },
  {
    source: 'TODO', bindsToField: 'lists', naming: 'field',
    slots: [
      { slot: 'WORK',     valueLabel: 'work todo list',     value: 'work' },
      { slot: 'PERSONAL', valueLabel: 'personal todo list', value: 'personal' },
    ],
    fields: [
      { field: 'NEXT',         descShape: l => `next undone item on user's ${l}`,    value: () => 'Review PR #50' },
      { field: 'COUNT',        descShape: l => `open item count on user's ${l}`,     value: () => '7' },
      { field: 'OLDEST',       descShape: l => `oldest open item on user's ${l}`,    value: () => 'File taxes' },
    ],
  },
  {
    source: 'COMMUTE', bindsToField: 'route_list', naming: 'field',
    slots: [
      { slot: 'HOME', valueLabel: 'home commute', value: 'home→work' },
      { slot: 'WORK', valueLabel: 'work commute', value: 'work→home' },
    ],
    fields: [
      { field: 'TIME',   descShape: l => `current door-to-door time for user's ${l}`, value: () => '38 min' },
      { field: 'STATUS', descShape: l => `service status for user's ${l}`,            value: () => 'minor delays' },
    ],
  },
  {
    source: 'FITNESS', bindsToField: 'metrics', naming: 'field',
    slots: [
      { slot: 'STEPS',  valueLabel: 'step counter',       value: 'steps' },
      { slot: 'SLEEP',  valueLabel: 'sleep tracker',      value: 'sleep' },
      { slot: 'HR',     valueLabel: 'heart rate monitor', value: 'hr' },
    ],
    fields: [
      { field: 'TODAY', descShape: l => `today's reading from user's ${l}`,         value: () => '8,402' },
      { field: 'GOAL',  descShape: l => `daily goal on user's ${l}`,                value: () => '10,000' },
    ],
  },
  {
    source: 'REPO', bindsToField: 'tracked_repos', naming: 'value',
    slots: [
      { slot: 'OPENCUES', valueLabel: 'opencues',     value: 'opencues' },
      { slot: 'CC',       valueLabel: 'claude-code',  value: 'claude-code' },
    ],
    fields: [
      { field: 'OPEN PRS',    descShape: l => `open PRs on ${l}`,                  value: () => '12' },
      { field: 'OPEN ISSUES', descShape: l => `open issues on ${l}`,               value: () => '34' },
    ],
  },
  // ─── Extended blank surface (to support n=128) ─────────────────────────
  {
    source: 'WEATHER', bindsToField: 'extra_cities', naming: 'field',
    slots: [
      { slot: 'HOMETOWN', valueLabel: 'hometown',   value: 'Cambridge' }, // distractor — collides with HOME slot
      { slot: 'OFFICE',   valueLabel: 'office',     value: 'London EC2' },
    ],
    fields: [
      { field: 'TEMP',       descShape: l => `current temperature in user's ${l}`,    value: () => '12°C' },
      { field: 'HUMIDITY',   descShape: l => `current humidity in user's ${l}`,       value: () => '64%' },
      { field: 'WIND',       descShape: l => `current wind speed in user's ${l}`,     value: () => '14 mph' },
    ],
  },
  {
    source: 'STOCK', bindsToField: 'watch_extra', naming: 'value',
    slots: [
      { slot: 'AMZN', valueLabel: 'AMZN', value: 'AMZN' },
      { slot: 'TSLA', valueLabel: 'TSLA', value: 'TSLA' },
      { slot: 'META', valueLabel: 'META', value: 'META' },
    ],
    fields: [
      { field: 'PRICE',  descShape: l => `current share price of ${l}`,             value: () => '$182.40' },
      { field: 'VOLUME', descShape: l => `today's trading volume for ${l}`,         value: () => '34.2M' },
    ],
  },
  {
    source: 'AIR', bindsToField: 'travel_airports', naming: 'value',
    slots: [
      { slot: 'LHR', valueLabel: 'Heathrow',    value: 'LHR' },
      { slot: 'JFK', valueLabel: 'JFK',         value: 'JFK' },
      { slot: 'NRT', valueLabel: 'Narita',      value: 'NRT' },
    ],
    fields: [
      { field: 'DELAY',  descShape: l => `current average departure delay at ${l}`, value: () => '22 min' },
      { field: 'TEMP',   descShape: l => `current temperature at ${l}`,             value: () => '11°C' },
    ],
  },
  {
    source: 'MEETING', bindsToField: 'calendars', naming: 'field',
    slots: [
      { slot: 'NEXT',     valueLabel: 'next scheduled meeting', value: 'next' },
      { slot: 'TODAY',    valueLabel: "today's meetings",       value: 'today' },
      { slot: 'TOMORROW', valueLabel: "tomorrow's meetings",    value: 'tomorrow' },
    ],
    fields: [
      { field: 'TITLE',   descShape: l => `title of ${l}`,                          value: () => 'Architecture sync' },
      { field: 'COUNT',   descShape: l => `count of ${l}`,                          value: () => '4' },
    ],
  },
  {
    source: 'SLACK', bindsToField: 'workspaces', naming: 'field',
    slots: [
      { slot: 'WORK',     valueLabel: 'work workspace',     value: 'work' },
      { slot: 'COMMUNITY',valueLabel: 'community workspace',value: 'community' },
    ],
    fields: [
      { field: 'UNREAD',     descShape: l => `unread count in user's ${l}`,         value: () => '23' },
      { field: 'TOP CHANNEL', descShape: l => `most-active channel in user's ${l}`, value: () => '#general' },
    ],
  },
  // Big multi-slot source — pushes pure-blank past n=128.
  {
    source: 'CITY', bindsToField: 'tracked_cities', naming: 'value',
    slots: [
      { slot: 'LDN', valueLabel: 'London',     value: 'London' },
      { slot: 'NYC', valueLabel: 'New York',   value: 'New York' },
      { slot: 'TYO', valueLabel: 'Tokyo',      value: 'Tokyo' },
      { slot: 'SFO', valueLabel: 'San Francisco', value: 'San Francisco' },
      { slot: 'PAR', valueLabel: 'Paris',      value: 'Paris' },
      { slot: 'BER', valueLabel: 'Berlin',     value: 'Berlin' },
      { slot: 'SIN', valueLabel: 'Singapore',  value: 'Singapore' },
      { slot: 'SYD', valueLabel: 'Sydney',     value: 'Sydney' },
      { slot: 'TOR', valueLabel: 'Toronto',    value: 'Toronto' },
    ],
    fields: [
      { field: 'TIME',     descShape: l => `current local time in ${l}`,            value: () => '14:32' },
      { field: 'WEATHER',  descShape: l => `current weather in ${l}`,               value: () => 'overcast' },
      { field: 'TZ',       descShape: l => `IANA timezone for ${l}`,                value: () => 'Europe/London' },
      { field: 'POPULATION', descShape: l => `population of ${l}`,                  value: () => '9M' },
    ],
  },
];

function blankPool(): MatrixToken[] {
  const out: MatrixToken[] = [];
  for (const spec of BLANK_SPECS) {
    for (const { slot, valueLabel } of spec.slots) {
      for (const f of spec.fields) {
        out.push({
          token: `[${spec.source} ${slot} ${f.field}]`,
          description: f.descShape(valueLabel),
          value: f.value(valueLabel),
          kind: 'blank',
          blankNaming: spec.naming,
          blankSource: spec.source.toLowerCase(),
          bindsToField: spec.bindsToField,
        });
      }
    }
  }
  return out;
}

const BLANK_POOL: ReadonlyArray<MatrixToken> = blankPool();

export const SUPPORTED_COUNTS = [4, 8, 16, 32, 64, 128] as const;
export type SupportedCount = typeof SUPPORTED_COUNTS[number];

export type CatalogKind = 'pure-sentinels' | 'pure-blank' | 'mixed';

/** Build a catalog of N tokens of the requested kind. Deterministic —
 *  same (kind, count) always returns the same token list (no shuffle).
 *  When N exceeds pool size we re-cycle by appending an index suffix to
 *  the description (token unchanged) — keeps the catalog distinct enough
 *  for the LLM without inventing implausible identity fields. */
export function buildCatalog(kind: CatalogKind, count: SupportedCount): MatrixToken[] {
  if (kind === 'pure-sentinels') {
    return SENTINEL_POOL.slice(0, count).map(s => ({ ...s, kind: 'sentinel' as const }));
  }
  if (kind === 'pure-blank') {
    if (count > BLANK_POOL.length) {
      throw new Error(`pure-blank catalog only has ${BLANK_POOL.length} tokens; requested ${count}`);
    }
    return BLANK_POOL.slice(0, count).map(t => ({ ...t }));
  }
  // mixed — interleave 50/50 starting from sentinels so the first few are
  // identity (more familiar) and parameterised blanks accumulate as count
  // grows. Matches the realistic adoption curve of the feature.
  const half = Math.ceil(count / 2);
  const sentinels = SENTINEL_POOL.slice(0, half).map(s => ({ ...s, kind: 'sentinel' as const }));
  const blanks = BLANK_POOL.slice(0, count - half).map(t => ({ ...t }));
  // interleave so the LLM doesn't see all sentinels first
  const out: MatrixToken[] = [];
  for (let i = 0; i < Math.max(sentinels.length, blanks.length); i++) {
    if (i < sentinels.length) out.push(sentinels[i]);
    if (i < blanks.length) out.push(blanks[i]);
  }
  return out.slice(0, count);
}

export function tokensOnly(catalog: MatrixToken[]): Set<string> {
  return new Set(catalog.map(t => t.token));
}

export function valuesOnly(catalog: MatrixToken[]): string[] {
  return catalog.map(t => t.value);
}

/** Ordering strategies for the catalog block. The LLM is documented to
 *  attend more strongly to the start and end of long contexts
 *  ("lost-in-the-middle"); this knob measures how much the catalog's
 *  position of the relevant token costs reliability. */
export type OrderStrategy =
  | 'natural'        // tokens in the order buildCatalog emits them
  | 'shuffle-seed'   // deterministic shuffle (seeded by count + kind)
  | 'expected-start' // place the case's expected token(s) at the head
  | 'expected-mid'   // place them in the middle (worst case)
  | 'expected-end';  // place them at the tail

/** Stable seeded shuffle (mulberry32) so the same params always produce
 *  the same order — bench results stay reproducible without depending
 *  on Math.random. */
export function shuffleSeeded<T>(arr: T[], seed: number): T[] {
  let s = seed >>> 0;
  const out = arr.slice();
  for (let i = out.length - 1; i > 0; i--) {
    s = (s + 0x6D2B79F5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    const r = ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    const j = Math.floor(r * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

/** Reorder a catalog so the expected tokens land at the requested
 *  position. `expectedSet` is the bench-supplied set of tokens that the
 *  current case expects to be emitted. */
export function reorderForExpected(
  catalog: MatrixToken[],
  expectedSet: Set<string>,
  strategy: OrderStrategy,
  seed: number,
): MatrixToken[] {
  if (strategy === 'natural') return catalog;
  if (strategy === 'shuffle-seed') return shuffleSeeded(catalog, seed);
  const expected = catalog.filter(t => expectedSet.has(t.token));
  const rest = catalog.filter(t => !expectedSet.has(t.token));
  if (strategy === 'expected-start') return [...expected, ...rest];
  if (strategy === 'expected-end')   return [...rest, ...expected];
  // mid
  const half = Math.floor(rest.length / 2);
  return [...rest.slice(0, half), ...expected, ...rest.slice(half)];
}
