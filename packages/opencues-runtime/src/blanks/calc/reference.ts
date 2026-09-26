/**
 * Reference tables — the answers that are the same in ten years: the NATO
 * alphabet, morse, greek letters, country codes and travel facts, key codes,
 * cron expressions, exit codes and signals, cooking measures and oven
 * temperatures, paper / shoe / bed sizes, zodiac signs, dog years.
 */
import type { Calculator } from './types';
import { fmt, NUM, num } from './types';
import { NATO, MORSE, GREEK, COUNTRIES, KEYCODES, EXIT_CODES, SIGNALS, CUP_GRAMS, OVEN, PAPER, SHOES, BEDS, ZODIAC, CHINESE_ZODIAC, CHINESE_ELEMENTS } from './reference-data';

const MORSE_REV: Readonly<Record<string, string>> = Object.fromEntries(Object.entries(MORSE).map(([k, v]) => [v, k]));
const country = (s: string) => { const q = s.toLowerCase().replace(/^(?:the|of|for|in)\s+/, '').replace(/\s+(?:the)$/, '').trim(); return COUNTRIES.find((c) => c.name === q || c.iso2.toLowerCase() === q || c.iso3.toLowerCase() === q || c.aliases?.includes(q)) ?? COUNTRIES.find((c) => q.includes(c.name) || c.aliases?.some((a) => new RegExp(`\\b${a}\\b`).test(q))) ?? null; };
const cap = (s: string): string => s.replace(/\b\w/g, (c) => c.toUpperCase());
const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];
const DAYS = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];
const monthDay = (s: string): [number, number] | null => { const t = s.toLowerCase(); let m = t.match(/(\d{1,2})(?:st|nd|rd|th)?\s+([a-z]+)/); if (m && MONTHS.includes(m[2].slice(0, 3))) return [MONTHS.indexOf(m[2].slice(0, 3)) + 1, Number(m[1])]; m = t.match(/([a-z]+)\s+(\d{1,2})/); if (m && MONTHS.includes(m[1].slice(0, 3))) return [MONTHS.indexOf(m[1].slice(0, 3)) + 1, Number(m[2])]; m = t.match(/\d{4}-(\d{2})-(\d{2})/); if (m) return [Number(m[1]), Number(m[2])]; m = t.match(/(\d{1,2})[/.](\d{1,2})/); if (m) return [Number(m[2]), Number(m[1])]; return null; };

/** a human cron: `every 5 minutes`, `every day at 9`, `every monday at 9:30`, `weekdays at 8am`, `every hour`, `first of the month at midnight` */
export function cronFor(s: string): string | null {
  const t = s.toLowerCase().replace(/\bat\s+midnight\b/, 'at 0:00').replace(/\bat\s+noon\b/, 'at 12:00').trim();
  const at = t.match(/\bat\s+(\d{1,2})(?::(\d{2}))?\s*(am|pm)?/);
  let h = at ? Number(at[1]) : 0, mi = at ? Number(at[2] ?? 0) : 0;
  if (at?.[3] === 'pm' && h < 12) h += 12; if (at?.[3] === 'am' && h === 12) h = 0;
  let m: RegExpMatchArray | null;
  if ((m = t.match(/every\s+(\d+)\s*min/))) return `*/${m[1]} * * * *`;
  if (/every\s+minute/.test(t)) return '* * * * *';
  if ((m = t.match(/every\s+(\d+)\s*hours?/))) return `${mi} */${m[1]} * * *`;
  if (/every\s+hour|hourly/.test(t)) return `${mi} * * * *`;
  if (/twice\s+(?:a\s+)?day|every\s+12\s*hours/.test(t)) return `${mi} ${h},${(h + 12) % 24} * * *`;
  const FULL = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];
  const days = DAYS.map((d, i) => (new RegExp(`\\b(?:${d}|${FULL[i]}|${FULL[i]}s)\\b`).test(t) ? i : -1)).filter((i) => i >= 0);
  if (/weekday|monday\s+to\s+friday|mon-fri/.test(t)) return `${mi} ${h} * * 1-5`;
  if (/weekend/.test(t)) return `${mi} ${h} * * 0,6`;
  if (days.length) return `${mi} ${h} * * ${days.join(',')}`;
  if ((m = t.match(/(?:on\s+)?(?:the\s+)?(\d{1,2})(?:st|nd|rd|th)?\s+(?:of\s+)?(?:every|each|the)\s+month|first\s+(?:day\s+)?of\s+(?:the|every)\s+month|monthly/))) return `${mi} ${h} ${m[1] ?? 1} * *`;
  if (/every\s+day|daily|each\s+day|nightly/.test(t) || at) return `${mi} ${h} * * *`;
  if (/yearly|annually|every\s+year/.test(t)) return `${mi} ${h} 1 1 *`;
  return null;
}
/** the other way: `0 9 * * 1` → "at 09:00 on Monday" */
export function cronExplain(expr: string): string | null {
  const p = expr.trim().split(/\s+/); if (p.length !== 5) return null;
  const [mi, h, dom, mon, dow] = p;
  const list = (v: string, names?: string[]): string => v.split(',').map((x) => { const r = x.match(/^(\d+)-(\d+)$/); if (r) return names ? `${names[Number(r[1])]}–${names[Number(r[2])]}` : `${r[1]}–${r[2]}`; return names ? names[Number(x)] ?? x : x; }).join(', ');
  const DN = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'];
  const MN = ['', 'January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
  let when: string;
  if (mi.startsWith('*/')) when = `every ${mi.slice(2)} minutes`; else if (mi === '*') when = 'every minute';
  else if (h.startsWith('*/')) when = `at minute ${mi} of every ${h.slice(2)} hours`; else if (h === '*') when = `at minute ${mi} of every hour`;
  else when = `at ${list(h).split(', ').map((hh) => `${hh.padStart(2, '0')}:${mi.padStart(2, '0')}`).join(' and ')}`;
  const parts = [when];
  if (dow !== '*') parts.push(`on ${list(dow, DN)}`);
  if (dom !== '*') parts.push(`on day ${list(dom)} of the month`);
  if (mon !== '*') parts.push(`in ${list(mon, MN)}`);
  if (dow === '*' && dom === '*' && mon === '*' && !/every/.test(when)) parts.push('every day');
  return parts.join(' ');
}

export const REFERENCE: readonly Calculator[] = [
  { id: 'nato', family: 'reference', keywords: ['nato for', 'nato alphabet for', 'phonetic alphabet for', 'spell phonetically', 'spell out phonetically', 'nato'], arg: 'segment', example: ['nato for wilfred', 'Whiskey India Lima Foxtrot Romeo Echo Delta'], miss: 'nothing to spell',
    run(arg) { const t = arg.trim(); if (!t) return null; const out = [...t.toLowerCase()].map((c) => c === ' ' ? '·' : NATO[c] ?? c).join(' '); return out; } },
  // Decoding dots back to text rides the same calculator (a dot/dash argument is decoded), but a morse string ENDS in a dot, which the sentence segmenter reads as a terminator before the `_`: write the dashes-last words, or `/`-separate, or accept that decoding is the demo that needs the buffer form.
  { id: 'morse', family: 'reference', keywords: ['morse for', 'morse code for', 'in morse', 'morse'], arg: 'segment', example: ['morse for sos', '... --- ...'], miss: 'nothing to encode',
    run(arg) { const t = arg.trim().toLowerCase(); if (!t) return null; if (/^[.\-\s/]+$/.test(t)) return t.split(/\s*\/\s*|\s{2,}/).map((w) => w.trim().split(/\s+/).map((c) => MORSE_REV[c] ?? '?').join('')).join(' ').toUpperCase(); return t.split(/\s+/).map((w) => [...w].map((c) => MORSE[c] ?? '?').join(' ')).join(' / '); } },
  { id: 'greek', family: 'reference', keywords: ['greek letter', 'greek for', 'greek alphabet', 'in greek'], arg: 'segment', optionalArg: true, example: ['greek letter sigma', 'σ Σ (sigma, 18th of 24; latin s)'], miss: 'not a greek letter name',
    run(arg) { const t = arg.trim().toLowerCase(); if (!t) return GREEK.map((g) => `${g.lower}${g.upper}`).join(' ') + ' (' + GREEK.map((g) => g.name).join(', ') + ')'; const i = GREEK.findIndex((g) => g.name === t || g.lower === t || g.upper === t); if (i < 0) return null; const g = GREEK[i]; return `${g.lower} ${g.upper} (${g.name}, ${i + 1}${['th', 'st', 'nd', 'rd'][(i + 1) % 10 < 4 && Math.floor((i + 1) / 10) !== 1 ? (i + 1) % 10 : 0]} of 24; latin ${g.latin})`; } },
  { id: 'country-code', family: 'reference', keywords: ['country code for', 'iso code for', 'iso country code for', 'country code', 'alpha-2 for', 'alpha-3 for'], arg: 'segment', example: ['country code for germany', 'DE · DEU · +49 · .de (EUR)'], miss: 'not a country in the table',
    run(arg) { const c = country(arg); if (!c) return null; return `${c.iso2} · ${c.iso3} · ${c.dial} · ${c.tld} (${c.currency})`; } },
  { id: 'dialling-code', family: 'reference', keywords: ['dialling code for', 'dialing code for', 'calling code for', 'phone code for', 'country calling code for', 'international code for'], arg: 'segment', example: ['dialling code for brazil', '+55 (Brazil, BR)'], miss: 'not a country in the table',
    run(arg) { const c = country(arg); if (!c) return null; return `${c.dial} (${cap(c.name)}, ${c.iso2})`; } },
  { id: 'driving-side', family: 'reference', keywords: ['driving side in', 'drive on the left in', 'drive on the right in', 'which side of the road in', 'driving side'], arg: 'segment', example: ['driving side in japan', 'Japan drives on the left'], miss: 'not a country in the table',
    run(arg) { const c = country(arg); if (!c) return null; return `${cap(c.name)} drives on the ${c.drives}`; } },
  { id: 'plug-type', family: 'reference', keywords: ['plug type in', 'plug types in', 'power plug in', 'socket type in', 'plug type for', 'plug type'], arg: 'segment', example: ['plug type in australia', 'Australia: type I (230 V, 50 Hz)'], miss: 'not a country in the table',
    run(arg) { const c = country(arg); if (!c) return null; const v = ['US', 'CA', 'MX', 'JP', 'TW', 'CO', 'PE', 'PH'].includes(c.iso2) ? (c.iso2 === 'JP' ? '100 V, 50/60 Hz' : c.iso2 === 'PH' ? '220 V, 60 Hz' : c.iso2 === 'PE' || c.iso2 === 'CO' ? c.iso2 === 'PE' ? '220 V, 60 Hz' : '110 V, 60 Hz' : c.iso2 === 'TW' ? '110 V, 60 Hz' : '120 V, 60 Hz') : c.iso2 === 'BR' ? '127/220 V, 60 Hz' : '230 V, 50 Hz'; return `${cap(c.name)}: type ${c.plugs} (${v})`; } },
  { id: 'tld', family: 'reference', keywords: ['tld for', 'domain ending for', 'country domain for', 'cctld for'], arg: 'segment', example: ['tld for germany', '.de (Germany)'], miss: 'not a country in the table',
    run(arg) { const c = country(arg); if (!c) return null; return `${c.tld} (${cap(c.name)})`; } },
  { id: 'keycode', family: 'reference', keywords: ['keycode for', 'key code for', 'keycode of', 'javascript keycode', 'keycode'], arg: 'segment', example: ['keycode for enter', 'Enter: keyCode 13 · key "Enter" · code "Enter"'], miss: 'not a key in the table (letters, digits, F-keys, named keys)',
    run(arg) { const t = arg.trim().toLowerCase().replace(/\bkey$/, '').trim(); if (!t) return null; let k = KEYCODES[t]; if (!k && /^[a-z]$/.test(t)) k = { keyCode: t.toUpperCase().charCodeAt(0), key: t, code: `Key${t.toUpperCase()}` }; if (!k && /^\d$/.test(t)) k = { keyCode: 48 + Number(t), key: t, code: `Digit${t}` }; const f = t.match(/^f(\d{1,2})$/); if (!k && f && Number(f[1]) >= 1 && Number(f[1]) <= 12) k = { keyCode: 111 + Number(f[1]), key: `F${f[1]}`, code: `F${f[1]}` }; if (!k) return null; return `${cap(t)}: keyCode ${k.keyCode} · key "${k.key}" · code "${k.code}"`; } },
  { id: 'cron', family: 'reference', keywords: ['cron for', 'cron expression for', 'crontab for', 'cron'], arg: 'segment', example: ['cron for every monday at 9', '0 9 * * 1 (at 09:00 on Monday)'], miss: 'say when: every 5 minutes, every day at 9, weekdays at 8:30, every monday at 9, first of the month at midnight',
    run(arg) { const t = arg.trim(); const expr = t.match(/(?:^|\s)((?:[\d*/,\-]+\s+){4}[\d*/,\-]+)(?=\s|$)/); if (expr) { const e = cronExplain(expr[1]); return e ? `${expr[1]}: ${e}` : null; } const c = cronFor(t); if (!c) return null; return `${c} (${cronExplain(c)})`; } },
  { id: 'exit-code', family: 'reference', keywords: ['exit code', 'exit status', 'what does exit code', 'signal', 'kill signal'], arg: 'segment', keywordIsArg: true, example: ['exit code 137', '137: killed (SIGKILL, 128+9) — often the OOM killer or `kill -9`'], miss: 'need an exit code (0–255) or a signal number / name',
    run(arg) { const t = arg.toLowerCase(); const sig = t.match(/\bsig(?!nal\b)([a-z]+)\b/); if (sig) { const e = Object.entries(SIGNALS).find(([, v]) => v.toLowerCase().startsWith(`sig${sig[1]}`)); return e ? `${e[1].split(' ')[0]} = signal ${e[0]} (${e[1].split(' ').slice(1).join(' ')}); exit code ${128 + Number(e[0])} when it kills a process` : null; } const n = (t.match(/\b(\d{1,3})\b/) ?? [])[1]; if (n === undefined) return null; const code = Number(n); if (/signal/.test(t) && !/exit/.test(t)) { const s = SIGNALS[code]; return s ? `signal ${code}: ${s} (exit code ${128 + code})` : null; } if (EXIT_CODES[code]) return `${code}: ${EXIT_CODES[code]}`; if (code > 128 && code < 160 && SIGNALS[code - 128]) return `${code}: killed by signal ${code - 128} (${SIGNALS[code - 128]})`; if (code >= 0 && code <= 255) return `${code}: program-defined (1–125 are the program's own error codes)`; return null; } },
  { id: 'cup-grams', family: 'reference', keywords: ['cups of', 'cup of', 'cups in grams', 'cup in grams', 'grams in a cup of'], arg: 'segment', keywordIsArg: true, example: ['1 cup of flour in grams', '120 g (US cup, 240 ml)'], miss: 'need <n> cups of <ingredient> (flour, sugar, butter, rice, oats…)',
    run(arg) { const t = arg.toLowerCase(); const m = t.match(new RegExp(String.raw`(${NUM}|half a|a quarter|three quarters|a|an)\s*(?:cups?|cup of|cups of)\s*(?:of\s+)?([a-z][a-z -]*?)(?:\s+(?:in|to)\s+(?:grams?|g|ounces?|oz))?\s*$`)); const g = t.match(/grams? in (?:a|one) cup of ([a-z][a-z -]*)/); const ing = (m ? m[2] : g ? g[1] : '').trim(); const per = CUP_GRAMS[ing] ?? CUP_GRAMS[ing.replace(/s$/, '')]; if (!per) return null; const n = m ? (m[1] === 'a' || m[1] === 'an' ? 1 : m[1] === 'half a' ? 0.5 : m[1] === 'a quarter' ? 0.25 : m[1] === 'three quarters' ? 0.75 : num(m[1])) : 1; const grams = per * n; return `${fmt(Math.round(grams))} g${/oz|ounce/.test(t) ? ` (${fmt(Math.round(grams / 28.35 * 10) / 10)} oz)` : ''} (US cup, ${fmt(240 * n)} ml)`; } },
  { id: 'oven', family: 'reference', keywords: ['oven', 'gas mark', 'fan oven', 'in fan', 'oven temperature'], arg: 'segment', keywordIsArg: true, example: ['350f fan oven', '350 °F = 180 °C conventional, 160 °C fan, 350 °F, gas mark 4'], miss: 'need a temperature (350f, 180c, gas mark 4)',
    run(arg) { const t = arg.toLowerCase(); const gm = t.match(/gas\s*mark\s*(\d(?:\.\d)?|¼|½)/); const f = t.match(/(\d{3})\s*°?\s*f\b/); const c = t.match(/(\d{2,3})\s*°?\s*c\b/); let row = gm ? OVEN.find((r) => r[0] === (gm[1] === '¼' ? 0.25 : gm[1] === '½' ? 0.5 : Number(gm[1]))) : f ? OVEN.reduce((a, b) => Math.abs(b[3] - Number(f[1])) < Math.abs(a[3] - Number(f[1])) ? b : a) : c ? OVEN.reduce((a, b) => Math.abs((/fan/.test(t) ? b[2] : b[1]) - Number(c[1])) < Math.abs((/fan/.test(t) ? a[2] : a[1]) - Number(c[1])) ? b : a) : undefined; if (!row) return null; const src = gm ? `gas mark ${gm[1]}` : f ? `${f[1]} °F` : `${c![1]} °C${/fan/.test(t) ? ' fan' : ''}`; return `${src} = ${row[1]} °C conventional, ${row[2]} °C fan, ${row[3]} °F, gas mark ${row[0]}`; } },
  { id: 'paper-size', family: 'reference', keywords: ['paper size', 'size of a4', 'a4 in', 'a3 in', 'a5 in', 'letter size', 'dimensions of'], arg: 'segment', keywordIsArg: true, example: ['a4 in inches', 'A4: 210 × 297 mm = 8.27 × 11.69 in (2480 × 3508 px at 300 dpi)'], miss: 'need a paper size (A0–A7, B4, B5, letter, legal, tabloid)',
    run(arg) { const t = arg.toLowerCase(); const k = Object.keys(PAPER).find((p) => new RegExp(`\\b${p}\\b`).test(t)); if (!k) return null; const [w, h] = PAPER[k]; const inch = (mm: number) => (mm / 25.4).toFixed(2); return `${k.length <= 2 ? k.toUpperCase() : cap(k)}: ${w} × ${h} mm = ${inch(w)} × ${inch(h)} in (${Math.round(w / 25.4 * 300)} × ${Math.round(h / 25.4 * 300)} px at 300 dpi)`; } },
  { id: 'shoe-size', family: 'reference', keywords: ['shoe size', 'uk shoe size', 'us shoe size', 'eu shoe size', 'shoe'], arg: 'segment', keywordIsArg: true, example: ['uk shoe size 9 in eu', 'UK 9 (men) = US 10 = EU 43'], miss: 'need <uk|us|eu> shoe size <n> (add women for women\'s)',
    run(arg) { const t = arg.toLowerCase(); const m = t.match(/\b(uk|us|eu)\b[^\d]*(\d{1,2}(?:\.5)?)/); if (!m) return null; const sex = /women|ladies|female/.test(t) ? 'women' : 'men'; const col = m[1] === 'uk' ? 0 : m[1] === 'us' ? 1 : 2; const size = Number(m[2]); const row = SHOES[sex].find((r) => r[col] === size); if (!row) return null; return `${m[1].toUpperCase()} ${size} (${sex}) = ${['UK', 'US', 'EU'].filter((_, i) => i !== col).map((n, i) => `${n} ${row[[0, 1, 2].filter((x) => x !== col)[i]]}`).join(' = ')}`; } },
  { id: 'bed-size', family: 'reference', keywords: ['bed size', 'size of a king bed', 'size of a queen bed', 'size of a double bed', 'mattress size', 'king size bed', 'queen size bed', 'double bed', 'single bed'], arg: 'segment', keywordIsArg: true, example: ['king size bed in cm', 'UK king 150 × 200 cm (5′ × 6′6″) · US king 193 × 203 cm (76 × 80 in) · EU king 160 × 200 cm'], miss: 'need single / double / queen / king / super king (uk, us or eu)',
    run(arg) { const t = arg.toLowerCase(); const region = (t.match(/\b(uk|us|eu|american|british|european)\b/) ?? [])[1]; const kind = (t.match(/\b(super king|california king|cal king|king|queen|small double|double|full|twin xl|twin|single)\b/) ?? [])[1]; if (!kind) return null; const reg = region === 'american' ? 'us' : region === 'british' ? 'uk' : region === 'european' ? 'eu' : region; const want = kind === 'cal king' ? 'california king' : kind; const rows = Object.entries(BEDS).filter(([k]) => k.replace(/^(uk|us|eu) /, '') === want && (!reg || k.startsWith(reg))); if (!rows.length) return null; return rows.map(([k, v]) => `${k.replace(/^(uk|us|eu)/, (r) => r.toUpperCase())} ${v}`).join(' · '); } },
  { id: 'zodiac', family: 'reference', keywords: ['zodiac for', 'star sign for', 'zodiac sign for', 'horoscope sign for', 'star sign', 'zodiac'], arg: 'segment', example: ['zodiac for 3 march', 'Pisces ♓ (19 Feb – 20 Mar)'], miss: 'need a day and month',
    run(arg) { const md = monthDay(arg); if (!md) return null; const [mo, d] = md; let i = ZODIAC.findIndex((z, k) => { const [, sm, sd] = z; const next = ZODIAC[(k + 1) % 12]; const after = mo > sm || (mo === sm && d >= sd); const before = mo < next[1] || (mo === next[1] && d < next[2]); return k === 0 ? (after || before) : (after && before); }); if (i < 0) i = 0; const z = ZODIAC[i], n = ZODIAC[(i + 1) % 12]; const M = ['', 'Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']; return `${z[0]} ${z[3]} (${z[2]} ${M[z[1]]} – ${n[2] - 1} ${M[n[1]]})`; } },
  { id: 'chinese-zodiac', family: 'reference', keywords: ['chinese zodiac for', 'chinese zodiac', 'year of the', 'chinese year for'], arg: 'segment', keywordIsArg: true, example: ['chinese zodiac for 1990', '1990: Metal Horse (by the lunar new year; a January or early-February birthday may be the year before)'], miss: 'need a year',
    run(arg) { const m = arg.match(/\b(1[89]\d{2}|20\d{2})\b/); if (!m) return null; const y = Number(m[1]); const animal = CHINESE_ZODIAC[((y - 1900) % 12 + 12) % 12]; const el = CHINESE_ELEMENTS[Math.floor(((y - 1900) % 10 + 10) % 10 / 2)]; return `${y}: ${el} ${animal} (by the lunar new year; a January or early-February birthday may be the year before)`; } },
  { id: 'dog-years', family: 'reference', keywords: ['dog years for', 'dog years', 'in dog years', 'cat years for', 'cat years', 'in cat years'], arg: 'segment', keywordIsArg: true, example: ['dog years for 7', '7 dog years ≈ 49 human years (AVMA: 15 for the first, 9 for the second, 5 each after)'], miss: 'need an age',
    run(arg) { const n = (arg.match(new RegExp(NUM)) ?? [])[0]; if (!n) return null; const a = num(n); if (a < 0 || a > 40) return null; const cat = /cat/.test(arg.toLowerCase()); const h = a <= 0 ? 0 : a <= 1 ? 15 * a : a <= 2 ? 15 + 9 * (a - 1) : cat ? 24 + 4 * (a - 2) : 24 + 5 * (a - 2); return `${fmt(a)} ${cat ? 'cat' : 'dog'} years ≈ ${fmt(Math.round(h))} human years (${cat ? '15 for the first, 9 for the second, 4 each after' : 'AVMA: 15 for the first, 9 for the second, 5 each after'})`; } },
];
