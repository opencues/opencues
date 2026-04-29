/**
 * Realistic-shape test cases for the fluid-blank benchmark.
 *
 * Every case follows the REALISTIC PRIMARY USER PATH: the user types
 * a casual preamble + lookup phrase + `_`, the system fires before
 * they keep typing. Therefore: input ENDS at `_`. No trailing context
 * after `_`. No `_` before the lookup. No ambient-bracketed shapes.
 *
 * Synthetic robustness shapes (text after `_`, `_` mid-sentence,
 * trailing question stems, ambient brackets) lived here in earlier
 * iterations but were removed once we noticed nearly all flakes were
 * on shapes users don't actually produce.
 *
 * Topics span: unicode codepoints, hex/RGB color codes, HTTP status
 * codes, MIME types, default ports, code/regex syntax, HTML/CSS, unit
 * conversions, foreign-language translations, science (atomic, ph,
 * boiling/melting points), math, history, geography, entertainment,
 * food, biology, art history, plus 5 long-preamble cross-domain and
 * 5 max-length 30–45 word cases.
 */

export interface FluidBlankCase {
  id: string;
  category: 'inline' | 'trailing' | 'ambient' | 'multi-clause' | 'ambiguous' | 'no-question';
  input: string;
  expected: {
    /** Exact substring of input — must include the _ unless shouldFailSoft */
    span: string;
    /** Self-contained natural-language paraphrase P2 should produce */
    question: string;
    /** Canonical answer for P3 */
    answer: string;
    /** Acceptable substring variations (case-insensitive) */
    answerAlternates?: string[];
    /** True for cases where P1 should refuse to segment */
    shouldFailSoft?: boolean;
  };
}

export const CASES: FluidBlankCase[] = [
  // ─── UNICODE CODEPOINTS ────────────────────────────────────────────────
  {
    id: 'r-unicode-underscore',
    category: 'inline',
    input: 'writing my doc unicode for underscore _',
    expected: { span: 'unicode for underscore _', question: 'What is the Unicode codepoint for the underscore character?', answer: 'U+005F', answerAlternates: ['005F', '0x5F', '5F'] },
  },
  {
    id: 'r-unicode-emdash',
    category: 'inline',
    input: 'writing docs unicode for em dash _',
    expected: { span: 'unicode for em dash _', question: 'What is the Unicode codepoint for the em dash?', answer: 'U+2014', answerAlternates: ['2014', '—', '&mdash;', '0x2014'] },
  },
  {
    id: 'r-unicode-ampersand',
    category: 'inline',
    input: 'html cleanup unicode for ampersand _',
    expected: { span: 'unicode for ampersand _', question: 'What is the Unicode codepoint for the ampersand?', answer: 'U+0026', answerAlternates: ['0026', '&', '&amp;', '0x26'] },
  },
  {
    id: 'r-unicode-copyright',
    category: 'inline',
    input: 'wedding invite design unicode for copyright symbol _',
    expected: { span: 'unicode for copyright symbol _', question: 'What is the Unicode codepoint for the copyright symbol?', answer: 'U+00A9', answerAlternates: ['00A9', '©', '&copy;', '0xA9'] },
  },
  {
    id: 'r-unicode-euro',
    category: 'inline',
    input: 'recipe blog unicode for euro sign _',
    expected: { span: 'unicode for euro sign _', question: 'What is the Unicode codepoint for the euro sign?', answer: 'U+20AC', answerAlternates: ['20AC', '€', '&euro;', '0x20AC'] },
  },
  {
    id: 'r-unicode-nbsp',
    category: 'inline',
    input: 'html email layout unicode for non-breaking space _',
    expected: { span: 'unicode for non-breaking space _', question: 'What is the Unicode codepoint for the non-breaking space?', answer: 'U+00A0', answerAlternates: ['00A0', '&nbsp;', '0xA0', 'NBSP'] },
  },
  {
    id: 'r-unicode-heart',
    category: 'inline',
    input: 'card design unicode for heart symbol _',
    expected: { span: 'unicode for heart symbol _', question: 'What is the Unicode codepoint for the heart symbol?', answer: 'U+2764', answerAlternates: ['2764', '♥', '&hearts;', 'U+2665', '2665'] },
  },
  {
    id: 'r-unicode-backslash',
    category: 'inline',
    input: 'writing docs unicode for backslash _',
    expected: { span: 'unicode for backslash _', question: 'What is the Unicode codepoint for the backslash?', answer: 'U+005C', answerAlternates: ['005C', '\\\\', '0x5C'] },
  },
  {
    id: 'r-unicode-at',
    category: 'inline',
    input: 'email parser unicode for at sign _',
    expected: { span: 'unicode for at sign _', question: 'What is the Unicode codepoint for the at sign?', answer: 'U+0040', answerAlternates: ['0040', '@', '0x40'] },
  },
  {
    id: 'r-unicode-tilde',
    category: 'inline',
    input: 'config file unicode for tilde _',
    expected: { span: 'unicode for tilde _', question: 'What is the Unicode codepoint for the tilde?', answer: 'U+007E', answerAlternates: ['007E', '~', '0x7E'] },
  },
  {
    id: 'r-unicode-degree',
    category: 'inline',
    input: 'weather doc unicode for degree symbol _',
    expected: { span: 'unicode for degree symbol _', question: 'What is the Unicode codepoint for the degree symbol?', answer: 'U+00B0', answerAlternates: ['00B0', '°', '&deg;', '0xB0'] },
  },

  // ─── HEX / RGB COLORS ──────────────────────────────────────────────────
  {
    id: 'r-hex-red',
    category: 'inline',
    input: 'css project hex for red _',
    expected: { span: 'hex for red _', question: 'What is the hex code for red?', answer: '#FF0000', answerAlternates: ['#ff0000', '#f00', 'FF0000'] },
  },
  {
    id: 'r-hex-tomato',
    category: 'inline',
    input: 'css project hex for tomato red _',
    expected: { span: 'hex for tomato red _', question: 'What is the hex code for tomato red?', answer: '#FF6347', answerAlternates: ['#ff6347', 'FF6347', 'tomato'] },
  },
  {
    id: 'r-hex-hot-pink',
    category: 'inline',
    input: 'valentines card draft hex for hot pink _',
    expected: { span: 'hex for hot pink _', question: 'What is the hex code for hot pink?', answer: '#FF69B4', answerAlternates: ['#ff69b4', 'FF69B4', 'ff69b4', 'HotPink'] },
  },
  {
    id: 'r-hex-slate',
    category: 'inline',
    input: 'dashboard mockup hex for slate gray _',
    expected: { span: 'hex for slate gray _', question: 'What is the hex code for slate gray?', answer: '#708090', answerAlternates: ['#708090', '708090', 'slategray', 'SlateGray'] },
  },
  {
    id: 'r-rgb-sky',
    category: 'inline',
    input: 'design moodboard rgb for sky blue _',
    expected: { span: 'rgb for sky blue _', question: 'What is the RGB value for sky blue?', answer: '135,206,235', answerAlternates: ['#87CEEB', 'rgb(135,206,235)', '135 206 235'] },
  },
  {
    id: 'r-rgb-navy',
    category: 'inline',
    input: 'logo work rgb for navy blue _',
    expected: { span: 'rgb for navy blue _', question: 'What is the RGB value for navy blue?', answer: '0,0,128', answerAlternates: ['#000080', 'rgb(0,0,128)', '0 0 128'] },
  },
  {
    id: 'r-rgb-forest-green',
    category: 'inline',
    input: 'logo redesign rgb for forest green _',
    expected: { span: 'rgb for forest green _', question: 'What is the RGB value for forest green?', answer: '34,139,34', answerAlternates: ['#228B22', 'rgb(34,139,34)', '34 139 34'] },
  },
  {
    id: 'r-rgb-goldenrod',
    category: 'inline',
    input: 'autumn theme css rgb for goldenrod _',
    expected: { span: 'rgb for goldenrod _', question: 'What is the RGB value for goldenrod?', answer: '218,165,32', answerAlternates: ['#DAA520', 'rgb(218,165,32)', 'DAA520'] },
  },
  {
    id: 'r-rgb-cornflower',
    category: 'inline',
    input: 'css palette rgb for cornflower blue _',
    expected: { span: 'rgb for cornflower blue _', question: 'What is the RGB value for cornflower blue?', answer: '100,149,237', answerAlternates: ['#6495ED', 'rgb(100,149,237)', '100 149 237'] },
  },

  // ─── HTTP STATUS CODES ─────────────────────────────────────────────────
  {
    id: 'r-http-404',
    category: 'inline',
    input: 'debugging today http status for not found _',
    expected: { span: 'http status for not found _', question: 'What is the HTTP status code for not found?', answer: '404' },
  },
  {
    id: 'r-http-401',
    category: 'inline',
    input: 'auth flow bug http status for unauthorized _',
    expected: { span: 'http status for unauthorized _', question: 'What is the HTTP status code for unauthorized?', answer: '401' },
  },
  {
    id: 'r-http-403',
    category: 'inline',
    input: 'auth bug fixing http status for forbidden _',
    expected: { span: 'http status for forbidden _', question: 'What is the HTTP status code for forbidden?', answer: '403' },
  },
  {
    id: 'r-http-429',
    category: 'inline',
    input: 'rate limiter docs http status for too many requests _',
    expected: { span: 'http status for too many requests _', question: 'What is the HTTP status code for too many requests?', answer: '429' },
  },
  {
    id: 'r-http-500',
    category: 'inline',
    input: 'on-call rotation http status for internal server error _',
    expected: { span: 'http status for internal server error _', question: 'What is the HTTP status code for internal server error?', answer: '500' },
  },
  {
    id: 'r-http-502',
    category: 'inline',
    input: 'outage triage http status for bad gateway _',
    expected: { span: 'http status for bad gateway _', question: 'What is the HTTP status code for bad gateway?', answer: '502' },
  },
  {
    id: 'r-http-503',
    category: 'inline',
    input: 'monitoring alert http status for service unavailable _',
    expected: { span: 'http status for service unavailable _', question: 'What is the HTTP status code for service unavailable?', answer: '503' },
  },
  {
    id: 'r-http-301',
    category: 'inline',
    input: 'site migration http status for moved permanently _',
    expected: { span: 'http status for moved permanently _', question: 'What is the HTTP status code for moved permanently?', answer: '301' },
  },
  {
    id: 'r-http-201',
    category: 'inline',
    input: 'rest api spec http status for created _',
    expected: { span: 'http status for created _', question: 'What is the HTTP status code for created?', answer: '201' },
  },

  // ─── MIME TYPES ────────────────────────────────────────────────────────
  {
    id: 'r-mime-css',
    category: 'inline',
    input: 'content type lookup mime type for css _',
    expected: { span: 'mime type for css _', question: 'What is the MIME type for CSS?', answer: 'text/css' },
  },
  {
    id: 'r-mime-png',
    category: 'inline',
    input: 'api docs mime type for png _',
    expected: { span: 'mime type for png _', question: 'What is the MIME type for PNG?', answer: 'image/png' },
  },
  {
    id: 'r-mime-json',
    category: 'inline',
    input: "api headers what's mime type for json _",
    expected: { span: "what's mime type for json _", question: 'What is the MIME type for JSON?', answer: 'application/json', answerAlternates: ['application/json; charset=utf-8'] },
  },

  // ─── DEFAULT PORTS ─────────────────────────────────────────────────────
  {
    id: 'r-port-postgres',
    category: 'inline',
    input: 'config review default port for postgres _',
    expected: { span: 'default port for postgres _', question: 'What is the default port for PostgreSQL?', answer: '5432' },
  },
  {
    id: 'r-port-mysql',
    category: 'inline',
    input: "docker compose what's default port for mysql _",
    expected: { span: "what's default port for mysql _", question: 'What is the default port for MySQL?', answer: '3306' },
  },
  {
    id: 'r-port-redis',
    category: 'inline',
    input: 'cache layer setup default port for redis _',
    expected: { span: 'default port for redis _', question: 'What is the default port for Redis?', answer: '6379' },
  },
  {
    id: 'r-port-ssh',
    category: 'inline',
    input: 'firewall rules default ssh port _',
    expected: { span: 'default ssh port _', question: 'What is the default SSH port?', answer: '22' },
  },
  {
    id: 'r-port-https',
    category: 'inline',
    input: 'firewall rules default port for https _',
    expected: { span: 'default port for https _', question: 'What is the default port for HTTPS?', answer: '443' },
  },

  // ─── CODE / SYNTAX ─────────────────────────────────────────────────────
  {
    id: 'r-regex-digit',
    category: 'inline',
    input: 'form validation regex for matching a single digit _',
    expected: { span: 'regex for matching a single digit _', question: 'What is the regex for matching a single digit?', answer: '\\d', answerAlternates: ['[0-9]', '\\d{1}', '/\\d/'] },
  },
  {
    id: 'r-escape-newline',
    category: 'inline',
    input: "string parsing what's escape sequence for newline character _",
    expected: { span: "what's escape sequence for newline character _", question: 'What is the escape sequence for the newline character?', answer: '\\n', answerAlternates: ['\\\\n', '0x0A', 'LF', 'line feed'] },
  },
  {
    id: 'r-html-lt',
    category: 'inline',
    input: 'blog post escaping html entity for less than _',
    expected: { span: 'html entity for less than _', question: 'What is the HTML entity for less than?', answer: '&lt;', answerAlternates: ['lt', '&lt', '&#60;'] },
  },
  {
    id: 'r-html-br',
    category: 'inline',
    input: 'newsletter cleanup html element for line break _',
    expected: { span: 'html element for line break _', question: 'What HTML element creates a line break?', answer: '<br>', answerAlternates: ['<br/>', '<br />', 'br'] },
  },
  {
    id: 'r-css-bold',
    category: 'inline',
    input: 'stylesheet refactor css property for making text bold _',
    expected: { span: 'css property for making text bold _', question: 'What CSS property makes text bold?', answer: 'font-weight', answerAlternates: ['font-weight: bold', 'font-weight:bold', 'font-weight: 700'] },
  },
  {
    id: 'r-html-alt',
    category: 'inline',
    input: 'a11y audit html attribute for image alt text _',
    expected: { span: 'html attribute for image alt text _', question: 'What HTML attribute holds image alt text?', answer: 'alt', answerAlternates: ['alt attribute', 'alt=""'] },
  },
  {
    id: 'r-bytes-kb',
    category: 'inline',
    input: 'storage planning how many bytes in a kilobyte _',
    expected: { span: 'how many bytes in a kilobyte _', question: 'How many bytes are in a kilobyte?', answer: '1024', answerAlternates: ['1000', '1024 (binary)', '2^10'] },
  },
  {
    id: 'r-ms-second',
    category: 'inline',
    input: 'animation timing how many milliseconds in a second _',
    expected: { span: 'how many milliseconds in a second _', question: 'How many milliseconds are in a second?', answer: '1000' },
  },

  // ─── UNITS / NUMBERS ───────────────────────────────────────────────────
  {
    id: 'r-feet-mile',
    category: 'inline',
    input: 'trail map prep how many feet in a mile _',
    expected: { span: 'how many feet in a mile _', question: 'How many feet are in a mile?', answer: '5280', answerAlternates: ['5,280'] },
  },
  {
    id: 'r-cups-pint',
    category: 'inline',
    input: 'recipe scaling how many cups in a pint _',
    expected: { span: 'how many cups in a pint _', question: 'How many cups are in a pint?', answer: '2' },
  },
  {
    id: 'r-secs-hour',
    category: 'inline',
    input: 'schedule math how many seconds in an hour _',
    expected: { span: 'how many seconds in an hour _', question: 'How many seconds are in an hour?', answer: '3600', answerAlternates: ['3,600'] },
  },
  {
    id: 'r-cm-inch',
    category: 'inline',
    input: 'tailor notes how many centimeters in an inch _',
    expected: { span: 'how many centimeters in an inch _', question: 'How many centimeters are in an inch?', answer: '2.54' },
  },
  {
    id: 'r-grams-pound',
    category: 'inline',
    input: 'shipping calc how many grams in a pound _',
    expected: { span: 'how many grams in a pound _', question: 'How many grams are in a pound?', answer: '453.59', answerAlternates: ['454', '453.6', '~454'] },
  },
  {
    id: 'r-100c-f',
    category: 'inline',
    input: 'recipe testing 100 celsius in fahrenheit _',
    expected: { span: '100 celsius in fahrenheit _', question: 'What is 100 Celsius in Fahrenheit?', answer: '212', answerAlternates: ['212 F', '212°F'] },
  },
  {
    id: 'r-350f-c',
    category: 'inline',
    input: "oven temp what's 350 fahrenheit in celsius _",
    expected: { span: '350 fahrenheit in celsius _', question: 'What is 350 Fahrenheit in Celsius?', answer: '177', answerAlternates: ['176.67', '177°C', '180', '175'] },
  },
  {
    id: 'r-5mi-km',
    category: 'inline',
    input: 'running tracker 5 miles in km _',
    expected: { span: '5 miles in km _', question: 'How many kilometers is 5 miles?', answer: '8.05', answerAlternates: ['8.0467', '8.04', '8 km', '~8'] },
  },
  {
    id: 'r-tbsp-cup',
    category: 'inline',
    input: 'baking project how many tablespoons in a cup _',
    expected: { span: 'how many tablespoons in a cup _', question: 'How many tablespoons are in a cup?', answer: '16' },
  },

  // ─── TRANSLATIONS ──────────────────────────────────────────────────────
  {
    id: 'r-spanish-dog',
    category: 'inline',
    input: 'flash cards for kids spanish word for dog _',
    expected: { span: 'spanish word for dog _', question: 'What is the Spanish word for dog?', answer: 'perro' },
  },
  {
    id: 'r-french-love',
    category: 'inline',
    input: 'anniversary card french word for love _',
    expected: { span: 'french word for love _', question: 'What is the French word for love?', answer: 'amour', answerAlternates: ["l'amour"] },
  },
  {
    id: 'r-german-water',
    category: 'inline',
    input: 'trip phrasebook german word for water _',
    expected: { span: 'german word for water _', question: 'What is the German word for water?', answer: 'wasser', answerAlternates: ['Wasser'] },
  },
  {
    id: 'r-japanese-cat',
    category: 'inline',
    input: 'sushi menu illustration japanese word for cat _',
    expected: { span: 'japanese word for cat _', question: 'What is the Japanese word for cat?', answer: 'neko', answerAlternates: ['猫', 'ネコ'] },
  },
  {
    id: 'r-arabic-peace',
    category: 'inline',
    input: 'interfaith poster arabic word for peace _',
    expected: { span: 'arabic word for peace _', question: 'What is the Arabic word for peace?', answer: 'salam', answerAlternates: ['salaam', 'السلام'] },
  },
  {
    id: 'r-hello-french',
    category: 'inline',
    input: 'email signoff how do you say hello in french _',
    expected: { span: 'how do you say hello in french _', question: 'How do you say hello in French?', answer: 'bonjour', answerAlternates: ['Bonjour', 'salut'] },
  },
  {
    id: 'r-water-spanish',
    category: 'inline',
    input: 'spanish class water in spanish _',
    expected: { span: 'water in spanish _', question: 'What is the Spanish word for water?', answer: 'agua', answerAlternates: ['el agua'] },
  },
  {
    id: 'r-thank-japanese',
    category: 'inline',
    input: 'subtitling project thank you in japanese romaji _',
    expected: { span: 'thank you in japanese romaji _', question: 'How do you say thank you in Japanese romaji?', answer: 'arigatou', answerAlternates: ['arigato', 'arigatou gozaimasu'] },
  },
  {
    id: 'r-formal-german',
    category: 'inline',
    input: 'german homework formal you in german _',
    expected: { span: 'formal you in german _', question: 'What is the formal "you" in German?', answer: 'Sie' },
  },
  {
    id: 'r-cheers-italian',
    category: 'inline',
    input: 'trip prep cheers in italian _',
    expected: { span: 'cheers in italian _', question: 'How do you say cheers in Italian?', answer: 'salute', answerAlternates: ['cin cin', 'alla salute'] },
  },

  // ─── SCIENCE ───────────────────────────────────────────────────────────
  {
    id: 'r-atomic-oxygen',
    category: 'inline',
    input: 'chem homework atomic number of oxygen _',
    expected: { span: 'atomic number of oxygen _', question: 'What is the atomic number of oxygen?', answer: '8' },
  },
  {
    id: 'r-atomic-gold',
    category: 'inline',
    input: 'chem homework atomic number of gold _',
    expected: { span: 'atomic number of gold _', question: 'What is the atomic number of gold?', answer: '79' },
  },
  {
    id: 'r-atomic-nitrogen',
    category: 'inline',
    input: 'chem study guide atomic mass of nitrogen _',
    expected: { span: 'atomic mass of nitrogen _', question: 'What is the atomic mass of nitrogen?', answer: '14.007', answerAlternates: ['14', '14.01'] },
  },
  {
    id: 'r-water-ph',
    category: 'inline',
    input: 'chem class quiz ph of pure water _',
    expected: { span: 'ph of pure water _', question: 'What is the pH of pure water?', answer: '7' },
  },
  {
    id: 'r-stomach-ph',
    category: 'inline',
    input: 'med school prep ph of stomach acid _',
    expected: { span: 'ph of stomach acid _', question: 'What is the pH of stomach acid?', answer: '1.5-2', answerAlternates: ['2', '1.5', '1.5-3.5'] },
  },
  {
    id: 'r-helium-boil',
    category: 'inline',
    input: 'cryogenics paper boiling point of helium in celsius _',
    expected: { span: 'boiling point of helium in celsius _', question: 'What is the boiling point of helium in Celsius?', answer: '-269', answerAlternates: ['-268.93', 'minus 269'] },
  },
  {
    id: 'r-iron-melt',
    category: 'inline',
    input: 'metallurgy notes melting point of iron in celsius _',
    expected: { span: 'melting point of iron in celsius _', question: 'What is the melting point of iron in Celsius?', answer: '1538', answerAlternates: ['1535', '1500-1538'] },
  },
  {
    id: 'r-water-boil',
    category: 'inline',
    input: 'kettle science boiling point of water in celsius _',
    expected: { span: 'boiling point of water in celsius _', question: 'What is the boiling point of water in Celsius?', answer: '100' },
  },
  {
    id: 'r-teeth-adult',
    category: 'inline',
    input: 'dental chart number of teeth in adult human _',
    expected: { span: 'number of teeth in adult human _', question: 'How many teeth does an adult human have?', answer: '32' },
  },

  // ─── MATH ──────────────────────────────────────────────────────────────
  {
    id: 'r-2-plus-2',
    category: 'inline',
    input: 'kids homework 2 plus 2 _',
    expected: { span: '2 plus 2 _', question: 'What is 2 plus 2?', answer: '4', answerAlternates: ['four'] },
  },
  {
    id: 'r-sqrt-144',
    category: 'inline',
    input: 'math homework square root of 144 _',
    expected: { span: 'square root of 144 _', question: 'What is the square root of 144?', answer: '12' },
  },
  {
    id: 'r-pi-5dp',
    category: 'inline',
    input: 'worksheet pi to 5 decimals _',
    expected: { span: 'pi to 5 decimals _', question: 'What is pi to 5 decimal places?', answer: '3.14159' },
  },

  // ─── HISTORY ───────────────────────────────────────────────────────────
  {
    id: 'r-shakespeare-died',
    category: 'inline',
    input: 'lecture notes year shakespeare died _',
    expected: { span: 'year shakespeare died _', question: 'What year did Shakespeare die?', answer: '1616' },
  },
  {
    id: 'r-apollo-1969',
    category: 'inline',
    input: 'trivia tonight year apollo 11 landed on the moon _',
    expected: { span: 'year apollo 11 landed on the moon _', question: 'What year did Apollo 11 land on the Moon?', answer: '1969' },
  },
  {
    id: 'r-einstein-nobel',
    category: 'inline',
    input: 'physics paper year einstein won nobel _',
    expected: { span: 'year einstein won nobel _', question: 'What year did Einstein win the Nobel Prize?', answer: '1921' },
  },
  {
    id: 'r-berlin-wall',
    category: 'inline',
    input: 'history podcast year the berlin wall fell _',
    expected: { span: 'year the berlin wall fell _', question: 'What year did the Berlin Wall fall?', answer: '1989' },
  },
  {
    id: 'r-iphone-launch',
    category: 'inline',
    input: 'tech timeline year the first iphone launched _',
    expected: { span: 'year the first iphone launched _', question: 'What year did the first iPhone launch?', answer: '2007' },
  },
  {
    id: 'r-america-indep',
    category: 'inline',
    input: 'july 4 essay year america declared independence _',
    expected: { span: 'year america declared independence _', question: 'What year did America declare independence?', answer: '1776' },
  },
  {
    id: 'r-penicillin',
    category: 'inline',
    input: 'biology paper inventor of penicillin _',
    expected: { span: 'inventor of penicillin _', question: 'Who invented penicillin?', answer: 'Alexander Fleming', answerAlternates: ['Fleming'] },
  },
  {
    id: 'r-fb-founder',
    category: 'inline',
    input: 'tech bio entry founder of facebook _',
    expected: { span: 'founder of facebook _', question: 'Who founded Facebook?', answer: 'Mark Zuckerberg', answerAlternates: ['Zuckerberg', 'Zuck'] },
  },

  // ─── GEOGRAPHY ─────────────────────────────────────────────────────────
  {
    id: 'r-canada-cap',
    category: 'inline',
    input: 'geography quiz capital of canada _',
    expected: { span: 'capital of canada _', question: 'What is the capital of Canada?', answer: 'Ottawa' },
  },
  {
    id: 'r-france-cap',
    category: 'inline',
    input: 'trivia tonight capital of france _',
    expected: { span: 'capital of france _', question: 'What is the capital of France?', answer: 'Paris' },
  },
  {
    id: 'r-japan-cap',
    category: 'inline',
    input: 'asia trip planning capital of japan _',
    expected: { span: 'capital of japan _', question: 'What is the capital of Japan?', answer: 'Tokyo' },
  },
  {
    id: 'r-everest-m',
    category: 'inline',
    input: 'geography quiz height of mount everest in meters _',
    expected: { span: 'height of mount everest in meters _', question: 'What is the height of Mount Everest in meters?', answer: '8848', answerAlternates: ['8849', '8848.86'] },
  },
  {
    id: 'r-denali',
    category: 'inline',
    input: 'alaska trip planning tallest mountain in north america _',
    expected: { span: 'tallest mountain in north america _', question: 'What is the tallest mountain in North America?', answer: 'Denali', answerAlternates: ['Mount McKinley', 'Mt. McKinley'] },
  },
  {
    id: 'r-amazon-river',
    category: 'inline',
    input: 'south america trip longest river in south america _',
    expected: { span: 'longest river in south america _', question: 'What is the longest river in South America?', answer: 'Amazon', answerAlternates: ['Amazon River'] },
  },
  {
    id: 'r-largest-country',
    category: 'inline',
    input: 'atlas trivia largest country by area _',
    expected: { span: 'largest country by area _', question: 'What is the largest country by area?', answer: 'Russia' },
  },
  {
    id: 'r-vatican',
    category: 'inline',
    input: 'europe trip planning smallest country in europe _',
    expected: { span: 'smallest country in europe _', question: 'What is the smallest country in Europe?', answer: 'Vatican City', answerAlternates: ['Vatican'] },
  },

  // ─── ENTERTAINMENT / POP CULTURE ───────────────────────────────────────
  {
    id: 'r-jurassic-dir',
    category: 'inline',
    input: 'movie marathon weekend ahead with the family thinking we will go through some classics director of jurassic park _',
    expected: { span: 'director of jurassic park _', question: 'Who directed Jurassic Park?', answer: 'Steven Spielberg', answerAlternates: ['Spielberg'] },
  },
  {
    id: 'r-jagger',
    category: 'inline',
    input: 'tribute band setlist work researching the originals lead singer of the rolling stones _',
    expected: { span: 'lead singer of the rolling stones _', question: 'Who is the lead singer of the Rolling Stones?', answer: 'Mick Jagger', answerAlternates: ['Jagger'] },
  },
  {
    id: 'r-best-actor',
    category: 'inline',
    input: 'oscars rewatch and trivia game tonight winner of best actor 2023 oscars _',
    expected: { span: 'winner of best actor 2023 oscars _', question: 'Who won Best Actor at the 2023 Oscars?', answer: 'Brendan Fraser', answerAlternates: ['Fraser'] },
  },
  {
    id: 'r-friends-eps',
    category: 'inline',
    input: 'writing a tribute piece for sitcom history magazine number of episodes in friends _',
    expected: { span: 'number of episodes in friends _', question: 'How many episodes are in Friends?', answer: '236' },
  },
  {
    id: 'r-hp-protag',
    category: 'inline',
    input: 'kids party theme planning superhero versus wizard battles main character in harry potter _',
    expected: { span: 'main character in harry potter _', question: 'Who is the main character in Harry Potter?', answer: 'Harry Potter', answerAlternates: ['Harry', 'Harry James Potter'] },
  },

  // ─── MISC LONG-PREAMBLE ────────────────────────────────────────────────
  {
    id: 'r-spider-legs',
    category: 'inline',
    input: 'halloween decorations buying plastic spiders for the porch number of legs on a spider _',
    expected: { span: 'number of legs on a spider _', question: 'How many legs does a spider have?', answer: '8', answerAlternates: ['eight'] },
  },
  {
    id: 'r-st-jude',
    category: 'inline',
    input: 'religious studies homework on saints and their domains patron saint of lost causes _',
    expected: { span: 'patron saint of lost causes _', question: 'Who is the patron saint of lost causes?', answer: 'Saint Jude', answerAlternates: ['St. Jude', 'Jude'] },
  },
  {
    id: 'r-greyhound',
    category: 'inline',
    input: 'dog show planning weekend for the speed event fastest dog breed _',
    expected: { span: 'fastest dog breed _', question: 'What is the fastest dog breed?', answer: 'Greyhound', answerAlternates: ['greyhound'] },
  },
  {
    id: 'r-india-flower',
    category: 'inline',
    input: 'cultural studies project on national symbols around the world national flower of india _',
    expected: { span: 'national flower of india _', question: 'What is the national flower of India?', answer: 'Lotus', answerAlternates: ['lotus'] },
  },
  {
    id: 'r-edison',
    category: 'inline',
    input: 'elementary school science fair on inventors and their famous works inventor of the lightbulb _',
    expected: { span: 'inventor of the lightbulb _', question: 'Who invented the lightbulb?', answer: 'Thomas Edison', answerAlternates: ['Edison'] },
  },

  // ─── MAX-LENGTH PREAMBLE (30-45 words) ─────────────────────────────────
  {
    id: 'r-max-pacific',
    category: 'inline',
    input: 'writing a travel blog post about my recent trip to australia and how the flight from san francisco took ages and the weather there was honestly amazing for that time of year largest ocean on earth _',
    expected: { span: 'largest ocean on earth _', question: 'What is the largest ocean on Earth?', answer: 'Pacific', answerAlternates: ['Pacific Ocean', 'the Pacific'] },
  },
  {
    id: 'r-max-ny-london',
    category: 'inline',
    input: 'summer travel planning thinking about a london trip but the price keeps fluctuating and i need to figure out the budget for the flight and hotel and a few extra excursions distance from new york to london in km _',
    expected: { span: 'distance from new york to london in km _', question: 'What is the distance from New York to London in km?', answer: '5570', answerAlternates: ['~5500', '5585', '5,570'] },
  },
  {
    id: 'r-max-hand-bones',
    category: 'inline',
    input: 'anatomy class for nursing students this semester is heavy and the lab work has been intense with cadaver dissections every other tuesday morning number of bones in human hand _',
    expected: { span: 'number of bones in human hand _', question: 'How many bones are in the human hand?', answer: '27' },
  },
  {
    id: 'r-max-goldfish',
    category: 'inline',
    input: 'kids pet store trip after school today they want to bring home a fish and the husband is finally on board after months of negotiating lifespan of a goldfish in years _',
    expected: { span: 'lifespan of a goldfish in years _', question: 'What is the lifespan of a goldfish in years?', answer: '10-15', answerAlternates: ['10', '15', '10 to 15'] },
  },
  {
    id: 'r-max-mongolia',
    category: 'inline',
    input: 'geography club world capitals quiz prep marathon all weekend trying to memorize the more obscure ones for the regional competition next saturday capital of mongolia _',
    expected: { span: 'capital of mongolia _', question: 'What is the capital of Mongolia?', answer: 'Ulaanbaatar', answerAlternates: ['Ulan Bator'] },
  },

  // ─── MULTI-CLAUSE / AMBIGUOUS (rare but realistic — _ at end) ─────────
  {
    id: 'multi-clause-silver',
    category: 'multi-clause',
    input: 'the chemical symbol for gold is au and the symbol for silver is _',
    expected: { span: 'the symbol for silver is _', question: 'What is the chemical symbol for silver?', answer: 'Ag' },
  },
  {
    id: 'multi-lookup-sad',
    category: 'multi-clause',
    input: 'looking up better word for happy and better word for sad _',
    expected: { span: 'better word for sad _', question: 'What is a better word for sad?', answer: 'melancholy', answerAlternates: ['sorrowful', 'gloomy', 'downcast', 'blue', 'unhappy'] },
  },
  {
    id: 'ambiguous-river',
    category: 'ambiguous',
    input: 'the capital of france is paris and the largest river is _',
    expected: { span: 'the largest river is _', question: 'What is the largest river in France?', answer: 'Loire', answerAlternates: ['the Loire', 'Loire River'] },
  },

  // ─── INPUTS WITH QUESTION MARKS (?) ─────────────────────────────────────
  // Real users sometimes type a literal question + ?, then _. Tests
  // whether the ? itself acts as a strong "lookup ends here" disambiguator.
  {
    id: 'r-q-france-cap',
    category: 'inline',
    input: "geography club what's the capital of france? _",
    expected: { span: 'capital of france? _', question: 'What is the capital of France?', answer: 'Paris' },
  },
  {
    id: 'r-q-planets',
    category: 'inline',
    input: 'astronomy worksheet how many planets in our solar system? _',
    expected: { span: 'how many planets in our solar system? _', question: 'How many planets are in our solar system?', answer: '8', answerAlternates: ['eight'] },
  },
  {
    id: 'r-q-mona-lisa',
    category: 'inline',
    input: 'writing trivia who painted the mona lisa? _',
    expected: { span: 'who painted the mona lisa? _', question: 'Who painted the Mona Lisa?', answer: 'Leonardo da Vinci', answerAlternates: ['da Vinci', 'Leonardo'] },
  },
  {
    id: 'r-q-eiffel',
    category: 'inline',
    input: 'paris trip planning when was the eiffel tower built? _',
    expected: { span: 'when was the eiffel tower built? _', question: 'When was the Eiffel Tower built?', answer: '1889' },
  },
  {
    id: 'r-q-light-speed',
    category: 'inline',
    input: "physics class what's the speed of light in m/s? _",
    expected: { span: 'speed of light in m/s? _', question: 'What is the speed of light in m/s?', answer: '299792458', answerAlternates: ['299,792,458', '3×10^8', '3 × 10^8'] },
  },
  {
    id: 'r-q-everest-ft',
    category: 'inline',
    input: 'geography quiz how tall is mount everest in feet? _',
    expected: { span: 'how tall is mount everest in feet? _', question: 'How tall is Mount Everest in feet?', answer: '29,032', answerAlternates: ['29032', '29029', '29031.69'] },
  },
  {
    id: 'r-q-wwii-end',
    category: 'inline',
    input: 'history homework when did wwii end? _',
    expected: { span: 'when did wwii end? _', question: 'When did World War II end?', answer: '1945' },
  },

  // ─── QUESTION MARKS WITHOUT what's / how ────────────────────────────────
  // Direct topic + ? — tests that ? alone (no interrogative) acts as
  // a "lookup ends here" marker.
  {
    id: 'r-q-canberra',
    category: 'inline',
    input: 'geo trivia capital of australia? _',
    expected: { span: 'capital of australia? _', question: 'What is the capital of Australia?', answer: 'Canberra' },
  },
  {
    id: 'r-q-carbon-atomic',
    category: 'inline',
    input: 'chem quiz atomic number of carbon? _',
    expected: { span: 'atomic number of carbon? _', question: 'What is the atomic number of carbon?', answer: '6' },
  },
  {
    id: 'r-q-sound-speed',
    category: 'inline',
    input: 'physics class speed of sound in m/s? _',
    expected: { span: 'speed of sound in m/s? _', question: 'What is the speed of sound in m/s?', answer: '343', answerAlternates: ['~343', '340', '343 m/s'] },
  },
  {
    id: 'r-q-moon-landing',
    category: 'inline',
    input: 'history homework year of moon landing? _',
    expected: { span: 'year of moon landing? _', question: 'What year was the moon landing?', answer: '1969' },
  },
  {
    id: 'r-q-burj',
    category: 'inline',
    input: 'skyline article tallest building in the world? _',
    expected: { span: 'tallest building in the world? _', question: 'What is the tallest building in the world?', answer: 'Burj Khalifa', answerAlternates: ['Burj', 'the Burj'] },
  },
  {
    id: 'r-q-beethoven-key',
    category: 'inline',
    input: "music quiz key of beethoven's 5th? _",
    expected: { span: "key of beethoven's 5th? _", question: "What key is Beethoven's 5th in?", answer: 'C minor', answerAlternates: ['Cm', 'C-minor'] },
  },
  {
    id: 'r-q-zeus-wife',
    category: 'inline',
    input: "mythology trivia name of zeus's wife? _",
    expected: { span: "name of zeus's wife? _", question: "What is the name of Zeus's wife?", answer: 'Hera' },
  },
  {
    id: 'r-q-french-rev',
    category: 'inline',
    input: 'history class french revolution year? _',
    expected: { span: 'french revolution year? _', question: 'What year did the French Revolution start?', answer: '1789' },
  },
  {
    id: 'r-q-purple-hex',
    category: 'inline',
    input: 'css palette hex for purple? _',
    expected: { span: 'hex for purple? _', question: 'What is the hex code for purple?', answer: '#800080', answerAlternates: ['#800080', '800080', 'purple'] },
  },
  {
    id: 'r-q-mercury-boil',
    category: 'inline',
    input: 'lab notes boiling point of mercury celsius? _',
    expected: { span: 'boiling point of mercury celsius? _', question: 'What is the boiling point of mercury in Celsius?', answer: '357', answerAlternates: ['356.7', '356.73', '~357'] },
  },
  {
    id: 'r-q-brazil-cap',
    category: 'inline',
    input: 'world capitals capital of brazil? _',
    expected: { span: 'capital of brazil? _', question: 'What is the capital of Brazil?', answer: 'Brasília', answerAlternates: ['Brasilia'] },
  },
  {
    id: 'r-q-richter-max',
    category: 'inline',
    input: 'earthquake article richter scale max value? _',
    expected: { span: 'richter scale max value? _', question: 'What is the maximum value on the Richter scale?', answer: '10', answerAlternates: ['9-10', '9.5 (highest recorded)', 'no theoretical max', '9.5'] },
  },

  // ─── ELLIPSIS (...) AS THINKING PAUSE ─────────────────────────────────
  // Users sometimes type a casual hesitation like "hmm..." or "let me
  // think..." before the lookup. The ellipsis should act as a strong
  // "preamble ends here" marker.
  {
    id: 'r-e-france-cap',
    category: 'inline',
    input: 'hmm... capital of france _',
    expected: { span: 'capital of france _', question: 'What is the capital of France?', answer: 'Paris' },
  },
  {
    id: 'r-e-light-speed',
    category: 'inline',
    input: 'let me think... speed of light in m/s _',
    expected: { span: 'speed of light in m/s _', question: 'What is the speed of light in m/s?', answer: '299792458', answerAlternates: ['299,792,458', '3×10^8'] },
  },
  {
    id: 'r-e-planets',
    category: 'inline',
    input: 'wait... how many planets in our solar system _',
    expected: { span: 'how many planets in our solar system _', question: 'How many planets are in our solar system?', answer: '8', answerAlternates: ['eight'] },
  },
  {
    id: 'r-e-largest-desert',
    category: 'inline',
    input: 'ugh blanking... largest desert in the world _',
    expected: { span: 'largest desert in the world _', question: 'What is the largest desert in the world?', answer: 'Sahara', answerAlternates: ['Antarctic', 'Antarctic Desert', 'Sahara Desert'] },
  },
  {
    id: 'r-e-wwii',
    category: 'inline',
    input: 'ok so... year wwii ended _',
    expected: { span: 'year wwii ended _', question: 'What year did WWII end?', answer: '1945' },
  },
  {
    id: 'r-e-gold-atomic',
    category: 'inline',
    input: 'thinking... atomic number of gold _',
    expected: { span: 'atomic number of gold _', question: 'What is the atomic number of gold?', answer: '79' },
  },
  {
    id: 'r-e-usa-bird',
    category: 'inline',
    input: 'blanking on this... national bird of usa _',
    expected: { span: 'national bird of usa _', question: 'What is the national bird of the USA?', answer: 'Bald Eagle', answerAlternates: ['bald eagle'] },
  },
  {
    id: 'r-e-q-elephant',
    category: 'inline',
    input: "hmm... what's the gestation period of elephants? _",
    expected: { span: "what's the gestation period of elephants? _", question: 'What is the gestation period of elephants?', answer: '22 months', answerAlternates: ['~22 months', '21-22 months', '~22', '22'] },
  },
];
