/**
 * Reference tables for the `reference` calculators (reference.ts): small,
 * curated, and stable — the answer is the same in ten years. Authored by
 * hand; the odd row that ages (a plug standard, a dialling code) is a
 * one-line edit here.
 */

export const NATO: Readonly<Record<string, string>> = { a: 'Alfa', b: 'Bravo', c: 'Charlie', d: 'Delta', e: 'Echo', f: 'Foxtrot', g: 'Golf', h: 'Hotel', i: 'India', j: 'Juliett', k: 'Kilo', l: 'Lima', m: 'Mike', n: 'November', o: 'Oscar', p: 'Papa', q: 'Quebec', r: 'Romeo', s: 'Sierra', t: 'Tango', u: 'Uniform', v: 'Victor', w: 'Whiskey', x: 'X-ray', y: 'Yankee', z: 'Zulu', '0': 'Zero', '1': 'One', '2': 'Two', '3': 'Three', '4': 'Four', '5': 'Five', '6': 'Six', '7': 'Seven', '8': 'Eight', '9': 'Niner', '-': 'Dash', '.': 'Stop', '@': 'At', '_': 'Underscore' };

export const MORSE: Readonly<Record<string, string>> = { a: '.-', b: '-...', c: '-.-.', d: '-..', e: '.', f: '..-.', g: '--.', h: '....', i: '..', j: '.---', k: '-.-', l: '.-..', m: '--', n: '-.', o: '---', p: '.--.', q: '--.-', r: '.-.', s: '...', t: '-', u: '..-', v: '...-', w: '.--', x: '-..-', y: '-.--', z: '--..', '0': '-----', '1': '.----', '2': '..---', '3': '...--', '4': '....-', '5': '.....', '6': '-....', '7': '--...', '8': '---..', '9': '----.', '.': '.-.-.-', ',': '--..--', '?': '..--..', "'": '.----.', '!': '-.-.--', '/': '-..-.', '(': '-.--.', ')': '-.--.-', '&': '.-...', ':': '---...', ';': '-.-.-.', '=': '-...-', '+': '.-.-.', '-': '-....-', '_': '..--.-', '"': '.-..-.', '$': '...-..-', '@': '.--.-.' };

export const GREEK: ReadonlyArray<{ name: string; lower: string; upper: string; latin: string }> = [
  { name: 'alpha', lower: 'α', upper: 'Α', latin: 'a' }, { name: 'beta', lower: 'β', upper: 'Β', latin: 'b' }, { name: 'gamma', lower: 'γ', upper: 'Γ', latin: 'g' }, { name: 'delta', lower: 'δ', upper: 'Δ', latin: 'd' }, { name: 'epsilon', lower: 'ε', upper: 'Ε', latin: 'e' }, { name: 'zeta', lower: 'ζ', upper: 'Ζ', latin: 'z' }, { name: 'eta', lower: 'η', upper: 'Η', latin: 'ē' }, { name: 'theta', lower: 'θ', upper: 'Θ', latin: 'th' },
  { name: 'iota', lower: 'ι', upper: 'Ι', latin: 'i' }, { name: 'kappa', lower: 'κ', upper: 'Κ', latin: 'k' }, { name: 'lambda', lower: 'λ', upper: 'Λ', latin: 'l' }, { name: 'mu', lower: 'μ', upper: 'Μ', latin: 'm' }, { name: 'nu', lower: 'ν', upper: 'Ν', latin: 'n' }, { name: 'xi', lower: 'ξ', upper: 'Ξ', latin: 'x' }, { name: 'omicron', lower: 'ο', upper: 'Ο', latin: 'o' }, { name: 'pi', lower: 'π', upper: 'Π', latin: 'p' },
  { name: 'rho', lower: 'ρ', upper: 'Ρ', latin: 'r' }, { name: 'sigma', lower: 'σ', upper: 'Σ', latin: 's' }, { name: 'tau', lower: 'τ', upper: 'Τ', latin: 't' }, { name: 'upsilon', lower: 'υ', upper: 'Υ', latin: 'u' }, { name: 'phi', lower: 'φ', upper: 'Φ', latin: 'ph' }, { name: 'chi', lower: 'χ', upper: 'Χ', latin: 'ch' }, { name: 'psi', lower: 'ψ', upper: 'Ψ', latin: 'ps' }, { name: 'omega', lower: 'ω', upper: 'Ω', latin: 'ō' },
];

/** iso2 · iso3 · dialling · tld · drives on · plug types · currency code */
export const COUNTRIES: ReadonlyArray<{ name: string; aliases?: string[]; iso2: string; iso3: string; dial: string; tld: string; drives: 'left' | 'right'; plugs: string; currency: string }> = [
  { name: 'united kingdom', aliases: ['uk', 'britain', 'great britain', 'england', 'scotland', 'wales'], iso2: 'GB', iso3: 'GBR', dial: '+44', tld: '.uk', drives: 'left', plugs: 'G', currency: 'GBP' },
  { name: 'united states', aliases: ['usa', 'us', 'america'], iso2: 'US', iso3: 'USA', dial: '+1', tld: '.us', drives: 'right', plugs: 'A, B', currency: 'USD' },
  { name: 'canada', iso2: 'CA', iso3: 'CAN', dial: '+1', tld: '.ca', drives: 'right', plugs: 'A, B', currency: 'CAD' },
  { name: 'mexico', iso2: 'MX', iso3: 'MEX', dial: '+52', tld: '.mx', drives: 'right', plugs: 'A, B', currency: 'MXN' },
  { name: 'brazil', iso2: 'BR', iso3: 'BRA', dial: '+55', tld: '.br', drives: 'right', plugs: 'C, N', currency: 'BRL' },
  { name: 'argentina', iso2: 'AR', iso3: 'ARG', dial: '+54', tld: '.ar', drives: 'right', plugs: 'C, I', currency: 'ARS' },
  { name: 'chile', iso2: 'CL', iso3: 'CHL', dial: '+56', tld: '.cl', drives: 'right', plugs: 'C, L', currency: 'CLP' },
  { name: 'colombia', iso2: 'CO', iso3: 'COL', dial: '+57', tld: '.co', drives: 'right', plugs: 'A, B', currency: 'COP' },
  { name: 'peru', iso2: 'PE', iso3: 'PER', dial: '+51', tld: '.pe', drives: 'right', plugs: 'A, C', currency: 'PEN' },
  { name: 'ireland', iso2: 'IE', iso3: 'IRL', dial: '+353', tld: '.ie', drives: 'left', plugs: 'G', currency: 'EUR' },
  { name: 'france', iso2: 'FR', iso3: 'FRA', dial: '+33', tld: '.fr', drives: 'right', plugs: 'C, E', currency: 'EUR' },
  { name: 'germany', iso2: 'DE', iso3: 'DEU', dial: '+49', tld: '.de', drives: 'right', plugs: 'C, F', currency: 'EUR' },
  { name: 'spain', iso2: 'ES', iso3: 'ESP', dial: '+34', tld: '.es', drives: 'right', plugs: 'C, F', currency: 'EUR' },
  { name: 'portugal', iso2: 'PT', iso3: 'PRT', dial: '+351', tld: '.pt', drives: 'right', plugs: 'C, F', currency: 'EUR' },
  { name: 'italy', iso2: 'IT', iso3: 'ITA', dial: '+39', tld: '.it', drives: 'right', plugs: 'C, F, L', currency: 'EUR' },
  { name: 'netherlands', aliases: ['holland'], iso2: 'NL', iso3: 'NLD', dial: '+31', tld: '.nl', drives: 'right', plugs: 'C, F', currency: 'EUR' },
  { name: 'belgium', iso2: 'BE', iso3: 'BEL', dial: '+32', tld: '.be', drives: 'right', plugs: 'C, E', currency: 'EUR' },
  { name: 'luxembourg', iso2: 'LU', iso3: 'LUX', dial: '+352', tld: '.lu', drives: 'right', plugs: 'C, F', currency: 'EUR' },
  { name: 'switzerland', iso2: 'CH', iso3: 'CHE', dial: '+41', tld: '.ch', drives: 'right', plugs: 'C, J', currency: 'CHF' },
  { name: 'austria', iso2: 'AT', iso3: 'AUT', dial: '+43', tld: '.at', drives: 'right', plugs: 'C, F', currency: 'EUR' },
  { name: 'denmark', iso2: 'DK', iso3: 'DNK', dial: '+45', tld: '.dk', drives: 'right', plugs: 'C, E, F, K', currency: 'DKK' },
  { name: 'sweden', iso2: 'SE', iso3: 'SWE', dial: '+46', tld: '.se', drives: 'right', plugs: 'C, F', currency: 'SEK' },
  { name: 'norway', iso2: 'NO', iso3: 'NOR', dial: '+47', tld: '.no', drives: 'right', plugs: 'C, F', currency: 'NOK' },
  { name: 'finland', iso2: 'FI', iso3: 'FIN', dial: '+358', tld: '.fi', drives: 'right', plugs: 'C, F', currency: 'EUR' },
  { name: 'iceland', iso2: 'IS', iso3: 'ISL', dial: '+354', tld: '.is', drives: 'right', plugs: 'C, F', currency: 'ISK' },
  { name: 'poland', iso2: 'PL', iso3: 'POL', dial: '+48', tld: '.pl', drives: 'right', plugs: 'C, E', currency: 'PLN' },
  { name: 'czech republic', aliases: ['czechia'], iso2: 'CZ', iso3: 'CZE', dial: '+420', tld: '.cz', drives: 'right', plugs: 'C, E', currency: 'CZK' },
  { name: 'slovakia', iso2: 'SK', iso3: 'SVK', dial: '+421', tld: '.sk', drives: 'right', plugs: 'C, E', currency: 'EUR' },
  { name: 'hungary', iso2: 'HU', iso3: 'HUN', dial: '+36', tld: '.hu', drives: 'right', plugs: 'C, F', currency: 'HUF' },
  { name: 'romania', iso2: 'RO', iso3: 'ROU', dial: '+40', tld: '.ro', drives: 'right', plugs: 'C, F', currency: 'RON' },
  { name: 'bulgaria', iso2: 'BG', iso3: 'BGR', dial: '+359', tld: '.bg', drives: 'right', plugs: 'C, F', currency: 'BGN' },
  { name: 'greece', iso2: 'GR', iso3: 'GRC', dial: '+30', tld: '.gr', drives: 'right', plugs: 'C, F', currency: 'EUR' },
  { name: 'croatia', iso2: 'HR', iso3: 'HRV', dial: '+385', tld: '.hr', drives: 'right', plugs: 'C, F', currency: 'EUR' },
  { name: 'slovenia', iso2: 'SI', iso3: 'SVN', dial: '+386', tld: '.si', drives: 'right', plugs: 'C, F', currency: 'EUR' },
  { name: 'serbia', iso2: 'RS', iso3: 'SRB', dial: '+381', tld: '.rs', drives: 'right', plugs: 'C, F', currency: 'RSD' },
  { name: 'ukraine', iso2: 'UA', iso3: 'UKR', dial: '+380', tld: '.ua', drives: 'right', plugs: 'C, F', currency: 'UAH' },
  { name: 'russia', iso2: 'RU', iso3: 'RUS', dial: '+7', tld: '.ru', drives: 'right', plugs: 'C, F', currency: 'RUB' },
  { name: 'turkey', aliases: ['türkiye', 'turkiye'], iso2: 'TR', iso3: 'TUR', dial: '+90', tld: '.tr', drives: 'right', plugs: 'C, F', currency: 'TRY' },
  { name: 'estonia', iso2: 'EE', iso3: 'EST', dial: '+372', tld: '.ee', drives: 'right', plugs: 'C, F', currency: 'EUR' },
  { name: 'latvia', iso2: 'LV', iso3: 'LVA', dial: '+371', tld: '.lv', drives: 'right', plugs: 'C, F', currency: 'EUR' },
  { name: 'lithuania', iso2: 'LT', iso3: 'LTU', dial: '+370', tld: '.lt', drives: 'right', plugs: 'C, F', currency: 'EUR' },
  { name: 'malta', iso2: 'MT', iso3: 'MLT', dial: '+356', tld: '.mt', drives: 'left', plugs: 'G', currency: 'EUR' },
  { name: 'cyprus', iso2: 'CY', iso3: 'CYP', dial: '+357', tld: '.cy', drives: 'left', plugs: 'G', currency: 'EUR' },
  { name: 'israel', iso2: 'IL', iso3: 'ISR', dial: '+972', tld: '.il', drives: 'right', plugs: 'C, H', currency: 'ILS' },
  { name: 'united arab emirates', aliases: ['uae', 'emirates', 'dubai'], iso2: 'AE', iso3: 'ARE', dial: '+971', tld: '.ae', drives: 'right', plugs: 'G', currency: 'AED' },
  { name: 'saudi arabia', iso2: 'SA', iso3: 'SAU', dial: '+966', tld: '.sa', drives: 'right', plugs: 'G', currency: 'SAR' },
  { name: 'qatar', iso2: 'QA', iso3: 'QAT', dial: '+974', tld: '.qa', drives: 'right', plugs: 'G', currency: 'QAR' },
  { name: 'egypt', iso2: 'EG', iso3: 'EGY', dial: '+20', tld: '.eg', drives: 'right', plugs: 'C, F', currency: 'EGP' },
  { name: 'morocco', iso2: 'MA', iso3: 'MAR', dial: '+212', tld: '.ma', drives: 'right', plugs: 'C, E', currency: 'MAD' },
  { name: 'nigeria', iso2: 'NG', iso3: 'NGA', dial: '+234', tld: '.ng', drives: 'right', plugs: 'D, G', currency: 'NGN' },
  { name: 'ghana', iso2: 'GH', iso3: 'GHA', dial: '+233', tld: '.gh', drives: 'right', plugs: 'D, G', currency: 'GHS' },
  { name: 'kenya', iso2: 'KE', iso3: 'KEN', dial: '+254', tld: '.ke', drives: 'left', plugs: 'G', currency: 'KES' },
  { name: 'uganda', iso2: 'UG', iso3: 'UGA', dial: '+256', tld: '.ug', drives: 'left', plugs: 'G', currency: 'UGX' },
  { name: 'tanzania', iso2: 'TZ', iso3: 'TZA', dial: '+255', tld: '.tz', drives: 'left', plugs: 'D, G', currency: 'TZS' },
  { name: 'rwanda', iso2: 'RW', iso3: 'RWA', dial: '+250', tld: '.rw', drives: 'right', plugs: 'C, J', currency: 'RWF' },
  { name: 'ethiopia', iso2: 'ET', iso3: 'ETH', dial: '+251', tld: '.et', drives: 'right', plugs: 'C, E, F, L', currency: 'ETB' },
  { name: 'south africa', iso2: 'ZA', iso3: 'ZAF', dial: '+27', tld: '.za', drives: 'left', plugs: 'C, M, N', currency: 'ZAR' },
  { name: 'india', iso2: 'IN', iso3: 'IND', dial: '+91', tld: '.in', drives: 'left', plugs: 'C, D, M', currency: 'INR' },
  { name: 'pakistan', iso2: 'PK', iso3: 'PAK', dial: '+92', tld: '.pk', drives: 'left', plugs: 'C, D', currency: 'PKR' },
  { name: 'bangladesh', iso2: 'BD', iso3: 'BGD', dial: '+880', tld: '.bd', drives: 'left', plugs: 'C, D, G, K', currency: 'BDT' },
  { name: 'sri lanka', iso2: 'LK', iso3: 'LKA', dial: '+94', tld: '.lk', drives: 'left', plugs: 'D, G', currency: 'LKR' },
  { name: 'nepal', iso2: 'NP', iso3: 'NPL', dial: '+977', tld: '.np', drives: 'left', plugs: 'C, D, M', currency: 'NPR' },
  { name: 'china', iso2: 'CN', iso3: 'CHN', dial: '+86', tld: '.cn', drives: 'right', plugs: 'A, C, I', currency: 'CNY' },
  { name: 'hong kong', iso2: 'HK', iso3: 'HKG', dial: '+852', tld: '.hk', drives: 'left', plugs: 'G', currency: 'HKD' },
  { name: 'taiwan', iso2: 'TW', iso3: 'TWN', dial: '+886', tld: '.tw', drives: 'right', plugs: 'A, B', currency: 'TWD' },
  { name: 'japan', iso2: 'JP', iso3: 'JPN', dial: '+81', tld: '.jp', drives: 'left', plugs: 'A, B', currency: 'JPY' },
  { name: 'south korea', aliases: ['korea'], iso2: 'KR', iso3: 'KOR', dial: '+82', tld: '.kr', drives: 'right', plugs: 'C, F', currency: 'KRW' },
  { name: 'singapore', iso2: 'SG', iso3: 'SGP', dial: '+65', tld: '.sg', drives: 'left', plugs: 'G', currency: 'SGD' },
  { name: 'malaysia', iso2: 'MY', iso3: 'MYS', dial: '+60', tld: '.my', drives: 'left', plugs: 'G', currency: 'MYR' },
  { name: 'indonesia', iso2: 'ID', iso3: 'IDN', dial: '+62', tld: '.id', drives: 'left', plugs: 'C, F', currency: 'IDR' },
  { name: 'thailand', iso2: 'TH', iso3: 'THA', dial: '+66', tld: '.th', drives: 'left', plugs: 'A, B, C, O', currency: 'THB' },
  { name: 'vietnam', iso2: 'VN', iso3: 'VNM', dial: '+84', tld: '.vn', drives: 'right', plugs: 'A, C', currency: 'VND' },
  { name: 'philippines', iso2: 'PH', iso3: 'PHL', dial: '+63', tld: '.ph', drives: 'right', plugs: 'A, B, C', currency: 'PHP' },
  { name: 'australia', iso2: 'AU', iso3: 'AUS', dial: '+61', tld: '.au', drives: 'left', plugs: 'I', currency: 'AUD' },
  { name: 'new zealand', iso2: 'NZ', iso3: 'NZL', dial: '+64', tld: '.nz', drives: 'left', plugs: 'I', currency: 'NZD' },
];

/** key → keyCode (legacy), `event.key`, `event.code` */
export const KEYCODES: Readonly<Record<string, { keyCode: number; key: string; code: string }>> = {
  backspace: { keyCode: 8, key: 'Backspace', code: 'Backspace' }, tab: { keyCode: 9, key: 'Tab', code: 'Tab' }, enter: { keyCode: 13, key: 'Enter', code: 'Enter' }, return: { keyCode: 13, key: 'Enter', code: 'Enter' }, shift: { keyCode: 16, key: 'Shift', code: 'ShiftLeft' }, ctrl: { keyCode: 17, key: 'Control', code: 'ControlLeft' }, control: { keyCode: 17, key: 'Control', code: 'ControlLeft' }, alt: { keyCode: 18, key: 'Alt', code: 'AltLeft' }, option: { keyCode: 18, key: 'Alt', code: 'AltLeft' }, pause: { keyCode: 19, key: 'Pause', code: 'Pause' }, 'caps lock': { keyCode: 20, key: 'CapsLock', code: 'CapsLock' }, capslock: { keyCode: 20, key: 'CapsLock', code: 'CapsLock' }, escape: { keyCode: 27, key: 'Escape', code: 'Escape' }, esc: { keyCode: 27, key: 'Escape', code: 'Escape' }, space: { keyCode: 32, key: ' ', code: 'Space' }, spacebar: { keyCode: 32, key: ' ', code: 'Space' }, 'page up': { keyCode: 33, key: 'PageUp', code: 'PageUp' }, pageup: { keyCode: 33, key: 'PageUp', code: 'PageUp' }, 'page down': { keyCode: 34, key: 'PageDown', code: 'PageDown' }, pagedown: { keyCode: 34, key: 'PageDown', code: 'PageDown' }, end: { keyCode: 35, key: 'End', code: 'End' }, home: { keyCode: 36, key: 'Home', code: 'Home' }, left: { keyCode: 37, key: 'ArrowLeft', code: 'ArrowLeft' }, 'left arrow': { keyCode: 37, key: 'ArrowLeft', code: 'ArrowLeft' }, up: { keyCode: 38, key: 'ArrowUp', code: 'ArrowUp' }, 'up arrow': { keyCode: 38, key: 'ArrowUp', code: 'ArrowUp' }, right: { keyCode: 39, key: 'ArrowRight', code: 'ArrowRight' }, 'right arrow': { keyCode: 39, key: 'ArrowRight', code: 'ArrowRight' }, down: { keyCode: 40, key: 'ArrowDown', code: 'ArrowDown' }, 'down arrow': { keyCode: 40, key: 'ArrowDown', code: 'ArrowDown' }, insert: { keyCode: 45, key: 'Insert', code: 'Insert' }, delete: { keyCode: 46, key: 'Delete', code: 'Delete' }, del: { keyCode: 46, key: 'Delete', code: 'Delete' }, meta: { keyCode: 91, key: 'Meta', code: 'MetaLeft' }, command: { keyCode: 91, key: 'Meta', code: 'MetaLeft' }, cmd: { keyCode: 91, key: 'Meta', code: 'MetaLeft' }, windows: { keyCode: 91, key: 'Meta', code: 'MetaLeft' }, 'context menu': { keyCode: 93, key: 'ContextMenu', code: 'ContextMenu' }, 'num lock': { keyCode: 144, key: 'NumLock', code: 'NumLock' }, 'scroll lock': { keyCode: 145, key: 'ScrollLock', code: 'ScrollLock' }, semicolon: { keyCode: 186, key: ';', code: 'Semicolon' }, equals: { keyCode: 187, key: '=', code: 'Equal' }, comma: { keyCode: 188, key: ',', code: 'Comma' }, minus: { keyCode: 189, key: '-', code: 'Minus' }, period: { keyCode: 190, key: '.', code: 'Period' }, slash: { keyCode: 191, key: '/', code: 'Slash' }, backtick: { keyCode: 192, key: '`', code: 'Backquote' }, 'left bracket': { keyCode: 219, key: '[', code: 'BracketLeft' }, backslash: { keyCode: 220, key: '\\', code: 'Backslash' }, 'right bracket': { keyCode: 221, key: ']', code: 'BracketRight' }, quote: { keyCode: 222, key: "'", code: 'Quote' },
};

/** exit code → meaning; 128+n is "killed by signal n" */
export const EXIT_CODES: Readonly<Record<number, string>> = { 0: 'success', 1: 'general error (catch-all)', 2: 'misuse of a shell builtin, or bad usage', 126: 'command found but not executable (permissions)', 127: 'command not found', 128: 'invalid exit argument', 130: 'terminated by Ctrl-C (SIGINT, 128+2)', 137: 'killed (SIGKILL, 128+9) — often the OOM killer or `kill -9`', 139: 'segmentation fault (SIGSEGV, 128+11)', 143: 'terminated (SIGTERM, 128+15) — a normal `kill`, a container stop, a timeout', 255: 'exit status out of range, or an uncaught error in some runtimes' };
export const SIGNALS: Readonly<Record<number, string>> = { 1: 'SIGHUP hangup / reload config', 2: 'SIGINT interrupt (Ctrl-C)', 3: 'SIGQUIT quit with core dump (Ctrl-\\)', 4: 'SIGILL illegal instruction', 6: 'SIGABRT abort()', 8: 'SIGFPE arithmetic error', 9: 'SIGKILL kill, cannot be caught', 10: 'SIGUSR1 user-defined', 11: 'SIGSEGV segmentation fault', 12: 'SIGUSR2 user-defined', 13: 'SIGPIPE write to a closed pipe', 14: 'SIGALRM alarm timer', 15: 'SIGTERM terminate, the polite kill', 17: 'SIGCHLD child stopped or exited', 18: 'SIGCONT continue', 19: 'SIGSTOP stop, cannot be caught', 20: 'SIGTSTP stop from the terminal (Ctrl-Z)' };

/** grams per US cup */
export const CUP_GRAMS: Readonly<Record<string, number>> = { flour: 120, 'plain flour': 120, 'all purpose flour': 120, 'all-purpose flour': 120, 'bread flour': 127, 'whole wheat flour': 113, 'wholemeal flour': 113, 'cake flour': 114, 'self raising flour': 120, 'self-raising flour': 120, cornflour: 128, cornstarch: 128, sugar: 200, 'granulated sugar': 200, 'caster sugar': 200, 'white sugar': 200, 'brown sugar': 220, 'icing sugar': 120, 'powdered sugar': 120, 'confectioners sugar': 120, butter: 227, margarine: 227, water: 240, milk: 240, cream: 240, 'double cream': 240, 'heavy cream': 240, yogurt: 245, yoghurt: 245, oil: 224, 'olive oil': 216, 'vegetable oil': 224, honey: 340, 'maple syrup': 320, 'golden syrup': 340, rice: 185, 'uncooked rice': 185, 'cooked rice': 175, oats: 90, 'rolled oats': 90, 'cocoa powder': 100, cocoa: 100, 'chocolate chips': 170, 'ground almonds': 96, 'almond flour': 96, breadcrumbs: 108, salt: 288, 'table salt': 288, 'baking powder': 230, 'peanut butter': 258, 'cream cheese': 232, 'grated cheese': 113, 'grated parmesan': 100, nuts: 140, walnuts: 120, raisins: 150, lentils: 190, quinoa: 170, couscous: 180, 'chia seeds': 170, coconut: 80, 'desiccated coconut': 80 };
/** [gas mark, °C conventional, °C fan, °F] */
export const OVEN: ReadonlyArray<[number, number, number, number]> = [[0.25, 110, 90, 225], [0.5, 120, 100, 250], [1, 140, 120, 275], [2, 150, 130, 300], [3, 160, 140, 325], [4, 180, 160, 350], [5, 190, 170, 375], [6, 200, 180, 400], [7, 220, 200, 425], [8, 230, 210, 450], [9, 240, 220, 475], [10, 260, 240, 500]];

/** [mm w, mm h] */
export const PAPER: Readonly<Record<string, [number, number]>> = { a0: [841, 1189], a1: [594, 841], a2: [420, 594], a3: [297, 420], a4: [210, 297], a5: [148, 210], a6: [105, 148], a7: [74, 105], b4: [250, 353], b5: [176, 250], letter: [216, 279], legal: [216, 356], tabloid: [279, 432], ledger: [432, 279], executive: [184, 267], 'business card': [85, 55], postcard: [148, 105], 'id card': [86, 54], 'credit card': [86, 54] };
/** UK men's → [US men's, EU] and UK women's → [US women's, EU] */
export const SHOES: Readonly<Record<'men' | 'women', ReadonlyArray<[number, number, number]>>> = {
  men: [[5, 6, 38], [5.5, 6.5, 38.5], [6, 7, 39], [6.5, 7.5, 40], [7, 8, 41], [7.5, 8.5, 41.5], [8, 9, 42], [8.5, 9.5, 42.5], [9, 10, 43], [9.5, 10.5, 44], [10, 11, 44.5], [10.5, 11.5, 45], [11, 12, 46], [11.5, 12.5, 46.5], [12, 13, 47], [13, 14, 48]],
  women: [[2, 4, 35], [2.5, 4.5, 35.5], [3, 5, 36], [3.5, 5.5, 36.5], [4, 6, 37], [4.5, 6.5, 37.5], [5, 7, 38], [5.5, 7.5, 38.5], [6, 8, 39], [6.5, 8.5, 39.5], [7, 9, 40], [7.5, 9.5, 41], [8, 10, 42], [8.5, 10.5, 42.5], [9, 11, 43]],
};
/** bed sizes, cm */
export const BEDS: Readonly<Record<string, string>> = { 'uk single': '90 × 190 cm (3′ × 6′3″)', 'uk small double': '120 × 190 cm (4′ × 6′3″)', 'uk double': '135 × 190 cm (4′6″ × 6′3″)', 'uk king': '150 × 200 cm (5′ × 6′6″)', 'uk super king': '180 × 200 cm (6′ × 6′6″)', 'us twin': '96 × 190 cm (38 × 75 in)', 'us twin xl': '96 × 203 cm (38 × 80 in)', 'us full': '137 × 190 cm (54 × 75 in)', 'us double': '137 × 190 cm (54 × 75 in)', 'us queen': '152 × 203 cm (60 × 80 in)', 'us king': '193 × 203 cm (76 × 80 in)', 'us california king': '183 × 213 cm (72 × 84 in)', 'eu single': '90 × 200 cm', 'eu double': '140 × 200 cm', 'eu king': '160 × 200 cm', 'eu super king': '180 × 200 cm' };

/** western zodiac: [name, start month (1-12), start day] in order from Capricorn (Dec 22) */
export const ZODIAC: ReadonlyArray<[string, number, number, string]> = [['Capricorn', 12, 22, '♑'], ['Aquarius', 1, 20, '♒'], ['Pisces', 2, 19, '♓'], ['Aries', 3, 21, '♈'], ['Taurus', 4, 20, '♉'], ['Gemini', 5, 21, '♊'], ['Cancer', 6, 21, '♋'], ['Leo', 7, 23, '♌'], ['Virgo', 8, 23, '♍'], ['Libra', 9, 23, '♎'], ['Scorpio', 10, 23, '♏'], ['Sagittarius', 11, 22, '♐']];
export const CHINESE_ZODIAC: ReadonlyArray<string> = ['Rat', 'Ox', 'Tiger', 'Rabbit', 'Dragon', 'Snake', 'Horse', 'Goat', 'Monkey', 'Rooster', 'Dog', 'Pig'];   // 1900 = Rat
export const CHINESE_ELEMENTS: ReadonlyArray<string> = ['Metal', 'Water', 'Wood', 'Fire', 'Earth'];   // two years each from 1900 (Metal)
